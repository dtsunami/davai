/**
 * Tab completion for the REPL and approval/save panes:
 *   - /commands and their subcommands, providers, models, blocks, and flags
 *   - @path file/directory references in prompts
 *   - Shell commands ($PATH executables, builtins, git/npm/cargo/docker subcommands,
 *     package.json scripts, flags, and file/directory arguments)
 */
import fs from 'node:fs';
import path from 'node:path';
import { commandList } from './commands.js';
import { PROVIDERS, MODELS } from '../config/models.js';
import { PROMPT_SPECS } from '../agent/prompt.js';
import { profileState } from '../session/profiles.js';
import {
  COMMAND_WRAPPERS,
  TOOL_SUBCOMMANDS,
  getPathCommands,
  readPackageScripts,
  resolveShellBaseDir,
} from './shell-env.js';

/**
 * Aliases the switch in commands.js accepts but HELP does not list. They are worth
 * completing and not worth documenting twice.
 */
const ALIASES = ['/perf', '/throughput', '/speed', '/quit', '/q', '/?', '/providers', '/profile', '/repl'];

/**
 * Derived from the same table the help text and the web client use, rather than kept
 * alongside it. A hand-maintained copy is why /stream and /prompts shipped without
 * completion: they were added to HELP and nowhere else.
 */
const COMMANDS = [
  ...new Set([
    ...commandList()
      .map((c) => c.name)
      .filter((n) => n.startsWith('/')),
    ...ALIASES,
  ]),
].sort();

const COMMAND_DESCS = new Map(commandList().map((c) => [c.name, c.desc]));

/** Known slash commands and aliases, for syntax highlighting and completion. */
export function knownSlashCommands() {
  return COMMANDS;
}

/**
 * @typedef {object} CompletionItem
 * @property {string} label   short text shown in the candidate bar
 * @property {string} insert  replacement text written into `replaceRange`
 * @property {string} [desc]  optional description
 */

/**
 * @typedef {object} CompletionResult
 * @property {string} value
 * @property {number} cursor
 * @property {string} [hint]
 * @property {CompletionItem[]} [items]
 * @property {[number, number]} [replaceRange]
 */

/**
 * Compute Tab completions at `cursor`.
 *
 * @param {string} value
 * @param {number} cursor
 * @param {{sandbox?: object, cfg?: object}} [session]
 * @param {{mode?: 'composer'|'shell'|'path', shellMode?: boolean, cwd?: string}} [opts]
 * @returns {CompletionResult|null}
 */
export function completeInput(value, cursor, session = {}, opts = {}) {
  const { mode = 'composer', shellMode = false, cwd } = opts;
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);

  // --- bare file/directory path mode (ArtifactPane `save as:`) ---
  if (mode === 'path') {
    const res = completePathCandidates(before, session?.sandbox, { cwd, trailingSpace: false });
    if (!res) return null;
    return buildResult(value, [0, cursor], res);
  }

  // --- pure shell mode (ApprovalPane edit, or Composer ctrl+s `$` mode) ---
  if (mode === 'shell' || shellMode) {
    return completeShellInput(value, cursor, session, { cwd });
  }

  // --- `sh <cmd>` in Composer delegates the command tail to shell completion ---
  if (/^sh\s+/.test(before)) {
    const shPrefixLen = before.match(/^sh\s+/)[0].length;
    const sub = completeShellInput(
      value.slice(shPrefixLen),
      cursor - shPrefixLen,
      session,
      { cwd },
    );
    if (!sub) return null;
    const prefix = value.slice(0, shPrefixLen);
    return {
      value: prefix + sub.value,
      cursor: shPrefixLen + sub.cursor,
      hint: sub.hint,
      items: sub.items,
      replaceRange: sub.replaceRange
        ? [sub.replaceRange[0] + shPrefixLen, sub.replaceRange[1] + shPrefixLen]
        : undefined,
    };
  }

  // --- slash command name at the start of input ---
  if (/^\/\S*$/.test(before)) {
    const matches = COMMANDS.filter((c) => c.toLowerCase().startsWith(before.toLowerCase()));
    if (!matches.length) return null;
    const items = matches.map((c) => ({
      label: c,
      insert: `${c} `,
      desc: COMMAND_DESCS.get(c) || '',
    }));
    if (items.length === 1) {
      const next = items[0].insert;
      return {
        value: next + after,
        cursor: next.length,
        items,
        replaceRange: [0, cursor],
      };
    }
    const common = longestCommonPrefix(matches);
    return {
      value: common + after,
      cursor: common.length,
      hint: formatHint(matches),
      items,
      replaceRange: [0, cursor],
    };
  }

  // --- slash command arguments (`/model <tab>`, `/prompts diff <tab>`, etc.) ---
  if (before.startsWith('/')) {
    const slashArg = completeSlashArgs(value, cursor, session, { cwd });
    if (slashArg) return slashArg;
  }

  // --- @path completion anywhere in a prompt ---
  const at = before.lastIndexOf('@');
  if (at !== -1 && (at === 0 || /\s/.test(before[at - 1])) && !/\s/.test(before.slice(at + 1))) {
    const partial = before.slice(at + 1);
    const res = completePathCandidates(partial, session?.sandbox, { cwd, trailingSpace: false });
    if (!res) return null;
    return buildResult(value, [at + 1, cursor], res);
  }

  return null;
}

