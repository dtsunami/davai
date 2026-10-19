/**
 * The session event bus: one subscriber to the agent, many consumers.
 *
 * The TUI listens to the agent directly and always has. This sits alongside it rather
 * than in front of it, so a second view (the web sidecar) can attach without the two
 * racing to own the agent's events. It is deliberately Ink-free and import-light: the
 * harness owns it, and a view is a subscriber like any other.
 *
 * Three jobs:
 *
 *   1. Sequence every event. A client that reconnects sends the last id it saw and gets
 *      the gap replayed, which is what makes a flaky phone connection survivable.
 *   2. Project the running state. A client joining mid-turn needs the text so far, not
 *      just the deltas it missed the start of.
 *   3. Broker approvals. `approval-request` carries a `respond` callback, which cannot
 *      cross a socket. The bus swaps in its own wrapper, hands out an id, and lets
 *      whichever view answers first win.
 */
import { EventEmitter } from 'node:events';

/** Events forwarded verbatim. Anything carrying a function is handled specially below. */
const FORWARD = [
  'thinking',
  'text',
  'turn-start',
  'turn-end',
  'ops-parsed',
  'ops-result',
  'artifact',
  'usage',
  'error',
  'warning',
  'done',
  'cancelled',
  'compact-start',
  'compact-done',
  'repair',
  'nudge',
  'retry',
  'steer-queued',
  'steered',
];

export class SessionBus extends EventEmitter {
  /**
   * @param {{agent: object, cfg?: object, limit?: number}} opts
   *   `limit` caps the replay ring. 2000 events is several long turns; past that a
   *   reconnecting client is told to reload rather than handed a partial history.
   */
  constructor({ agent, cfg, limit = 2000 } = {}) {
    super();
    this.agent = agent;
    this.cfg = cfg;
    this.limit = limit;
    this.seq = 0;
    /** @type {Array<{seq: number, t: number, type: string, data: any}>} */
    this.ring = [];
    /** Events dropped off the front of the ring, so `since` can admit it lost some. */
    this.dropped = 0;
    /** @type {Map<string, {id: string, op: object, extra: object, respond: Function}>} */
    this.pending = new Map();
    this.nextApproval = 1;
    /** Projection of the current turn, for a client that joins late. */
    this.state = { busy: false, status: null, live: '', thinking: '', stats: {} };
    this.#attach();
  }

  #attach() {
    this.handlers = {};
    for (const name of FORWARD) {
      const fn = (payload) => this.publish(name, payload);
      // Marked passive: the agent's half-wired-event diagnostic discounts these, so an
      // event that only the bus hears still reports as unretired. The bus is a relay, not
      // a consumer, and it must not make the warning go quiet.
      fn.passive = true;
      this.handlers[name] = fn;
      this.agent.on(name, fn);
    }
    // Carries a callback, so it cannot be forwarded as-is. Not passive: answering an
    // approval is real consumption, and the TUI may legitimately not be attached.
    this.handlers['approval-request'] = (req) => this.#onApproval(req);
    this.agent.on('approval-request', this.handlers['approval-request']);
  }

  /**
   * The agent passes one object to every listener, so replacing `respond` here also
   * redirects the TUI's own call through the wrapper. That is the point: whichever view
   * answers first resolves the request, and the other is told it is gone.
   */
  #onApproval(req) {
    const id = `ap${this.nextApproval++}`;
    const original = req.respond;
    let settled = false;
    const wrapped = (decision) => {
      if (settled) return;
      settled = true;
      this.pending.delete(id);
      this.publish('approval-resolved', { id, decision });
      original(decision);
    };
    req.respond = wrapped;
    // Stamped onto the request itself, not just the published payload. The TUI holds the
    // raw object and has no other way to tell whether the `approval-resolved` it just saw
    // is the request on its screen — without an id it cannot clear a pane a browser
    // answered, and while that pane is up useInput swallows every key.
    req.id = id;
    this.pending.set(id, { id, op: req.op, extra: req, respond: wrapped });
    // `op` is plain data; `respond` is deliberately not in the payload.
    this.publish('approval-request', {
      id,
      op: req.op,
      index: req.index,
      sudo: req.sudo || false,
      operator: req.operator || false,
    });
  }

  /**
   * Answer a pending approval. Returns false if it was already settled — a stale click
   * from a second browser tab, which is not an error.
   * @param {string} id
   * @param {{allow: boolean, secret?: string}} decision
   */
  resolveApproval(id, decision) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.respond(decision);
    return true;
  }

  /** Append to the ring and notify subscribers. */
  publish(type, data) {
    const ev = { seq: ++this.seq, t: Date.now(), type, data };
    this.#project(type, data);
    this.ring.push(ev);
    while (this.ring.length > this.limit) {
      this.ring.shift();
      this.dropped++;
    }
    this.emit('event', ev);
    return ev;
  }

  /** Keep enough state that a client joining mid-turn renders something sensible. */
  #project(type, data) {
    const s = this.state;
    switch (type) {
      case 'turn-start':
        s.busy = true;
        s.status = 'thinking';
        s.live = '';
        s.thinking = '';
        break;
      case 'thinking':
        s.thinking += data;
        break;
      case 'text':
        // The answer has started, so the working notes have served their purpose.
        if (s.thinking) s.thinking = '';
        s.live += data;
        break;
      case 'ops-parsed':
        s.status = `running ${data.length} op${data.length > 1 ? 's' : ''}`;
        break;
      case 'ops-result':
        s.status = null;
        break;
      case 'compact-start':
        s.status = 'compacting context';
        break;
      case 'turn-end':
      case 'done':
      case 'cancelled':
      case 'error':
        s.busy = false;
        s.status = null;
        s.live = '';
        s.thinking = '';
        break;
      default:
        break;
    }
    if (this.agent?.stats) s.stats = { ...this.agent.stats };
  }

  /**
   * Events after `seq`. `gap` is true when the ring had already discarded some of what
   * the client asked for, which means it should reload rather than stitch.
   * @param {number} seq
   */
  since(seq = 0) {
    const first = this.ring.length ? this.ring[0].seq : this.seq + 1;
    return { events: this.ring.filter((e) => e.seq > seq), gap: seq > 0 && seq < first - 1 };
  }

  /** Everything a fresh client needs before it starts streaming. */
  snapshot() {
    return {
      seq: this.seq,
      state: { ...this.state },
      pending: [...this.pending.values()].map((p) => ({
        id: p.id,
        op: p.op,
        sudo: p.extra.sudo || false,
      })),
    };
  }

  detach() {
    for (const [name, fn] of Object.entries(this.handlers || {})) this.agent.off(name, fn);
    this.handlers = {};
    this.removeAllListeners();
  }
}