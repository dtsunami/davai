/**
 * Streamed-output sidecar: sessions/<id>/stream.jsonl.
 *
 * The transcript's `assistant` event is written once a turn completes, so a turn that
 * is killed, crashes, or dies behind a proxy timeout leaves no record of what the model
 * actually produced — session e1e2a95620 lost a Mistral turn mid-reasoning that way, and
 * ed7f36618e burned 16k output tokens on thinking that only survived because the turn
 * happened to finish. This file is written as the deltas arrive, so it is the record
 * that exists *before* the turn is over.
 *
 * Everything the UI sees goes here: both channels, in order, with turn boundaries.
 *
 * Durability: deltas are coalesced into runs (one turn, one channel) and flushed on
 * size, on a timer, at every turn boundary and on process exit. Writes are writeSync on
 * a long-lived fd, so a SIGKILL of the REPL loses at most the current buffer — the data
 * is already in the page cache. fsync is reserved for turn boundaries and close, where
 * it costs nothing next to a model call.
 *
 * One JSON object per line:
 *   {ts, turn, ev:"start", attempt?}
 *   {ts, turn, ch:"thinking"|"text", text}
 *   {ts, turn, ev:"end", status, stop?, error?}
 */
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './log.js';

const FLUSH_BYTES = 8192;
const FLUSH_MS = 500;

export const STREAM_FILE = 'stream.jsonl';

export class StreamLog {
  /** @param {{dir: string, flushBytes?: number, flushMs?: number}} opts */
  constructor({ dir, flushBytes = FLUSH_BYTES, flushMs = FLUSH_MS }) {
    this.file = path.join(dir, STREAM_FILE);
    this.flushBytes = flushBytes;
    this.flushMs = flushMs;
    this.fd = null;
    /** One failed write retires the sidecar; logging must never take down the REPL. */
    this.broken = false;
    this.turn = 0;
    /** Channel of the run currently buffered, or null. */
    this.ch = null;
    this.buf = '';
    this.timer = null;
    this.onExit = () => this.close();
    process.once('exit', this.onExit);
  }

  #handle() {
    if (this.broken) return null;
    if (this.fd == null) {
      try {
        this.fd = fs.openSync(this.file, 'a');
      } catch {
        this.broken = true;
        return null;
      }
    }
    return this.fd;
  }

  #line(obj) {
    const fd = this.#handle();
    if (fd == null) return;
    try {
      fs.writeSync(fd, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');
    } catch {
      this.broken = true;
    }
  }

  #arm() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
    // Never hold the process open for a log flush.
    this.timer.unref?.();
  }

  #disarm() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Open a turn. A provider retry re-opens the same turn number with a higher attempt:
   * both attempts stay on disk, which is the point — the discarded one is usually the
   * interesting one.
   */
  begin(turn, attempt = 0) {
    this.flush();
    this.turn = turn;
    this.#line({ turn, ev: 'start', ...(attempt ? { attempt } : {}) });
  }

  /** @param {'text'|'thinking'} ch @param {string} delta */
  write(ch, delta) {
    if (!delta || this.broken) return;
    if (this.ch && ch !== this.ch) this.flush();
    this.ch = ch;
    this.buf += delta;
    if (this.buf.length >= this.flushBytes) this.flush();
    else this.#arm();
  }

  /** Put the buffered run on disk. Safe to call at any time, including twice. */
  flush() {
    this.#disarm();
    if (!this.buf) return;
    const text = this.buf;
    const ch = this.ch;
    this.buf = '';
    this.ch = null;
    this.#line({ turn: this.turn, ch, text: redact(text) });
  }

  /** @param {{status?: string, stop?: string, error?: string}} [info] */
  end(info = {}) {
    this.flush();
    this.#line({ turn: this.turn, ev: 'end', status: 'ok', ...info });
    this.sync();
  }

  sync() {
    if (this.fd == null || this.broken) return;
    try {
      fs.fsyncSync(this.fd);
    } catch {
      /* best effort */
    }
  }

  close() {
    this.flush();
    this.#disarm();
    try {
      process.removeListener('exit', this.onExit);
    } catch {
      /* exiting */
    }
    if (this.fd != null) {
      this.sync();
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already gone */
      }
      this.fd = null;
    }
  }
}

/**
 * @typedef {object} StreamTurn
 * @property {number} turn
 * @property {string} thinking
 * @property {string} text
 * @property {'ok'|'error'|'cancelled'|'open'} status  `open` means no end marker: the
 *   process died mid-turn, which is exactly the case this file exists for
 * @property {string|null} stop
 * @property {string} [error]
 * @property {string|null} startedAt
 * @property {string|null} endedAt
 */

/**
 * Reassemble stream.jsonl into one record per turn, oldest first. Tolerates a torn
 * final line, which is normal after a kill.
 * @param {string} dir session directory
 * @returns {StreamTurn[]}
 */
export function readStream(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, STREAM_FILE), 'utf8');
  } catch {
    return [];
  }

  /** @type {Map<number, StreamTurn>} */
  const turns = new Map();
  const get = (n) => {
    let t = turns.get(n);
    if (!t) {
      t = {
        turn: n,
        thinking: '',
        text: '',
        status: 'open',
        stop: null,
        startedAt: null,
        endedAt: null,
      };
      turns.set(n, t);
    }
    return t;
  };

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const t = get(typeof ev.turn === 'number' ? ev.turn : 0);
    if (ev.ev === 'start') {
      if (!t.startedAt) t.startedAt = ev.ts;
      if (ev.attempt) t.attempts = ev.attempt + 1;
    } else if (ev.ev === 'end') {
      t.endedAt = ev.ts;
      t.status = ev.status || 'ok';
      t.stop = ev.stop || null;
      if (ev.error) t.error = ev.error;
    } else if (ev.ch === 'text' || ev.ch === 'thinking') {
      t[ev.ch] += ev.text || '';
    }
  }

  return [...turns.values()].sort((a, b) => a.turn - b.turn);
}