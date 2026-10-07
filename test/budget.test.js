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
import { resolveModel, costOf, isPriceEstimated, FALLBACK_PRICE } from '../src/config/models.js';

const READ_OPS = '```da_ops\n{"ops": [{"op": "read", "path": "index.js"}]}\n```';

let base;
let root;

/** Replays canned turns. Each costs $0.001 at the prices makeAgent sets. */
function stubProvider(turns) {
  return {
    calls: 0,
    async *send() {
      const text = turns[this.calls++] ?? '';
      yield { t: 'text', delta: text };
      yield { t: 'usage', in: 100, out: 20, cacheRead: 0, cacheWrite: 0 };
      yield { t: 'stop', reason: 'end_turn' };
    },
  };
}

function makeAgent(provider, { maxCost, priced = true }) {
  const model = {
    ...resolveModel('anthropic', 'claude-opus-5'),
    ...(priced ? { inputPrice: 5, outputPrice: 25 } : { inputPrice: null, outputPrice: null }),
  };
  const ledger = new Ledger({ limit: model.context, compactAt: 0.75 });
  ledger.setSystem('system prompt');
  return new Agent({
    cfg: { cwd: root, home: base, provider: 'anthropic', shellTimeout: 5000, roDirs: [], model, maxCost },
    provider,
    makeProvider: () => provider,
    ledger,
    sandbox: new Sandbox({ cwd: root, roDirs: [], ignore: DaIgnore.fromDir(root) }),
    journal: new Journal({ dir: path.join(base, 'session') }),
    artifacts: new Artifacts(),
    log: { event: () => {}, addUsage: () => {}, addOps: () => {} },
  });
}

async function drive(agent, input) {
  const events = { done: [], warning: [], error: [] };
  for (const name of Object.keys(events)) agent.on(name, (e) => events[name].push(e));
  agent.on('ops-result', () => {});
  agent.on('approval-request', ({ respond }) => respond({ allow: true }));
  await agent.run(input);
  return events;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-budget-'));
  fs.mkdirSync(path.join(base, 'project'), { recursive: true });
  root = fs.realpathSync(path.join(base, 'project'));
  fs.writeFileSync(path.join(root, 'index.js'), 'export const x = 1;\n');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('spend cap', () => {
  it('warns at 80% and stops before the request that would exceed it', async () => {
    const provider = stubProvider(Array(10).fill(READ_OPS));
    const events = await drive(makeAgent(provider, { maxCost: 0.0022 }), 'loop forever');
    expect(provider.calls).toBe(3);
    expect(events.warning.map((w) => w.message).join('\n')).toMatch(/session cap/);
    expect(events.error[0].message).toMatch(/Spend cap reached/);
    expect(events.done).toHaveLength(0);
  });

  it('does nothing when no cap is set', async () => {
    const provider = stubProvider([READ_OPS, 'Done.']);
    const events = await drive(makeAgent(provider, { maxCost: 0 }), 'go');
    expect(events.error).toHaveLength(0);
    expect(events.done).toHaveLength(1);
  });

  it('enforces the cap on estimated pricing when the model has none', async () => {
    // 100 in + 20 out at the $3/$15 fallback is $0.0006 a turn.
    const provider = stubProvider(Array(10).fill(READ_OPS));
    const events = await drive(makeAgent(provider, { maxCost: 0.001, priced: false }), 'go');
    expect(provider.calls).toBe(2);
    expect(events.error[0].message).toMatch(/Spend cap reached.*estimated/);
  });
});

describe('fallback pricing', () => {
  const usage = { in: 1_000_000, out: 1_000_000, cacheRead: 0, cacheWrite: 0 };

  it('costs an unpriced model at FALLBACK_PRICE and flags it', () => {
    const spec = { inputPrice: null, outputPrice: null };
    expect(costOf(spec, usage)).toBeCloseTo(FALLBACK_PRICE.input + FALLBACK_PRICE.output);
    expect(isPriceEstimated(spec)).toBe(true);
  });

  it('uses seed pricing when the model has it', () => {
    const spec = { inputPrice: 5, outputPrice: 25 };
    expect(costOf(spec, usage)).toBeCloseTo(30);
    expect(isPriceEstimated(spec)).toBe(false);
  });
});