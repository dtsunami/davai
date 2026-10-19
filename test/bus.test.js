import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionBus } from '../src/session/bus.js';

/** Stand-in for the Agent: the bus only needs `on`/`off` and a stats object. */
class FakeAgent extends EventEmitter {
  constructor() {
    super();
    this.stats = { turns: 0, ops: 0, cost: 0 };
  }
}

let agent;
let bus;

beforeEach(() => {
  agent = new FakeAgent();
  bus = new SessionBus({ agent });
});

describe('forwarding and sequencing', () => {
  it('assigns a monotonic seq to every event', () => {
    agent.emit('text', 'a');
    agent.emit('text', 'b');
    const { events } = bus.since(0);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events.map((e) => e.data)).toEqual(['a', 'b']);
  });

  it('replays only what a client has not seen', () => {
    agent.emit('text', 'a');
    agent.emit('text', 'b');
    agent.emit('text', 'c');
    const { events, gap } = bus.since(2);
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('c');
    expect(gap).toBe(false);
  });

  it('reports a gap when the ring has already dropped what was asked for', () => {
    const small = new SessionBus({ agent: new FakeAgent(), limit: 3 });
    for (let i = 0; i < 10; i++) small.publish('text', String(i));
    // Asking for everything since #1 cannot be served: #1..#6 are gone.
    expect(small.since(1).gap).toBe(true);
    // Asking from the live edge is fine.
    expect(small.since(9).gap).toBe(false);
  });

  it('notifies live subscribers as events arrive', () => {
    const seen = [];
    bus.on('event', (e) => seen.push(e.type));
    agent.emit('turn-start');
    agent.emit('text', 'hi');
    agent.emit('done', {});
    expect(seen).toEqual(['turn-start', 'text', 'done']);
  });

  it('stops forwarding after detach', () => {
    bus.detach();
    agent.emit('text', 'a');
    expect(bus.since(0).events).toHaveLength(0);
  });
});

describe('state projection', () => {
  it('accumulates the running turn so a late client sees it', () => {
    agent.emit('turn-start');
    agent.emit('thinking', 'weighing options');
    expect(bus.state.thinking).toBe('weighing options');

    agent.emit('text', 'Here');
    agent.emit('text', ' we go');
    // The answer has started, so the working notes are dropped — as in the TUI.
    expect(bus.state.thinking).toBe('');
    expect(bus.state.live).toBe('Here we go');
    expect(bus.state.busy).toBe(true);
  });

  it('clears the turn on every terminal event', () => {
    for (const ending of ['done', 'cancelled', 'error', 'turn-end']) {
      agent.emit('turn-start');
      agent.emit('text', 'partial');
      agent.emit(ending, { message: 'x', text: 'y' });
      expect(bus.state.busy, ending).toBe(false);
      expect(bus.state.live, ending).toBe('');
    }
  });

  it('tracks op status', () => {
    agent.emit('ops-parsed', [{ op: 'read' }, { op: 'write' }]);
    expect(bus.state.status).toBe('running 2 ops');
    agent.emit('ops-result', { outcome: { status: 'ok' }, ops: [] });
    expect(bus.state.status).toBe(null);
  });
});

describe('approvals', () => {
  it('replaces respond with a broker and publishes plain data', () => {
    let answered = null;
    agent.emit('approval-request', {
      op: { op: 'shell', cmd: 'ls' },
      index: 0,
      respond: (d) => { answered = d; },
    });

    const ev = bus.since(0).events.find((e) => e.type === 'approval-request');
    expect(ev.data).toMatchObject({ id: 'ap1', op: { cmd: 'ls' } });
    // The callback must not cross the wire.
    expect(ev.data.respond).toBeUndefined();

    expect(bus.resolveApproval('ap1', { allow: true })).toBe(true);
    expect(answered).toEqual({ allow: true });
  });

  it('is idempotent: the second answer is refused, not double-applied', () => {
    let calls = 0;
    agent.emit('approval-request', { op: { cmd: 'rm -rf /' }, respond: () => { calls++; } });

    expect(bus.resolveApproval('ap1', { allow: false })).toBe(true);
    // A stale click from another tab, or the REPL answering after the browser did.
    expect(bus.resolveApproval('ap1', { allow: true })).toBe(false);
    expect(calls).toBe(1);
  });

  it('lets the TUI answer through the same broker', () => {
    let answered = null;
    const req = { op: { cmd: 'ls' }, respond: (d) => { answered = d; } };
    agent.emit('approval-request', req);

    // App.jsx holds the same object and calls req.respond; the bus swapped it for the
    // wrapper, so the browser's copy is retired too.
    req.respond({ allow: true });
    expect(answered).toEqual({ allow: true });
    expect(bus.resolveApproval('ap1', { allow: false })).toBe(false);
    expect(bus.snapshot().pending).toHaveLength(0);
  });

  it('stamps the id onto the request so the TUI can match a remote answer', () => {
    // App.jsx holds the raw request object, not the published payload. Without an id on
    // it there is no way to tell whether an `approval-resolved` refers to the pane
    // currently on screen — and that pane is modal, so a browser approval left the
    // terminal frozen on an answered question with its input swallowed.
    const req = { op: { cmd: 'ls' }, respond: () => {} };
    agent.emit('approval-request', req);
    const ev = bus.since(0).events.find((e) => e.type === 'approval-request');
    expect(req.id).toBe(ev.data.id);
  });

  it('announces the decision so another view can clear its pane', () => {
    agent.emit('approval-request', { op: { cmd: 'ls' }, respond: () => {} });
    bus.resolveApproval('ap1', { allow: true });
    const ev = bus.since(0).events.find((e) => e.type === 'approval-resolved');
    expect(ev.data).toMatchObject({ id: 'ap1', decision: { allow: true } });
  });

  it('carries a sudo flag and a secret', () => {
    let answered = null;
    agent.emit('approval-request', { op: { cmd: 'sudo apt update' }, sudo: true, respond: (d) => { answered = d; } });
    expect(bus.snapshot().pending[0].sudo).toBe(true);
    bus.resolveApproval('ap1', { allow: true, secret: 'hunter2' });
    expect(answered).toEqual({ allow: true, secret: 'hunter2' });
  });
});

describe('snapshot', () => {
  it('gives a joining client the seq, state and open approvals', () => {
    agent.emit('turn-start');
    agent.emit('text', 'partial answer');
    agent.emit('approval-request', { op: { cmd: 'ls' }, respond: () => {} });

    const snap = bus.snapshot();
    expect(snap.seq).toBe(3);
    expect(snap.state.live).toBe('partial answer');
    expect(snap.state.busy).toBe(true);
    expect(snap.pending).toHaveLength(1);
  });
});