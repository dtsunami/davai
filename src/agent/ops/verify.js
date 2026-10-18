/**
 * Post-apply structural check on a file a mutating op just produced.
 *
 * `replace` is already guarded by the exactly-once rule and `write` by `overwrite`, but
 * neither knows whether what landed on disk is still a file a human would recognise. A
 * model can pair a correct-looking `old` span with a `new` that closes a block the file
 * had left open, or clear half a file it meant to edit.
 *
 * Only two rules are enforced, and the restraint is the design. Both are signals that
 * cannot arise from a legitimate edit, so a trip is always real corruption:
 *
 *   1. a git conflict marker in a file that did not already contain one
 *   2. NUL bytes in the result
 *
 * Deliberately *not* checked, after trying each and finding it cried wolf on ordinary work:
 *
 *   - brace/paren balance deltas. Every legitimate edit that opens or closes a block
 *     changes the balance, and this check cannot distinguish that from the edit that only
 *     looks like it does.
 *   - a large drop in line count, as a stand-in for a truncated `write`. Clearing a
 *     generated file really is a three-line overwrite of a five-hundred-line one.
 *   - a bare `=======`. It is a valid setext heading underline and appears in comment
 *     banners, so it flags healthy markdown and rst.
 *
 * A false positive here is expensive in a way the checks above are not: it rolls back the
 * whole batch and tells the model that its correct edit was wrong. Two airtight rules beat
 * five that need a judgement call.
 */
import fs from 'node:fs';

/** Seven angles then a space or end of line — the long git form, which prose does not use. */
const CONFLICT = /^(?:<{7}|>{7})(?:[ \t]|$)/m;

/**
 * @param {string} abs  the file the op just wrote
 * @param {{created?: boolean}} [opts] `created` means the op made the file, so a conflict
 *   marker in it is content the model chose to write (a doc quoting a diff) rather than
 *   damage to a file that was previously clean. Skip the check in that case.
 * @returns {string|null} a reason if the result is corrupt, else null
 */
export function verifyWritten(abs, { created = false } = {}) {
  let content;
  try {
    content = fs.readFileSync(abs);
  } catch {
    return null; // unreadable tells this check nothing; the op's own error handling owns it
  }

  if (content.includes(0)) {
    return 'the result contains NUL bytes, so it is no longer a text file';
  }

  if (!created) {
    const m = CONFLICT.exec(content.toString('utf8'));
    if (m) return `the result contains a git conflict marker (${JSON.stringify(m[0])})`;
  }

  return null;
}