import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sandbox } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';
import { Journal } from '../src/agent/journal.js';
import { normalizeBatch } from '../src/agent/ops/schema.js';
import { executeBatch, formatResults } from '../src/agent/ops/executor.js';
import { buildSystemPrompt, DEFAULT_PROMPTS } from '../src/agent/prompt.js';
import { loadConfig } from '../src/config/env.js';
import { parseArgs } from '../bin/davai.js';
import { Agent } from '../src/agent/loop.js';
import { Ledger } from '../src/context/ledger.js';
import { Artifacts } from '../src/context/artifacts.js';
import { resolveModel } from '../src/config/models.js';
import { replaySegments } from '../src/session/resume.js';

let base;
let root;
let ctx;

function run(rawOps, extra = {}) {
  const { ops, errors } = normalizeBatch(rawOps);
  if (errors.length) {
    return Promise.resolve({ status: 'plan-failed', results: [], errors });
  }
  return executeBatch(ops, { ...ctx, ...extra });
}

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-tx-'));
  fs.mkdirSync(path.join(base, 'project'), { recursive: true });
  root = fs.realpathSync(path.join(base, 'project'));
  fs.writeFileSync(path.join(root, '.daignore'), 'secret.txt\n');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'top-secret\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'one.js'),
    'export function oldHelper(x) {\n  return x + 1;\n}\n',
  );
  fs.writeFileSync(
    path.join(root, 'src', 'two.js'),
    'import { oldHelper } from "./one.js";\nexport const v = oldHelper(2);\n',
  );
  fs.writeFileSync(path.join(root, 'src', 'three.js'), 'export const untouched = true;\n');

  const sessionDir = path.join(base, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  ctx = {
    sandbox: new Sandbox({ cwd: root, roDirs: [], ignore: DaIgnore.fromDir(root) }),
    journal: new Journal({ dir: sessionDir }),
    shellTimeout: 5000,
    codeMode: true,
    txState: {},
  };
});

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('DAVAI_CODE_MODE gate and prompt baseline', () => {
  it('defaults codeMode to false and leaves buildSystemPrompt byte-identical when off', () => {
    const savedHome = process.env.DAVAI_HOME;
    const savedMode = process.env.DAVAI_CODE_MODE;
    process.env.DAVAI_HOME = base;
    delete process.env.DAVAI_CODE_MODE;
    try {
      const cfgOff = loadConfig({ cwd: root });
      expect(cfgOff.codeMode).toBe(false);

      const cfgOn = loadConfig({ cwd: root, overrides: { DAVAI_CODE_MODE: 'true' } });
      expect(cfgOn.codeMode).toBe(true);

      const baseline = buildSystemPrompt({ grounding: 'GROUND', prompts: DEFAULT_PROMPTS });
      const explicitOff = buildSystemPrompt({
        grounding: 'GROUND',
        prompts: DEFAULT_PROMPTS,
        codeMode: false,
      });
      const withTx = buildSystemPrompt({
        grounding: 'GROUND',
        prompts: DEFAULT_PROMPTS,
        codeMode: true,
      });
      expect(explicitOff).toBe(baseline);
      expect(baseline).not.toContain('"tx"');
      expect(withTx).toContain('Code Mode (`tx` op — enabled)');
    } finally {
      if (savedHome === undefined) delete process.env.DAVAI_HOME;
      else process.env.DAVAI_HOME = savedHome;
      if (savedMode === undefined) delete process.env.DAVAI_CODE_MODE;
      else process.env.DAVAI_CODE_MODE = savedMode;
    }
  });

  it('supports --code-mode CLI flag', () => {
    expect(parseArgs(['--code-mode', 'refactor']).overrides.DAVAI_CODE_MODE).toBe('true');
  });

  it('refuses tx at plan time when codeMode is disabled', async () => {
    const out = await run([{ op: 'tx', code: 'return 1;' }], { codeMode: false });
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/DAVAI_CODE_MODE/);
  });
});

