/**
 * Tab completion: @paths, /commands, and sh subcommands.
 */
import fs from 'node:fs';
import path from 'node:path';

const COMMANDS = [
  '/help',
  '/model',
  '/context',
  '/artifacts',
  '/image',
  '/sessions',
  '/config',
  '/compact',
  '/clear',
  '/yolo',
  '/exit',
];

/**
 * @param {string} value
 * @param {number} cursor
 * @param {{sandbox: object}} session
 * @returns {{value: string, cursor: number, hint?: string}|null}
 */
export function completeInput(value, cursor, session) {
  const before = value.slice(0, cursor);
  const after = value.slice(cursor);

  // --- slash commands, only at the very start ---
  if (/^\/\S*$/.test(before)) {
    const matches = COMMANDS.filter((c) => c.startsWith(before));
    if (!matches.length) return null;
    if (matches.length === 1) {
      const next = matches[0] + ' ';
      return { value: next + after, cursor: next.length };
    }
    const common = longestCommonPrefix(matches);
    return {
      value: common + after,
      cursor: common.length,
      hint: matches.join('  '),
    };
  }

  // --- @path completion ---
  const at = before.lastIndexOf('@');
  if (at !== -1 && !/\s/.test(before.slice(at + 1))) {
    const partial = before.slice(at + 1);
    const result = completePath(partial, session.sandbox);
    if (!result) return null;
    const head = before.slice(0, at + 1);
    const next = head + result.completion;
    return { value: next + after, cursor: next.length, hint: result.hint };
  }

  return null;
}

function completePath(partial, sandbox) {
  const normalized = partial.replace(/\\/g, '/');
  const dirPart = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
  const basePart = normalized.includes('/')
    ? normalized.slice(normalized.lastIndexOf('/') + 1)
    : normalized;

  let dirAbs;
  try {
    dirAbs = sandbox.resolveForRead(dirPart || '.', { allowIgnored: true });
  } catch {
    return null;
  }

  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return null;
  }

  const matches = entries
    .filter((e) => e.name.toLowerCase().startsWith(basePart.toLowerCase()))
    .filter((e) => !sandbox.isIgnored(path.join(dirAbs, e.name)))
    .map((e) => e.name + (e.isDirectory() ? '/' : ''));

  if (!matches.length) return null;

  const prefix = dirPart ? `${dirPart}/` : '';
  if (matches.length === 1) {
    return { completion: prefix + matches[0] };
  }
  const common = longestCommonPrefix(matches);
  return {
    completion: prefix + common,
    hint: matches.slice(0, 12).join('  ') + (matches.length > 12 ? '  …' : ''),
  };
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
