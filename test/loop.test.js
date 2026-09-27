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
import { DEFAULT_PROMPTS } from '../src/agent/prompt.js';

let base;
let root;
let deps;

/** A provider that replays canned turns, one per call. */
function stubProvider(turns) {
  const sent = [];
  return {
    sent,
    calls: 0,
    async *send({ system, messages }) {
      sent.push({ system, messages });
      const text = turns[this.calls++] ?? '';
      yield { t: 'text', delta: text };
      yield { t: 'usage', in: 100, out: 20, cacheRead: 0, cacheWrite: 0 };
      yield { t: 'stop', reason: 'end_turn' };
    },
  };
}

function makeAgent(provider, prompts) {
  const model = resolveModel('anthropic', 'claude-opus-5');
  const ledger = new Ledger({ limit: model.context, compactAt: 0.75 });
  ledger.setSystem('system prompt');
  const agent = new Agent({
    ...deps,
    provider,
    makeProvider: () => provider,
    ledger,
    cfg: { ...deps.cfg, model, ...(prompts ? { prompts } : {}) },
  });
  return { agent, ledger };
}

/** Everything the model was told on its Nth request. */
function requestText(provider, n) {
  return provider.sent[n].messages
    .flatMap((m) => m.content)
    .map((c) => c.text)
    .join('\n');
}

/** Run to completion, collecting the events we care about. */
async function drive(agent, input) {
  const events = { nudge: [], done: [], warning: [], error: [], opsResult: [] };
  agent.on('nudge', (e) => events.nudge.push(e));
  agent.on('done', (e) => events.done.push(e));
  agent.on('warning', (e) => events.warning.push(e));
  agent.on('error', (e) => events.error.push(e));
  agent.on('ops-result', (e) => events.opsResult.push(e));
  agent.on('approval-request', ({ respond }) => respond({ allow: true }));
  await agent.run(input);
  return events;
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-loop-'));
  fs.mkdirSync(path.join(base, 'project'), { recursive: true });
  root = fs.realpathSync(path.join(base, 'project'));
  fs.writeFileSync(path.join(root, 'index.js'), 'export const x = 1;\n');

  deps = {
    cfg: { cwd: root, home: base, provider: 'anthropic', shellTimeout: 5000, roDirs: [] },
    sandbox: new Sandbox({ cwd: root, roDirs: [], ignore: DaIgnore.fromDir(root) }),
    journal: new Journal({ dir: path.join(base, 'session') }),
    artifacts: new Artifacts(),
    log: { event: () => {}, addUsage: () => {}, addOps: () => {} },
  };
});

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
});

const READ_OPS = '```da_ops\n{"ops": [{"op": "read", "path": "index.js"}]}\n```';

describe('stalled turns', () => {
  it('nudges a model that announces work and emits no ops', async () => {
    // Exactly what grok-4.7 did: one sentence of intent, stop reason end_turn.
    const provider = stubProvider([
      "I'll look up how yolo mode is implemented, then try a few shell commands against it.",
      `Read it.\n${READ_OPS}`,
      'index.js exports a single constant.',
    ]);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'check yolo mode');

    expect(events.nudge).toHaveLength(1);
    expect(events.opsResult).toHaveLength(1);
    expect(events.done).toHaveLength(1);
    expect(events.done[0].prose).toContain('single constant');
    expect(provider.calls).toBe(3);
  });

  it('gives up after MAX_NUDGES instead of burning turns', async () => {
    const provider = stubProvider(Array(10).fill("Let me check that for you."));
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'check yolo mode');

    expect(events.nudge).toHaveLength(2);
    expect(provider.calls).toBe(3); // the first turn plus two nudged retries
    expect(events.warning.at(-1).message).toMatch(/no ops after 2 reminders/);
    expect(events.done).toHaveLength(1);
    expect(events.error).toHaveLength(0);
  });

  it('nudges an empty turn', async () => {
    const provider = stubProvider(['', 'Nothing needed changing.']);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'anything to do?');

    expect(events.nudge).toHaveLength(1);
    expect(events.done[0].prose).toContain('Nothing needed');
  });

  it('puts the nudge in context so the model can see it', async () => {
    const provider = stubProvider(["I'll take a look.", 'Done — nothing to change.']);
    const { agent, ledger } = makeAgent(provider);
    await drive(agent, 'look around');

    expect(ledger.segments.some((s) => s.label === 'nudge')).toBe(true);
    // The nudge reaches the model on the following request, not just the ledger.
    expect(requestText(provider, 1)).toMatch(/no da_ops block/);
  });
});

