/**
 * Editing a .env file as a file, rather than reading it as a blob.
 *
 * config/env.js parses .env into config and never writes one. This writes one back:
 * the key pane and `/keys --save` need to persist a value the operator typed, and the
 * alternative — telling them to quit, open an editor, and relaunch — is the thing that
 * makes "enable a provider" feel like configuring a daemon.
 *
 * Comments, ordering and unrelated lines survive. A .env is hand-written far more often
 * than it is generated, and a writer that reserializes a parsed object silently eats
 * the comment explaining why a value is what it is.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/** Matches an assignment, capturing any `export ` prefix so it can be preserved. */
const ASSIGN = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Characters that need no quoting in a .env. Anything else is JSON-quoted. */
const BARE = /^[A-Za-z0-9_@%+:,./=-]*$/;

export function envFilePath(home) {
  return path.join(home, '.env');
}

/** @returns {Record<string,string>} parsed contents, or {} when there is no file */
export function readEnv(file) {
  try {
    return dotenv.parse(fs.readFileSync(file));
  } catch {
    return {};
  }
}

/**
 * Render one assignment. Exported because config/profiles.js writes assignments into
 * provider blocks and has to quote them exactly as this does, or a value would mean
 * different things depending on which door it came through.
 */
export function formatAssignment(name, value, prefix = '') {
  const str = String(value);
  return `${prefix}${name}=${BARE.test(str) ? str : JSON.stringify(str)}`;
}

/** Split file text into lines, dropping the empty element a trailing newline leaves. */
export function toLines(text) {
  const lines = text.length ? text.split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The inverse of toLines: the file ends with exactly one newline, or is empty. */
export function joinLines(lines) {
  const out = lines.join('\n');
  return out.length ? `${out}\n` : '';
}

/** A .env as raw text. A missing file is empty, not an error. */
export function readEnvText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Write a .env atomically: temp file, then rename, so an interrupted write cannot leave
 * a truncated file holding every key on the machine. Mode 0600 for the same reason.
 */
export function writeEnvText(file, text) {
  const tmp = `${file}.davai-tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  // rename preserves the temp file's mode on create, but not on replace.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // A .env on a filesystem without modes (a mount, a container overlay) is still
    // better written than refused.
  }
}

/**
 * Read-modify-write a .env through a pure text transform. Provider blocks are edited
 * this way: config/profiles.js does text in, text out and never touches the filesystem,
 * so the atomic write and the 0600 live in exactly one place.
 *
 * @param {string} file
 * @param {(text: string) => string} transform
 * @returns {{file: string, changed: boolean, text: string}}
 */
export function editEnvFile(file, transform) {
  const before = readEnvText(file);
  const after = transform(before);
  if (after !== before) writeEnvText(file, after);
  return { file, changed: after !== before, text: after };
}

/**
 * Apply `updates` to `file` in place. A value of `null` removes the variable; any other
 * value sets it. Returns what changed, so a caller can report it without re-reading.
 *
 * A variable assigned more than once keeps only its last assignment, which is the one
 * dotenv would have used anyway — leaving the earlier ones would mean a file whose
 * visible first line is not the value in effect.
 *
 * The write goes to a temp file and is renamed, so an interrupted write cannot leave a
 * truncated .env holding every key on the machine. Mode 0600 for the same reason.
 *
 * @param {string} file
 * @param {Record<string, string|null>} updates
 * @returns {{set: string[], removed: string[], file: string}}
 */
export function setEnvVars(file, updates) {
  const names = Object.keys(updates);
  if (!names.length) return { set: [], removed: [], file };

  const lines = toLines(readEnvText(file));

  /** @type {Map<string, number[]>} every line index assigning each name */
  const seen = new Map();
  lines.forEach((line, i) => {
    const m = ASSIGN.exec(line);
    if (!m || !Object.hasOwn(updates, m[2])) return;
    const at = seen.get(m[2]) || [];
    at.push(i);
    seen.set(m[2], at);
  });

  const drop = new Set();
  const set = [];
  const removed = [];

  for (const name of names) {
    const value = updates[name];
    const at = seen.get(name) || [];
    // Earlier duplicates go regardless; only the effective assignment is rewritten.
    for (const i of at.slice(0, -1)) drop.add(i);
    const last = at.at(-1);

    if (value === null) {
      if (last !== undefined) drop.add(last);
      if (at.length) removed.push(name);
      continue;
    }
    const str = String(value);
    if (last === undefined) {
      lines.push(formatAssignment(name, str));
    } else {
      lines[last] = formatAssignment(name, str, ASSIGN.exec(lines[last])[1]);
    }
    set.push(name);
  }

  writeEnvText(file, joinLines(lines.filter((_, i) => !drop.has(i))));

  return { set, removed, file };
}