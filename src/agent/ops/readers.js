/**
 * Read-type ops: read, list, grep, glob. No side effects, so these never enter the
 * rollback set. Output is size-capped — an unbounded grep across a monorepo is the
 * fastest way to blow the context window.
 */
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

const MAX_BYTES = 200_000;
const MAX_MATCHES = 200;
const MAX_ENTRIES = 500;

function truncate(text, limit = MAX_BYTES) {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: text.slice(0, limit),
    truncated: true,
    note: `output truncated at ${limit} bytes (${text.length} total)`,
  };
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function opRead(op, ctx) {
  const abs = ctx.sandbox.resolveForRead(op.path);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    throw new Error(`${ctx.sandbox.rel(abs)} is a directory — use the "list" op`);
  }
  const buf = fs.readFileSync(abs);
  if (isProbablyBinary(buf)) {
    return { path: ctx.sandbox.rel(abs), binary: true, bytes: stat.size };
  }
  const content = buf.toString('utf8');
  const allLines = content.split(/\r?\n/);

  let from = 1;
  let to = allLines.length;
  if (op.lines) {
    from = op.lines[0];
    to = Math.min(op.lines[1], allLines.length);
    if (from > allLines.length) {
      throw new Error(
        `${ctx.sandbox.rel(abs)} has ${allLines.length} lines; requested start ${from}`,
      );
    }
  }
  const slice = allLines.slice(from - 1, to).join('\n');
  const t = truncate(slice);
  return {
    path: ctx.sandbox.rel(abs),
    lines: [from, to],
    totalLines: allLines.length,
    content: t.text,
    ...(t.truncated ? { note: t.note } : {}),
  };
}

export function opList(op, ctx) {
  const abs = ctx.sandbox.resolveForRead(op.path);
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) {
    throw new Error(`${ctx.sandbox.rel(abs)} is not a directory — use the "read" op`);
  }
  const max = Math.min(op.max || MAX_ENTRIES, MAX_ENTRIES);
  const entries = [];
  let skipped = 0;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(abs, ent.name);
    if (ctx.sandbox.isIgnored(child)) {
      skipped++;
      continue;
    }
    if (entries.length >= max) {
      skipped++;
      continue;
    }
    let size;
    try {
      size = ent.isFile() ? fs.statSync(child).size : undefined;
    } catch {
      /* raced away */
    }
    entries.push({
      name: ent.name + (ent.isDirectory() ? '/' : ''),
      type: ent.isDirectory() ? 'dir' : 'file',
      ...(size !== undefined ? { size } : {}),
    });
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
  return {
    path: ctx.sandbox.rel(abs),
    entries,
    ...(skipped ? { skipped: `${skipped} entries hidden (ignored or over max)` } : {}),
  };
}

/** Walk a subtree, honouring .daignore, yielding absolute file paths. */
function* walkFiles(root, ctx, budget = { n: 20000 }) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (budget.n-- <= 0) return;
      const p = path.join(dir, ent.name);
      if (ctx.sandbox.isIgnored(p)) continue;
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) yield p;
    }
  }
}

export function opGrep(op, ctx) {
  const abs = ctx.sandbox.resolveForRead(op.path);
  const max = Math.min(op.max || MAX_MATCHES, MAX_MATCHES);

  let test;
  if (op.regex) {
    let re;
    try {
      re = new RegExp(op.pattern, 'g');
    } catch (err) {
      throw new Error(`invalid regex: ${err.message}`, { cause: err });
    }
    test = (line) => {
      re.lastIndex = 0;
      return re.test(line);
    };
  } else {
    test = (line) => line.includes(op.pattern);
  }

  const stat = fs.statSync(abs);
  const files = stat.isDirectory() ? walkFiles(abs, ctx) : [abs];
  const matches = [];
  let scanned = 0;
  let capped = false;

  for (const file of files) {
    if (matches.length >= max) {
      capped = true;
      break;
    }
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    if (isProbablyBinary(buf)) continue;
    scanned++;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= max) {
        capped = true;
        break;
      }
      if (test(lines[i])) {
        matches.push({
          path: ctx.sandbox.rel(file),
          line: i + 1,
          text: lines[i].length > 400 ? lines[i].slice(0, 400) + '…' : lines[i],
        });
      }
    }
  }

  return {
    pattern: op.pattern,
    regex: !!op.regex,
    root: ctx.sandbox.rel(abs),
    filesScanned: scanned,
    matches,
    ...(capped ? { note: `stopped at ${max} matches` } : {}),
  };
}

export function opGlob(op, ctx) {
  const abs = ctx.sandbox.resolveForRead(op.path);
  const max = Math.min(op.max || MAX_ENTRIES, MAX_ENTRIES);
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) throw new Error(`${ctx.sandbox.rel(abs)} is not a directory`);

  // "**.py" is a common model typo for "**/*.py"; accept both.
  const pattern = op.pattern.replace(/\*\*(?=[^/*])/g, '**/*');
  const isMatch = picomatch(pattern, { dot: true, nocase: process.platform === 'win32' });

  const results = [];
  let capped = false;
  for (const file of walkFiles(abs, ctx)) {
    const rel = path.relative(abs, file).split(path.sep).join('/');
    if (isMatch(rel)) {
      if (results.length >= max) {
        capped = true;
        break;
      }
      results.push(ctx.sandbox.rel(file));
    }
  }
  return {
    pattern,
    root: ctx.sandbox.rel(abs),
    files: results,
    ...(capped ? { note: `stopped at ${max} files` } : {}),
  };
}