describe('prompt overrides', () => {
  it('wraps op results in the ops-result prompt', async () => {
    const provider = stubProvider([`Reading.\n${READ_OPS}`, 'Done.']);
    const { agent } = makeAgent(provider);
    await drive(agent, 'read index.js');

    const followup = requestText(provider, 1);
    expect(followup).toContain('Results of your da_ops batch');
    expect(followup).toContain('```da_results');
    expect(followup).toContain('export const x = 1;');
  });

  it('sends a custom ops-result prompt instead of the default', async () => {
    const prompts = { ...DEFAULT_PROMPTS, opsResult: 'OPS OUTPUT FOLLOWS\n{results}' };
    const provider = stubProvider([`Reading.\n${READ_OPS}`, 'Done.']);
    const { agent } = makeAgent(provider, prompts);
    await drive(agent, 'read index.js');

    const followup = requestText(provider, 1);
    expect(followup).toContain('OPS OUTPUT FOLLOWS');
    expect(followup).toContain('```da_results');
    expect(followup).not.toContain('Results of your da_ops batch');
  });

  it('sends a custom nudge', async () => {
    const prompts = { ...DEFAULT_PROMPTS, nudge: 'ACT NOW OR SAY YOU ARE FINISHED' };
    const provider = stubProvider(["I'll take a look.", 'Nothing to change.']);
    const { agent } = makeAgent(provider, prompts);
    await drive(agent, 'look');

    expect(requestText(provider, 1)).toContain('ACT NOW OR SAY YOU ARE FINISHED');
  });

  it('sends a custom repair prompt with the parser error', async () => {
    const prompts = { ...DEFAULT_PROMPTS, repair: 'BROKEN: {error} — resend it' };
    const provider = stubProvider([
      '```da_ops\n{"ops": [not json}\n```',
      `Fixed.\n${READ_OPS}`,
      'Done.',
    ]);
    const { agent } = makeAgent(provider, prompts);
    await drive(agent, 'read it');

    const followup = requestText(provider, 1);
    expect(followup).toMatch(/^BROKEN: /m);
    expect(followup).toContain('— resend it');
  });
});

describe('conclusive turns', () => {
  it('finishes on a report of completed work without nudging', async () => {
    const provider = stubProvider(['Fixed the timeout in config.js and the tests pass.']);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'fix the timeout');

    expect(events.nudge).toHaveLength(0);
    expect(events.done).toHaveLength(1);
    expect(provider.calls).toBe(1);
  });

  it('does not mistake an explanatory opener for a stall', async () => {
    const provider = stubProvider([
      "I'll explain what changed: slug.js now collapses runs of non-alphanumerics, " +
        'and the seven tests in test.js cover it. Nothing else was touched.',
    ]);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'what changed?');

    expect(events.nudge).toHaveLength(0);
    expect(provider.calls).toBe(1);
  });

  it('runs ops and finishes without a nudge when the model complies', async () => {
    const provider = stubProvider([`Reading it.\n${READ_OPS}`, 'index.js exports one constant.']);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'read index.js');

    expect(events.nudge).toHaveLength(0);
    expect(events.opsResult[0].outcome.status).toBe('ok');
    expect(events.done).toHaveLength(1);
  });
});
