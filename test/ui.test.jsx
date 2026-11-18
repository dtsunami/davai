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
 * Wait for `text` to reach the rendered output.
 *
 * App.jsx batches streaming deltas into frames every FRAME_MS (33), so anything asserted
 * straight after a `text` or `thinking` emit depends on that timer having fired. A fixed
 * sleep is a race against it: under the full parallel suite the event loop is contended
 * enough that 60ms occasionally is not enough, which is what made these tests fail about
 * one run in three while passing every time in isolation. Poll for the frame instead of
 * guessing how long it takes to arrive.
 */
const waitForText = async (stdout, text, timeout = 2000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (stdout.frames.join('').includes(text)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${JSON.stringify(text)}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

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
    await waitForText(stdout, 'hello from the model');
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

describe('an approval answered in the browser clears the terminal pane', () => {
  /**
   * The pane is modal: App.jsx's useInput returns early while it is open and the
   * Composer is unmounted. The bus brokers the decision, so when a browser answers
   * first the agent proceeds — but nothing told the TUI, which sat on an answered
   * question with every keystroke swallowed. The only way out was to answer it again.
   */
  it('dismisses the pane and records who decided', async () => {
    const { SessionBus } = await import('../src/session/bus.js');
    const bus = new SessionBus({ agent: session.agent, cfg: session.cfg });
    session.bus = bus;

    const stdout = fakeStdout();
    const app = render(<App session={session} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();

    let decision = null;
    session.agent.emit('approval-request', {
      op: { op: 'shell', cmd: 'npm test' },
      index: 0,
      respond: (d) => { decision = d; },
    });
    await flush();
    expect(stdout.frames.join('')).toContain('needs approval');

    // The browser answers through the bus, exactly as POST /api/approve does.
    const id = bus.snapshot().pending[0].id;
    expect(bus.resolveApproval(id, { allow: true })).toBe(true);
    await flush();

    expect(decision).toEqual({ allow: true });
    const out = stdout.frames.join('');
    expect(out).toContain('approved in the browser');
    // The pane is gone: the last frame no longer asks the question.
    expect(stdout.frames.at(-1)).not.toContain('cannot be undone');

    bus.detach();
    app.unmount();
  });

  it('does not double-record when the terminal answers it', async () => {
    const { SessionBus } = await import('../src/session/bus.js');
    const bus = new SessionBus({ agent: session.agent, cfg: session.cfg });
    session.bus = bus;

    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const app = render(<App session={session} />, {
      stdout,
      stdin,
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

    stdin.write('y');
    await flush();

    const out = stdout.frames.at(-1) || '';
    // Answered locally, so the bus's own approval-resolved must not add a second line.
    expect(out).not.toContain('approved in the browser');
    const frames = stdout.frames.join('');
    const approvals = frames.split('shell approved').length - 1;
    expect(approvals).toBeGreaterThan(0);

    bus.detach();
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

  it('coalesces a multi-chunk paste burst into a single paste#1 in forward order', async () => {
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

    stdin.write('prefix ');
    await flush();

    // Simulate Windows console delivering a large paste in separate synchronous/back-to-back
    // chunks — including a middle chunk with no newline at all. Previously this shattered
    // into N pastes and spliced them in reverse order ([paste#N]...[paste#1]).
    stdin.write('chunk1 line A\r\nchunk1 part B ');
    stdin.write('chunk2 has no line breaks at all ');
    stdin.write('chunk3 finishes line B\r\nchunk3 line C');
    await flush();

    stdin.write(' suffix');
    await flush();
    stdin.write('\r');
    await flush();

    expect(session.pastes.n).toBe(1);
    expect(session.pastes.get(1).text).toBe(
      'chunk1 line A\nchunk1 part B chunk2 has no line breaks at all chunk3 finishes line B\nchunk3 line C',
    );
    expect(submitted).toEqual(['prefix [paste#1] suffix']);
    app.unmount();
  });

  it('expands a pasted block when steering a running turn', async () => {
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    const steered = [];
    session.agent.run = () => new Promise(() => {});
    session.agent.steer = (text, segments) => {
      steered.push({ text, segments });
      return true;
    };

    const app = render(<App session={session} initialInput="start working" />, {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    session.agent.emit('turn-start');
    await flush();

    stdin.write('here is the log ');
    await flush();
    stdin.write('error line 1\r\nerror line 2\r\nerror line 3');
    await flush();
    stdin.write('\r');
    await flush();

    expect(steered).toHaveLength(1);
    expect(steered[0].text).toBe('here is the log [paste#1]');
    expect(steered[0].segments).toEqual([
      expect.objectContaining({
        type: 'paste',
        label: 'paste#1 (3 lines)',
        text: '[paste#1]\nerror line 1\nerror line 2\nerror line 3',
      }),
    ]);
    app.unmount();
  });

  it('coalesces a multi-chunk DECSET 2004 bracketed paste without premature flush when steering', async () => {
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    const steered = [];
    session.agent.run = () => new Promise(() => {});
    session.agent.steer = (text, segments) => {
      steered.push({ text, segments });
      return true;
    };

    const app = render(<App session={session} initialInput="start working" />, {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    session.agent.emit('turn-start');
    await flush();

    // Terminal sends \x1b[200~ in chunk 1, plain body in chunk 2 (no ESC!), and \x1b[201~ in chunk 3.
    // Previously chunk 1 armed `b.timer`, and chunk 2 saw `b.timer` truthy and prematurely flushed
    // chunk 1, dropping bracketed state so chunk 3's \x1b[201~ and newlines corrupted the steer!
    stdin.write('fix ');
    await flush();
    stdin.write('\x1b[200~trace line 1\n');
    stdin.write('trace line 2 without esc\n');
    stdin.write('trace line 3\x1b[201~');
    await flush();
    stdin.write('\r');
    await flush();

    expect(session.pastes.n).toBe(1);
    expect(steered).toHaveLength(1);
    expect(steered[0].text).toBe('fix [paste#1]');
    expect(steered[0].segments).toEqual([
      expect.objectContaining({
        type: 'paste',
        label: 'paste#1 (3 lines)',
        text: '[paste#1]\ntrace line 1\ntrace line 2 without esc\ntrace line 3',
      }),
    ]);
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
    await waitForText(stdout, 'never collapses runs');

    const out = stdout.frames.join('');
    expect(out).toContain('thinking');
    expect(out).toMatch(/[╭┌]/); // the box is drawn, not plain text
    app.unmount();
  });

  it('drops the box once the answer starts', async () => {
    const { stdout, app } = renderApp();
    await flush();
    session.agent.emit('turn-start');
    session.agent.emit('thinking', 'weighing two approaches');
    await waitForText(stdout, 'weighing two approaches');

    session.agent.emit('text', 'Here is what I found.');
    await waitForText(stdout, 'Here is what I found.');
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
    await waitForText(stdout, 'internal deliberation');

    // Everything written from here on is the commit of this turn.
    const before = stdout.frames.length;
    session.agent.emit('turn-end', { text: 'Done.' });
    await waitForText(stdout, 'Done.');

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

describe('escape cancellation', () => {
  it('cancels a running ops batch on Escape and returns cleanly on cancelled event', async () => {
    let cancelCalls = 0;
    session.agent.cancel = () => {
      cancelCalls++;
    };
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    const app = render(<App session={session} />, {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();

    session.agent.emit('turn-start');
    session.agent.emit('turn-end', { text: 'running tests', ttftMs: 10, durationMs: 20, effort: 'high' });
    session.agent.emit('ops-parsed', [{ op: 'shell', cmd: 'pytest -v' }]);
    await waitForText(stdout, 'running 1 op');

    stdin.write('\u001b');
    await flush();
    expect(cancelCalls).toBe(1);
    await waitForText(stdout, 'cancelling');

    session.agent.emit('cancelled');
    await waitForText(stdout, 'cancelled');
    app.unmount();
  });

  it('aborts an in-flight operator sh command on Escape', async () => {
    const ctl = new AbortController();
    session.shellController = ctl;
    const stdout = fakeStdout();
    const stdin = fakeStdin();
    const app = render(<App session={session} />, {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();

    stdin.write('\u001b');
    await flush();
    expect(ctl.signal.aborted).toBe(true);
    app.unmount();
  });
});

describe('tx Code Mode TUI rendering regressions (blenderbot session 2531b2cee2)', () => {
  it('bounds 64KB single-line JSON tx outputs and strips raw ANSI/CRLF/tabs in App.jsx', async () => {
    session.cfg.codeMode = true;
    const stdout = fakeStdout(100);
    const app = render(<App session={session} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();

    const beforeLen = stdout.frames.join('').length;
    // Exact shape from blenderbot session: JSON.stringify(out, null, 2) where 2 keys hold
    // 8KB + 55KB escaped source strings on single lines, plus ANSI/CR/tab hazards.
    const hugeJson = JSON.stringify(
      {
        'davag/src/davag/agent/parser.py': 'x'.repeat(8500) + '\r\n\t\u001b[2J\u001b[31mBOOM',
        'davag/src/davag/agent/executor.py': 'y'.repeat(55_000),
      },
      null,
      2,
    ).slice(0, 64_000);

    const op = {
      op: 'tx',
      description: 'read davag agent, context, providers, session, cli, tui',
      code: 'const files = ["a.py", "b.py"];\nconst out = {};\nfor (const f of files) out[f] = read(f);\nreturn out;',
    };
    session.agent.emit('ops-parsed', [op]);
    session.agent.emit('ops-result', {
      ops: [op],
      outcome: {
        status: 'ok',
        errors: [],
        results: [
          {
            index: 0,
            op: 'tx',
            ok: true,
            result: {
              opsCount: 10,
              changes: [],
              logs: ['loaded\tfiles\r\n\u001b[2Jclear-attempt ' + 'z'.repeat(500)],
              output: hugeJson,
            },
          },
        ],
      },
    });
    await waitForText(stdout, '/tx for full output');

    const delta = stdout.frames.join('').slice(beforeLen);
    // Must not dump 64KB into Ink <Static> or pass raw clear-screen CSI sequences through:
    expect(delta.length).toBeLessThan(4000);
    expect(delta).not.toContain('\u001b[2J');
    expect(delta).toContain('tx: read davag agent');
    expect(delta).toContain('10 fs ops (read-only)');
    expect(delta).toContain('63.6k chars, 4 lines');
    // Does not duplicate raw op.code lines underneath `ops` in chat scrollback:
    expect(delta).not.toContain('for (const f of files) out[f] = read(f);');
    app.unmount();
  });

  it('keeps full <App /> live region (TxPane + StatusBar) <= stdout.rows at 80x24 and 100x30', async () => {
    const { sanitizeTerminalText } = await import('../src/ui/theme.js');
    session.cfg.codeMode = true;
    const hugeJson = JSON.stringify(
      {
        'a.py': 'a'.repeat(12_000),
        'b.py': 'b'.repeat(52_000),
      },
      null,
      2,
    ).slice(0, 64_000);
    session.agent.txSnapshot = () => ({
      codeMode: true,
      queued: [{ position: 1, code: 'state.x = 1', ts: Date.now() }],
      stateKeys: ['cache', 'files'],
      statePreview: { cache: 'v'.repeat(300), files: '["a.py","b.py"]' },
      entries: Array.from({ length: 12 }, (_, idx) => ({
        seq: idx + 1,
        origin: idx % 2 === 0 ? 'agent' : 'operator',
        turn: idx + 1,
        description: `batch #${idx + 1} reading davag modules`,
        code: Array.from({ length: 20 }, (__, i) => `const line${i} = ${i};`).join('\r\n'),
        ok: true,
        opsCount: 10,
        changes: [],
        logs: ['step1\tstep2\u001b[31m'],
        output: hugeJson,
      })),
    });

    for (const [cols, rows] of [
      [80, 24],
      [100, 30],
    ]) {
      const stdout = fakeStdout(cols);
      stdout.rows = rows;
      const stdin = fakeStdin();
      const app = render(<App session={session} />, {
        stdout,
        stdin,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await flush();

      stdin.write('/tx');
      await flush();
      stdin.write('\r');
      await waitForText(stdout, 'Code Mode REPL');

      const rawFrame = [...stdout.frames].reverse().find((f) => f.includes('Code Mode REPL')) || '';
      const frame = sanitizeTerminalText(rawFrame);
      const renderedRows = frame.split('\n').length;
      // Invariant: full dynamic region (<TxPane> + <StatusBar>) MUST fit inside stdout.rows
      // so Ink's cursor-up erase never overflows the viewport and smears scrollback.
      expect(renderedRows).toBeLessThanOrEqual(rows);
      expect(frame).toContain('64.0k chars');
      expect(frame).toContain('more line(s)');
      expect(frame).not.toContain('\t');
      app.unmount();
    }
  });

  it('bounds and sanitizes operator tx-eval (tx-applied) entries with CRLF, tabs, ANSI, and 64KB output', async () => {
    const stdout = fakeStdout(90);
    const app = render(<App session={session} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();

    const beforeLen = stdout.frames.join('').length;
    session.agent.emit('tx-applied', {
      applied: 1,
      immediate: true,
      entries: [
        {
          seq: 1,
          origin: 'operator',
          ok: true,
          opsCount: 4,
          durationMs: 12,
          changes: Array.from({ length: 14 }, (_, i) => ({
            path: `src/mod${i}.js`,
            action: 'replaced',
            delta: 2,
          })),
          logs: ['\u001b[2Jtab\there\r\nline2 ' + 'q'.repeat(400)],
          output: JSON.stringify({ big: 'w'.repeat(63_900) }, null, 2),
        },
      ],
    });
    await waitForText(stdout, 'tx (operator):');

    const delta = stdout.frames.join('').slice(beforeLen);
    expect(delta.length).toBeLessThan(5000);
    expect(delta).not.toContain('\u001b[2J');
    expect(delta).not.toContain('\t');
    expect(delta).toContain('+4 more file(s)');
    expect(delta).toContain('/tx for full output');
    app.unmount();
  });

  it('never column-shreds StatusBar or live Spinner meter row when overflowing 80 or 100 cols', async () => {
    const { StatusBar } = await import('../src/ui/StatusBar.jsx');
    const { sanitizeTerminalText } = await import('../src/ui/theme.js');
    const cfg = {
      ...session.cfg,
      cwd: path.join(base, 'blenderbot'),
      codeMode: true,
      yolo: true,
      model: { ...session.cfg.model, id: 'gemini-4-carbon', effort: true },
      effort: 'high',
    };
    const fakeLedger = { tokens: 207_878, limit: 1_000_000 };
    const stats = { turns: 17, ops: 39, cost: 1.646, costEstimated: true };
    const throughput = {
      snapshot: () => ({
        active: true,
        currentTps: 54,
        avgTps: 54,
        series: [10, 20, 35, 50, 60, 55, 48, 52, 54, 54],
      }),
    };

    for (const cols of [80, 100]) {
      const stdout = fakeStdout(cols);
      const app = render(
        <StatusBar
          cfg={cfg}
          ledger={fakeLedger}
          stats={stats}
          throughput={throughput}
          width={cols}
          exitArmed={false}
        />,
        {
          stdout,
          stdin: fakeStdin(),
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await flush();

      const rawFrame = [...stdout.frames].reverse().find((f) => f.includes('blenderbot')) || '';
      const lines = sanitizeTerminalText(rawFrame)
        .split('\n')
        .filter((l) => l.trim().length > 0);
      // Invariant: horizontal status chrome must stay strictly 1 row, never flex-shrunk strips.
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('blenderbot');
      expect(lines[0]).toContain('tx');
      expect(lines[0]).toContain('gemini-4-carbon');
      app.unmount();
    }

    // Same 1-row invariant on the live Spinner + formatMeter + sparkline + steer hint bar:
    session.cfg.codeMode = true;
    session.agent.run = () => new Promise(() => {});
    const stdout = fakeStdout(80);
    const app = render(<App session={session} initialInput="run heavy turn" />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();
    session.agent.emit('turn-start');
    session.agent.emit('thinking', 't'.repeat(25_000));
    session.agent.emit('text', 'hello ');
    await waitForText(stdout, 'thinking…');
    await flush();

    const rawLive = [...stdout.frames].reverse().find((f) => f.includes('thinking…')) || '';
    const spinLines = sanitizeTerminalText(rawLive)
      .split('\n')
      .filter((l) => l.includes('thinking…'));
    expect(spinLines).toHaveLength(1);
    expect(spinLines[0].length).toBeLessThanOrEqual(80);
    app.unmount();
  });

  it('toggles Composer ctrl+x tx REPL mode and submits prefixed tx snippets', async () => {
    const submitted = [];
    session.agent.runOperatorTx = (code) => {
      submitted.push(code);
      return { queued: false, entry: { ok: true, opsCount: 1, changes: [] } };
    };
    const stdout = fakeStdout(100);
    const stdin = fakeStdin();
    const app = render(<App session={session} />, {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();

    // Ctrl+X enters tx REPL mode:
    stdin.write('\x18');
    await waitForText(stdout, 'tx repl mode');

    stdin.write('glob("src/**/*.js")');
    await flush();
    stdin.write('\r');
    await flush();

    expect(submitted).toEqual(['glob("src/**/*.js")']);
    app.unmount();
  });

  it('caps live streaming output to a viewport tail window while committing full text at turn-end', async () => {
    const stdout = fakeStdout(80);
    stdout.rows = 24;
    const app = render(<App session={session} />, {
      stdout,
      stdin: fakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();

    const bigTurn = Array.from({ length: 200 }, (_, i) => `line-${i + 1}: payload content`).join('\n');
    session.agent.emit('turn-start');
    session.agent.emit('text', bigTurn);
    await waitForText(stdout, 'line-200: payload content');
    await waitForText(stdout, 'earlier streaming lines');

    // Live frame shows the tail and the hidden-line banner, not all 200 lines at once:
    const liveFrame = lastRender(stdout);
    expect(liveFrame).toContain('earlier streaming lines');
    expect(liveFrame).toContain('line-200: payload content');
    expect(liveFrame).not.toContain('line-1: payload content');

    // Once the turn finishes, the full untruncated assistant message commits to <Static>:
    session.agent.emit('turn-end', { text: bigTurn, ttftMs: 10, durationMs: 50 });
    await waitForText(stdout, 'line-1: payload content');
    app.unmount();
  });
});
