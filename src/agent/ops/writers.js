/**
 * Mutating ops: write, replace, delete, move. Each returns a journal entry so the
 * executor can roll the batch back.
 *
 * Every one of these runs only after the planner has validated the whole batch, so
 * the preconditions here are assertions, not the primary check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Journal, renameOver } from '../journal.js';

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

/**
 * Apply a single replace hunk (`{old, new, all?, regex?}`) to `content` in memory,
 * returning `{updated, occurrences}` or throwing an actionable error naming `relPath`.
 * Shared by `planner.js` (virtual overlay pre-validation) and `opReplace` (execution).
 */
export function applyReplaceHunk(content, hunk, relPath, label = '') {
  const prefix = label ? `${label}: ` : '';

  if (hunk.regex) {
    let reSingle;
    let reGlobal;
    try {
      reSingle = new RegExp(hunk.old, 'm');
      reGlobal = new RegExp(hunk.old, 'gm');
    } catch (err) {
      throw new Error(`${prefix}invalid regex: ${err.message}`, { cause: err });
    }
    const matches = [...content.matchAll(reGlobal)];
    if (matches.length === 0) {
      throw new Error(`${prefix}regex pattern not found in ${relPath}`);
    }
    if (matches.length > 1 && !hunk.all) {
      throw new Error(
        `${prefix}regex pattern matches ${matches.length} times in ${relPath} — ` +
          `make the pattern more specific, or set "all": true`,
      );
    }
    const usesCRLF = content.includes('\r\n') && !content.replace(/\r\n/g, '').includes('\n');
    const replacement = usesCRLF
      ? String(hunk.new ?? '').replace(/\r?\n/g, '\r\n')
      : String(hunk.new ?? '');
    const updated = hunk.all
      ? content.replace(reGlobal, replacement)
      : content.replace(reSingle, replacement);
    return { updated, occurrences: hunk.all ? matches.length : 1 };
  }

  const { old, new: replacement } = alignOp(content, hunk);
  const count = countOccurrences(content, old);
  if (count === 0) {
    throw new Error(
      `${prefix}"old" text not found in ${relPath}. ` +
        `Read the file and copy the exact text, including indentation.`,
    );
  }
  if (count > 1 && !hunk.all) {
    throw new Error(
      `${prefix}"old" text occurs ${count} times in ${relPath} — ` +
        `include more surrounding context to make it unique, or set "all": true`,
    );
  }

  const updated = hunk.all
    ? content.split(old).join(replacement)
    : // A function replacement, so `$&` and friends in the model's text are literal.
      content.replace(old, () => replacement);
  return { updated, occurrences: hunk.all ? count : 1 };
}

/** Normalize a replace op into an ordered list of hunks. */
export function replaceHunks(op) {
  if (Array.isArray(op.edits)) {
    return op.edits.map((e) => ({
      old: e.old,
      new: e.new,
      all: e.all ?? op.all ?? false,
      regex: e.regex ?? op.regex ?? false,
    }));
  }
  return [{ old: op.old, new: op.new, all: Boolean(op.all), regex: Boolean(op.regex) }];
}

/** Apply all hunks of a replace op sequentially in memory. */
export function simulateReplace(content, op, relPath) {
  const hunks = replaceHunks(op);
  let current = content;
  let totalOccurrences = 0;
  for (let i = 0; i < hunks.length; i++) {
    const label = hunks.length > 1 ? `edits[${i}]` : '';
    const { updated, occurrences } = applyReplaceHunk(current, hunks[i], relPath, label);
    current = updated;
    totalOccurrences += occurrences;
  }
  return { updated: current, occurrences: totalOccurrences, hunks: hunks.length };
}

export function opReplace(op, ctx) {
  const abs = ctx.sandbox.resolveForWrite(op.path);
  const rel = ctx.sandbox.rel(abs);
  const original = fs.readFileSync(abs, 'utf8');
  const { updated, occurrences, hunks } = simulateReplace(original, op, rel);

  const pre = ctx.journal.snapshot(abs);
  const entry = ctx.journal.record({ op: 'replace', path: abs, pre, existed: true });
  Journal.atomicWrite(abs, Buffer.from(updated, 'utf8'));

  return {
    entry,
    result: {
      path: rel,
      action: 'replaced',
      occurrences,
      ...(hunks > 1 ? { hunks } : {}),
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
    // renameOver, not renameSync: a read-only destination blocks the replace on Windows
    // even though the directory is writable, so `move --overwrite` onto one failed with
    // EPERM at apply time. The moved file keeps the *source's* mode either way, which is
    // what a rename means.
    renameOver(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Cross-device: copy then unlink. The journal must record which path was taken
    // or rollback restores the wrong side.
    //
    // Not atomic, and it cannot be: no filesystem offers a cross-device rename. The
    // order is the deliberate part — copy first, remove second — so an interruption
    // leaves the file at both paths rather than neither. A duplicate is recoverable
    // and the journal's `copied` flag still rolls it back; a loss would not be.
    const srcIsFile = fs.statSync(from).isFile();
    fs.cpSync(from, to, { recursive: true });
    if (srcIsFile) fs.chmodSync(to, fs.statSync(from).mode);
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
