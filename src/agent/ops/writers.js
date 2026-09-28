/**
 * Mutating ops: write, replace, delete, move. Each returns a journal entry so the
 * executor can roll the batch back.
 *
 * Every one of these runs only after the planner has validated the whole batch, so
 * the preconditions here are assertions, not the primary check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../journal.js';

export function opWrite(op, ctx) {
  const abs = ctx.sandbox.resolveForWrite(op.path);
  const existed = fs.existsSync(abs);
  const pre = ctx.journal.snapshot(abs);
  const entry = ctx.journal.record({ op: 'write', path: abs, pre, existed });

  Journal.atomicWrite(abs, Buffer.from(op.text, 'utf8'));

  return {
    entry,
    result: {
      path: ctx.sandbox.rel(abs),
      action: existed ? 'overwritten' : 'created',
      bytes: Buffer.byteLength(op.text, 'utf8'),
      lines: op.text.split('\n').length,
    },
  };
}

export function opReplace(op, ctx) {
  const abs = ctx.sandbox.resolveForWrite(op.path);
  const original = fs.readFileSync(abs, 'utf8');
  const { old, new: replacement } = alignOp(original, op);
  const count = countOccurrences(original, old);

  // The planner already checked this; re-check because the file may have changed
  // between plan and apply.
  if (count === 0) throw new Error(`"old" text not found in ${ctx.sandbox.rel(abs)}`);
  if (count > 1 && !op.all) {
    throw new Error(
      `"old" text occurs ${count} times in ${ctx.sandbox.rel(abs)} — ` +
        `include more surrounding context to make it unique, or set "all": true`,
    );
  }

  const updated = op.all
    ? original.split(old).join(replacement)
    : // A function replacement, so `$&` and friends in the model's text are literal.
      original.replace(old, () => replacement);

  const pre = ctx.journal.snapshot(abs);
  const entry = ctx.journal.record({ op: 'replace', path: abs, pre, existed: true });
  Journal.atomicWrite(abs, Buffer.from(updated, 'utf8'));

  return {
    entry,
    result: {
      path: ctx.sandbox.rel(abs),
      action: 'replaced',
      occurrences: op.all ? count : 1,
      delta: updated.split('\n').length - original.split('\n').length,
    },
  };
}

export function opDelete(op, ctx) {
  const abs = ctx.sandbox.resolveForWrite(op.path);
  const stat = fs.statSync(abs);

  if (stat.isDirectory()) {
    if (!op.recursive) {
      throw new Error(
        `${ctx.sandbox.rel(abs)} is a directory — set "recursive": true to delete it`,
      );
    }
    const preTree = ctx.journal.snapshotTree(abs);
    const entry = ctx.journal.record({ op: 'delete', path: abs, preTree });
    fs.rmSync(abs, { recursive: true, force: true });
    return {
      entry,
      result: { path: ctx.sandbox.rel(abs), action: 'deleted', type: 'dir' },
    };
  }

  const pre = ctx.journal.snapshot(abs);
  const entry = ctx.journal.record({ op: 'delete', path: abs, pre });
  fs.rmSync(abs, { force: true });
  return {
    entry,
    result: { path: ctx.sandbox.rel(abs), action: 'deleted', type: 'file', bytes: stat.size },
  };
}

export function opMove(op, ctx) {
  const from = ctx.sandbox.resolveForWrite(op.from);
  const to = ctx.sandbox.resolveForWrite(op.to);

  const destExisted = fs.existsSync(to);
  // Snapshot whatever we are about to clobber at the destination.
  const pre = destExisted ? ctx.journal.snapshot(to) : null;

  fs.mkdirSync(path.dirname(to), { recursive: true });

  let copied = false;
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Cross-device: copy then unlink. The journal must record which path was taken
    // or rollback restores the wrong side.
    //
    // Not atomic, and it cannot be: no filesystem offers a cross-device rename. The
    // order is the deliberate part — copy first, remove second — so an interruption
    // leaves the file at both paths rather than neither. A duplicate is recoverable
    // and the journal's `copied` flag still rolls it back; a loss would not be.
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
    copied = true;
  }

  const entry = ctx.journal.record({ op: 'move', from, to, pre, copied });
  return {
    entry,
    result: {
      from: ctx.sandbox.rel(from),
      to: ctx.sandbox.rel(to),
      action: destExisted ? 'moved (overwrote destination)' : 'moved',
      ...(copied ? { note: 'cross-device: copied then removed' } : {}),
    },
  };
}

/**
 * Reconcile a needle's line endings with the file's.
 *
 * A model quoting a multi-line span back from a CRLF file sends "\n" almost every time:
 * the carriage returns were in the read result but they are invisible, and no amount of
 * "copy it byte for byte" in the protocol makes a model reproduce a character it cannot
 * see. Without this, every multi-line `replace` on a Windows-authored file fails with
 * "old text not found" and the model has no way to work out why.
 *
 * Exact match is still tried first, so a file with deliberately mixed endings behaves
 * as before.
 */
export function alignNewlines(haystack, needle) {
  if (!needle || !needle.includes('\n')) return needle;
  if (haystack.includes(needle)) return needle;

  const crlf = needle.replace(/\r?\n/g, '\r\n');
  if (haystack.includes(crlf)) return crlf;

  const lf = needle.replace(/\r\n/g, '\n');
  if (haystack.includes(lf)) return lf;

  return needle; // genuinely absent: let the caller report it
}

/**
 * The op's old/new with endings that match the file. If CRs had to be added to find the
 * text, they are added to the replacement too — otherwise the edit leaves one LF island
 * in an otherwise CRLF file, and the next replace over that region fails again.
 */
function alignOp(haystack, op) {
  const old = alignNewlines(haystack, op.old);
  const addedCrs = old !== op.old && old.includes('\r\n');
  return {
    old,
    new: addedCrs ? String(op.new ?? '').replace(/\r?\n/g, '\r\n') : op.new,
  };
}

export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) return n;
    n++;
    i = at + needle.length;
  }
}