/** Complete arguments to built-in slash commands. */
function completeSlashArgs(value, cursor, session, { cwd } = {}) {
  const before = value.slice(0, cursor);
  const firstSpace = before.search(/\s/);
  if (firstSpace === -1) return null;

  const cmd = before.slice(0, firstSpace).toLowerCase();
  const tail = before.slice(firstSpace);
  const tokenMatch = tail.match(/(\S*)$/);
  const partial = tokenMatch ? tokenMatch[1] : '';
  const tokenStart = cursor - partial.length;
  const priorWords = tail
    .slice(0, tail.length - partial.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const matchWords = (words) => {
    const hits = words.filter((w) => w.toLowerCase().startsWith(partial.toLowerCase()));
    if (!hits.length) return null;
    return buildWordResult(value, [tokenStart, cursor], hits);
  };

  switch (cmd) {
    case '/model': {
      const modelIds = Object.values(MODELS)
        .flat()
        .map((m) => m.id);
      const candidates = [...new Set([...PROVIDERS, ...modelIds, '--save'])];
      return matchWords(candidates);
    }

    case '/keys':
    case '/providers': {
      if (priorWords.length === 0) {
        return matchWords([...PROVIDERS, '--save', '--clear']);
      }
      return matchWords(['--save', '--clear', '--no-verify']);
    }

    case '/env':
    case '/profile': {
      let blocks = [];
      try {
        if (session?.cfg) blocks = profileState(session.cfg).blocks.map((b) => b.name);
      } catch {
        /* ignore missing/unreadable .env */
      }
      return matchWords([...blocks, '--off', '--list']);
    }

    case '/prompts': {
      const promptKeys = PROMPT_SPECS.map((s) => s.key);
      if (priorWords.length === 0) {
        return matchWords(['export', 'diff', 'accept', 'reset']);
      }
      const sub = priorWords[0];
      if (sub === 'export') return matchWords(['--force']);
      if (sub === 'accept') return matchWords([...promptKeys, 'all']);
      if (sub === 'diff' || sub === 'reset') return matchWords(promptKeys);
      return null;
    }

    case '/yolo':
      return matchWords(['on', 'off']);

    case '/image': {
      const pathRes = completePathCandidates(partial, session?.sandbox, { cwd, trailingSpace: true });
      const clipMatches = 'clipboard'.startsWith(partial.toLowerCase())
        ? [{ label: 'clipboard', insert: 'clipboard ' }]
        : [];
      const combined = [...clipMatches, ...(pathRes?.items || [])];
      if (!combined.length) return null;
      return buildResult(value, [tokenStart, cursor], { items: combined });
    }

    case '/video': {
      const pathRes = completePathCandidates(partial, session?.sandbox, { cwd, trailingSpace: true });
      if (!pathRes) return null;
      return buildResult(value, [tokenStart, cursor], pathRes);
    }

    default:
      return null;
  }
}

/**
 * Complete shell commands, tool subcommands, npm scripts, and filesystem paths.
 *
 * @param {string} value
 * @param {number} cursor
 * @param {{sandbox?: object, cfg?: object}} [session]
 * @param {{cwd?: string}} [opts]
 * @returns {CompletionResult|null}
 */
export function completeShellInput(value, cursor, session = {}, opts = {}) {
  const before = value.slice(0, cursor);
  const seg = parseShellSegment(before);
  const { words, partial, tokenStart, quote } = seg;

  // `--flag=path/to/...` -> complete the value right after `=`.
  if (!quote && partial.startsWith('-') && partial.includes('=')) {
    const eq = partial.indexOf('=');
    const valPart = partial.slice(eq + 1);
    const valStart = tokenStart + eq + 1;
    const res = completePathCandidates(valPart, session?.sandbox, {
      cwd: opts.cwd,
      trailingSpace: true,
      quote: '',
    });
    return res ? buildResult(value, [valStart, cursor], res) : null;
  }

  // Strip wrapper commands (`sudo`, `env FOO=1`, `npx`, `time`) to find the real command.
  let cmdIdx = 0;
  while (cmdIdx < words.length) {
    const w = words[cmdIdx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      cmdIdx++;
      continue;
    }
    if (COMMAND_WRAPPERS.has(w)) {
      cmdIdx++;
      while (cmdIdx < words.length && words[cmdIdx].startsWith('-')) cmdIdx++;
      continue;
    }
    break;
  }

  const inCommandPos = cmdIdx >= words.length;
  const looksLikePath =
    partial.includes('/') ||
    partial.includes('\\') ||
    partial.startsWith('.');

  // 1. Command position: complete executables from $PATH + builtins + local dirs/scripts.
  if (inCommandPos && !looksLikePath) {
    if (!partial) return null; // avoid dumping hundreds of $PATH binaries on an empty line
    const { commands } = getPathCommands();
    const cmdMatches = commands
      .filter((c) => c.toLowerCase().startsWith(partial.toLowerCase()))
      .map((c) => ({ label: c, insert: `${c} ` }));
    const pathRes = completePathCandidates(partial, session?.sandbox, {
      cwd: opts.cwd,
      trailingSpace: true,
      quote,
    });
    const seen = new Set(cmdMatches.map((m) => m.label));
    const merged = [
      ...cmdMatches,
      ...(pathRes?.items || []).filter((it) => !seen.has(it.label)),
    ];
    if (!merged.length) return null;
    return buildResult(value, [tokenStart, cursor], { items: merged });
  }

  const baseCmd = !inCommandPos ? path.basename(words[cmdIdx]).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase() : '';
  const argWords = !inCommandPos ? words.slice(cmdIdx + 1) : [];

  // 2. `npm run <tab>` / `pnpm run <tab>` / `yarn run <tab>` -> scripts from package.json.
  if (
    !looksLikePath &&
    !quote &&
    (baseCmd === 'npm' || baseCmd === 'pnpm' || baseCmd === 'yarn') &&
    ((argWords.length === 1 && argWords[0] === 'run') ||
      (argWords.length === 0 && (baseCmd === 'pnpm' || baseCmd === 'yarn') && partial))
  ) {
    const scripts = readPackageScripts({ sandbox: session?.sandbox, cwd: opts.cwd });
    const scriptHits = scripts.filter((s) => s.toLowerCase().startsWith(partial.toLowerCase()));
    if (argWords[0] === 'run' && scriptHits.length) {
      return buildWordResult(value, [tokenStart, cursor], scriptHits);
    }
  }

  // 3. First subcommand of `git`, `npm`, `pnpm`, `yarn`, `cargo`, `docker`, `vitest`.
  if (!looksLikePath && !quote && argWords.length === 0 && TOOL_SUBCOMMANDS[baseCmd]) {
    const subs = TOOL_SUBCOMMANDS[baseCmd].filter((s) =>
      s.toLowerCase().startsWith(partial.toLowerCase()),
    );
    if (subs.length) {
      return buildWordResult(value, [tokenStart, cursor], subs);
    }
  }

  // 4. Default argument completion: files and directories relative to cwd / sandbox.
  const pathRes = completePathCandidates(partial, session?.sandbox, {
    cwd: opts.cwd,
    trailingSpace: true,
    quote,
  });
  if (!pathRes) return null;
  return buildResult(value, [tokenStart, cursor], pathRes);
}

/**
 * Parse the active pipeline/list segment right before `cursor`.
 * Tracks quotes and backslash escapes so paths with spaces complete cleanly.
 */
function parseShellSegment(before) {
  let segStart = 0;
  let quote = '';
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (quote === "'") {
      if (ch === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < before.length) {
        i++;
        continue;
      }
      if (ch === '"') quote = '';
      continue;
    }
    if (ch === '\\' && i + 1 < before.length) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '(' || ch === '\n') {
      segStart = i + 1;
    }
  }

  const seg = before.slice(segStart);
  const words = [];
  let i = 0;
  let cur = '';
  let curStart = segStart;
  let inTok = false;
  let tokQuote = '';

  while (i < seg.length) {
    const ch = seg[i];
    if (tokQuote) {
      if (ch === '\\' && tokQuote === '"' && i + 1 < seg.length) {
        cur += seg[i + 1];
        i += 2;
        continue;
      }
      if (ch === tokQuote) {
        tokQuote = '';
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inTok) {
        words.push(cur);
        cur = '';
        inTok = false;
      }
      i++;
      curStart = segStart + i;
      continue;
    }
    if (!inTok) {
      inTok = true;
      curStart = segStart + i;
    }
    if (ch === "'" || ch === '"') {
      tokQuote = ch;
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < seg.length) {
      cur += seg[i + 1];
      i += 2;
      continue;
    }
    cur += ch;
    i++;
  }

  if (inTok) {
    return {
      words,
      partial: cur,
      // When inside an open quote (`"src/ui/Ap`), replace right after the opening quote.
      tokenStart: tokQuote ? curStart + 1 : curStart,
      quote: tokQuote,
    };
  }
  return { words, partial: '', tokenStart: before.length, quote: '' };
}

