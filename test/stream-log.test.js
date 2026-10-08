import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StreamLog, readStream, STREAM_FILE } from '../src/session/stream.js';
import { Agent } from '../src/agent/loop.js';
import { Ledger } from '../src/context/ledger.js';
import { Artifacts } from '../src/context/artifacts.js';
import { Sandbox } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';
import { Journal } from '../src/agent/journal.js';
import { resolveModel } from '../src/config/models.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-stream-'));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
});

describe('StreamLog', () => {
  it('writes deltas to disk before the turn ends', () => {
    const s = new StreamLog({ dir, flushBytes: 4 });
    s.begin(1);
    s.write('thinking', 'abcdefgh');

    // No end(), no close() — this is the SIGKILL case.
    const turns = readStream(dir);
    expect(turns).toHaveLength(1);
    expect(turns[0].thinking).toBe('abcdefgh');
    expect(turns[0].status).toBe('open');
    s.close();
  });

  it('keeps the two channels separate and ordered', () => {
    const s = new StreamLog({ dir, flushBytes: 1 });
    s.begin(1);
    s.write('thinking', 'think ');
    s.write('text', 'say ');
    s.write('thinking', 'more');
    s.end({ status: 'ok', stop: 'end_turn' });
    s.close();

    const [t] = readStream(dir);
    expect(t.thinking).toBe('think more');
    expect(t.text).toBe('say ');
    expect(t.status).toBe('ok');
    expect(t.stop).toBe('end_turn');
  });

  it('coalesces a run of deltas into one line', () => {
    const s = new StreamLog({ dir });
    s.begin(1);
    for (let i = 0; i < 50; i++) s.write('text', 'x');
    s.end();
    s.close();

    const lines = fs.readFileSync(path.join(dir, STREAM_FILE), 'utf8').trim().split('\n');
    // start, one coalesced run, end
    expect(lines).toHaveLength(3);
    expect(readStream(dir)[0].text).toBe('x'.repeat(50));
  });

  it('records each turn separately and survives a torn final line', () => {
    const s = new StreamLog({ dir });
    s.begin(1);
    s.write('text', 'one');
    s.end();
    s.begin(2);
    s.write('text', 'two');
    s.flush();
    s.close();

    fs.appendFileSync(path.join(dir, STREAM_FILE), '{"turn":3,"ch":"te');

    const turns = readStream(dir);
    expect(turns.map((t) => t.text)).toEqual(['one', 'two']);
    expect(turns[1].status).toBe('open');
  });

  it('redacts credentials on the way to disk', () => {
    const s = new StreamLog({ dir, flushBytes: 1 });
    s.begin(1);
    s.write('text', 'key is sk-abcdefghijklmnopqrstuvwxyz done');
    s.end();
    s.close();

    const raw = fs.readFileSync(path.join(dir, STREAM_FILE), 'utf8');
    expect(raw).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(readStream(dir)[0].text).toContain('<redacted>');
  });

  it('is inert once a write fails rather than throwing', () => {
    const s = new StreamLog({ dir });
    s.broken = true;
    expect(() => {
      s.begin(1);
      s.write('text', 'ignored');
      s.end();
      s.close();
    }).not.toThrow();
    expect(readStream(dir)).toEqual([]);
  });

  it('returns nothing for a session with no stream file', () => {
    expect(readStream(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('the agent writes streamed output as it arrives', () => {
  function makeAgent(provider, stream) {
    const root = fs.realpathSync(dir);
    const model = resolveModel('anthropic', 'claude-opus-5');
    const ledger = new Ledger({ limit: model.context, compactAt: 0.75 });
    ledger.setSystem('system prompt');
    return new Agent({
      cfg: { cwd: root, home: root, provider: 'anthropic', roDirs: [], model },
      provider,
      makeProvider: () => provider,
      ledger,
      sandbox: new Sandbox({ cwd: root, roDirs: [], ignore: DaIgnore.fromDir(root) }),
      journal: new Journal({ dir: path.join(dir, 'session') }),
      artifacts: new Artifacts(),
      log: { event: () => {}, addUsage: () => {}, addOps: () => {}, stream },
    });
  }

  it('persists thinking from a turn that dies mid-stream', async () => {
    const stream = new StreamLog({ dir, flushBytes: 1 });
    const provider = {
      async *send() {
        yield { t: 'thinking', delta: 'half a thought' };
        throw Object.assign(new Error('connection reset'), { retryable: false });
      },
    };
    const agent = makeAgent(provider, stream);
    agent.on('thinking', () => {});
    agent.on('text', () => {});
    agent.on('error', () => {});
    await agent.run('go');
    stream.close();

    const [t] = readStream(dir);
    expect(t.thinking).toBe('half a thought');
    expect(t.status).toBe('error');
    expect(t.error).toContain('connection reset');
  });

  it('keeps a discarded retry attempt alongside the one that worked', async () => {
    const stream = new StreamLog({ dir, flushBytes: 1 });
    let call = 0;
    const provider = {
      async *send() {
        if (call++ === 0) {
          yield { t: 'thinking', delta: 'first try' };
          throw Object.assign(new Error('503'), { retryable: true, retryAfterMs: 1 });
        }
        yield { t: 'text', delta: 'done' };
        yield { t: 'stop', reason: 'end_turn' };
      },
    };
    const agent = makeAgent(provider, stream);
    agent.on('thinking', () => {});
    agent.on('text', () => {});
    agent.on('retry', () => {});
    agent.on('done', () => {});
    await agent.run('go');
    stream.close();

    const [t] = readStream(dir);
    expect(t.thinking).toBe('first try');
    expect(t.text).toBe('done');
    expect(t.status).toBe('ok');
    expect(t.attempts).toBe(2);
  });
});