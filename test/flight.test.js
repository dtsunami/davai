import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FlightRecorder, readBreadcrumbs } from '../src/session/flight.js';
import { iterateWithIdleTimeout } from '../src/providers/watchdog.js';
import { wrapError } from '../src/providers/base.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-flight-'));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
});

describe('FlightRecorder', () => {
  it('writes durable phase transitions, redacts secrets, and records elapsed ms', () => {
    let clock = 1_000_000;
    const flight = new FlightRecorder({ dir, now: () => clock });

    flight.mark('llm:await-first-byte', {
      turn: 1,
      apiKey: 'sk-1234567890abcdefghijklmnop',
      model: 'gemini-3-pro',
    });
    clock += 420;
    flight.mark('llm:streaming', { turn: 1, ttftMs: 420 });
    clock += 1800;
    flight.close('exit');

    const rows = readBreadcrumbs(dir);
    expect(rows.length).toBe(3);
    expect(rows[0]).toMatchObject({
      kind: 'phase',
      phase: 'llm:await-first-byte',
      turn: 1,
      apiKey: '<redacted>',
      model: 'gemini-3-pro',
    });
    expect(rows[1]).toMatchObject({
      kind: 'phase',
      phase: 'llm:streaming',
      prev: 'llm:await-first-byte',
      prevMs: 420,
    });
    expect(rows[2]).toMatchObject({
      kind: 'close',
      reason: 'exit',
      lastPhase: 'llm:streaming',
      lastPhaseMs: 1800,
    });
  });

  it('logs event-loop lag and async stall heartbeats, ignoring human-wait phases', () => {
    let clock = 10_000;
    const flight = new FlightRecorder({
      dir,
      checkMs: 2000,
      lagThresholdMs: 1500,
      stallMs: 15_000,
      now: () => clock,
    });

    flight.mark('idle');
    clock += 30_000;
    // Idle phase shouldn't emit a stall heartbeat, though a 28s jump in 1 tick triggers lag.
    flight.tick();

    let rows = readBreadcrumbs(dir);
    expect(rows.some((r) => r.kind === 'event-loop-lag' && r.lagMs === 28_000)).toBe(true);
    expect(rows.some((r) => r.kind === 'stall-heartbeat')).toBe(false);

    flight.mark('llm:await-first-byte', { turn: 2 });
    clock += 2000;
    flight.tick(); // 2s elapsed, healthy
    clock += 14_000;
    flight.tick(); // 16s elapsed -> stall heartbeat!

    rows = readBreadcrumbs(dir);
    const stalls = rows.filter((r) => r.kind === 'stall-heartbeat');
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({
      phase: 'llm:await-first-byte',
      elapsedMs: 16_000,
      idleMs: 16_000,
      turn: 2,
    });

    // Active streaming that calls touch() every few seconds is NOT a stall even past 15s:
    flight.mark('llm:streaming', { turn: 2 });
    for (let i = 0; i < 10; i++) {
      clock += 2000;
      flight.touch();
      flight.tick();
    }
    rows = readBreadcrumbs(dir);
    expect(rows.filter((r) => r.kind === 'stall-heartbeat')).toHaveLength(1);

    // Once chunks stop arriving (no touch()) for >= 15s, stall-heartbeat fires:
    clock += 16_000;
    flight.tick();
    rows = readBreadcrumbs(dir);
    const stallsAfterSilence = rows.filter((r) => r.kind === 'stall-heartbeat');
    expect(stallsAfterSilence).toHaveLength(2);
    expect(stallsAfterSilence[1]).toMatchObject({
      phase: 'llm:streaming',
      elapsedMs: 36_000,
      idleMs: 16_000,
    });

    flight.close('done');
  });

  it('records crash breadcrumbs synchronously', () => {
    const flight = new FlightRecorder({ dir });
    flight.mark('ops:execute', { count: 3 });
    flight.crash('uncaughtException', new Error('kaboom'));
    flight.close('crash');

    const rows = readBreadcrumbs(dir);
    const crash = rows.find((r) => r.kind === 'crash');
    expect(crash).toMatchObject({
      crashType: 'uncaughtException',
      phase: 'ops:execute',
      message: 'kaboom',
      count: 3,
    });
    expect(crash.stack).toContain('kaboom');
  });
});

describe('iterateWithIdleTimeout', () => {
  it('breaks a hung half-open stream with a retryable 408 error', async () => {
    const hungStream = {
      [Symbol.asyncIterator]() {
        let first = true;
        return {
          async next() {
            if (first) {
              first = false;
              return { value: 'hello', done: false };
            }
            return new Promise(() => {}); // hangs forever
          },
        };
      },
    };

    const seen = [];
    let caught = null;
    try {
      for await (const chunk of iterateWithIdleTimeout(hungStream, {
        firstChunkMs: 200,
        idleMs: 40,
      })) {
        seen.push(chunk);
      }
    } catch (err) {
      caught = wrapError(err, 'gemini');
    }

    expect(seen).toEqual(['hello']);
    expect(caught).toBeTruthy();
    expect(caught.status).toBe(408);
    expect(caught.retryable).toBe(true);
    expect(caught.message).toMatch(/stalled with no data/i);
  });

  it('settles immediately on AbortSignal even when the underlying iterator ignores abort', async () => {
    const ctl = new AbortController();
    const uncooperativeStream = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise(() => {}); // never resolves or rejects
          },
        };
      },
    };

    setTimeout(() => ctl.abort(), 25);

    const started = Date.now();
    let caught = null;
    try {
      for await (const _ of iterateWithIdleTimeout(uncooperativeStream, {
        signal: ctl.signal,
        firstChunkMs: 10_000,
      })) {
        // unreachable
      }
    } catch (err) {
      caught = wrapError(err, 'openai');
    }

    expect(Date.now() - started).toBeLessThan(1000);
    expect(caught?.cancelled).toBe(true);
  });

  it('marks undici socket drops ("terminated", ECONNRESET) as retryable in wrapError', () => {
    const terminated = new TypeError('terminated');
    const w1 = wrapError(terminated, 'gemini');
    expect(w1.retryable).toBe(true);

    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const w2 = wrapError(reset, 'openai');
    expect(w2.retryable).toBe(true);
  });
});