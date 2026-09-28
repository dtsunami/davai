import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Agent, EVENTS } from '../src/agent/loop.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const matchAll = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

/** Event names the harness emits, read out of the source rather than a list of guesses. */
function emittedInSource() {
  const names = new Set();
  for (const file of ['agent/loop.js']) {
    for (const name of matchAll(read(file), /this\.emit\('([a-z-]+)'/g)) names.add(name);
  }
  return names;
}

/** Event names a front end subscribes to. */
function consumedIn(rel) {
  return new Set(matchAll(read(rel), /agent\.on\('([a-z-]+)'/g));
}

/**
 * Events a front end may legitimately ignore, with the reason. Anything not listed here
 * has to be handled somewhere, or it is the half-wired event bug again.
 */
const HEADLESS_MAY_IGNORE = {
  'turn-start': 'nothing to show: there is no spinner to start',
  'compact-start': 'the paired compact-done line is enough for a log',
  cancelled: 'no operator to cancel a headless run',
  repair: 'the retry is silent; only the final outcome matters to a pipe',
  'steer-queued': 'nothing can be typed mid-run without a TTY',
  steered: 'nothing can be typed mid-run without a TTY',
  done: 'runHeadless awaits agent.run() instead',
};

describe('the event contract', () => {
  const emitted = emittedInSource();
  const app = consumedIn('ui/App.jsx');
  const headless = consumedIn('headless.js');

  it('declares every event it emits', () => {
    const undeclared = [...emitted].filter((n) => !EVENTS.includes(n));
    expect(undeclared, 'emitted but missing from EVENTS').toEqual([]);
  });

  it('emits every event it declares', () => {
    const unused = EVENTS.filter((n) => !emitted.has(n));
    expect(unused, 'in EVENTS but never emitted — dead declaration').toEqual([]);
  });

  it('has a consumer for every event in the TUI', () => {
    // The TUI is the full-fidelity front end: if it ignores an event, the event is
    // invisible to the operator, which is how nudge, thinking and retry all shipped
    // half-wired.
    const orphans = [...emitted].filter((n) => !app.has(n));
    expect(orphans, 'emitted but nothing in App.jsx listens').toEqual([]);
  });

  it('has a consumer or a stated reason for every event in headless mode', () => {
    const orphans = [...emitted].filter((n) => !headless.has(n) && !HEADLESS_MAY_IGNORE[n]);
    expect(orphans, 'emitted but headless neither handles nor excuses it').toEqual([]);
  });

  it('has no listeners for events that are never emitted', () => {
    for (const [label, consumed] of [
      ['App.jsx', app],
      ['headless.js', headless],
    ]) {
      const dead = [...consumed].filter((n) => !emitted.has(n));
      expect(dead, `${label} listens for events nothing emits`).toEqual([]);
    }
  });

  it('keeps the ignore list honest', () => {
    // An excuse for an event that is handled anyway is stale and should be deleted.
    const stale = Object.keys(HEADLESS_MAY_IGNORE).filter((n) => headless.has(n));
    expect(stale, 'excused in HEADLESS_MAY_IGNORE but actually handled').toEqual([]);
  });
});

describe('the runtime counter', () => {
  const makeAgent = () =>
    new Agent({
      cfg: {},
      provider: {},
      makeProvider: () => {},
      ledger: { add: () => {} },
      sandbox: {},
      journal: {},
      artifacts: {},
      log: { event: () => {} },
    });

  it('counts emissions', () => {
    const a = makeAgent();
    a.on('text', () => {});
    a.emit('text', 'x');
    a.emit('text', 'y');
    expect(a.eventCounts.text).toBe(2);
    expect(a.unretiredEvents.text).toBeUndefined();
  });

  it('flags an event that fired with nothing listening', () => {
    const a = makeAgent();
    a.emit('nudge', {});
    expect(a.eventCounts.nudge).toBe(1);
    expect(a.unretiredEvents.nudge).toBe(1);
  });

  it('flags a name that is not in EVENTS', () => {
    const a = makeAgent();
    a.on('typoed-name', () => {});
    a.emit('typoed-name');
    // Listened to, so not unretired — but still not a declared event.
    expect(a.unretiredEvents['typoed-name']).toBeUndefined();
    expect(a.unknownEvents['typoed-name']).toBe(1);
  });

  it('still delivers to listeners', () => {
    const a = makeAgent();
    const seen = [];
    a.on('text', (d) => seen.push(d));
    a.emit('text', 'delivered');
    expect(seen).toEqual(['delivered']);
    expect(a).toBeInstanceOf(EventEmitter);
  });

  it('records a pending emit to the transcript once, not per emission', () => {
    const logged = [];
    const a = makeAgent();
    a.log = { event: (type, data) => logged.push({ type, data }) };
    a.emit('text', 'a');
    a.emit('text', 'b');
    a.emit('text', 'c');

    expect(a.unretiredEvents.text).toBe(3);
    const notes = logged.filter((l) => l.type === 'unretired-emit');
    expect(notes).toHaveLength(1);
    expect(notes[0].data).toEqual({ name: 'text', declared: true });
  });

  it('lists pending events newest-count-first with their declared status', () => {
    const a = makeAgent();
    a.emit('nudge', {});
    a.emit('retry', {});
    a.emit('retry', {});
    a.emit('made-up-name');

    expect(a.pendingEvents()).toEqual([
      { name: 'retry', count: 2, declared: true },
      { name: 'made-up-name', count: 1, declared: false },
      { name: 'nudge', count: 1, declared: true },
    ]);
  });

  it('reports nothing pending when every event was listened to', () => {
    const a = makeAgent();
    a.on('text', () => {});
    a.emit('text', 'x');
    expect(a.pendingEvents()).toEqual([]);
  });

  it('throws on a pending emit under DAVAI_STRICT_EVENTS', () => {
    const a = makeAgent();
    a.strictEvents = true;
    expect(() => a.emit('nudge', {})).toThrow(/no listener/);
    // Only the first one throws; the count keeps rising without re-raising.
    expect(() => a.emit('nudge', {})).not.toThrow();
    expect(a.unretiredEvents.nudge).toBe(2);
  });

  it('does not throw in strict mode when something is listening', () => {
    const a = makeAgent();
    a.strictEvents = true;
    a.on('text', () => {});
    expect(() => a.emit('text', 'x')).not.toThrow();
  });

  it('summarizes declared events that never fired', () => {
    const a = makeAgent();
    a.on('text', () => {});
    a.emit('text', 'x');
    const summary = a.eventSummary();

    expect(summary[0]).toEqual({ name: 'text', emitted: 1, unretired: 0, declared: true });
    const nudge = summary.find((r) => r.name === 'nudge');
    expect(nudge).toEqual({ name: 'nudge', emitted: 0, unretired: 0, declared: true });
    // Every declared event appears, fired or not.
    expect(summary.filter((r) => r.declared)).toHaveLength(EVENTS.length);
  });
});
