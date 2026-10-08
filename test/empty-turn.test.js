import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/agent/loop.js';
import { Ledger } from '../src/context/ledger.js';
import { Artifacts } from '../src/context/artifacts.js';
import { Sandbox } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';
import { Journal } from '../src/agent/journal.js';
import { resolveModel } from '../src/config/models.js';

let base;

/** Replays canned turns; an empty one ends on `stop` with no text at all. */
function provider(turns, stop = 'max_tokens') {
  const sent = [];
  let calls = 0;
  return {
    sent,
    async *send({ messages }) {
      sent.push(messages);
      const text = turns[calls++] ?? '';
      if (text) yield { t: 'text', delta: text };
      yield { t: 'usage', in: 10, out: 10, cacheRead: 0, cacheWrite: 0 };
      yield { t: 'stop', reason: text ? 'end_turn' : stop };
    },
  };
}

/** A model that spends the whole budget thinking and writes nothing — Mistral's habit. */
function thinkingProvider(chars, turns = []) {
  const sent = [];
  let calls = 0;
  return {
    sent,
    async *send({ messages }) {
      sent.push(messages);
      const text = turns[calls++] ?? '';
      if (!text) yield { t: 'thinking', delta: 'x'.repeat(chars) };
      if (text) yield { t: 'text', delta: text };
      yield { t: 'usage', in: 10, out: 10, cacheRead: 0, cacheWrite: 0 };
      yield { t: 'stop', reason: text ? 'end_turn' : 'max_tokens' };
    },
  };
}

function makeAgent(p) {
  const root = fs.realpathSync(base);
  const model = resolveModel('anthropic', 'claude-opus-5');
  const ledger = new Ledger({ limit: model.context, compactAt: 0.75 });
  ledger.setSystem('system prompt');
  return new Agent({
    cfg: { cwd: root, home: root, provider: 'anthropic', shellTimeout: 5000, roDirs: [], model, maxTokens: 32000 },
    provider: p,
    makeProvider: () => p,
    ledger,
    sandbox: new Sandbox({ cwd: root, roDirs: [], ignore: DaIgnore.fromDir(root) }),
    journal: new Journal({ dir: path.join(root, '.session') }),
    artifacts: new Artifacts(),
    log: { event: () => {}, addUsage: () => {}, addOps: () => {} },
  });
}

async function drive(agent) {
  const ev = { warning: [], error: [], done: [] };
  for (const k of Object.keys(ev)) agent.on(k, (e) => ev[k].push(e));
  await agent.run('do the thing');
  return ev;
}

const textParts = (messages) =>
  messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ text: m.content }]))
    .filter((c) => typeof c?.text === 'string');

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-empty-'));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('empty assistant turns', () => {
  it('never sends an empty text block, and tells the model why its turn was dropped', async () => {
    const p = provider(['', 'All done.']);
    const ev = await drive(makeAgent(p));

    expect(ev.error).toEqual([]);
    expect(ev.done).toHaveLength(1);
    expect(ev.warning.some((w) => /empty turn/.test(w.message))).toBe(true);

    const next = textParts(p.sent[1]);
    expect(next.every((c) => c.text.trim().length > 0)).toBe(true);
    const said = next.map((c) => c.text).join('\n');
    expect(said).toMatch(/no visible output/);
    expect(said).toMatch(/max_tokens 32000/);
  });

  it('stops after repeated empty turns instead of looping', async () => {
    const p = provider([]);
    const ev = await drive(makeAgent(p));

    expect(p.sent).toHaveLength(3);
    expect(ev.error).toHaveLength(1);
    expect(ev.error[0].message).toMatch(/3 empty turns in a row/);
    expect(ev.error[0].message).toMatch(/DAVAI_MAX_TOKENS/);
  });
});

