import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSession, replaySegments, restoreLedger } from '../src/session/resume.js';
import { pruneSessions } from '../src/session/log.js';
import { Ledger } from '../src/context/ledger.js';

let home;

/** Write a fake session directory the way SessionLog would. */
function writeSession(id, { startedAt, events = [], cwd = '/proj', model = 'test-model', calibrator } = {}) {
  const dir = path.join(home, 'sessions', `${startedAt.replace(/[:.]/g, '-')}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      id,
      startedAt,
      cwd,
      model,
      ...(calibrator ? { calibrator } : {}),
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'transcript.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  return dir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-resume-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('findSession', () => {
  beforeEach(() => {
    writeSession('aaaa111111', { startedAt: '2026-09-01T10:00:00.000Z' });
    writeSession('bbbb222222', { startedAt: '2026-09-02T10:00:00.000Z' });
    writeSession('bbbb333333', { startedAt: '2026-09-03T10:00:00.000Z' });
  });

  it('returns the most recent session with no id', () => {
    expect(findSession(home).id).toBe('bbbb333333');
  });

  it('matches a full id', () => {
    expect(findSession(home, 'aaaa111111').id).toBe('aaaa111111');
  });

  it('matches a unique prefix', () => {
    expect(findSession(home, 'aaaa').id).toBe('aaaa111111');
  });

  it('rejects an ambiguous prefix', () => {
    expect(() => findSession(home, 'bbbb')).toThrow(/ambiguous/);
  });

  it('returns null for an unknown id', () => {
    expect(findSession(home, 'zzzz')).toBeNull();
  });

  it('returns null when there are no sessions', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-empty-'));
    expect(findSession(empty)).toBeNull();
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

describe('replaySegments', () => {
  it('maps transcript events onto ledger segment types, in order', () => {
    const dir = writeSession('cccc444444', {
      startedAt: '2026-09-04T10:00:00.000Z',
      events: [
        { type: 'user', text: 'fix slugify' },
        { type: 'assistant', text: 'on it\n```da_ops\n[]\n```' },
        { type: 'ops-result', status: 'ok', label: '2 ops ok', text: 'wrote slug.js' },
        { type: 'operator-shell', cmd: 'git status', exitCode: 0 },
        { type: 'usage', in: 10 },
        { type: 'session-end', reason: 'exit' },
      ],
    });

    const specs = replaySegments(dir);
    expect(specs.map((s) => s.type)).toEqual(['user', 'assistant', 'op-result', 'shell']);
    expect(specs[1].role).toBe('assistant');
    expect(specs[1].text).toContain('da_ops');
    expect(specs[2].text).toBe('wrote slug.js');
    expect(specs[3].text).toContain('git status');
  });

  it('restores assistant thinking from transcript events', () => {
    const dir = writeSession('cccc444445', {
      startedAt: '2026-09-04T11:00:00.000Z',
      events: [
        { type: 'user', text: 'ping' },
        { type: 'assistant', text: 'pong', thinking: 'let me reply pong' },
      ],
    });
    const specs = replaySegments(dir);
    expect(specs[1].thinking).toBe('let me reply pong');
  });

  it('synthesizes op-result text for transcripts written before it was logged', () => {
    const dir = writeSession('dddd555555', {
      startedAt: '2026-09-05T10:00:00.000Z',
      events: [
        {
          type: 'ops-result',
          status: 'partial',
          results: [{ index: 0, op: 'write', ok: true }],
          errors: [{ index: 1, op: 'shell', message: 'exit 1' }],
        },
      ],
    });

    const [seg] = replaySegments(dir);
    expect(seg.label).toBe('batch partial');
    expect(seg.text).toContain('[0] write: ok');
    expect(seg.text).toContain('! [1] shell: exit 1');
  });

  it('synthesizes an interrupted op-result when a session died mid-batch with no ops-result', () => {
    const dir = writeSession('dddd666666', {
      startedAt: '2026-09-05T11:00:00.000Z',
      events: [
        { type: 'user', text: 'fix and run pytest' },
        { type: 'assistant', text: '```da_ops\n{"ops":[...]}\n```' },
        {
          type: 'ops',
          ops: [
            { op: 'replace', path: 'src/http.py' },
            { op: 'shell', cmd: 'pytest -v' },
          ],
        },
      ],
    });

    const specs = replaySegments(dir);
    expect(specs.map((s) => s.type)).toEqual(['user', 'assistant', 'op-result']);
    expect(specs[2].label).toBe('batch interrupted');
    expect(specs[2].text).toContain('replace: src/http.py');
    expect(specs[2].text).toContain('shell: pytest -v');
    expect(specs[2].text).toMatch(/read files to verify/i);
  });

  it('is empty for a session with no transcript', () => {
    const dir = path.join(home, 'sessions', 'nothing-here');
    fs.mkdirSync(dir, { recursive: true });
    expect(replaySegments(dir)).toEqual([]);
  });
});

describe('restoreLedger', () => {
  const ledgerFor = (limit) => {
    const l = new Ledger({ limit, compactAt: 0.75 });
    l.setSystem('system prompt');
    return l;
  };

  it('replays a conversation into the ledger', () => {
    const dir = writeSession('eeee666666', {
      startedAt: '2026-09-06T10:00:00.000Z',
      events: [
        { type: 'user', text: 'first' },
        { type: 'assistant', text: 'reply' },
        { type: 'user', text: 'second' },
        { type: 'assistant', text: 'reply two' },
      ],
    });

    const ledger = ledgerFor(100_000);
    const info = restoreLedger(ledger, { id: 'eeee666666', dir });

    expect(info.turns).toBe(2);
    expect(info.segments).toBe(4);
    expect(info.omitted).toBe(0);
    expect(ledger.segments.map((s) => s.part.text)).toEqual([
      'first',
      'reply',
      'second',
      'reply two',
    ]);
    // The rebuilt conversation must still render as alternating provider messages.
    expect(ledger.toMessages().map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('refuses to replay a session that is no longer on disk', () => {
    const dir = path.join(home, 'sessions', 'gone');
    expect(() => restoreLedger(ledgerFor(100_000), { id: 'gone', dir })).toThrow(
      /no longer on disk/,
    );
  });

  it('survives a startup prune of the session it is resuming', () => {
    const dir = writeSession('9999888877', {
      startedAt: '2026-08-01T10:00:00.000Z',
      events: [{ type: 'user', text: 'old but wanted' }],
    });
    // Old enough that an unguarded prune would delete it.
    const ancient = new Date(Date.now() - 90 * 86400_000);
    fs.utimesSync(dir, ancient, ancient);

    pruneSessions(home, { except: dir });
    expect(fs.existsSync(dir)).toBe(true);

    const ledger = ledgerFor(100_000);
    expect(restoreLedger(ledger, { id: '9999888877', dir }).segments).toBe(1);

    // ...and is still prunable when it is not the one being resumed.
    pruneSessions(home);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('drops op-results first when the replay exceeds its budget', () => {
    const big = 'x'.repeat(4500);
    const dir = writeSession('ffff777777', {
      startedAt: '2026-09-07T10:00:00.000Z',
      events: [
        { type: 'user', text: 'a' },
        { type: 'ops-result', status: 'ok', label: '1 op ok', text: big },
        { type: 'assistant', text: 'b' },
      ],
    });

    // Budget is half the limit (~1000 tokens): the >1000-token op-result cannot fit.
    const ledger = ledgerFor(2000);
    const info = restoreLedger(ledger, { id: 'ffff777777', dir });

    expect(info.omitted).toBe(1);
    expect(ledger.segments.some((s) => s.type === 'op-result')).toBe(false);
    expect(ledger.segments.some((s) => s.type === 'user' && s.part.text === 'a')).toBe(true);
    // The omission is announced in context rather than silently dropped.
    const summary = ledger.segments.find((s) => s.type === 'summary');
    expect(summary.part.text).toContain('ffff777777');
  });

  it('replays steers, pastes, media attachments, compaction summaries, and /clear', () => {
    const imgPath = path.join(home, 'shot.png');
    fs.writeFileSync(imgPath, Buffer.alloc(256, 9));
    const sandbox = {
      resolveForRead: (p) => {
        const abs = path.resolve(home, p);
        if (!fs.existsSync(abs)) throw new Error('missing');
        return abs;
      },
      rel: (abs) => path.relative(home, abs).replace(/\\/g, '/'),
    };

    const dir = writeSession('aaaa999999', {
      startedAt: '2026-09-08T10:00:00.000Z',
      events: [
        { type: 'user', text: 'discarded before /clear' },
        { type: 'context-clear' },
        { type: 'user', text: 'old q1' },
        { type: 'assistant', text: 'old a1' },
        {
          type: 'compact',
          freed: 500,
          actions: ['summarized 2 turns into #5'],
          summary: {
            label: 'summary of 2 earlier turns',
            text: '[earlier conversation, summarized]\ncondensed q1/a1',
            replacedCount: 2,
          },
        },
        { type: 'paste', label: 'paste#1 (2 lines)', text: '[paste#1]\nl1\nl2' },
        {
          type: 'attachment',
          kind: 'image',
          label: 'image shot.png (1kB)',
          name: 'shot.png',
          path: 'shot.png',
          mediaType: 'image/png',
          bytes: 256,
          tokens: 85,
        },
        {
          type: 'attachment',
          kind: 'youtube',
          label: 'youtube https://youtu.be/dQw4w9WgXcQ',
          uri: 'https://youtu.be/dQw4w9WgXcQ',
          minutes: 4,
          assumed: false,
          tokens: 70_800,
        },
        { type: 'steer', text: 'check [paste#1] and [image: shot.png]' },
        { type: 'assistant', text: 'checked both' },
      ],
    });

    const ledger = ledgerFor(500_000);
    const info = restoreLedger(
      ledger,
      { id: 'aaaa999999', dir, model: 'test-model' },
      { sandbox, model: { id: 'test-model', vision: true, video: true } },
    );

    expect(info.omitted).toBe(0);
    // Everything before `context-clear` is gone; `old q1`/`old a1` were replaced by the pinned summary.
    expect(ledger.segments.map((s) => s.type)).toEqual([
      'summary',
      'paste',
      'paste',
      'paste',
      'user',
      'assistant',
    ]);
    expect(ledger.segments[0].part.text).toContain('condensed q1/a1');
    expect(ledger.segments[1].part.text).toBe('[paste#1]\nl1\nl2');
    expect(ledger.segments[2].part.type).toBe('image');
    expect(ledger.segments[3].part).toMatchObject({
      type: 'video',
      uri: 'https://youtu.be/dQw4w9WgXcQ',
    });
    expect(ledger.segments[4].label).toContain('steer:');
    expect(ledger.segments[4].part.text).toContain('check [paste#1] and [image: shot.png]');
  });

  it('degrades missing or unsupported media attachments to an explanatory text note on resume', () => {
    const dir = writeSession('bbbb888888', {
      startedAt: '2026-09-09T10:00:00.000Z',
      events: [
        {
          type: 'attachment',
          kind: 'image',
          label: 'image gone.png (4kB)',
          name: 'gone.png',
          path: 'gone.png',
          mediaType: 'image/png',
          bytes: 4096,
          tokens: 85,
        },
        { type: 'user', text: 'inspect [image: gone.png]' },
      ],
    });

    const sandbox = {
      resolveForRead: () => {
        throw new Error('ENOENT');
      },
      rel: (p) => p,
    };

    const ledger = ledgerFor(100_000);
    restoreLedger(ledger, { id: 'bbbb888888', dir }, { sandbox, model: { id: 'm', vision: true } });
    expect(ledger.segments[0].part.type).toBe('text');
    expect(ledger.segments[0].part.text).toMatch(/no longer readable/);
  });

  it('persists and restores the TokenCalibrator heuristic across sessions for the same model', () => {
    const dir = writeSession('cal1112223', {
      startedAt: '2026-09-10T10:00:00.000Z',
      model: 'claude-opus-5',
      calibrator: { ratio: 1.35, samples: 4 },
      events: [
        { type: 'user', text: 'hello '.repeat(100) },
        { type: 'assistant', text: 'world '.repeat(100) },
      ],
    });

    const uncalibrated = ledgerFor(100_000);
    restoreLedger(
      uncalibrated,
      { id: 'cal1112223', dir, model: 'claude-opus-5' },
      { model: { id: 'different-model' } },
    );
    expect(uncalibrated.calibrator.samples).toBe(0);
    expect(uncalibrated.calibrator.ratio).toBe(1);

    const calibrated = ledgerFor(100_000);
    const info = restoreLedger(
      calibrated,
      { id: 'cal1112223', dir, model: 'claude-opus-5' },
      { model: { id: 'claude-opus-5' } },
    );
    expect(info.calibrated).toBe(true);
    expect(calibrated.calibrator.samples).toBe(4);
    expect(calibrated.calibrator.ratio).toBeCloseTo(1.35, 3);
    expect(calibrated.tokens).toBeGreaterThan(uncalibrated.tokens);
  });
});
