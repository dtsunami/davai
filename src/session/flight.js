/**
 * Flight recorder: `sessions/<id>/breadcrumbs.jsonl`.
 *
 * When davai hangs (a stalled HTTP socket with zero tokens arriving, a blocking fs walk
 * across a huge drive, a slow `refineModel` call, or an unawaited promise rejection) or
 * crashes abruptly, `transcript.jsonl` only holds *completed* events and `stream.jsonl`
 * only holds *received* deltas. Neither says what phase the process is parked in right
 * now or whether the Node event loop itself is blocked.
 *
 * This sidecar records two things synchronously to an open file descriptor:
 *   1. Explicit phase transitions (`mark(phase, detail)`) around startup, network
 *      requests, first-byte arrival, stream close, compaction, and batch execution.
 *   2. A lightweight `unref()`'d watchdog timer that logs only when either:
 *      - the Node event loop was blocked past `lagThresholdMs` (sync CPU/fs stall), or
 *      - an active async phase has been parked with no transition past `stallMs`.
 *
 * Quiet sessions write ~5 lines per turn (~500 bytes); healthy idle REPLs write zero.
 */
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './log.js';

export const BREADCRUMB_FILE = 'breadcrumbs.jsonl';

const DEFAULT_CHECK_MS = 2000;
const DEFAULT_LAG_THRESHOLD_MS = 1500;
const DEFAULT_STALL_MS = 15_000;

/** Phases where waiting on a human is expected, not a hang. */
const HUMAN_WAIT_PHASES = new Set(['idle', 'approval-wait', 'closed']);

export class FlightRecorder {
  /**
   * @param {{
   *   dir: string,
   *   checkMs?: number,
   *   lagThresholdMs?: number,
   *   stallMs?: number,
   *   now?: () => number,
   * }} opts
   */
  constructor({
    dir,
    checkMs = DEFAULT_CHECK_MS,
    lagThresholdMs = DEFAULT_LAG_THRESHOLD_MS,
    stallMs = DEFAULT_STALL_MS,
    now = Date.now,
  }) {
    this.file = path.join(dir, BREADCRUMB_FILE);
    this.checkMs = checkMs;
    this.lagThresholdMs = lagThresholdMs;
    this.stallMs = stallMs;
    this.now = now;

    this.fd = null;
    this.broken = false;
    this.closed = false;

    const t = this.now();
    this.phase = 'init';
    this.detail = {};
    this.phaseSince = t;
    this.lastStallReportAt = 0;
    this.lastTickAt = t;

    this.timer = setInterval(() => this.tick(), this.checkMs);
    this.timer.unref?.();

    this.onExit = (code) => {
      if (!this.closed) this.close('process-exit', { exitCode: code });
    };
    process.once('exit', this.onExit);
  }

  #handle() {
    if (this.broken || this.closed) return null;
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

  #write(record) {
    const fd = this.#handle();
    if (fd == null) return;
    try {
      const safe = redact({
        ts: new Date(this.now()).toISOString(),
        pid: process.pid,
        ...record,
      });
      fs.writeSync(fd, JSON.stringify(safe) + '\n');
    } catch {
      this.broken = true;
    }
  }

  /**
   * Record a phase transition. Overwrites `this.phase` so the watchdog measures stalls
   * against the operation currently in flight.
   * @param {string} phase
   * @param {Record<string, any>} [detail]
   */
  mark(phase, detail = {}) {
    if (this.closed) return;
    const t = this.now();
    const prevElapsedMs = t - this.phaseSince;
    const prevPhase = this.phase;
    this.phase = phase;
    this.detail = detail;
    this.phaseSince = t;
    this.lastStallReportAt = 0;
    this.#write({
      kind: 'phase',
      phase,
      ...(prevPhase && prevPhase !== 'init' ? { prev: prevPhase, prevMs: prevElapsedMs } : {}),
      ...detail,
    });
  }

  /**
   * Record a one-off diagnostic event (warning, error, crash) without changing the
   * current phase.
   * @param {string} event
   * @param {Record<string, any>} [detail]
   */
  note(event, detail = {}) {
    if (this.closed) return;
    this.#write({
      kind: 'note',
      event,
      phase: this.phase,
      phaseElapsedMs: this.now() - this.phaseSince,
      ...detail,
    });
  }

  /** Periodic watchdog check for event-loop lag and long silent async stalls. */
  tick() {
    if (this.closed) return;
    const t = this.now();
    const expected = this.lastTickAt + this.checkMs;
    const lagMs = Math.max(0, t - expected);
    this.lastTickAt = t;

    if (lagMs >= this.lagThresholdMs) {
      const mem = process.memoryUsage();
      this.#write({
        kind: 'event-loop-lag',
        lagMs,
        phase: this.phase,
        phaseElapsedMs: t - this.phaseSince,
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
        ...this.detail,
      });
    }

    if (!HUMAN_WAIT_PHASES.has(this.phase)) {
      const elapsed = t - this.phaseSince;
      if (
        elapsed >= this.stallMs &&
        (this.lastStallReportAt === 0 || t - this.lastStallReportAt >= this.stallMs)
      ) {
        this.lastStallReportAt = t;
        const mem = process.memoryUsage();
        this.#write({
          kind: 'stall-heartbeat',
          phase: this.phase,
          elapsedMs: elapsed,
          rssMb: Math.round(mem.rss / 1048576),
          heapMb: Math.round(mem.heapUsed / 1048576),
          ...this.detail,
        });
      }
    }
  }

  /** Record an uncaught exception or unhandled rejection synchronously and fsync. */
  crash(kind, err) {
    const message = err?.message || String(err);
    const stack = err?.stack || null;
    this.#write({
      kind: 'crash',
      crashType: kind,
      phase: this.phase,
      phaseElapsedMs: this.now() - this.phaseSince,
      message,
      ...(stack ? { stack } : {}),
      ...this.detail,
    });
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

  close(reason = 'exit', extra = {}) {
    if (this.closed) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      process.removeListener('exit', this.onExit);
    } catch {
      /* exiting */
    }
    this.#write({
      kind: 'close',
      reason,
      lastPhase: this.phase,
      lastPhaseMs: this.now() - this.phaseSince,
      ...extra,
    });
    this.closed = true;
    if (this.fd != null) {
      this.sync();
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
  }
}

/**
 * Read back a session's breadcrumb trail (`breadcrumbs.jsonl`), tolerating torn lines.
 * @param {string} dir session directory
 * @returns {Array<Record<string, any>>}
 */
export function readBreadcrumbs(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, BREADCRUMB_FILE), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* torn line after a hard kill */
    }
  }
  return out;
}