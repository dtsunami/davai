import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { App } from '../src/ui/App.jsx';
import { Ledger } from '../src/context/ledger.js';
import { Artifacts } from '../src/context/artifacts.js';
import { Pastes } from '../src/context/pastes.js';
import { Sandbox } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';
import { Journal } from '../src/agent/journal.js';
import { resolveModel } from '../src/config/models.js';

/** A stdout Ink can draw into, capturing frames. */
function fakeStdout(columns = 100) {
  const frames = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      frames.push(chunk.toString());
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = 30;
  stream.isTTY = true;
  stream.frames = frames;
  return stream;
}

function fakeStdin() {
  const stream = new EventEmitter();
  stream.isTTY = true;
  stream.setRawMode = () => {};
  stream.setEncoding = () => {};
  stream.resume = () => {};
  stream.pause = () => {};
  stream.read = () => null;
  stream.unref = () => {};
  stream.ref = () => {};
  return stream;
}

let base;
let session;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-ui-'));
  fs.mkdirSync(path.join(base, 'project'), { recursive: true });
  const root = fs.realpathSync(path.join(base, 'project'));
  fs.writeFileSync(path.join(root, 'index.js'), 'export const x = 1;\n');

  const model = resolveModel('anthropic', 'claude-opus-5');
  const cfg = {
    cwd: root,
    home: base,
    provider: 'anthropic',
    model,
    effort: 'high',
    maxTokens: 32000,
    contextLimit: model.context,
    compactAt: 0.75,
    shellTimeout: 5000,
    roDirs: [],
    envFiles: [],
    keys: { anthropic: 'sk-ant-test' },
  };

  const ledger = new Ledger({ limit: model.context, compactAt: 0.75 });
  ledger.setSystem('system prompt here');
  ledger.add({ type: 'grounding', label: 'project grounding', role: 'user', text: 'grounding text' });

  const agent = new EventEmitter();
  agent.stats = { turns: 0, ops: 0, cost: 0 };
  agent.run = async () => {};
  agent.cancel = () => {};

  session = {
    cfg,
    agent,
    ledger,
    sandbox: new Sandbox({ cwd: root, roDirs: [], ignore: DaIgnore.fromDir(root) }),
    journal: new Journal({ dir: path.join(base, 'session') }),
    artifacts: new Artifacts(),
    pastes: new Pastes(),
    log: { id: 'test123', dir: base, close: () => {}, event: () => {}, meta: {} },
  };
});

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* windows handle */
  }
});

/** Let Ink flush a frame. */
const flush = () => new Promise((r) => setTimeout(r, 60));

describe('App rendering', () => {
  it('renders the status bar with model and context usage', async () => {
    const stdout = fakeStdout();
    const app = render(<App session={session} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    const out = stdout.frames.join('');
    expect(out).toContain('claude-opus-5');
    expect(out).toContain('project'); // cwd basename
    expect(out).toMatch(/\d+%/); // context percentage
    app.unmount();
  });

  it('shows streamed assistant text in the live region', async () => {
    const stdout = fakeStdout();
    const app = render(<App session={session} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    session.agent.emit('turn-start');
    session.agent.emit('text', 'hello from the model');
    await flush();
    expect(stdout.frames.join('')).toContain('hello from the model');
    app.unmount();
  });

  it('renders op lines and success results', async () => {
    const stdout = fakeStdout();
    const app = render(<App session={session} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    session.agent.emit('ops-parsed', [{ op: 'read', path: 'index.js' }]);
    session.agent.emit('ops-result', {
      ops: [{ op: 'write', path: 'new.js' }],
      outcome: {
        status: 'ok',
        errors: [],
        results: [
          { index: 0, op: 'write', ok: true, result: { path: 'new.js', action: 'created', lines: 3 } },
        ],
      },
    });
    await flush();
    const out = stdout.frames.join('');
    expect(out).toContain('read: index.js');
    expect(out).toContain('new.js created');
    app.unmount();
  });

  it('renders batch rejection with the rollback explanation', async () => {
    const stdout = fakeStdout();
    const app = render(<App session={session} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    session.agent.emit('ops-result', {
      ops: [],
      outcome: {
        status: 'plan-failed',
        results: [],
        errors: [{ index: 0, op: 'replace', message: '"old" text not found in a.js' }],
      },
    });
    await flush();
    const out = stdout.frames.join('');
    expect(out).toContain('old" text not found');
    expect(out).toContain('nothing was applied');
    app.unmount();
  });

  it('renders the shell approval prompt', async () => {
    const stdout = fakeStdout();
    const app = render(<App session={session} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    session.agent.emit('approval-request', {
      op: { op: 'shell', cmd: 'npm test' },
      index: 0,
      respond: () => {},
    });
    await flush();
    const out = stdout.frames.join('');
    expect(out).toContain('needs approval');
    expect(out).toContain('npm test');
    expect(out).toContain('cannot be undone');
    app.unmount();
  });
});

describe('context pane', () => {
  it('lists segments Pareto-ordered with a total', async () => {
    session.ledger.add({
      type: 'op-result',
      label: 'big read',
      role: 'user',
      text: 'x'.repeat(20000),
    });
    const { ContextPane } = await import('../src/ui/ContextPane.jsx');
    const stdout = fakeStdout();
    const app = render(<ContextPane ledger={session.ledger} width={100} onClose={() => {}} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    const out = stdout.frames.join('');
    expect(out).toContain('Context');
    expect(out).toContain('big read');
    expect(out).toContain('op-result');
    app.unmount();
  });
});
