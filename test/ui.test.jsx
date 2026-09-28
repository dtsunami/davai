import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
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

/**
 * A stdin Ink will actually read from. It has to be a real Readable — Ink ignores a bare
 * EventEmitter, so `stream.write(...)` here is the only way a test can press a key.
 */
function fakeStdin() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
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

/**
 * The most recent complete render. Ink writes control sequences as their own chunks, so
 * `frames.at(-1)` is often just an escape code; the status bar's model id anchors a frame
 * that actually holds the UI.
 */
const lastRender = (stdout) =>
  [...stdout.frames].reverse().find((f) => f.includes('claude-opus-5')) || '';

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

describe('formatMeter', () => {
  it('shows sub-minute elapsed time to a tenth', async () => {
    const { formatMeter } = await import('../src/ui/theme.js');
    expect(formatMeter({ ms: 3240, chars: 0, thought: 0, ops: 0 })).toBe('3.2s');
  });

  it('switches to minutes and pads the seconds', async () => {
    const { formatMeter } = await import('../src/ui/theme.js');
    expect(formatMeter({ ms: 63_000, chars: 0, thought: 0, ops: 0 })).toBe('1m 03s');
  });

  it('abbreviates thousands and pluralizes ops', async () => {
    const { formatMeter } = await import('../src/ui/theme.js');
    const out = formatMeter({ ms: 1000, chars: 1234, thought: 900, ops: 1 });
    expect(out).toContain('1.2k chars');
    expect(out).toContain('900 thought');
    expect(out).toContain('1 op');
    expect(out).not.toContain('1 ops');
    expect(formatMeter({ ms: 1000, chars: 0, thought: 0, ops: 2 })).toContain('2 ops');
  });

  it('omits counters that are still zero', async () => {
    const { formatMeter } = await import('../src/ui/theme.js');
    expect(formatMeter({ ms: 500, chars: 0, thought: 0, ops: 0 })).toBe('0.5s');
  });
});

