import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  tokenizeRawInput,
  createEditorState,
  applyEditorEvent,
  wordLeft,
  wordRight,
} from '../src/ui/editor.js';
import { completeInput } from '../src/ui/complete.js';
import { tokenizeInput, tokenizeShell } from '../src/ui/highlight.jsx';
import { colors } from '../src/ui/theme.js';
import { ApprovalPane } from '../src/ui/ApprovalPane.jsx';
import { App } from '../src/ui/App.jsx';
import { Ledger } from '../src/context/ledger.js';
import { Artifacts } from '../src/context/artifacts.js';
import { Pastes } from '../src/context/pastes.js';
import { Sandbox } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';
import { Journal } from '../src/agent/journal.js';
import { resolveModel } from '../src/config/models.js';

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
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => stream;
  stream.ref = () => {};
  stream.unref = () => {};
  return stream;
}

const flush = () => new Promise((r) => setTimeout(r, 60));

function runKeys(initial, rawChunks, opts = {}) {
  let state = createEditorState(initial, opts.history || []);
  const effects = [];
  const pasteState = { active: false, buffer: '' };
  for (const chunk of rawChunks) {
    for (const ev of tokenizeRawInput(chunk, pasteState)) {
      const res = applyEditorEvent(state, ev, opts);
      state = res.state;
      if (res.effect) effects.push(res.effect);
    }
  }
  return { state, effects };
}

describe('shell cursor movement and line editing', () => {
  it('moves left/right, home/end, and ctrl+a/ctrl+e cleanly', () => {
    const { state } = runKeys('git status --short', [
      '\x1b[D', '\x1b[D', // left 2 -> before 'rt'
      '!', // insert '!' -> 'git status --sho!rt'
      '\x1b[H', // Home -> 0
      'sudo ', // insert at start
      '\x1b[F', // End -> end of line
    ]);
    expect(state.value).toBe('sudo git status --sho!rt');
    expect(state.cursor).toBe(state.value.length);

    const { state: s2 } = runKeys('echo hello', ['\x01', 'time ', '\x05', '!']);
    expect(s2.value).toBe('time echo hello!');
  });

  it('steps across shell subwords (paths, extensions, flags) with Ctrl+Arrow and Alt+B/F', () => {
    const cmd = 'pytest tests/test_cli.py --max-fail=1';
    let c = cmd.length;
    c = wordLeft(cmd, c);
    expect(cmd.slice(c)).toBe('1');
    c = wordLeft(cmd, c);
    expect(cmd.slice(c)).toBe('=1');
    c = wordLeft(cmd, c);
    expect(cmd.slice(c)).toBe('fail=1');

    expect(wordRight(cmd, 0)).toBe(6); // 'pytest'

    // CSI 1;5D (Ctrl+Left) + Alt+B (\x1bb) + CSI 1;5C (Ctrl+Right)
    const { state } = runKeys('node src/index.js', ['\x1b[1;5D', '\x1bb', '\x1b[1;5C']);
    expect(state.cursor).toBe('node src/index.'.length);
  });

  it('distinguishes Backspace (backward) from Delete / Ctrl+D (forward)', () => {
    // Move to index 4 ('abcd|efgh'), Backspace removes 'd', Delete (\x1b[3~) removes 'e', Ctrl+D (\x04) removes 'f'
    const { state } = runKeys('abcdefgh', [
      '\x1b[H',
      '\x1b[C', '\x1b[C', '\x1b[C', '\x1b[C',
      '\x7f',
      '\x1b[3~',
      '\x04',
    ]);
    expect(state.value).toBe('abcgh');
    expect(state.cursor).toBe(3);
  });

  it('supports Ctrl+W, Alt+Backspace, Alt+D, Ctrl+K, Ctrl+U, Ctrl+Y yank, and Ctrl+_ undo', () => {
    // Ctrl+W rubs out back to slash/whitespace
    const { state: w1 } = runKeys('cat src/ui/ApprovalPane.jsx', ['\x17']);
    expect(w1.value).toBe('cat src/ui/');

    // Alt+D (\x1bd) kills word forward, Ctrl+Y (\x19) yanks it back
    const { state: yanked } = runKeys('git checkout main', [
      '\x1b[H', // start
      '\x1bd', // kill 'git'
      '\x1b[F', // end
      ' ',
      '\x19', // yank 'git'
    ]);
    expect(yanked.value).toBe(' checkout main git');

    // Ctrl+K kills to end of line, Ctrl+_ (\x1f) undoes it
    const { state: undone } = runKeys('npm run build --watch', [
      '\x1b[H',
      '\x1b[1;5C', // after 'npm'
      '\x0b', // Ctrl+K -> 'npm'
      '\x1f', // Ctrl+_ undo -> 'npm run build --watch'
    ]);
    expect(undone.value).toBe('npm run build --watch');

    // Ctrl+U kills back to start of line
    const { state: u1 } = runKeys('echo one two', ['\x1b[1;5D', '\x15']);
    expect(u1.value).toBe('two');
    expect(u1.cursor).toBe(0);
  });

  it('does not split astral UTF-16 surrogate pairs on arrow/backspace/delete', () => {
    const { state } = runKeys('a🚀b', ['\x1b[D', '\x7f']);
    expect(state.value).toBe('ab');
    expect(state.cursor).toBe(1);
  });

  it('navigates multiline buffers with ↑/↓ preserving column before hitting history', () => {
    const { state } = runKeys('first line here\nsec\nthird line here', [
      '\x1b[D', '\x1b[D', '\x1b[D', '\x1b[D', // col 11 on line 2
      '\x1b[A', // up to line 1 ('sec', clamped to len 3)
      '\x1b[A', // up to line 0, restores preferred col 11!
    ], { multiline: true, enableHistory: true, history: ['older cmd'] });
    expect(state.cursor).toBe(11);
    expect(state.value).toContain('first line here');
  });

  it('preserves the unsubmitted draft when arrowing ↑ into history and ↓ back out, plus Ctrl+R search', () => {
    const history = ['git status', 'npm test', 'git diff --staged'];
    const { state } = runKeys('my draft', ['\x1b[A', '\x1b[A', '\x1b[B', '\x1b[B'], {
      enableHistory: true,
      history,
    });
    expect(state.value).toBe('my draft');

    // Ctrl+R reverse incremental search
    const { state: searched } = runKeys('', ['\x12', 'status', '\x1b[C'], {
      enableHistory: true,
      enableSearch: true,
      history,
    });
    expect(searched.search).toBeNull();
    expect(searched.value).toBe('git status');
  });
});