/**
 * List matching filesystem entries in `sandbox` / `cwd`.
 * Directories end with `/` (no space) so another Tab descends into them; files get a
 * trailing space when `trailingSpace` is true.
 */
function completePathCandidates(partial, sandbox, { cwd, trailingSpace = false, quote = '' } = {}) {
  const useBackslash = partial.includes('\\') && !partial.includes('/');
  const normalized = partial.replace(/\\/g, '/');
  const hasSlash = normalized.includes('/');
  const dirPart = hasSlash ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
  const basePart = hasSlash ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized;

  const baseDir = resolveShellBaseDir(sandbox, cwd);
  const targetDir = dirPart ? path.resolve(baseDir, dirPart) : baseDir;

  let dirAbs;
  if (typeof sandbox?.resolveForRead === 'function') {
    try {
      dirAbs = sandbox.resolveForRead(targetDir, { allowIgnored: true });
    } catch {
      return null;
    }
  } else if (sandbox && Object.keys(sandbox).length === 0) {
    return null;
  } else {
    dirAbs = targetDir;
  }

  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return null;
  }

  const showDotfiles = basePart.startsWith('.');
  const isIgnored = typeof sandbox?.isIgnored === 'function'
    ? (abs) => sandbox.isIgnored(abs)
    : () => false;

  const matched = entries
    .filter((e) => (showDotfiles ? true : !e.name.startsWith('.')))
    .filter((e) => e.name.toLowerCase().startsWith(basePart.toLowerCase()))
    .filter((e) => !isIgnored(path.join(dirAbs, e.name)))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  if (!matched.length) return null;

  const sep = useBackslash ? '\\' : '/';
  const rawPrefix = dirPart ? `${useBackslash ? dirPart.replace(/\//g, '\\') : dirPart}${sep}` : '';

  const items = matched.map((e) => {
    const isDir = e.isDirectory();
    const label = e.name + (isDir ? '/' : '');
    let formattedName = e.name;
    if (!quote && trailingSpace && /\s/.test(formattedName)) {
      formattedName = process.platform === 'win32' ? `"${formattedName}"` : formattedName.replace(/ /g, '\\ ');
    }
    const fullPath = rawPrefix + formattedName + (isDir ? sep : '');
    const suffix = isDir ? '' : quote ? `${quote} ` : trailingSpace ? ' ' : '';
    return {
      label,
      insert: fullPath + suffix,
      rawPath: rawPrefix + e.name + (isDir ? sep : ''),
    };
  });

  return { items };
}

