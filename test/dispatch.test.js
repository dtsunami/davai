import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createDispatcher } from '../src/session/dispatch.js';

/**
 * The dispatcher is the one path both views drive the session through, so these tests
 * are mostly about the *contract*: an omitted view hook defaults to a no-op, which is
 * convenient and also exactly how `/context` silently did nothing in the browser during
 * development. Anything a view must supply is asserted here.
 */
class FakeAgent extends EventEmitter {
  constructor() {
    super();
    this.stats = { turns: 0, ops: 0, cost: 0 };
    this.ran = [];
    this.steered = [];
    this.steerable = false;
  }
  async run(text) { this.ran.push(text); }
  steer(text) {
    if (!this.steerable) return false;
    this.steered.push(text);
    return true;
  }
}

let session;
let pushed;
let panes;

const makeSession = () => ({
  agent: new FakeAgent(),
  cfg: { model: { id: 'm', vision: false }, cwd: '/tmp' },
  ledger: { add: vi.fn() },
  pastes: { expand: (t) => ({ text: t, referenced: [] }) },
  sandbox: {},
  history: { add: vi.fn() },
});

beforeEach(() => {
  session = makeSession();
  pushed = [];
  panes = [];
});

const build = (extra = {}) =>
  createDispatcher({
    session,
    view: { push: (e) => pushed.push(e), ...extra },
  });

describe('plain messages', () => {
  it('pushes the user line and runs the agent', async () => {
    await build()('do the thing');
    expect(pushed).toEqual([{ type: 'user', text: 'do the thing' }]);
    expect(session.agent.ran).toEqual(['do the thing']);
    expect(session.history.add).toHaveBeenCalledWith('do the thing');
  });

  it('ignores empty input', async () => {
    const submit = build();
    await submit('   ');
    await submit('');
    expect(session.agent.ran).toEqual([]);
  });

  it('signals the view when a run starts, for the spinner', async () => {
    const onRunStart = vi.fn();
    await build({ onRunStart })('go');
    expect(onRunStart).toHaveBeenCalledOnce();
  });
});

describe('steering', () => {
  it('steers instead of queueing when a turn is in flight', async () => {
    session.agent.steerable = true;
    await build({ isBusy: () => true })('actually use grep');
    expect(session.agent.steered).toEqual(['actually use grep']);
    expect(session.agent.ran).toEqual([]);
    expect(pushed).toEqual([{ type: 'user', text: 'actually use grep' }]);
  });

  it('runs commands immediately even mid-turn', async () => {
    session.agent.steerable = true;
    await build({ isBusy: () => true, setPane: (p) => panes.push(p) })('/context');
    // The whole point of /context while it works.
    expect(panes).toEqual(['context']);
    expect(session.agent.steered).toEqual([]);
  });

  it('falls back to a normal run when the agent refuses the steer', async () => {
    session.agent.steerable = false;
    await build({ isBusy: () => true })('too late');
    expect(session.agent.ran).toEqual(['too late']);
  });

  it('reads busy at call time, not when the dispatcher was built', async () => {
    let busy = false;
    session.agent.steerable = true;
    const submit = build({ isBusy: () => busy });
    await submit('first');
    busy = true;
    await submit('second');
    expect(session.agent.ran).toEqual(['first']);
    expect(session.agent.steered).toEqual(['second']);
  });
});

describe('commands', () => {
  it('routes a pane command to the view and never to the model', async () => {
    await build({ setPane: (p) => panes.push(p) })('/context');
    expect(panes).toEqual(['context']);
    expect(session.agent.ran).toEqual([]);
    // Commands are not prompts, so they stay out of /history.
    expect(session.history.add).not.toHaveBeenCalled();
  });

  it('is unchanged by a view that omits setPane, but then the command does nothing', async () => {
    // Documents the sharp edge: hooks default to no-ops, so a view that forgets one gets
    // silence rather than an error. This is how /context did nothing in the browser.
    await build()('/context');
    expect(session.agent.ran).toEqual([]);
    expect(pushed).toEqual([]);
  });
});

describe('images', () => {
  it('warns instead of attaching when the model has no vision', async () => {
    session.sandbox = { resolveForRead: (p) => `/tmp/${p}` };
    await build()('look at @shot.png');
    const warning = pushed.find((p) => p.type === 'warning');
    expect(warning?.message).toMatch(/no vision support/);
    expect(session.ledger.add).not.toHaveBeenCalled();
  });
});

describe('pastes', () => {
  it('adds referenced pastes to context before the prompt', async () => {
    session.pastes = {
      expand: () => ({
        text: 'see above',
        referenced: [{ n: 1, lines: 3, text: 'a\nb\nc' }],
      }),
    };
    await build()('[[paste#1]] see above');
    expect(session.ledger.add).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'paste', label: 'paste#1 (3 lines)' }),
    );
    expect(session.agent.ran).toEqual(['see above']);
  });
});