describe('tx Copy-on-Write execution, sandbox, and rollback', () => {
  it('performs bulk fileset queries and refactors in one step with compact output', async () => {
    const out = await run([
      {
        op: 'tx',
        description: 'rename oldHelper to newHelper',
        code: `
          const hits = fileset("src/**/*.js").containing("oldHelper");
          const res = hits.replaceAll("oldHelper", "newHelper");
          return { paths: hits.paths(), ...res };
        `,
      },
    ]);
    expect(out.status).toBe('ok');
    expect(read('src/one.js')).toContain('function newHelper(x)');
    expect(read('src/two.js')).toContain('newHelper(2)');
    expect(read('src/three.js')).toBe('export const untouched = true;\n');

    const formatted = formatResults(out);
    expect(formatted).toContain('src/one.js');
    expect(formatted).toContain('src/two.js');
    expect(formatted).toContain('"occurrences": 3');
  });

  it('supports RegExp literals inside the VM context across realms', async () => {
    const out = await run([
      {
        op: 'tx',
        code: `
          replace("src/one.js", /oldHelper\\((\\w+)\\)/, "newHelper($1)");
          return fileset("src/**/*.js").containing(/newHelper/).paths();
        `,
      },
    ]);
    expect(out.status).toBe('ok');
    expect(read('src/one.js')).toContain('function newHelper(x)');
    expect(JSON.parse(out.results[0].result.output)).toEqual(['src/one.js']);
  });

  it('leaves disk completely untouched if the script throws mid-loop', async () => {
    const out = await run([
      {
        op: 'tx',
        code: `
          write("src/created.js", "export const x = 1;\\n");
          replace("src/one.js", "oldHelper", "halfway");
          // Ambiguous or missing replace on second file aborts the whole CoW staging map:
          replace("src/two.js", "nonexistent_symbol", "boom");
        `,
      },
    ]);
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/not found in src\/two\.js/);
    expect(exists('src/created.js')).toBe(false);
    expect(read('src/one.js')).toContain('oldHelper');
  });

  it('rolls back committed tx changes if a subsequent op in the batch fails at apply time', async () => {
    const out = await run([
      {
        op: 'tx',
        code: `
          replace("src/one.js", "oldHelper", "renamedInTx");
          write("src/added.js", "export const ok = 1;\\n");
        `,
      },
      {
        op: 'write',
        path: 'src/corrupt.js',
        text: 'bad\0nul',
      },
    ]);
    expect(out.status).toBe('apply-failed');
    expect(read('src/one.js')).toContain('oldHelper');
    expect(exists('src/added.js')).toBe(false);
    expect(exists('src/corrupt.js')).toBe(false);
  });

  it('enforces Sandbox write jail, .daignore, and blocks ambient Node globals', async () => {
    const escapeWrite = await run([
      { op: 'tx', code: 'write("../outside.txt", "nope");' },
    ]);
    expect(escapeWrite.status).toBe('plan-failed');
    expect(escapeWrite.errors[0].message).toMatch(/write denied/);

    const ignoredRead = await run([
      { op: 'tx', code: 'return read("secret.txt");' },
    ]);
    expect(ignoredRead.status).toBe('plan-failed');
    expect(ignoredRead.errors[0].message).toMatch(/\.daignore/);

    const ambient = await run([
      {
        op: 'tx',
        code: 'return [typeof process, typeof require, typeof fetch, typeof setTimeout];',
      },
    ]);
    expect(ambient.status).toBe('ok');
    expect(JSON.parse(ambient.results[0].result.output)).toEqual([
      'undefined',
      'undefined',
      'undefined',
      'undefined',
    ]);
  });

  it('terminates infinite loops via V8 timeout without touching disk', async () => {
    const out = await run(
      [
        {
          op: 'tx',
          code: 'write("src/never.js", "x"); while (true) {}',
        },
      ],
      { txTimeoutMs: 60 },
    );
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/timed out/i);
    expect(exists('src/never.js')).toBe(false);
  });

  it('persists state across turns without leaking dry-run mutations on failed batches', async () => {
    const sharedState = {};
    const ok1 = await run(
      [{ op: 'tx', code: 'state.files = glob("src/**/*.js"); return state.files.length;' }],
      { txState: sharedState },
    );
    expect(ok1.status).toBe('ok');
    expect(sharedState.files).toHaveLength(3);

    // Failed batch must not mutate sharedState during planning:
    const bad = await run(
      [
        { op: 'tx', code: 'state.files.push("corrupted");' },
        { op: 'replace', path: 'src/one.js', old: 'missing', new: 'x' },
      ],
      { txState: sharedState },
    );
    expect(bad.status).toBe('plan-failed');
    expect(sharedState.files).toHaveLength(3);
  });

  it('composes cleanly with earlier and later ops on the same file in one batch', async () => {
    const out = await run([
      { op: 'write', path: 'src/generated.js', text: 'export const count = 1;\n' },
      {
        op: 'tx',
        code: 'replace("src/generated.js", "count = 1", "count = 2");',
      },
      { op: 'replace', path: 'src/generated.js', old: 'count = 2', new: 'count = 3' },
    ]);
    expect(out.status).toBe('ok');
    expect(read('src/generated.js')).toBe('export const count = 3;\n');
  });
});

