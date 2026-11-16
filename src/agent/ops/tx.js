/**
 * Transactional embedded JavaScript DSL (`tx` op) — Copy-on-Write Code Mode.
 *
 * Gated behind `DAVAI_CODE_MODE=true` (`cfg.codeMode`). When disabled, `davai`'s
 * prompt, planner, and baseline `da_ops` behaviour are completely untouched.
 *
 * Architecture:
 *   1. The model's JS payload runs inside a sealed `node:vm` context with NO ambient
 *      authority (`require`, `import`, `process`, `fs`, `fetch`, timers are absent).
 *   2. Every filesystem helper (`read`, `exists`, `list`, `glob`, `grep`, `write`,
 *      `replace`, `remove`, `move`, `fileset`) routes through `Sandbox.resolveForRead`
 *      or `Sandbox.resolveForWrite` (honouring `.daignore`) and operates on an
 *      in-memory Copy-on-Write `StagedFS` overlay.
 *   3. Disk is untouched while the script runs. If the script throws, fails a
 *      `replace` uniqueness check, produces NUL bytes / conflict markers, exceeds the
 *      op or byte budget, or hits the V8 CPU timeout, `StagedFS` is discarded and
 *      nothing was written.
 *   4. Only after the script returns cleanly does `opTx` flush dirty entries
 *      through `Journal` (`snapshot` + `atomicWrite`), preserving full rollback if
 *      a later op in the same `da_ops` batch fails.
 *   5. `state` is a plain object persisted across turns in memory for the session
 *      so bulk intermediate data can live in V8 heap instead of burning context tokens.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import picomatch from 'picomatch';
import { Journal } from '../journal.js';
import { simulateReplace } from './writers.js';
import { verifyBuffer } from './verify.js';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_FS_OPS = 2000;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;
const MAX_RETURN_BYTES = 64_000;
const MAX_LOG_LINES = 200;

export const TOMBSTONE = Symbol('TOMBSTONE');

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function formatValue(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * In-memory Copy-on-Write filesystem view backed by `Sandbox`.
 *
 * Preloads `initialOverlay` from earlier ops in the same `da_ops` batch when planning,
 * so `[write a.js, tx reading a.js]` sees the earlier op's staged content seamlessly.
 */
export class StagedFS {
  /**
   * @param {{sandbox: any, initialOverlay?: Map<string, string|null>,
   *   initialPending?: Map<string, string>, maxOps?: number, maxBytes?: number}} opts
   */
  constructor({
    sandbox,
    initialOverlay = null,
    initialPending = null,
    maxOps = MAX_FS_OPS,
    maxBytes = MAX_STAGED_BYTES,
  }) {
    this.sandbox = sandbox;
    this.maxOps = maxOps;
    this.maxBytes = maxBytes;
    this.opsCount = 0;
    this.stagedBytes = 0;

    /**
     * Staged file contents: `string` for written/modified UTF-8 text, or `TOMBSTONE`
     * for deleted/moved-away paths.
     * @type {Map<string, string | symbol>}
     */
    this.files = new Map();
    /**
     * Ordered mutation log used to commit to `Journal` once the VM completes cleanly,
     * collapsed per target path so 10 in-script edits to `a.js` produce 1 atomic write.
     * @type {Map<string, {action: 'created'|'overwritten'|'replaced'|'deleted', beforeLines: number}>}
     */
    this.mutations = new Map();

    if (initialPending) {
      for (const [abs, state] of initialPending.entries()) {
        if (state === 'deleted' || state === 'moved-away') {
          this.files.set(abs, TOMBSTONE);
        } else if (state === 'written' && initialOverlay?.has(abs)) {
          const text = initialOverlay.get(abs);
          if (typeof text === 'string') this.files.set(abs, text);
        }
      }
    }
  }

