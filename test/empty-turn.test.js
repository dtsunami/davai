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