describe('shell and slash autocomplete + Tab/Shift+Tab cycling', () => {
  let tmp;
  let sandbox;
  let session;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'davai-comp-')));
    fs.mkdirSync(path.join(tmp, 'src', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'ui', 'App.jsx'), '');
    fs.writeFileSync(path.join(tmp, 'src', 'ui', 'ApprovalPane.jsx'), '');
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'demo', scripts: { test: 'vitest', lint: 'eslint .' } }),
    );
    sandbox = new Sandbox({ cwd: tmp, roDirs: [], ignore: DaIgnore.fromDir(tmp) });
    session = { sandbox, cfg: { home: tmp } };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('completes slash command subcommands and provider names', () => {
    const r1 = completeInput('/model openr', 12, session);
    expect(r1.value).toBe('/model openrouter ');

    const rAnt = completeInput('/model ant', 10, session);
    expect(rAnt.value).toBe('/model anthropic');
    expect(rAnt.hint).toContain('anthropic');

    const r2 = completeInput('/prompts ex', 11, session);
    expect(r2.value).toBe('/prompts export ');

    const r3 = completeInput('/yolo o', 7, session);
    expect(r3.hint).toContain('on');
    expect(r3.hint).toContain('off');
  });

  it('completes git subcommands, npm run scripts from package.json, and file paths in shell mode', () => {
    const g = completeInput('git st', 6, session, { mode: 'shell' });
    expect(g.hint).toContain('stash');
    expect(g.hint).toContain('status');

    const gUnique = completeInput('git statu', 9, session, { mode: 'shell' });
    expect(gUnique.value).toBe('git status ');

    const npmScript = completeInput('npm run li', 10, session, { mode: 'shell' });
    expect(npmScript.value).toBe('npm run lint ');

    const shComposer = completeInput('sh node src/ui/Approval', 23, session, { mode: 'composer' });
    expect(shComposer.value).toBe('sh node src/ui/ApprovalPane.jsx ');
  });

  it('completes mid-line without inserting duplicate spaces and cycles on Tab / Shift+Tab', () => {
    const mid = completeInput('git statu --short', 9, session, { mode: 'shell' });
    expect(mid.value).toBe('git status --short');
    expect(mid.cursor).toBe('git status'.length);

    // Tab #1 shows candidates at common prefix, Tab #2 picks first, Tab #3 picks second, Shift+Tab goes back!
    const complete = (v, c) => completeInput(v, c, session, { mode: 'composer' });
    const { state: s1 } = runKeys('/yol', ['\t'], { complete });
    expect(s1.value).toBe('/yolo ');

    const { state: c1 } = runKeys('/c', ['\t'], { complete });
    expect(c1.value).toBe('/c');
    expect(c1.hint).toContain('/clear');

    const { state: c2 } = runKeys('/c', ['\t', '\t'], { complete });
    expect(c2.value).toBe('/clear ');

    const { state: c3 } = runKeys('/c', ['\t', '\t', '\t'], { complete });
    expect(c3.value).toBe('/compact ');

    const { state: cBack } = runKeys('/c', ['\t', '\t', '\t', '\x1b[Z'], { complete });
    expect(cBack.value).toBe('/clear ');
  });
});