  #chargeOp() {
    if (++this.opsCount > this.maxOps) {
      throw new Error(`tx exceeded filesystem operation cap (${this.maxOps} ops)`);
    }
  }

  #chargeBytes(delta) {
    this.stagedBytes += delta;
    if (this.stagedBytes > this.maxBytes) {
      throw new Error(
        `tx exceeded staged write budget (${Math.round(this.maxBytes / 1024 / 1024)}MB)`,
      );
    }
  }

  #existsRead(abs) {
    if (this.files.has(abs)) return this.files.get(abs) !== TOMBSTONE;
    return fs.existsSync(abs);
  }

  #isDirOnDisk(abs) {
    if (this.files.has(abs)) return false;
    try {
      return fs.statSync(abs).isDirectory();
    } catch {
      return false;
    }
  }

  #readTextAt(abs) {
    if (this.files.has(abs)) {
      const v = this.files.get(abs);
      if (v === TOMBSTONE) throw new Error(`${this.sandbox.rel(abs)} does not exist`);
      return /** @type {string} */ (v);
    }
    if (!fs.existsSync(abs)) {
      throw new Error(`${this.sandbox.rel(abs)} does not exist`);
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      throw new Error(`${this.sandbox.rel(abs)} is a directory — use list()`);
    }
    const buf = fs.readFileSync(abs);
    if (isProbablyBinary(buf)) {
      throw new Error(`${this.sandbox.rel(abs)} is a binary file (${stat.size} bytes)`);
    }
    return buf.toString('utf8');
  }

  #recordWrite(abs, nextText, kind) {
    const prevStaged = this.files.get(abs);
    const prevBytes = typeof prevStaged === 'string' ? Buffer.byteLength(prevStaged, 'utf8') : 0;
    const nextBytes = Buffer.byteLength(nextText, 'utf8');
    this.#chargeBytes(nextBytes - prevBytes);

    const existingMeta = this.mutations.get(abs);
    let existedOriginally;
    let beforeLines = 0;
    if (existingMeta) {
      existedOriginally = existingMeta.action !== 'created';
      beforeLines = existingMeta.beforeLines;
    } else if (prevStaged === TOMBSTONE) {
      existedOriginally = false;
    } else if (typeof prevStaged === 'string') {
      existedOriginally = true;
      beforeLines = prevStaged.split('\n').length;
    } else if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      existedOriginally = true;
      try {
        beforeLines = fs.readFileSync(abs, 'utf8').split('\n').length;
      } catch {
        beforeLines = 0;
      }
    } else {
      existedOriginally = false;
    }

    const bad = verifyBuffer(Buffer.from(nextText, 'utf8'), { created: !existedOriginally });
    if (bad) {
      throw new Error(`${this.sandbox.rel(abs)} — ${bad}`);
    }

    this.files.set(abs, nextText);
    const action = !existedOriginally
      ? 'created'
      : kind === 'replace' && (!existingMeta || existingMeta.action === 'replaced')
        ? 'replaced'
        : 'overwritten';
    this.mutations.set(abs, { action, beforeLines });
  }

  exists(p) {
    this.#chargeOp();
    const abs = this.sandbox.resolveForRead(String(p));
    return this.#existsRead(abs);
  }

  read(p, lines) {
    this.#chargeOp();
    const abs = this.sandbox.resolveForRead(String(p));
    const content = this.#readTextAt(abs);
    if (!lines) return content;
    if (
      !Array.isArray(lines) ||
      lines.length !== 2 ||
      !lines.every((n) => Number.isInteger(n) && n > 0) ||
      lines[0] > lines[1]
    ) {
      throw new Error('read(path, lines): lines must be [min, max], 1-indexed with min <= max');
    }
    const all = content.split(/\r?\n/);
    if (lines[0] > all.length) return '';
    return all.slice(lines[0] - 1, Math.min(lines[1], all.length)).join('\n');
  }

  list(p = '.') {
    this.#chargeOp();
    const abs = this.sandbox.resolveForRead(String(p));
    if (!this.#isDirOnDisk(abs)) {
      const stagedChild = [...this.files.entries()].some(
        ([k, v]) => v !== TOMBSTONE && k.startsWith(abs + path.sep),
      );
      if (!stagedChild) {
        throw new Error(`${this.sandbox.rel(abs)} is not a directory`);
      }
    }
    const names = new Map();
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = path.join(abs, ent.name);
        if (this.sandbox.isIgnored(child)) continue;
        if (this.files.get(child) === TOMBSTONE) continue;
        names.set(ent.name, ent.isDirectory() ? `${ent.name}/` : ent.name);
      }
    }
    const prefix = abs.endsWith(path.sep) ? abs : abs + path.sep;
    for (const [k, v] of this.files.entries()) {
      if (v === TOMBSTONE || !k.startsWith(prefix)) continue;
      const rel = k.slice(prefix.length);
      const seg = rel.split(path.sep)[0];
      if (!seg) continue;
      if (rel.includes(path.sep)) names.set(seg, `${seg}/`);
      else if (!names.has(seg)) names.set(seg, seg);
    }
    return [...names.values()].sort();
  }

  *#walkFiles(rootAbs) {
    const yielded = new Set();
    if (fs.existsSync(rootAbs) && fs.statSync(rootAbs).isDirectory()) {
      const stack = [rootAbs];
      let budget = 20_000;
      while (stack.length && budget > 0) {
        const dir = stack.pop();
        let ents;
        try {
          ents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of ents) {
          if (--budget <= 0) break;
          const child = path.join(dir, ent.name);
          if (this.sandbox.isIgnored(child)) continue;
          if (ent.isDirectory()) {
            stack.push(child);
          } else if (ent.isFile()) {
            if (this.files.get(child) === TOMBSTONE) continue;
            yielded.add(child);
            yield child;
          }
        }
      }
    } else if (this.#existsRead(rootAbs) && !this.#isDirOnDisk(rootAbs)) {
      yielded.add(rootAbs);
      yield rootAbs;
    }

    const prefix = rootAbs.endsWith(path.sep) ? absWithSep(rootAbs) : rootAbs + path.sep;
    for (const [abs, v] of this.files.entries()) {
      if (v === TOMBSTONE || yielded.has(abs)) continue;
      if (abs === rootAbs || abs.startsWith(prefix)) {
        yielded.add(abs);
        yield abs;
      }
    }
  }

  glob(pattern, root = '.') {
    this.#chargeOp();
    const abs = this.sandbox.resolveForRead(String(root));
    const fixed = String(pattern).replace(/\*\*(?=[^/*])/g, '**/*');
    const isMatch = picomatch(fixed, { dot: true, nocase: process.platform === 'win32' });
    const out = [];
    for (const file of this.#walkFiles(abs)) {
      const rel = path.relative(abs, file).split(path.sep).join('/');
      if (isMatch(rel)) out.push(this.sandbox.rel(file));
    }
    return out.sort();
  }

  grep(pattern, opts = {}) {
    this.#chargeOp();
    const rootPath = typeof opts === 'string' ? opts : (opts?.path ?? '.');
    const regex = Boolean(opts?.regex);
    const outMode = opts?.out || 'lines';
    const max = Math.min(opts?.max || 500, 2000);
    const abs = this.sandbox.resolveForRead(String(rootPath));

    let test;
    if (regex) {
      const re = new RegExp(String(pattern), 'g');
      test = (line) => {
        re.lastIndex = 0;
        return re.test(line);
      };
    } else {
      const needle = String(pattern);
      test = (line) => line.includes(needle);
    }

    const matches = [];
    const matchedFiles = [];
    let count = 0;

    for (const file of this.#walkFiles(abs)) {
      let text;
      if (this.files.has(file)) {
        const v = this.files.get(file);
        if (typeof v !== 'string') continue;
        text = v;
      } else {
        let buf;
        try {
          buf = fs.readFileSync(file);
        } catch {
          continue;
        }
        if (isProbablyBinary(buf)) continue;
        text = buf.toString('utf8');
      }

      const lines = text.split(/\r?\n/);
      let hit = false;
      for (let i = 0; i < lines.length; i++) {
        if (test(lines[i])) {
          hit = true;
          count++;
          if (outMode === 'files') break;
          if (outMode === 'lines' && matches.length < max) {
            matches.push({
              path: this.sandbox.rel(file),
              line: i + 1,
              text: lines[i].length > 400 ? lines[i].slice(0, 400) + '…' : lines[i],
            });
          }
        }
      }
      if (hit) matchedFiles.push(this.sandbox.rel(file));
      if (outMode === 'files' && matchedFiles.length >= max) break;
      if (outMode === 'lines' && matches.length >= max) break;
    }

    if (outMode === 'files') return matchedFiles.sort();
    if (outMode === 'count') return { count, files: matchedFiles.length };
    return matches;
  }

  write(p, text, opts = {}) {
    this.#chargeOp();
    if (typeof text !== 'string') {
      throw new Error(`write(${p}): text must be a string`);
    }
    const overwrite = opts === true ? true : Boolean(opts?.overwrite ?? true);
    const abs = this.sandbox.resolveForWrite(String(p));
    if (this.#isDirOnDisk(abs)) {
      throw new Error(`${this.sandbox.rel(abs)} is a directory`);
    }
    if (!overwrite && this.#existsRead(abs)) {
      throw new Error(
        `${this.sandbox.rel(abs)} already exists — pass { overwrite: true } or omit overwrite: false`,
      );
    }
    this.#recordWrite(abs, text, 'write');
    return this.sandbox.rel(abs);
  }

  replace(p, oldOrEdits, replacement, opts = {}) {
    this.#chargeOp();
    const abs = this.sandbox.resolveForWrite(String(p));
    const rel = this.sandbox.rel(abs);
    const content = this.#readTextAt(abs);

    const isRegExpLike =
      oldOrEdits instanceof RegExp ||
      Boolean(
        oldOrEdits &&
          typeof oldOrEdits === 'object' &&
          typeof oldOrEdits.source === 'string' &&
          typeof oldOrEdits.flags === 'string',
      );

    let opShape;
    if (Array.isArray(oldOrEdits)) {
      const extra = replacement && typeof replacement === 'object' ? replacement : {};
      opShape = { edits: oldOrEdits, all: Boolean(extra.all), regex: Boolean(extra.regex) };
    } else if (isRegExpLike) {
      if (typeof replacement !== 'string') {
        throw new Error(`replace(${rel}): replacement must be a string`);
      }
      opShape = {
        old: oldOrEdits.source,
        new: replacement,
        regex: true,
        all: oldOrEdits.flags.includes('g') || Boolean(opts?.all),
      };
    } else {
      if (typeof oldOrEdits !== 'string' || oldOrEdits === '') {
        throw new Error(`replace(${rel}): "old" must be a non-empty string, RegExp, or edits array`);
      }
      if (typeof replacement !== 'string') {
        throw new Error(`replace(${rel}): "new" must be a string`);
      }
      opShape = {
        old: oldOrEdits,
        new: replacement,
        all: Boolean(opts?.all),
        regex: Boolean(opts?.regex),
      };
    }

    const { updated, occurrences } = simulateReplace(content, opShape, rel);
    this.#recordWrite(abs, updated, 'replace');
    return occurrences;
  }

  remove(p) {
    this.#chargeOp();
    const abs = this.sandbox.resolveForWrite(String(p));
    if (abs === this.sandbox.writeRoot) {
      throw new Error('refusing to delete the working directory itself');
    }
    if (this.#isDirOnDisk(abs)) {
      throw new Error(
        `${this.sandbox.rel(abs)} is a directory — remove individual files or use the delete op with "recursive": true`,
      );
    }
    if (!this.#existsRead(abs)) {
      throw new Error(`${this.sandbox.rel(abs)} does not exist`);
    }

    const prevMeta = this.mutations.get(abs);
    const prevStaged = this.files.get(abs);
    if (typeof prevStaged === 'string') {
      this.#chargeBytes(-Buffer.byteLength(prevStaged, 'utf8'));
    }

    if (prevMeta?.action === 'created') {
      // Created and deleted inside the same tx: net effect on disk is zero.
      this.files.set(abs, TOMBSTONE);
      this.mutations.delete(abs);
    } else {
      let beforeLines = prevMeta?.beforeLines ?? 0;
      if (!prevMeta && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        try {
          beforeLines = fs.readFileSync(abs, 'utf8').split('\n').length;
        } catch {
          beforeLines = 0;
        }
      }
      this.files.set(abs, TOMBSTONE);
      this.mutations.set(abs, { action: 'deleted', beforeLines });
    }
    return this.sandbox.rel(abs);
  }

  move(from, to, opts = {}) {
    this.#chargeOp();
    const fromAbs = this.sandbox.resolveForWrite(String(from));
    const toAbs = this.sandbox.resolveForWrite(String(to));
    if (fromAbs === toAbs) throw new Error('move: "from" and "to" are the same path');
    if (fromAbs === this.sandbox.writeRoot) {
      throw new Error('refusing to move the working directory itself');
    }
    const overwrite = Boolean(opts?.overwrite);
    if (this.#existsRead(toAbs) && !overwrite) {
      throw new Error(
        `${this.sandbox.rel(toAbs)} already exists — pass { overwrite: true } to replace it`,
      );
    }
    const content = this.#readTextAt(fromAbs);
    this.remove(from);
    this.#recordWrite(toAbs, content, 'write');
    return this.sandbox.rel(toAbs);
  }

  /**
   * Declarative collection pipeline over a set of project paths:
   *   `fileset("src/**\/*.js").containing("oldName").replaceAll("oldName", "newName")`
   */
  fileset(patternOrPaths, root = '.') {
    const initial = Array.isArray(patternOrPaths)
      ? patternOrPaths.map((p) => this.sandbox.rel(this.sandbox.resolveForRead(String(p))))
      : this.glob(patternOrPaths, root);

    const isRe = (x) =>
      x instanceof RegExp ||
      Boolean(x && typeof x === 'object' && typeof x.source === 'string' && typeof x.flags === 'string');

    const wrap = (paths) => ({
      paths: () => [...paths],
      get length() {
        return paths.length;
      },
      filter: (fn) => wrap(paths.filter((p) => fn(p, this.read(p)))),
      containing: (needle, opts = {}) => {
        if (isRe(needle)) {
          const flags = needle.flags.replace('g', '');
          const re = new RegExp(needle.source, flags);
          return wrap(paths.filter((p) => re.test(this.read(p))));
        }
        if (opts?.regex) {
          const re = new RegExp(String(needle));
          return wrap(paths.filter((p) => re.test(this.read(p))));
        }
        const s = String(needle);
        return wrap(paths.filter((p) => this.read(p).includes(s)));
      },
      map: (fn) => paths.map((p) => fn(p, this.read(p))),
      readAll: () => paths.map((p) => ({ path: p, content: this.read(p) })),
      replace: (oldOrEdits, replacement, opts = {}) => {
        let count = 0;
        for (const p of paths) count += this.replace(p, oldOrEdits, replacement, opts);
        return { files: paths.length, occurrences: count };
      },
      replaceAll: (oldOrPattern, replacement, opts = {}) => {
        let filesChanged = 0;
        let occurrences = 0;
        for (const p of paths) {
          const text = this.read(p);
          const matches = isRe(oldOrPattern)
            ? new RegExp(oldOrPattern.source, oldOrPattern.flags.replace('g', '')).test(text)
            : opts?.regex
              ? new RegExp(String(oldOrPattern)).test(text)
              : text.includes(String(oldOrPattern));
          if (!matches) continue;
          occurrences += this.replace(p, oldOrPattern, replacement, { ...opts, all: true });
          filesChanged++;
        }
        return { files: filesChanged, occurrences };
      },
    });

    return wrap(initial);
  }
}

function absWithSep(p) {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

/**
 * Execute a `tx` script against a Copy-on-Write `StagedFS` without touching disk.
 *
 * Used both by `planBatch` (dry-run validation, with cloned `state`) and by `opTx`
 * (real execution, committing mutations to `Journal` afterwards).
 *
 * @param {object} op
 * @param {{sandbox: any, txState?: Record<string, any>, txTimeoutMs?: number,
 *   initialOverlay?: Map<string, string|null>, initialPending?: Map<string, string>,
 *   dryRun?: boolean}} ctx
 */
export function evaluateTx(op, ctx) {
  const staged = new StagedFS({
    sandbox: ctx.sandbox,
    initialOverlay: ctx.initialOverlay,
    initialPending: ctx.initialPending,
  });

  const logs = [];
  const logFn = (...args) => {
    if (logs.length < MAX_LOG_LINES) {
      logs.push(args.map(formatValue).join(' '));
    }
  };

  // Dry-run planning clones `txState` so validation cannot pollute session state if a
  // later op in the same batch fails `planBatch`.
  let stateObj = ctx.txState || {};
  if (ctx.dryRun) {
    try {
      stateObj = structuredClone(stateObj);
    } catch {
      stateObj = { ...stateObj };
    }
  }

  const sandboxGlobals = {
    read: (p, lines) => staged.read(p, lines),
    exists: (p) => staged.exists(p),
    list: (p) => staged.list(p),
    glob: (pattern, root) => staged.glob(pattern, root),
    grep: (pattern, opts) => staged.grep(pattern, opts),
    write: (p, text, opts) => staged.write(p, text, opts),
    replace: (p, oldOrEdits, replacement, opts) =>
      staged.replace(p, oldOrEdits, replacement, opts),
    remove: (p) => staged.remove(p),
    move: (from, to, opts) => staged.move(from, to, opts),
    fileset: (patternOrPaths, root) => staged.fileset(patternOrPaths, root),
    preview: (val, maxChars = 1000) => {
      const s = formatValue(val);
      return s.length <= maxChars ? s : `${s.slice(0, maxChars)}… (${s.length} chars total)`;
    },
    state: stateObj,
    log: logFn,
    console: Object.freeze({
      log: logFn,
      info: logFn,
      warn: logFn,
      error: logFn,
    }),
  };

  const vmContext = vm.createContext(sandboxGlobals, {
    codeGeneration: { strings: false, wasm: false },
  });

  // Wrap as an IIFE so top-level `return ...` works cleanly inside the script.
  // For interactive REPL convenience (`tx read("a.js")`), if `op.allowImplicitReturn` is
  // set and the snippet has no explicit `return` and parses as a single JS expression,
  // auto-return its value while keeping line numbers aligned.
  let body = String(op.code ?? '');
  if (op.allowImplicitReturn && !/\breturn\b/.test(body) && !body.includes('\n')) {
    const trimmed = body.trim().replace(/;+\s*$/, '');
    if (trimmed) {
      try {
        new vm.Script(`'use strict';\n(\n${trimmed}\n)`, { filename: 'davai-tx-expr.js' });
        body = `return (${trimmed});`;
      } catch {
        /* statement rather than expression — compile as-is below */
      }
    }
  }
  const wrapped = `'use strict';\n(function() {\n${body}\n})()`;
  let script;
  try {
    script = new vm.Script(wrapped, { filename: 'davai-tx.js' });
  } catch (err) {
    throw new Error(`tx syntax error: ${err.message}`, { cause: err });
  }

  const timeout = ctx.txTimeoutMs || DEFAULT_TIMEOUT_MS;
  let rawReturn;
  try {
    rawReturn = script.runInContext(vmContext, { timeout });
  } catch (err) {
    throw new Error(cleanVmError(err), { cause: err });
  }

  if (rawReturn && typeof rawReturn.then === 'function') {
    throw new Error(
      'tx scripts are synchronous: all helpers (read, glob, grep, write, replace, fileset) return directly without await',
    );
  }

  return { staged, rawReturn, logs };
}

function cleanVmError(err) {
  const msg = err?.message || String(err);
  const stack = String(err?.stack || '');
  const m = stack.match(/davai-tx\.js:(\d+)/);
  // Subtract the 2 wrapper lines (`'use strict';\n(function() {`) so line numbers match
  // the model's payload line-for-line.
  if (m) {
    const line = Math.max(1, Number(m[1]) - 2);
    return `line ${line}: ${msg}`;
  }
  return msg;
}

/**
 * Flush `StagedFS` mutations to disk through `Journal`, returning `{entries, result}`.
 */
export function opTx(op, ctx) {
  const { staged, rawReturn, logs } = evaluateTx(op, ctx);
  const entries = [];
  const changes = [];

  try {
    for (const [abs, meta] of staged.mutations.entries()) {
      const rel = ctx.sandbox.rel(abs);
      if (meta.action === 'deleted') {
        const pre = ctx.journal.snapshot(abs);
        entries.push(ctx.journal.record({ op: 'delete', path: abs, pre }));
        fs.rmSync(abs, { force: true });
        changes.push({ path: rel, action: 'deleted', delta: -meta.beforeLines });
      } else {
        const nextText = /** @type {string} */ (staged.files.get(abs));
        const existed = meta.action !== 'created';
        const pre = ctx.journal.snapshot(abs);
        entries.push(
          ctx.journal.record({
            op: meta.action === 'replaced' ? 'replace' : 'write',
            path: abs,
            pre,
            existed,
          }),
        );
        Journal.atomicWrite(abs, Buffer.from(nextText, 'utf8'));
        const afterLines = nextText.split('\n').length;
        changes.push({
          path: rel,
          action: meta.action,
          delta: existed ? afterLines - meta.beforeLines : afterLines,
        });
      }
    }
  } catch (err) {
    ctx.journal.rollback(entries);
    throw err;
  }

  let output = undefined;
  let note;
  if (rawReturn !== undefined) {
    const serialized =
      typeof rawReturn === 'string' ? rawReturn : JSON.stringify(rawReturn, null, 2);
    if (serialized && serialized.length > MAX_RETURN_BYTES) {
      output = serialized.slice(0, MAX_RETURN_BYTES);
      note = `return value truncated at ${MAX_RETURN_BYTES} chars (${serialized.length} total)`;
    } else {
      output = serialized;
    }
  }

  return {
    entries,
    result: {
      opsCount: staged.opsCount,
      changes,
      ...(logs.length ? { logs } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(note ? { note } : {}),
    },
  };
}