function buildWordResult(value, range, words) {
  const items = words.map((w) => ({ label: w, insert: `${w} ` }));
  return buildResult(value, range, { items });
}

function buildResult(value, [start, end], { items }) {
  if (!items.length) return null;
  const head = value.slice(0, start);
  const tail = value.slice(end);
  const current = value.slice(start, end);

  if (items.length === 1) {
    const ins =
      tail.startsWith(' ') && items[0].insert.endsWith(' ')
        ? items[0].insert.slice(0, -1)
        : items[0].insert;
    const next = head + ins;
    return {
      value: next + tail,
      cursor: next.length,
      items,
      replaceRange: [start, end],
    };
  }

  const rawTargets = items.map((it) => it.rawPath ?? it.label);
  const common = longestCommonPrefix(rawTargets);
  const nextToken = common.length > current.length ? common : current;
  const next = head + nextToken;

  return {
    value: next + tail,
    cursor: next.length,
    hint: formatHint(items.map((it) => it.label)),
    items,
    replaceRange: [start, end],
  };
}

function formatHint(labels, max = 12) {
  return labels.slice(0, max).join('  ') + (labels.length > max ? '  …' : '');
}

function longestCommonPrefix(strings) {
  if (!strings.length) return '';
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    while (!s.toLowerCase().startsWith(prefix.toLowerCase())) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return '';
    }
  }
  return prefix;
}