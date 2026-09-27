/**
 * Journal + content snapshots. Backs batch rollback (req 8).
 *
 * Per mutating op, in this order:
 *   1. snapshot current bytes to sessions/<id>/snaps/<seq>-<basename>
 *   2. append the journal entry and fsync it
 *   3. write to a temp file in the same directory, fsync, rename over the target
 *
 * Rollback replays entries backwards. Scope is the batch; there is no operator-facing
 * session-wide revert (see PLAN.md Phase 6).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Journal {
  /** @param {{dir: string}} opts  session directory */
  constructor({ dir }) {
    this.dir = dir;
    this.snapDir = path.join(dir, 'snaps');
    this.file = path.join(dir, 'journal.jsonl');
    this.seq = 0;
    fs.mkdirSync(this.snapDir, { recursive: true });
  }

  #append(entry) {
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(entry) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Snapshot a file's current bytes. Returns null when the file does not exist,
   * which is itself meaningful: rollback then deletes whatever got created.
   */
  snapshot(abs) {
    if (!fs.existsSync(abs)) return null;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return null;
    const seq = String(++this.seq).padStart(4, '0');
    const snap = path.join(this.snapDir, `${seq}-${path.basename(abs)}`);
    fs.copyFileSync(abs, snap);
    return snap;
  }

  /**
   * Recursively snapshot a directory subtree, refusing past `maxBytes` rather than
   * filling the session directory.
   */
  snapshotTree(absDir, { maxBytes = 64 * 1024 * 1024 } = {}) {
    let total = 0;
    const files = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile()) {
          total += fs.statSync(p).size;
          if (total > maxBytes) {
            throw new Error(
              `refusing to snapshot ${path.basename(absDir)}: subtree exceeds ` +
                `${Math.round(maxBytes / 1024 / 1024)}MB. Delete it manually if you mean it.`,
            );
          }
          files.push(p);
        }
      }
    };
    walk(absDir);
    const seq = String(++this.seq).padStart(4, '0');
    const root = path.join(this.snapDir, `${seq}-tree-${path.basename(absDir)}`);
    for (const f of files) {
      const dest = path.join(root, path.relative(absDir, f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
    }
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  /** Atomic replace: temp file in the same dir, fsync, rename. */
  static atomicWrite(abs, data) {
    const dir = path.dirname(abs);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.davai-${crypto.randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, abs);
  }

  /**
   * Record an intent and return a handle carrying enough state to undo it.
   * @param {{op: string, path?: string, from?: string, to?: string,
   *          pre?: string|null, preTree?: string|null, existed?: boolean,
   *          copied?: boolean}} entry
   */
  record(entry) {
    const full = { seq: this.seq, ts: new Date().toISOString(), ...entry };
    this.#append(full);
    return full;
  }

  /**
   * Undo a list of entries, newest first. Best-effort: a failure to undo one entry
   * must not prevent undoing the rest, so failures are collected and returned.
   * @returns {string[]} messages for entries that could not be undone
   */
  rollback(entries) {
    const failures = [];
    for (const e of [...entries].reverse()) {
      try {
        undoEntry(e);
      } catch (err) {
        failures.push(`${e.op} ${e.path || e.to || ''}: ${err.message}`);
      }
    }
    return failures;
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function restoreTree(snapRoot, dest) {
  rmrf(dest);
  fs.cpSync(snapRoot, dest, { recursive: true });
}

function undoEntry(e) {
  switch (e.op) {
    case 'write':
    case 'replace':
      if (e.pre) fs.copyFileSync(e.pre, e.path);
      else if (!e.existed) rmrf(e.path); // we created it; remove it
      return;

    case 'delete':
      if (e.preTree) restoreTree(e.preTree, e.path);
      else if (e.pre) {
        fs.mkdirSync(path.dirname(e.path), { recursive: true });
        fs.copyFileSync(e.pre, e.path);
      }
      return;

    case 'move':
      // Undo the rename. If the original op overwrote a file at `to`, put it back.
      if (e.copied) {
        // cross-device: we copied then unlinked, so copy back the same way
        if (fs.existsSync(e.to)) {
          fs.mkdirSync(path.dirname(e.from), { recursive: true });
          fs.cpSync(e.to, e.from, { recursive: true });
          rmrf(e.to);
        }
      } else if (fs.existsSync(e.to)) {
        fs.mkdirSync(path.dirname(e.from), { recursive: true });
        fs.renameSync(e.to, e.from);
      }
      if (e.pre) fs.copyFileSync(e.pre, e.to);
      return;

    default:
      return; // read-type ops have nothing to undo
  }
}
