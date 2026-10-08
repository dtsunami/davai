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

/** A provider that throws on its first N calls, then replays canned turns. */
function flakyProvider(failures, turns) {
  let thrown = 0;
  const base = stubProvider(turns);
  return {
    get calls() {
      return base.calls;
    },
    sent: base.sent,
    async *send(req) {
      if (thrown < failures.length) {
        const err = failures[thrown++];
        throw err;
      }
      yield* base.send(req);
    },
  };
}

/** A retryable provider failure, shaped the way wrapError leaves one. */
function transient(message = 'gemini: service unavailable (503)', retryAfterMs = 60) {
  return Object.assign(new Error(message), { retryable: true, status: 503, retryAfterMs });
}

/** Run to completion, collecting the events we care about. */
async function drive(agent, input) {
  const events = { nudge: [], done: [], warning: [], error: [], opsResult: [], retry: [], steered: [] };
  agent.on('steered', (e) => events.steered.push(e));
  agent.on('retry', (e) => events.retry.push(e));
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

describe('native tool calls', () => {
  /** One turn of text plus whatever native calls the model "made". */
  function toolCallProvider(text, calls, reason = 'tool_calls') {
    return {
      sent: [],
      calls: 0,
      async *send({ system, messages }) {
        this.sent.push({ system, messages });
        this.calls++;
        yield { t: 'text', delta: text };
        if (calls.length) yield { t: 'tool_calls', calls };
        yield { t: 'usage', in: 100, out: 20, cacheRead: 0, cacheWrite: 0 };
        yield { t: 'stop', reason };
      },
    };
  }

  function captureLog() {
    const logged = [];
    deps.log = { ...deps.log, event: (type, data = {}) => logged.push({ type, ...data }) };
    return logged;
  }

  it('answers an unmappable call with a reminder that names it, and logs it', async () => {
    const logged = captureLog();
    // Mistral's shape: a line of narration, a call, finish_reason "tool_calls". The prose
    // has no intent phrase, so this used to end the run with nothing done.
    const provider = toolCallProvider('Reading the project docs.', [
      { id: 'c1', name: 'read_file', args: '{"path":"README.md"}' },
    ]);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'look around');

    expect(events.warning.some((w) => /read_file: not a da_ops batch/.test(w.message))).toBe(true);
    const turn = logged.find((e) => e.type === 'assistant');
    expect(turn.stop).toBe('tool_calls');
    expect(turn.toolCalls).toEqual([{ id: 'c1', name: 'read_file', args: '{"path":"README.md"}' }]);
    expect(logged.find((e) => e.type === 'native-calls').calls).toEqual([
      expect.objectContaining({ id: 'c1', name: 'read_file', disposition: 'unusable' }),
    ]);
    expect(events.opsResult).toHaveLength(0);
    expect(events.nudge).toHaveLength(2);
    expect(events.nudge[0].nativeCalls).toEqual(['read_file']);
    expect(requestText(provider, 1)).toMatch(/read_file.*none of them ran/s);
    expect(provider.calls).toBe(3);
    expect(agent.stats.nativeCalls).toBe(3);
  });

  it('adds nothing to the log or the warnings when there were no calls', async () => {
    const logged = captureLog();
    const provider = toolCallProvider('Nothing to do.', [], 'end_turn');
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'anything?');

    expect(events.warning.some((w) => /native tool call/.test(w.message))).toBe(false);
    expect(logged.find((e) => e.type === 'assistant')).not.toHaveProperty('toolCalls');
  });

  /** Turns as {text, calls}; a turn with calls stops on "tool_calls", like Mistral's. */
  function scriptedProvider(turns) {
    return {
      sent: [],
      calls: 0,
      async *send({ system, messages }) {
        this.sent.push({ system, messages });
        const turn = turns[this.calls++] ?? { text: 'Done.' };
        if (turn.text) yield { t: 'text', delta: turn.text };
        if (turn.calls?.length) yield { t: 'tool_calls', calls: turn.calls };
        yield { t: 'usage', in: 100, out: 20, cacheRead: 0, cacheWrite: 0 };
        yield { t: 'stop', reason: turn.calls?.length ? 'tool_calls' : 'end_turn' };
      },
    };
  }

  const READ_ARGS = '{"ops": [{"op": "read", "path": "index.js"}]}';

  it('runs a native da_ops call as the batch it carries (session 0a7d6caba0)', async () => {
    const logged = captureLog();
    const provider = scriptedProvider([
      {
        text: 'Let me look at the project first.',
        calls: [{ id: 'c1', name: 'da_ops', args: READ_ARGS }],
      },
      { text: 'index.js exports one constant.' },
    ]);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'look around');

    expect(events.opsResult).toHaveLength(1);
    expect(events.opsResult[0].outcome.status).toBe('ok');
    expect(events.nudge).toHaveLength(0);
    expect(events.done[0].prose).toContain('one constant');

    // The request is in history as a fenced block, so the results answer something.
    const second = requestText(provider, 1);
    expect(second).toContain('```da_ops');
    expect(second).toContain('"path":"index.js"');
    expect(second).toContain('Results of your da_ops batch');
    expect(second).toMatch(/Received as a native tool call/);

    const native = logged.find((e) => e.type === 'native-calls');
    expect(native.calls[0]).toMatchObject({ id: 'c1', name: 'da_ops', disposition: 'executed' });
    expect(native.block).toContain('```da_ops');
    expect(agent.stats.nativeSalvaged).toBe(1);
  });

  it('runs a native call that came with no text at all', async () => {
    const provider = scriptedProvider([
      { text: '', calls: [{ name: 'da_ops', args: READ_ARGS }] },
      { text: 'Done.' },
    ]);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'look around');

    expect(events.opsResult).toHaveLength(1);
    expect(events.warning.some((w) => /empty turn/.test(w.message))).toBe(false);
  });

  it('resolves payload references against blocks in the reply text', async () => {
    const provider = scriptedProvider([
      {
        text: 'Writing it.\n--davai:1--\nhello\nworld\n--davai:end--',
        calls: [{ name: 'da_ops', args: '{"ops": [{"op": "write", "path": "new.txt", "text": "@1"}]}' }],
      },
      { text: 'Wrote new.txt.' },
    ]);
    const { agent } = makeAgent(provider);
    await drive(agent, 'write it');

    expect(fs.readFileSync(path.join(root, 'new.txt'), 'utf8')).toContain('hello\nworld');
  });

  it('merges op-named calls into one batch', async () => {
    const provider = scriptedProvider([
      {
        text: 'Looking.',
        calls: [
          { name: 'read', args: '{"path": "index.js"}' },
          { name: 'list', args: '{"path": "."}' },
        ],
      },
      { text: 'Done.' },
    ]);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'look around');

    expect(events.opsResult).toHaveLength(1);
    expect(events.opsResult[0].ops.map((o) => o.op)).toEqual(['read', 'list']);
  });

  it('lets a fenced block win over native calls in the same reply', async () => {
    const logged = captureLog();
    const provider = scriptedProvider([
      {
        text: `Reading.\n${READ_OPS}`,
        calls: [{ name: 'da_ops', args: '{"ops": [{"op": "delete", "path": "index.js"}]}' }],
      },
      { text: 'Done.' },
    ]);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'look around');

    expect(fs.existsSync(path.join(root, 'index.js'))).toBe(true);
    expect(events.opsResult[0].ops.map((o) => o.op)).toEqual(['read']);
    expect(logged.find((e) => e.type === 'native-calls').calls[0].disposition).toBe('shadowed');
  });

  it('sends a malformed native call through repair', async () => {
    const provider = scriptedProvider([
      { text: 'Reading.', calls: [{ name: 'da_ops', args: '{"ops": [{"op": "read"' }] },
      { text: 'Gave up; nothing changed.' },
    ]);
    const { agent } = makeAgent(provider);
    const repairs = [];
    agent.on('repair', (r) => repairs.push(r));
    const events = await drive(agent, 'look around');

    expect(repairs).toHaveLength(1);
    expect(repairs[0].error).toMatch(/^native da_ops tool call: da_ops envelope is not valid JSON/);
    expect(events.opsResult).toHaveLength(0);
    expect(events.done).toHaveLength(1);
  });
});

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

  it('handles an empty turn without a nudge, and never resends empty text', async () => {
    // Empty turns used to be nudged, which left an empty assistant segment in context;
    // Anthropic then rejected every later request with a 400. They now get a
    // placeholder and an explanation instead (see test/empty-turn.test.js).
    const provider = stubProvider(['', 'Nothing needed changing.']);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'anything to do?');

    expect(events.nudge).toHaveLength(0);
    expect(events.warning.some((w) => /empty turn/.test(w.message))).toBe(true);
    expect(events.done[0].prose).toContain('Nothing needed');
    const texts = provider.sent[1].messages.flatMap((m) => m.content).map((c) => c.text);
    expect(texts.every((t) => typeof t !== 'string' || t.trim().length > 0)).toBe(true);
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

describe('nudge accuracy metric', () => {
  it('counts a nudge that led to real work as earned', async () => {
    const provider = stubProvider([
      "I'll take a look.",
      `Reading.\n${READ_OPS}`,
      'index.js exports one constant.',
    ]);
    const { agent } = makeAgent(provider);
    await drive(agent, 'look');

    expect(agent.stats.nudges).toBe(1);
    expect(agent.stats.nudgesWasted).toBe(0);
  });

  it('counts a nudge answered by another bare conclusion as wasted', async () => {
    // "I'll leave the tests to you" is a conclusion that trips the intent regex — the
    // documented false positive. It should be visible, not invisible.
    const provider = stubProvider([
      'Fixed it. I will leave the tests to you.',
      'Nothing further — it is done.',
    ]);
    const { agent } = makeAgent(provider);
    await drive(agent, 'fix it');

    expect(agent.stats.nudges).toBe(1);
    expect(agent.stats.nudgesWasted).toBe(1);
  });

  it('counts nothing when no nudge was needed', async () => {
    const provider = stubProvider(['Fixed the timeout in config.js.']);
    const { agent } = makeAgent(provider);
    await drive(agent, 'fix it');

    expect(agent.stats.nudges).toBe(0);
    expect(agent.stats.nudgesWasted).toBe(0);
  });

  it('does not blame a later conclusion on an earlier nudge', async () => {
    // Nudge, then ops, then a conclusion: the nudge worked, the conclusion is genuine.
    const provider = stubProvider([
      "I'll check.",
      `Reading.\n${READ_OPS}`,
      'Done — all good.',
    ]);
    const { agent } = makeAgent(provider);
    await drive(agent, 'check');

    expect(agent.stats.nudges).toBe(1);
    expect(agent.stats.nudgesWasted).toBe(0);
  });
});

describe('steering', () => {
  /** A provider that calls back after each turn, so a test can steer mid-run. */
  function steerableProvider(turns, onTurn) {
    let i = 0;
    const sent = [];
    return {
      sent,
      get calls() {
        return i;
      },
      async *send({ system, messages }) {
        sent.push({ system, messages });
        const text = turns[i++] ?? 'Done.';
        yield { t: 'text', delta: text };
        yield { t: 'usage', in: 10, out: 5, cacheRead: 0, cacheWrite: 0 };
        yield { t: 'stop', reason: 'end_turn' };
        await onTurn?.(i);
      },
    };
  }

  it('refuses a steer when nothing is running', () => {
    const { agent } = makeAgent(stubProvider(['Done.']));
    expect(agent.steer('change course')).toBe(false);
  });

  it('applies a steer on the next turn and keeps the loop alive', async () => {
    // Turn 1 would normally conclude; the steer must stop that being the end of the run.
    const held = {};
    const provider = steerableProvider([`Reading.\n${READ_OPS}`, 'All done.', 'Also renamed it.'], (n) => {
      if (n === 2) held.agent.steer('actually rename the function too');
    });
    const { agent, ledger } = makeAgent(provider);
    held.agent = agent;
    const events = await drive(agent, 'read index.js');

    expect(events.steered).toHaveLength(1);
    expect(events.steered[0].applied).toBe(1);
    expect(provider.calls).toBe(3); // it did not stop at 'All done.'
    expect(events.done[0].prose).toContain('Also renamed it.');

    const steerSeg = ledger.segments.find((s) => s.label.startsWith('steer:'));
    expect(steerSeg.role).toBe('user');
    expect(steerSeg.part.text).toContain('actually rename the function too');
    expect(steerSeg.part.text).toContain('takes precedence');
  });

  it('puts the steer in front of the model on the following request', async () => {
    const held = {};
    const provider = steerableProvider(['Working.' + `\n${READ_OPS}`, 'Done.'], (n) => {
      if (n === 1) held.agent.steer('use tabs, not spaces');
    });
    const { agent } = makeAgent(provider);
    held.agent = agent;
    await drive(agent, 'go');

    expect(requestText(provider, 1)).toContain('use tabs, not spaces');
  });

  it('applies several queued steers at once, in order', async () => {
    const held = {};
    const provider = steerableProvider(['First pass.', 'Second pass.'], (n) => {
      if (n === 1) {
        held.agent.steer('one');
        held.agent.steer('two');
      }
    });
    const { agent, ledger } = makeAgent(provider);
    held.agent = agent;
    const events = await drive(agent, 'go');

    expect(events.steered[0].applied).toBe(2);
    const steers = ledger.segments.filter((s) => s.label.startsWith('steer:'));
    expect(steers).toHaveLength(2);
    expect(steers[0].part.text).toContain('one');
    expect(steers[1].part.text).toContain('two');
    expect(agent.steers).toEqual([]);
  });

  it('honours a custom steer prompt', async () => {
    const held = {};
    const prompts = { ...DEFAULT_PROMPTS, steer: 'COURSE CHANGE: {text}' };
    const provider = steerableProvider(['Working.', 'Done.'], (n) => {
      if (n === 1) held.agent.steer('stop and explain');
    });
    const { agent } = makeAgent(provider, prompts);
    held.agent = agent;
    await drive(agent, 'go');

    expect(requestText(provider, 1)).toContain('COURSE CHANGE: stop and explain');
  });

  it('ignores blank steers', async () => {
    const held = {};
    const provider = steerableProvider(['Working.', 'Done.'], (n) => {
      if (n === 1) {
        expect(held.agent.steer('   ')).toBe(false);
        expect(held.agent.steer('')).toBe(false);
      }
    });
    const { agent } = makeAgent(provider);
    held.agent = agent;
    const events = await drive(agent, 'go');
    expect(events.steered).toHaveLength(0);
    expect(provider.calls).toBe(1);
  });
});

describe('provider retries', () => {
  it('retries a transient failure and completes the turn', async () => {
    const provider = flakyProvider([transient()], ['Nothing to change.']);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'look around');

    expect(events.retry).toHaveLength(1);
    expect(events.retry[0]).toMatchObject({ attempt: 1, of: 2, waitMs: 60 });
    expect(events.error).toHaveLength(0);
    expect(events.done[0].prose).toContain('Nothing to change.');
  });

  it('honours the provider retry hint, capped', async () => {
    const provider = flakyProvider([transient('busy', 250)], ['Done.']);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'go');
    expect(events.retry[0].waitMs).toBe(250);
  });

  it('gives up after MAX_PROVIDER_RETRIES and reports the error', async () => {
    const provider = flakyProvider([transient(), transient(), transient()], ['unreached']);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'go');

    expect(events.retry).toHaveLength(2);
    expect(events.error).toHaveLength(1);
    expect(events.error[0].message).toContain('service unavailable');
    expect(events.done).toHaveLength(0);
  });

  it('does not retry an error marked unretryable', async () => {
    // A 429 with "limit: 0" — waiting cannot help, so it must surface at once.
    const quota = Object.assign(new Error('gemini: no quota for gemini-3.1-pro'), {
      retryable: false,
      status: 429,
      retryAfterMs: 12000,
    });
    const provider = flakyProvider([quota], ['unreached']);
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'go');

    expect(events.retry).toHaveLength(0);
    expect(events.error[0].message).toContain('no quota');
  });

  it('does not retry once text has already streamed', async () => {
    // Re-sending mid-answer would duplicate what the operator already saw.
    let call = 0;
    const provider = {
      calls: 0,
      sent: [],
      async *send() {
        call++;
        yield { t: 'text', delta: 'half an answer' };
        throw transient();
      },
    };
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'go');

    expect(events.retry).toHaveLength(0);
    expect(events.error).toHaveLength(1);
    expect(call).toBe(1);
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

describe('transcript records every model output', () => {
  function captureLog() {
    const logged = [];
    deps.log = { ...deps.log, event: (type, data = {}) => logged.push({ type, ...data }) };
    return logged;
  }

  /** A provider that runs one scripted generator per call. */
  function scripted(...turns) {
    return {
      sent: [],
      calls: 0,
      async *send() {
        const turn = turns[this.calls++] ?? (async function* () {
          yield { t: 'text', delta: 'Done.' };
          yield { t: 'stop', reason: 'end_turn' };
        });
        yield* turn();
      },
    };
  }

  it('logs thinking alongside the completed turn', async () => {
    const logged = captureLog();
    const provider = scripted(async function* () {
      yield { t: 'thinking', delta: 'hmm ' };
      yield { t: 'thinking', delta: 'ok' };
      yield { t: 'text', delta: 'Done.' };
      yield { t: 'stop', reason: 'end_turn' };
    });
    const { agent } = makeAgent(provider);
    await drive(agent, 'go');

    expect(logged.find((e) => e.type === 'assistant')).toMatchObject({ text: 'Done.', thinking: 'hmm ok' });
  });

  it('keeps the thinking of a turn that spent max_tokens on it (session 9290eb08bb)', async () => {
    const logged = captureLog();
    const provider = scripted(async function* () {
      yield { t: 'thinking', delta: 'x'.repeat(5000) };
      yield { t: 'usage', in: 100, out: 16000, cacheRead: 0, cacheWrite: 0 };
      yield { t: 'stop', reason: 'max_tokens' };
    });
    const { agent } = makeAgent(provider);
    await drive(agent, 'go');

    const first = logged.find((e) => e.type === 'assistant');
    expect(first.text).toBe('');
    expect(first.stop).toBe('max_tokens');
    expect(first.thinking).toHaveLength(5000);
  });

  it('logs a cancelled turn as a partial, never as an assistant turn', async () => {
    const logged = captureLog();
    const provider = scripted(async function* () {
      yield { t: 'thinking', delta: 'still thinking' };
      yield { t: 'text', delta: 'half' };
      throw Object.assign(new Error('cancelled'), { cancelled: true });
    });
    const { agent } = makeAgent(provider);
    await drive(agent, 'go');

    expect(logged.filter((e) => e.type === 'assistant')).toHaveLength(0);
    expect(logged.find((e) => e.type === 'assistant-partial')).toMatchObject({
      reason: 'cancelled',
      text: 'half',
      thinking: 'still thinking',
    });
  });

  it('logs what streamed before a provider error, with the error', async () => {
    const logged = captureLog();
    const provider = scripted(async function* () {
      yield { t: 'thinking', delta: 'partway' };
      throw Object.assign(new Error('openai: connection reset'), { retryable: false });
    });
    const { agent } = makeAgent(provider);
    const events = await drive(agent, 'go');

    expect(events.error).toHaveLength(1);
    expect(logged.find((e) => e.type === 'assistant-partial')).toMatchObject({
      reason: 'error',
      thinking: 'partway',
      error: 'openai: connection reset',
    });
  });

  it('writes no partial when nothing streamed', async () => {
    const logged = captureLog();
    // eslint-disable-next-line require-yield -- fails before streaming anything, which is the case
    const provider = scripted(async function* () {
      throw Object.assign(new Error('cancelled'), { cancelled: true });
    });
    const { agent } = makeAgent(provider);
    await drive(agent, 'go');

    expect(logged.some((e) => e.type === 'assistant-partial')).toBe(false);
  });
});
