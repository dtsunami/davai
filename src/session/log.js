/**
 * Session logging (req 6). $DAVAI_HOME/sessions/<iso-ts>-<id>/
 *
 *   meta.json         provider, model, cwd, argv, start/end, token and cost totals
 *   transcript.jsonl  one object per event
 *   journal.jsonl     the undo log (written by Journal)
 *   snaps/            pre-change file snapshots
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Anything that looks like a credential is redacted on the way in. */
const SECRET = /\b(sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g;

export function redact(value) {
  if (typeof value === 'string') return value.replace(SECRET, '<redacted>');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /key|token|secret|password/i.test(k) && typeof v === 'string' ? '<redacted>' : redact(v);
    }
    return out;
  }
  return value;
}

export class SessionLog {
  /** @param {{home: string, cfg: object, id?: string, resumedFrom?: string}} opts */
  constructor({ home, cfg, id, resumedFrom }) {
    this.id = id || crypto.randomBytes(5).toString('hex');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.dir = path.join(home, 'sessions', `${stamp}-${this.id}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.transcriptFile = path.join(this.dir, 'transcript.jsonl');
    this.startedAt = Date.now();
    this.totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ops: 0 };

    this.meta = {
      id: this.id,
      startedAt: new Date().toISOString(),
      cwd: cfg.cwd,
      provider: cfg.provider,
      model: cfg.model.id,
      effort: cfg.effort,
      roDirs: cfg.roDirs,
      argv: process.argv.slice(2),
      ...(resumedFrom ? { resumedFrom } : {}),
    };
    this.#writeMeta();
  }

  #writeMeta() {
    fs.writeFileSync(
      path.join(this.dir, 'meta.json'),
      JSON.stringify(redact({ ...this.meta, totals: this.totals }), null, 2) + '\n',
    );
  }

  /** @param {string} type @param {object} data */
  event(type, data = {}) {
    const line = JSON.stringify(redact({ ts: new Date().toISOString(), type, ...data }));
    try {
      fs.appendFileSync(this.transcriptFile, line + '\n');
    } catch {
      /* logging must never take down the REPL */
    }
  }

  addUsage(usage, cost, estimated = false) {
    this.totals.in += usage.in || 0;
    this.totals.out += usage.out || 0;
    this.totals.cacheRead += usage.cacheRead || 0;
    this.totals.cacheWrite += usage.cacheWrite || 0;
    // costUnknown stays for sessions logged before FALLBACK_PRICE existed.
    if (cost == null) this.totals.costUnknown = true;
    else this.totals.cost += cost;
    if (estimated) this.totals.costEstimated = true;
    this.totals.turns++;
  }

  addOps(n) {
    this.totals.ops += n;
  }

  close(reason = 'exit') {
    this.meta.endedAt = new Date().toISOString();
    this.meta.durationMs = Date.now() - this.startedAt;
    this.meta.closeReason = reason;
    this.#writeMeta();
    this.event('session-end', { reason, totals: this.totals });
  }
}

/** List sessions, newest first. */
export function listSessions(home, limit = 25) {
  const root = path.join(home, 'sessions');
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, name, 'meta.json'), 'utf8'));
      out.push({ ...meta, dir: path.join(root, name) });
    } catch {
      /* partial session dir */
    }
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit);
}

/** Read a session's transcript events back. */
export function readTranscript(dir) {
  try {
    return fs
      .readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Delete sessions older than `days` or beyond `keep` count. `except` is a session
 * directory to spare — startup prunes and `--resume` both run at startup, and pruning
 * the session being resumed would empty its transcript out from under the replay.
 */
export function pruneSessions(home, { days = 30, keep = 100, except } = {}) {
  const root = path.join(home, 'sessions');
  let entries;
  try {
    entries = fs.readdirSync(root).sort();
  } catch {
    return 0;
  }
  const cutoff = Date.now() - days * 86400_000;
  let removed = 0;
  const excess = Math.max(0, entries.length - keep);
  entries.forEach((name, i) => {
    const dir = path.join(root, name);
    if (except && path.resolve(dir) === path.resolve(except)) return;
    let old;
    try {
      old = fs.statSync(dir).mtimeMs < cutoff;
    } catch {
      return;
    }
    if (old || i < excess) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {
        /* in use */
      }
    }
  });
  return removed;
}
