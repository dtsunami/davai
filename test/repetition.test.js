/**
 * The degeneracy guard's detector. Pure function, tested on its own: the interesting
 * cases are all about what it must *not* fire on, and a false positive kills a turn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, detectRepetition } from '../src/agent/loop.js';
import { Ledger } from '../src/context/ledger.js';
import { Artifacts } from '../src/context/artifacts.js';
import { Sandbox } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';
import { Journal } from '../src/agent/journal.js';
import { resolveModel } from '../src/config/models.js';

describe('detectRepetition', () => {
  it('catches a repeated line', () => {
    const unit = '    "cli": "node bin/notebookjs.js",\n';
    const hit = detectRepetition('some preamble\n' + unit.repeat(400));
    expect(hit).toBeTruthy();
    expect(hit.period).toBe(unit.length);
    expect(hit.unit).toBe(unit);
    expect(hit.repeats).toBeGreaterThanOrEqual(4);
  });

  it('catches a single repeated character', () => {
    const hit = detectRepetition('x'.repeat(5000));
    expect(hit?.period).toBe(1);
  });

  it('ignores ordinary prose', () => {
    const prose = Array.from({ length: 400 }, (_, i) => `line ${i} of a perfectly normal reply`).join('\n');
    expect(detectRepetition(prose)).toBeNull();
  });

  it('ignores a short burst of repetition', () => {
    const unit = 'la la la\n';
    expect(detectRepetition('prose '.repeat(400) + unit.repeat(20))).toBeNull();
  });

  it('ignores text shorter than the window', () => {
    expect(detectRepetition('ab'.repeat(200))).toBeNull();
  });

  it('ignores a long unit that has not repeated enough', () => {
    const unit = 'z'.repeat(600) + '\n';
    expect(detectRepetition(unit.repeat(10))).toBeNull();
  });
});

describe('the harness stops a runaway generation', () => {
  let base;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-repeat-'));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  /**
   * Streams `unit` forever, honouring the abort signal the way a real adapter does.
   * Usage arrives before the collapse, which is the case the billing fix is about.
   */
  function loopingProvider(unit) {
    let aborted = false;
    return {
      get aborted() {
        return aborted;
      },
      async *send({ signal }) {
        yield { t: 'usage', in: 1000, out: 50, cacheRead: 0, cacheWrite: 0 };
        for (let i = 0; i < 100_000; i++) {
          if (signal?.aborted) {
            aborted = true;
            const e = new Error('aborted');
            e.cancelled = true;
            throw e;
          }
          yield { t: 'text', delta: unit };
          await Promise.resolve();
        }
      },
    };
  }

  function makeAgent(p) {
    const root = fs.realpathSync(base);
    const model = resolveModel('anthropic', 'claude-opus-5');
    const ledger = new Ledger({ limit: model.context, compactAt: 0.75 });
    ledger.setSystem('system prompt');
    return new Agent({
      cfg: {
        cwd: root,
        home: root,
        provider: 'anthropic',
        shellTimeout: 5000,
        roDirs: [],
        model,
        maxTokens: 32000,
      },
      provider: p,
      makeProvider: () => p,
      ledger,
      sandbox: new Sandbox({ cwd: root, roDirs: [], ignore: DaIgnore.fromDir(root) }),
      journal: new Journal({ dir: path.join(root, '.session') }),
      artifacts: new Artifacts(),
      log: { event: () => {}, addUsage: () => {}, addOps: () => {} },
    });
  }

  it('aborts the turn, names the cycle, and does not report it as a cancellation', async () => {
    const p = loopingProvider('    "desc": "desc",\n');
    const agent = makeAgent(p);
    const ev = { error: [], warning: [], cancelled: [], done: [] };
    for (const k of Object.keys(ev)) agent.on(k, (e) => ev[k].push(e ?? {}));

    await agent.run('do the thing');

    expect(p.aborted).toBe(true);
    expect(ev.cancelled).toEqual([]);
    expect(ev.done).toEqual([]);
    expect(ev.error).toHaveLength(1);
    expect(ev.error[0].message).toMatch(/repeating \d+-character cycle/);
    expect(ev.warning.some((w) => /output is repeating/.test(w.message))).toBe(true);
    expect(agent.degenerate?.channel).toBe('text');
  });

  it('bills the aborted turn rather than reporting it as free', async () => {
    const agent = makeAgent(loopingProvider('xy\n'));
    const usage = [];
    agent.on('usage', (u) => usage.push(u));
    // EventEmitter throws an unhandled 'error' event; the guard emits one by design.
    agent.on('error', () => {});

    await agent.run('do the thing');

    expect(usage).toHaveLength(1);
    expect(usage[0].out).toBe(50);
    expect(agent.stats.cost).toBeGreaterThan(0);
  });

  it('leaves the garbage out of context', async () => {
    const agent = makeAgent(loopingProvider('    "desc": "desc",\n'));
    agent.on('error', () => {});
    await agent.run('do the thing');
    const text = JSON.stringify(agent.ledger.toMessages());
    expect(text).not.toMatch(/"desc": "desc"/);
  });
});