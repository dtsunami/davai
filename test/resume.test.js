import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSession, replaySegments, restoreLedger } from '../src/session/resume.js';
import { pruneSessions } from '../src/session/log.js';
import { Ledger } from '../src/context/ledger.js';

let home;

/** Write a fake session directory the way SessionLog would. */
function writeSession(id, { startedAt, events = [], cwd = '/proj' }) {
  const dir = path.join(home, 'sessions', `${startedAt.replace(/[:.]/g, '-')}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ id, startedAt, cwd, model: 'test-model' }),
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
    const big = 'x'.repeat(4000);
    const dir = writeSession('ffff777777', {
      startedAt: '2026-09-07T10:00:00.000Z',
      events: [
        { type: 'user', text: 'a' },
        { type: 'ops-result', status: 'ok', label: '1 op ok', text: big },
        { type: 'assistant', text: 'b' },
      ],
    });

    // Budget is half the limit, so ~500 tokens: the 1000-token op-result cannot fit.
    const ledger = ledgerFor(2000);
    const info = restoreLedger(ledger, { id: 'ffff777777', dir });

    expect(info.omitted).toBe(1);
    expect(ledger.segments.some((s) => s.type === 'op-result')).toBe(false);
    expect(ledger.segments.some((s) => s.type === 'user' && s.part.text === 'a')).toBe(true);
    // The omission is announced in context rather than silently dropped.
    const summary = ledger.segments.find((s) => s.type === 'summary');
    expect(summary.part.text).toContain('ffff777777');
  });
});