describe('operator interactive tx REPL and atomic turn-boundary queueing', () => {
  function makeTestAgent(provider) {
    const model = resolveModel('anthropic', 'claude-opus-5');
    const ledger = new Ledger({ limit: model.context, compactAt: 0.75 });
    ledger.setSystem('sys');
    const events = [];
    const sessionLogDir = path.join(base, 'repl-log');
    fs.mkdirSync(sessionLogDir, { recursive: true });
    const transcriptFile = path.join(sessionLogDir, 'transcript.jsonl');
    const log = {
      event(type, data = {}) {
        const entry = { ts: new Date().toISOString(), type, ...data };
        events.push(entry);
        fs.appendFileSync(transcriptFile, JSON.stringify(entry) + '\n');
      },
      addUsage() {},
      addOps() {},
    };
    const agent = new Agent({
      cfg: { cwd: root, home: base, provider: 'anthropic', model, shellTimeout: 5000, codeMode: true },
      provider,
      makeProvider: () => provider,
      ledger,
      sandbox: ctx.sandbox,
      journal: ctx.journal,
      artifacts: new Artifacts(),
      log,
    });
    return { agent, ledger, events, sessionLogDir };
  }

  it('evaluates single-line expressions immediately when idle, shares state, and records transcript', () => {
    const dummyProvider = { async *send() {} };
    const { agent, ledger, sessionLogDir } = makeTestAgent(dummyProvider);
    const applied = [];
    agent.on('tx-applied', (ev) => applied.push(ev));

    const res = agent.runOperatorTx('state.hits = fileset("src/**/*.js").containing("oldHelper").paths()');
    expect(res.queued).toBe(false);
    expect(res.entry.ok).toBe(true);
    expect(res.entry.output).toContain('src/one.js');
    expect(agent.txState.hits).toEqual(['src/one.js', 'src/two.js']);
    expect(applied).toHaveLength(1);
    expect(applied[0].immediate).toBe(true);

    const snap = agent.txSnapshot();
    expect(snap.stateKeys).toEqual(['hits']);
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].origin).toBe('operator');

    // Context ledger receives the full code + result so the LLM sees the operator's REPL action:
    expect(ledger.segments.some((s) => s.label.startsWith('tx (operator):') && s.part.text.includes('src/one.js'))).toBe(true);

    // Session resume replays operator-tx cleanly:
    const replayed = replaySegments(sessionLogDir);
    expect(replayed).toHaveLength(1);
    expect(replayed[0].label).toContain('tx (operator)');
  });

  it('queues operator tx mid-turn and applies it atomically at the turn boundary alongside LLM tx', async () => {
    const holder = { agent: null };
    let callCount = 0;
    const seenMessages = [];

    const provider = {
      async *send({ messages }) {
        seenMessages.push(
          messages
            .flatMap((m) => m.content)
            .map((c) => c.text)
            .join('\n'),
        );
        callCount++;
        if (callCount === 1) {
          // Operator interacts mid-stream during Turn 1!
          const q = holder.agent.runOperatorTx('state.seed = 40; replace("src/three.js", "true", "false"); return state.seed;');
          expect(q.queued).toBe(true);
          expect(q.position).toBe(1);
          // Disk & txState MUST NOT be mutated yet while Turn 1 is still in flight:
          expect(holder.agent.txState.seed).toBeUndefined();
          expect(read('src/three.js')).toBe('export const untouched = true;\n');

          // Model concludes without ops — queued operator tx must keep the loop alive for Turn 2!
          yield { t: 'text', delta: 'Initial check done.' };
          yield { t: 'usage', in: 50, out: 10, cacheRead: 0, cacheWrite: 0 };
          yield { t: 'stop', reason: 'end_turn' };
          return;
        }
        if (callCount === 2) {
          // Turn 2: operator's tx has now applied atomically at the step boundary!
          expect(holder.agent.txState.seed).toBe(40);
          expect(read('src/three.js')).toBe('export const untouched = false;\n');
          // LLM now reads `state.seed` set by the operator in the shared REPL:
          yield {
            t: 'text',
            delta: '```da_ops\n{"ops": [{"op": "tx", "description": "consume operator state", "code": "state.total = state.seed + 2; return state.total;"}]}\n```',
          };
          yield { t: 'usage', in: 80, out: 20, cacheRead: 0, cacheWrite: 0 };
          yield { t: 'stop', reason: 'end_turn' };
          return;
        }
        yield { t: 'text', delta: 'All done: total is 42.' };
        yield { t: 'usage', in: 100, out: 10, cacheRead: 0, cacheWrite: 0 };
        yield { t: 'stop', reason: 'end_turn' };
      },
    };

    const { agent } = makeTestAgent(provider);
    holder.agent = agent;

    const queuedEvents = [];
    const appliedEvents = [];
    agent.on('tx-queued', (e) => queuedEvents.push(e));
    agent.on('tx-applied', (e) => appliedEvents.push(e));

    await agent.run('cooperate with me');

    expect(queuedEvents).toHaveLength(1);
    expect(appliedEvents).toHaveLength(1);
    expect(appliedEvents[0].immediate).toBe(false);
    expect(agent.txState.total).toBe(42);

    // Turn 2's prompt included the operator's REPL script and return value:
    expect(seenMessages[1]).toContain('The operator ran a `tx` script in the shared Code Mode REPL:');
    expect(seenMessages[1]).toContain('return:\n40');

    // Unified REPL transcript holds both the operator entry and the LLM entry in order:
    const snap = agent.txSnapshot();
    expect(snap.entries.map((e) => e.origin)).toEqual(['operator', 'agent']);
    expect(snap.entries[1].output).toBe('42');
  });
});