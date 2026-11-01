/**
 * Asserting file modes on a platform that has only one of them.
 *
 * Windows exposes a single bit through the POSIX layer: the read-only flag. `chmod 0o755`
 * reads back as `0o666`, `chmod 0o700` reads back as `0o666`, and only `0o444` survives
 * the round trip. So `expect(mode & 0o777).toBe(0o755)` is not a stricter test on Linux
 * and a failing one on Windows — it is a test of libuv's emulation, which is not what
 * mode preservation means.
 *
 * What davai actually promises is narrower and true on both: *whatever the filesystem
 * records for a file, an op that rewrites that file leaves it recording the same thing.*
 * `expectModePreserved` asserts exactly that, by reading the mode back after chmod rather
 * than assuming the requested one took. On Linux the distinctions are real and the
 * executable bit is genuinely checked; on Windows the read-only flag is, which is the
 * only thing there is to check — and is the bit that actually broke, since Windows
 * refuses to rename or copy over a read-only file.
 *
 * The alternative — `describe.skipIf(win32)` — would have left the rename-over-read-only
 * EPERM bug untested on the one platform where it happens.
 */
import { expect } from 'vitest';
import fs from 'node:fs';

export const POSIX_MODES = process.platform !== 'win32';

/** The mode bits as the filesystem reports them. */
export function modeOf(file) {
  return fs.statSync(file).mode & 0o777;
}

/**
 * chmod, then report what actually stuck. Use the return value in assertions, never the
 * value you asked for.
 * @returns {number} the mode the filesystem settled on
 */
export function setMode(file, mode) {
  fs.chmodSync(file, mode);
  return modeOf(file);
}

/**
 * Run `fn`, then assert the file's mode is unchanged from before it ran.
 * @param {string} file
 * @param {number} mode  the mode to put the file in first
 * @param {() => any} fn
 */
export async function expectModePreserved(file, mode, fn) {
  const before = setMode(file, mode);
  const out = await fn();
  expect(modeOf(file)).toBe(before);
  return out;
}

/**
 * A mode that is distinguishable from the default on this platform, so "preserved" is a
 * claim with content rather than a tautology. Read-only is the one such mode everywhere.
 */
export const DISTINCT = 0o444;

/** Leave nothing behind that a temp-dir cleanup cannot remove. */
export function unlock(file) {
  try {
    fs.chmodSync(file, 0o666);
  } catch {
    /* already gone */
  }
}