import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ThroughputTracker,
  byModel,
  byContextSeries,
  buildContextTrend,
} from '../src/ui/throughput.js';
import { loadPerfHistory, rollup } from '../src/session/perf.js';

function turn(over = {}) {
  return {
    turn: 1,
    model: 'claude-opus-5',
    provider: 'anthropic',
    startedAt: 0,
    firstTokenAt: 500,
    endedAt: 5000,
    buckets: [],
    rawTokens: 450,
    actualTokens: 450,
    scale: 1,
    contextTokens: 12000,
    ttftMs: 500,
    durationMs: 5000,
    ...over,
  };
}

describe('perf rollups', () => {
  it('groups turns by provider/model and skips the one still streaming', () => {
    const rows = byModel([
      turn({ turn: 1 }),
      turn({ turn: 2, actualTokens: 100, durationMs: 2500, ttftMs: 500 }),
      turn({ turn: 3, endedAt: null }), // in flight: no final figures yet
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].turns).toBe(2);
    expect(rows[0].outTokens).toBe(550);
    // 550 tokens over 4.5s + 2.0s of stream
    expect(rows[0].avgTps).toBeCloseTo(550 / 6.5, 5);
    expect(rows[0].peakTps).toBeCloseTo(100, 5);
    expect(rows[0].avgTtftMs).toBe(500);
    expect(rows[0].contextRange).toEqual([12000, 12000]);
  });

  it('keeps models apart and sorts by turn count', () => {
    const rows = byModel([
      turn({ model: 'a', provider: 'p' }),
      turn({ model: 'b', provider: 'p' }),
      turn({ model: 'b', provider: 'p' }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['p/b', 'p/a']);
  });

  it('counts a turn with no usage but scores it no rate', () => {
    const rows = byModel([turn({ actualTokens: null })]);
    expect(rows[0].turns).toBe(1);
    expect(rows[0].avgTps).toBe(0);
    expect(rows[0].peakTps).toBe(0);
  });

  it('pairs billed context with the rate the turn ran at', () => {
    const pts = byContextSeries([
      turn(),
      turn({ contextTokens: null }),
      turn({ endedAt: null }),
    ]);
    expect(pts).toHaveLength(1);
    expect(pts[0].ctx).toBe(12000);
    expect(pts[0].tps).toBeCloseTo(100, 5);
  });
});

describe('tracker carries what the history needs', () => {
  it('records provider, billed context and the harness timing', () => {
    const tracker = new ThroughputTracker({ bucketMs: 1000 });
    const t0 = 5_000_000;
    tracker.startTurn({ turn: 1, model: 'claude-opus-5', provider: 'anthropic', now: t0 });
    tracker.record('text', 'x'.repeat(400), t0 + 300);
    tracker.reconcileUsage({ in: 12345, out: 300 });
    tracker.applyTiming({ ttftMs: 250, durationMs: 4200 });
    tracker.endTurn(t0 + 4200);

    const snap = tracker.snapshot(t0 + 4200);
    expect(snap.provider).toBe('anthropic');
    expect(snap.contextTokens).toBe(12345);
    // The harness's measurement wins over the delta-arrival estimate.
    expect(snap.ttftMs).toBe(250);
    expect(snap.durationMs).toBe(4200);

    const groups = byModel(tracker.turns);
    expect(groups[0].key).toBe('anthropic/claude-opus-5');
    expect(groups[0].avgTps).toBeCloseTo(300 / 3.95, 5);
  });

  it('accumulates session phases including user-typing vs user-idle and per-turn settings', () => {
    const t0 = 1_000_000;
    const tracker = new ThroughputTracker({ startedAt: t0, typingTimeoutMs: 5000 });

    // Idle for 10s after session start.
    expect(tracker.sessionSummary(t0 + 10_000).state).toBe('user-idle');
    expect(tracker.sessionSummary(t0 + 10_000).totals.userIdleMs).toBe(10_000);

    // Keystrokes every 2s between t0+10s and t0+16s -> user-typing.
    tracker.recordKeystroke(t0 + 10_000);
    tracker.recordKeystroke(t0 + 12_000);
    tracker.recordKeystroke(t0 + 14_000);
    const midTyping = tracker.sessionSummary(t0 + 16_000);
    expect(midTyping.state).toBe('user-typing');
    expect(midTyping.totals.userIdleMs).toBe(10_000);
    expect(midTyping.totals.userTypingMs).toBe(6_000);

    // AFK past the 5s window -> transitions to user-idle after t0+19s.
    const afterAfk = tracker.sessionSummary(t0 + 25_000);
    expect(afterAfk.state).toBe('user-idle');
    expect(afterAfk.totals.userTypingMs).toBe(9_000); // 10s..19s
    expect(afterAfk.totals.userIdleMs).toBe(16_000); // 0..10s (10s) + 19s..25s (6s)

    // User types again at 25s and submits at 27s -> model turn with settings, then ops.
    tracker.recordKeystroke(t0 + 25_000);
    tracker.startTurn({
      turn: 1,
      model: 'claude-opus-5',
      provider: 'anthropic',
      effort: 'high',
      maxTokens: 32000,
      contextLimit: 200000,
      now: t0 + 27_000,
    });
    expect(tracker.turns[0]).toMatchObject({
      model: 'claude-opus-5',
      provider: 'anthropic',
      effort: 'high',
      maxTokens: 32000,
      contextLimit: 200000,
    });
    expect(tracker.sessionSummary(t0 + 29_000).state).toBe('model');
    tracker.endTurn(t0 + 30_000);

    tracker.startOps({ ops: 2, now: t0 + 30_000 });
    expect(tracker.sessionSummary(t0 + 31_000).state).toBe('ops');
    tracker.endOps(t0 + 32_000);

    const end = tracker.sessionSummary(t0 + 35_000);
    expect(end.state).toBe('user-idle');
    expect(end.totals).toEqual({
      userIdleMs: 19_000, // 10s + 6s + 3s
      userTypingMs: 11_000, // 9s + 2s
      modelMs: 3_000,
      opsMs: 2_000,
    });
    expect(end.elapsedMs).toBe(35_000);
  });
});

describe('context trend', () => {
  it('bins log-spaced when the range is wide', () => {
    const trend = buildContextTrend([
      { ctx: 1000, tps: 60 },
      { ctx: 1000, tps: 50 },
      { ctx: 100000, tps: 20 },
    ]);
    expect(trend.length).toBeGreaterThan(1);
    expect(trend.reduce((n, b) => n + b.n, 0)).toBe(3);
    expect(trend[0].avgTps).toBeCloseTo(55, 5);
    expect(trend.at(-1).avgTps).toBeCloseTo(20, 5);
    // A bin holding one turn is flagged, not hidden.
    expect(trend.at(-1).sparse).toBe(true);
  });

  it('collapses to one bin when context barely moves', () => {
    const trend = buildContextTrend([
      { ctx: 1000, tps: 50 },
      { ctx: 1050, tps: 40 },
    ]);
    expect(trend).toHaveLength(1);
    expect(trend[0].avgTps).toBeCloseTo(45, 5);
    expect(trend[0].sparse).toBe(true);
  });

  it('ignores points that cannot be placed on the axis', () => {
    expect(buildContextTrend([{ ctx: 0, tps: 50 }])).toEqual([]);
    expect(buildContextTrend([])).toEqual([]);
  });
});

describe('session perf history', () => {
  let home;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-perf-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function writeSession(id, meta, events) {
    const dir = path.join(home, 'sessions', `2026-01-01T00-00-00-000Z-${id}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, ...meta }));
    fs.writeFileSync(
      path.join(dir, 'transcript.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    return dir;
  }

  it('reads ttft, duration and usage back off the transcript', () => {
    writeSession(
      'aaa',
      { provider: 'anthropic', model: 'claude-opus-5', startedAt: '2026-01-01T00:00:00.000Z' },
      [
        { ts: '2026-01-01T00:00:01.000Z', type: 'user', text: 'hi' },
        {
          ts: '2026-01-01T00:00:02.000Z',
          type: 'assistant',
          text: 'ok',
          usage: { in: 8000, out: 400 },
          ttftMs: 600,
          durationMs: 4600,
        },
      ],
    );

    const rows = loadPerfHistory(home);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('claude-opus-5');
    expect(rows[0].contextTokens).toBe(8000);
    expect(rows[0].tps).toBeCloseTo(100, 5);
  });

  it('keeps a turn logged before timing existed, without inventing a rate', () => {
    writeSession(
      'bbb',
      { provider: 'openai', model: 'gpt-x', startedAt: '2026-01-01T00:00:00.000Z' },
      [{ ts: 'x', type: 'assistant', text: 'old', usage: { in: 900, out: 50 } }],
    );

    const rows = loadPerfHistory(home);
    expect(rows).toHaveLength(1);
    expect(rows[0].ttftMs).toBeNull();
    expect(rows[0].tps).toBeNull();

    const groups = rollup(rows);
    expect(groups[0].turns).toBe(1);
    expect(groups[0].avgTps).toBe(0);
    expect(groups[0].avgTtftMs).toBeNull();
  });

  it('skips the live session directory when asked', () => {
    const dir = writeSession(
      'ccc',
      { provider: 'anthropic', model: 'm', startedAt: '2026-01-01T00:00:00.000Z' },
      [
        {
          ts: 'x',
          type: 'assistant',
          text: 'ok',
          usage: { in: 1, out: 1 },
          ttftMs: 10,
          durationMs: 1010,
        },
      ],
    );
    expect(loadPerfHistory(home, { except: dir })).toEqual([]);
  });
});