describe('live shell & prompt syntax highlighting', () => {
  let tmp;
  let sandbox;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'davai-hl-')));
    fs.writeFileSync(path.join(tmp, 'exists.txt'), 'hi\n');
    sandbox = new Sandbox({ cwd: tmp, roDirs: [], ignore: DaIgnore.fromDir(tmp) });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('colors valid commands green, sudo yellow, unknown commands red, operators magenta, flags cyan, and underlines existing files', () => {
    const cmd = 'sudo echo --flag "hi $USER" ./exists.txt && definitely_not_a_cmd_xyz';
    const spans = tokenizeShell(cmd, { sandbox });
    const spanFor = (substr) => {
      const idx = cmd.indexOf(substr);
      return spans.find((s) => idx >= s.start && idx < s.end);
    };

    expect(spanFor('sudo')).toMatchObject({ color: colors.warn, bold: true });
    expect(spanFor('echo')).toMatchObject({ color: colors.ok, bold: true });
    expect(spanFor('--flag')).toMatchObject({ color: colors.accent });
    expect(spanFor('$USER')).toMatchObject({ color: colors.accent });
    expect(spanFor('./exists.txt')).toMatchObject({ underline: true });
    expect(spanFor('&&')).toMatchObject({ color: colors.op, bold: true });
    expect(spanFor('definitely_not_a_cmd_xyz')).toMatchObject({ color: colors.err });
  });

  it('flags unclosed quotes in red and highlights slash commands and @refs in composer mode', () => {
    const badQuote = tokenizeShell('echo "unterminated', { sandbox });
    expect(badQuote.at(-1)).toMatchObject({ color: colors.err, underline: true });

    const validSlash = tokenizeInput('/model anthropic --save', { mode: 'composer', sandbox });
    expect(validSlash[0]).toMatchObject({ color: colors.accent, bold: true });
    expect(validSlash.at(-1)).toMatchObject({ color: colors.op });

    const badSlash = tokenizeInput('/notacommand', { mode: 'composer', sandbox });
    expect(badSlash[0]).toMatchObject({ color: colors.err });

    const promptSpans = tokenizeInput('inspect @exists.txt and [[paste#1: 4 lines]]', {
      mode: 'composer',
      sandbox,
    });
    const atSpan = promptSpans.find((s) => s.underline);
    expect(atSpan).toMatchObject({ color: colors.accent, bold: true, underline: true });
  });
});

describe('TUI ApprovalPane & Composer editing integration', () => {
  let base;
  let session;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-tui-edit-'));
    fs.mkdirSync(path.join(base, 'repo'), { recursive: true });
    const root = fs.realpathSync(path.join(base, 'repo'));
    fs.writeFileSync(path.join(root, 'target-file.js'), 'export default 1;\n');

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
    ledger.setSystem('sys');
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
      log: { id: 't1', dir: base, close: () => {}, event: () => {}, meta: {} },
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows handle */
    }
  });

  it('edits a shell command mid-line with cursor movement and Tab completion in ApprovalPane', async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    let decision = null;

    const app = render(
      <ApprovalPane
        request={{ op: { op: 'shell', cmd: 'node --check ' } }}
        session={session}
        onRespond={(d) => {
          decision = d;
        }}
      />,
      { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
    );
    await flush();

    // Enter edit mode ('e'), Tab-complete 'target-f' -> 'target-file.js ', jump to start (Ctrl+A),
    // prepend 'env ', and press Enter!
    stdin.write('e');
    await flush();
    stdin.write('target-f\t');
    await flush();
    stdin.write('\x01env ');
    await flush();
    stdin.write('\r');
    await flush();

    expect(decision).toEqual({
      allow: true,
      cmd: 'env node --check target-file.js ',
    });
    app.unmount();
  });

  it('moves cursor to start of line on Ctrl+A in Composer when text is present instead of wiping the draft', async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const submitted = [];
    session.agent.run = async (text) => {
      submitted.push(text);
    };

    const app = render(<App session={session} />, {
      stdout,
      stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await flush();

    stdin.write('world');
    await flush();
    // Ctrl+A jumps to index 0 instead of opening Artifacts!
    stdin.write('\x01hello ');
    await flush();
    stdin.write('\r');
    await flush();

    expect(submitted).toEqual(['hello world']);
    app.unmount();
  });
});