describe('retrying a reasoning blowout at lower effort', () => {
  /**
   * Streams `chars` of thinking and stops on max_tokens until the effort drops to
   * `answersAt`, then replies normally. Records the effort of every request.
   */
  function demotionProvider({ answersAt = 'medium', chars = 60000, reply = 'Done.' } = {}) {
    const efforts = [];
    const make = (effort) => ({
      async *send() {
        efforts.push(effort);
        if (effort === answersAt) {
          yield { t: 'text', delta: reply };
          yield { t: 'usage', in: 10, out: 20, cacheRead: 0, cacheWrite: 0 };
          yield { t: 'stop', reason: 'end_turn' };
          return;
        }
        yield { t: 'thinking', delta: 'x'.repeat(chars) };
        yield { t: 'usage', in: 10, out: 16000, cacheRead: 0, cacheWrite: 0 };
        yield { t: 'stop', reason: 'max_tokens' };
      },
    });
    return { efforts, make };
  }

  function agentWithEffort({ effort = 'high', answersAt = 'medium', chars = 60000 } = {}) {
    const root = fs.realpathSync(base);
    const model = resolveModel('anthropic', 'claude-opus-5');
    const ledger = new Ledger({ limit: model.context, compactAt: 0.75 });
    ledger.setSystem('system prompt');
    const { efforts, make } = demotionProvider({ answersAt, chars });
    const logged = [];
    const agent = new Agent({
      cfg: { cwd: root, home: root, provider: 'anthropic', shellTimeout: 5000, roDirs: [], model, maxTokens: 16000, effort },
      provider: make(effort),
      makeProvider: (_model, extra = {}) => make(extra.effort),
      ledger,
      sandbox: new Sandbox({ cwd: root, roDirs: [], ignore: DaIgnore.fromDir(root) }),
      journal: new Journal({ dir: path.join(root, '.session') }),
      artifacts: new Artifacts(),
      log: { event: (type, d = {}) => logged.push({ type, ...d }), addUsage: () => {}, addOps: () => {} },
    });
    return { agent, efforts, logged };
  }

  it('re-asks the same turn one step down instead of spending a turn on an empty reply', async () => {
    const { agent, efforts, logged } = agentWithEffort();
    const ev = await drive(agent);

    expect(efforts).toEqual(['high', 'medium']);
    expect(ev.done).toHaveLength(1);
    // The blown attempt never became an assistant turn, so the model is never told
    // "that produced nothing" — the correction cost no extra round trip.
    expect(logged.filter((e) => e.type === 'empty-turn')).toHaveLength(0);
    expect(logged.find((e) => e.type === 'effort-demoted')).toMatchObject({
      from: 'high',
      to: 'medium',
      thinkingChars: 60000,
      out: 16000,
    });
    expect(ev.warning.some((w) => /retrying this turn at effort medium/.test(w.message))).toBe(true);
    expect(agent.stats.effortDemotions).toBe(1);
  });

  it('bills every attempt, not just the one that answered', async () => {
    const { agent } = agentWithEffort();
    const usage = [];
    agent.on('usage', (u) => usage.push(u.out));
    await drive(agent);

    expect(usage).toEqual([16000, 20]);
  });

  it('steps down twice before giving up and letting the empty turn through', async () => {
    const { agent, efforts, logged } = agentWithEffort({ answersAt: 'never' });
    await drive(agent);

    // high -> medium -> low, then the empty turn is handled as one.
    expect(efforts.slice(0, 3)).toEqual(['high', 'medium', 'low']);
    expect(logged.some((e) => e.type === 'empty-turn')).toBe(true);
  });

  it('does not demote when the turn wrote something, however little', async () => {
    const root = fs.realpathSync(base);
    const model = resolveModel('anthropic', 'claude-opus-5');
    const ledger = new Ledger({ limit: model.context, compactAt: 0.75 });
    ledger.setSystem('system prompt');
    const efforts = [];
    const make = (effort) => ({
      async *send() {
        efforts.push(effort);
        yield { t: 'thinking', delta: 'x'.repeat(50000) };
        yield { t: 'text', delta: 'partial ans' };
        yield { t: 'usage', in: 10, out: 16000, cacheRead: 0, cacheWrite: 0 };
        yield { t: 'stop', reason: 'max_tokens' };
      },
    });
    const agent = new Agent({
      cfg: { cwd: root, home: root, provider: 'anthropic', shellTimeout: 5000, roDirs: [], model, maxTokens: 16000, effort: 'high' },
      provider: make('high'),
      makeProvider: (_m, extra = {}) => make(extra.effort),
      ledger,
      sandbox: new Sandbox({ cwd: root, roDirs: [], ignore: DaIgnore.fromDir(root) }),
      journal: new Journal({ dir: path.join(root, '.session') }),
      artifacts: new Artifacts(),
      log: { event: () => {}, addUsage: () => {}, addOps: () => {} },
    });
    const ev = await drive(agent);

    expect(efforts).toEqual(['high']);
    expect(ev.warning.some((w) => /truncated/.test(w.message))).toBe(true);
    expect(agent.stats.effortDemotions).toBe(0);
  });

  it('tells a blown-out model to go and read rather than to continue', async () => {
    const p = thinkingProvider(60000, ['', 'All done.']);
    const agent = makeAgent(p);
    await drive(agent);

    const said = textParts(p.sent[1]).map((c) => c.text).join('\n');
    expect(said).toMatch(/spent its entire output budget/);
    expect(said).toMatch(/none of that reasoning is in this conversation/);
    expect(said).toMatch(/cheaper to look up than to deduce/);
    // The old "continue from where you were" advice is actively wrong here.
    expect(said).not.toMatch(/Continue from where you were/);
  });
});

describe('a turn that produced only thinking', () => {
  it('says how much was streamed and where to read it', async () => {
    const p = thinkingProvider(16000, ['', 'All done.']);
    const ev = await drive(makeAgent(p));

    const warned = ev.warning.map((w) => w.message).join('\n');
    expect(warned).toMatch(/16,000 chars of thinking were streamed/);
    expect(warned).toMatch(/\/stream 1\b/);
    // The truncation warning is the empty-turn one's business here, not a second line.
    expect(ev.warning.filter((w) => /max_tokens/.test(w.message))).toHaveLength(1);
  });

  it('repeats the pointer on the error that ends the run', async () => {
    const p = thinkingProvider(50000);
    const ev = await drive(makeAgent(p));

    expect(ev.error).toHaveLength(1);
    expect(ev.error[0].message).toMatch(/50,000 chars of thinking were streamed/);
    expect(ev.error[0].message).toMatch(/\/stream 3\b/);
  });

  it('logs the thinking size against the turn number', async () => {
    const p = thinkingProvider(1234, ['', 'done']);
    const logged = [];
    const agent = makeAgent(p);
    agent.log = { event: (type, data) => logged.push({ type, ...data }), addUsage: () => {}, addOps: () => {} };
    for (const k of ['warning', 'error', 'done']) agent.on(k, () => {});
    await agent.run('go');

    expect(logged.find((e) => e.type === 'empty-turn')).toMatchObject({
      reason: 'max_tokens',
      turn: 1,
      thinkingChars: 1234,
    });
  });

  it('adds no pointer when the turn was simply silent', async () => {
    const p = provider(['', 'All done.']);
    const ev = await drive(makeAgent(p));

    expect(ev.warning.some((w) => /chars of thinking/.test(w.message))).toBe(false);
  });
});