describe('the spinner meter', () => {
  it('reports elapsed time and streamed characters beside the spinner', async () => {
    const stdout = fakeStdout();
    const app = render(<App session={session} initialInput="go" />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    session.agent.emit('turn-start');
    session.agent.emit('text', 'x'.repeat(1500));
    await flush();

    const out = lastRender(stdout);
    expect(out).toMatch(/\d+\.\d+s/); // the timer
    expect(out).toContain('1.5k chars');
    expect(out).toContain('to steer');
    app.unmount();
  });
});

describe('steering from the composer', () => {
  it('steers the run in progress instead of starting another', async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const steered = [];
    let resolveRun;
    session.agent.run = () => new Promise((r) => (resolveRun = r));
    session.agent.steer = (text) => {
      steered.push(text);
      return true;
    };

    const app = render(<App session={session} initialInput="do the thing" />, {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    session.agent.emit('turn-start'); // now busy
    await flush();

    stdin.write('use tabs instead');
    await flush();
    stdin.write('\r');
    await flush();

    expect(steered).toEqual(['use tabs instead']);
    resolveRun?.();
    app.unmount();
  });

  it('still runs a slash command while busy rather than steering with it', async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const steered = [];
    session.agent.run = () => new Promise(() => {});
    session.agent.steer = (t) => {
      steered.push(t);
      return true;
    };

    const app = render(<App session={session} initialInput="work" />, {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    session.agent.emit('turn-start');
    await flush();

    stdin.write('/help');
    await flush();
    stdin.write('\r');
    await flush();

    expect(steered).toEqual([]);
    expect(stdout.frames.join('')).toContain('/yolo');
    app.unmount();
  });
});

describe('paste capture', () => {
  it('stores a CR-separated paste and inserts the placeholder instead of submitting', async () => {
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    const submitted = [];
    session.agent.run = async (text) => submitted.push(text);

    const app = render(<App session={session} />, {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();

    // One burst, Windows line endings: the shape that used to submit line one and
    // scatter the rest.
    stdin.write('first line\rsecond line\rthird line');
    await flush();

    const out = stdout.frames.join('');
    expect(out).toContain('paste#1');
    expect(out).toContain('3 lines');
    expect(submitted).toEqual([]);
    expect(session.pastes.get(1).text).toBe('first line\nsecond line\nthird line');
    app.unmount();
  });
});

describe('thinking panel', () => {
  const renderApp = () => {
    const stdout = fakeStdout();
    const app = render(<App session={session} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    return { stdout, app };
  };

  it('shows reasoning deltas in a labelled box', async () => {
    const { stdout, app } = renderApp();
    await flush();
    session.agent.emit('turn-start');
    session.agent.emit('thinking', 'The slug helper lowercases but never collapses runs.');
    await flush();

    const out = stdout.frames.join('');
    expect(out).toContain('thinking');
    expect(out).toContain('never collapses runs');
    expect(out).toMatch(/[╭┌]/); // the box is drawn, not plain text
    app.unmount();
  });

  it('drops the box once the answer starts', async () => {
    const { stdout, app } = renderApp();
    await flush();
    session.agent.emit('turn-start');
    session.agent.emit('thinking', 'weighing two approaches');
    await flush();
    expect(stdout.frames.join('')).toContain('weighing two approaches');

    session.agent.emit('text', 'Here is what I found.');
    await flush();
    const last = lastRender(stdout);
    expect(last).toContain('Here is what I found.');
    expect(last).not.toContain('weighing two approaches');
    app.unmount();
  });

  it('keeps thoughts out of the committed transcript', async () => {
    const { stdout, app } = renderApp();
    await flush();
    session.agent.emit('turn-start');
    session.agent.emit('thinking', 'internal deliberation');
    await flush();

    // Everything written from here on is the commit of this turn.
    const before = stdout.frames.length;
    session.agent.emit('turn-end', { text: 'Done.' });
    await flush();

    const committed = stdout.frames.slice(before).join('');
    expect(committed).toContain('Done.');
    expect(committed).not.toContain('internal deliberation');
    app.unmount();
  });

  it('shows nothing when no thoughts arrive', async () => {
    const { stdout, app } = renderApp();
    await flush();
    session.agent.emit('turn-start');
    session.agent.emit('text', 'straight to the answer');
    await flush();
    expect(stdout.frames.join('')).not.toContain('thinking\n');
    app.unmount();
  });
});

describe('wrapTail', () => {
  it('keeps only the last lines so the box cannot grow without bound', async () => {
    const { wrapTail } = await import('../src/ui/ThinkingBox.jsx');
    const text = Array.from({ length: 40 }, (_, i) => `line number ${i}`).join('\n');
    const lines = wrapTail(text, 40, 6);
    expect(lines).toHaveLength(6);
    expect(lines.at(-1)).toBe('line number 39');
  });

  it('wraps long prose to the given width', async () => {
    const { wrapTail } = await import('../src/ui/ThinkingBox.jsx');
    const lines = wrapTail('aaa bbb ccc ddd eee fff', 11, 10);
    expect(lines).toEqual(['aaa bbb ccc', 'ddd eee fff']);
  });

  it('is empty for empty input', async () => {
    const { wrapTail } = await import('../src/ui/ThinkingBox.jsx');
    expect(wrapTail('', 40, 6)).toEqual([]);
    expect(wrapTail('   \n\n  ', 40, 6)).toEqual([]);
  });
});

describe('yolo mode', () => {
  const renderApp = () => {
    const stdout = fakeStdout();
    const app = render(<App session={session} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    return { stdout, app };
  };

  it('auto-approves shell without showing the prompt', async () => {
    session.cfg.yolo = true;
    const { stdout, app } = renderApp();
    await flush();

    let decision = null;
    session.agent.emit('approval-request', {
      op: { op: 'shell', cmd: 'npm test' },
      index: 0,
      respond: (d) => {
        decision = d;
      },
    });
    await flush();

    expect(decision).toEqual({ allow: true });
    const out = stdout.frames.join('');
    expect(out).toContain('auto-approved (yolo)');
    expect(out).toContain('npm test');
    expect(out).not.toContain('needs approval');
    app.unmount();
  });

  it('flags yolo in the status bar', async () => {
    session.cfg.yolo = true;
    const { stdout, app } = renderApp();
    await flush();
    expect(stdout.frames.join('')).toContain('yolo');
    app.unmount();
  });

  it('leaves the status bar alone when off', async () => {
    const { stdout, app } = renderApp();
    await flush();
    expect(stdout.frames.join('')).not.toContain('yolo');
    app.unmount();
  });

  it('still prompts when off', async () => {
    const { stdout, app } = renderApp();
    await flush();
    let responded = false;
    session.agent.emit('approval-request', {
      op: { op: 'shell', cmd: 'rm -rf /' },
      index: 0,
      respond: () => {
        responded = true;
      },
    });
    await flush();
    expect(responded).toBe(false);
    expect(stdout.frames.join('')).toContain('needs approval');
    app.unmount();
  });

  it('/yolo toggles the running session and is never persisted', async () => {
    const { handleCommand } = await import('../src/ui/commands.js');
    const { loadSettings, saveSettings } = await import('../src/config/settings.js');
    const pushed = [];
    const deps = {
      session,
      push: (e) => pushed.push(e),
      setPane: () => {},
      exit: () => {},
      refresh: () => {},
    };

    await handleCommand('/yolo', deps);
    expect(session.cfg.yolo).toBe(true);
    expect(pushed.at(-1).message).toMatch(/yolo on/);

    await handleCommand('/yolo', deps);
    expect(session.cfg.yolo).toBe(false);

    await handleCommand('/yolo on', deps);
    expect(session.cfg.yolo).toBe(true);
    await handleCommand('/yolo off', deps);
    expect(session.cfg.yolo).toBe(false);

    await handleCommand('/yolo maybe', deps);
    expect(session.cfg.yolo).toBe(false);
    expect(pushed.at(-1).message).toMatch(/takes on or off/);

    // Persisted settings must never carry it forward into the next session.
    session.cfg.yolo = true;
    saveSettings(session.cfg.home, { ...session.cfg, yolo: true });
    expect(loadSettings(session.cfg.home).yolo).toBeUndefined();
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
