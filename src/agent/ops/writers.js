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
  const count = countOccurrences(original, op.old);

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
    ? original.split(op.old).join(op.new)
    : original.replace(op.old, op.new);

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
