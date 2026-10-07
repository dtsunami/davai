import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PROMPTS,
  PROMPT_SPECS,
  buildSystemPrompt,
  opsResultPrompt,
  promptDirs,
  removedPromptVars,
  repairPrompt,
  resolvePrompts,
} from '../src/agent/prompt.js';
import { loadConfig } from '../src/config/env.js';
import { handleCommand } from '../src/ui/commands.js';
import { Sandbox } from '../src/agent/sandbox.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-prompts-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Write `files` (name -> text) into a fresh directory under the temp dir. */
function layer(name, files) {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(d, file), text);
  return d;
}

describe('resolvePrompts', () => {
  it('returns the defaults when no directories are given', () => {
    const { values, sources, layers } = resolvePrompts();
    expect(values).toEqual(DEFAULT_PROMPTS);
    expect(Object.values(sources).every((s) => s === 'default')).toBe(true);
    expect(Object.values(layers).every((l) => l === 'default')).toBe(true);
  });

  it('uses the defaults when neither directory exists', () => {
    const r = resolvePrompts({ home: path.join(dir, 'nope'), project: path.join(dir, 'nada') });
    expect(r.values).toEqual(DEFAULT_PROMPTS);
  });

  it('reads a home prompt verbatim', () => {
    const home = layer('home', { 'preamble.md': 'Home preamble.\n' });
    const r = resolvePrompts({ home });
    expect(r.values.preamble).toBe('Home preamble.\n');
    expect(r.layers.preamble).toBe('home');
    expect(r.sources.preamble).toBe(path.join(home, 'preamble.md'));
    expect(r.layers.protocol).toBe('default');
  });

  it('lets the project override home, prompt by prompt', () => {
    const home = layer('home', { 'preamble.md': 'home pre', 'nudge.md': 'home nudge' });
    const project = layer('project', { 'preamble.md': 'project pre' });
    const r = resolvePrompts({ home, project });
    expect(r.values.preamble).toBe('project pre');
    expect(r.layers.preamble).toBe('project');
    expect(r.values.nudge).toBe('home nudge');
    expect(r.layers.nudge).toBe('home');
  });

  it('round-trips the defaults exactly', () => {
    const files = Object.fromEntries(PROMPT_SPECS.map((s) => [s.file, s.text]));
    const r = resolvePrompts({ project: layer('rt', files) });
    expect(r.values).toEqual(DEFAULT_PROMPTS);
    expect(Object.values(r.layers).every((l) => l === 'project')).toBe(true);
  });

  it('rejects a whitespace-only file', () => {
    const project = layer('p', { 'nudge.md': '  \n' });
    expect(() => resolvePrompts({ project })).toThrow(/is empty/);
  });

  it('rejects an unreadable file', () => {
    const project = layer('p', {});
    fs.mkdirSync(path.join(project, 'nudge.md')); // a directory where the file should be
    expect(() => resolvePrompts({ project })).toThrow(/could not be read/);
  });

  it('rejects a template that drops its placeholder', () => {
    const p1 = layer('p1', { 'ops_result.md': 'here are the results' });
    expect(() => resolvePrompts({ project: p1 })).toThrow(/must contain \{results\}/);
    const p2 = layer('p2', { 'repair.md': 'that did not parse' });
    expect(() => resolvePrompts({ project: p2 })).toThrow(/must contain \{error\}/);
  });

  it('checks a home file even while the project shadows it', () => {
    const home = layer('home', { 'ops_result.md': 'no placeholder' });
    const project = layer('project', { 'ops_result.md': 'ok {results}' });
    expect(() => resolvePrompts({ home, project })).toThrow(/must contain \{results\}/);
  });

  it('accepts a template that keeps its placeholder', () => {
    const project = layer('p', { 'ops_result.md': 'out:\n{results}' });
    const { values } = resolvePrompts({ project });
    expect(opsResultPrompt('```da_results\nok\n```', values)).toBe('out:\n```da_results\nok\n```');
  });

  it('gives every prompt its own .md file', () => {
    const files = PROMPT_SPECS.map((s) => s.file);
    expect(new Set(files).size).toBe(files.length);
    expect(files.every((f) => /^[a-z_]+\.md$/.test(f))).toBe(true);
  });

  it('places the directories under DAVAI_HOME and the working directory', () => {
    expect(promptDirs('/h', '/w')).toEqual({
      home: path.join('/h', 'prompts'),
      project: path.join('/w', '.prompts'),
    });
  });
});

describe('removed prompt variables', () => {
  it('reports any DAVAI_PROMPT_* that is still set', () => {
    const w = removedPromptVars({
      DAVAI_PROMPT_PREAMBLE: 'x',
      DAVAI_PROMPT_NUDGE_FILE: '/f',
      DAVAI_MODEL: 'm',
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/DAVAI_PROMPT_NUDGE_FILE, DAVAI_PROMPT_PREAMBLE are no longer read/);
  });

  it('stays quiet when none are set', () => {
    expect(removedPromptVars({ PATH: '/usr/bin', DAVAI_MODEL: 'x' })).toEqual([]);
    expect(removedPromptVars({ DAVAI_PROMPT_NUDGE: '' })).toEqual([]);
  });
});

describe('prompt assembly', () => {
  it('builds the system prompt from preamble, protocol and grounding in order', () => {
    const prompts = { ...DEFAULT_PROMPTS, preamble: 'PRE', protocol: 'PROTO' };
    const out = buildSystemPrompt({ grounding: 'GROUND', prompts });
    expect(out).toBe('PRE\n\nPROTO\n\nGROUND');
  });

  it('falls back to the defaults when no prompts are passed', () => {
    const out = buildSystemPrompt({ grounding: 'GROUND' });
    expect(out).toContain('da_ops protocol');
    expect(out.endsWith('GROUND')).toBe(true);
  });

  it('wraps results and substitutes the error', () => {
    expect(opsResultPrompt('BLOCK')).toContain('BLOCK');
    expect(repairPrompt('unexpected token')).toContain('unexpected token');
  });

  it('does not treat $ patterns in substituted text as replacement syntax', () => {
    // A shell result or a parser complaint can easily contain $& or $1.
    expect(opsResultPrompt('cost is $& and $1')).toContain('cost is $& and $1');
    expect(repairPrompt('bad $& at $1')).toContain('bad $& at $1');
  });

  it('substitutes every occurrence of a placeholder', () => {
    const prompts = { ...DEFAULT_PROMPTS, opsResult: '{results}\n---\n{results}' };
    expect(opsResultPrompt('X', prompts)).toBe('X\n---\nX');
  });
});

describe('loadConfig prompt layers', () => {
  it('loads home and project prompt files and ignores the old variables', () => {
    const saved = { ...process.env };
    const home = path.join(dir, 'davai-home');
    const cwd = path.join(dir, 'proj');
    fs.mkdirSync(path.join(home, 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.prompts'), { recursive: true });
    fs.writeFileSync(path.join(home, 'prompts', 'preamble.md'), 'home pre');
    fs.writeFileSync(path.join(cwd, '.prompts', 'nudge.md'), 'project nudge');
    fs.writeFileSync(path.join(home, '.env'), 'DAVAI_PROMPT_STEER=steer {text}\n');
    try {
      for (const k of Object.keys(process.env)) if (k.startsWith('DAVAI_')) delete process.env[k];
      process.env.DAVAI_HOME = home;
      const c = loadConfig({ cwd });
      expect(c.prompts.preamble).toBe('home pre');
      expect(c.prompts.nudge).toBe('project nudge');
      expect(c.prompts.steer).toBe(DEFAULT_PROMPTS.steer);
      expect(c.promptLayers.steer).toBe('default');
      expect(c.promptDirs.project).toBe(path.join(cwd, '.prompts'));
      expect(c.warnings.some((w) => /DAVAI_PROMPT_STEER is no longer read/.test(w))).toBe(true);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('/prompts', () => {
  function setup(prompts = DEFAULT_PROMPTS) {
    fs.mkdirSync(path.join(dir, 'proj'), { recursive: true });
    const cwd = fs.realpathSync(path.join(dir, 'proj'));
    const resolved = resolvePrompts();
    const cfg = {
      cwd,
      home: path.join(dir, 'home'),
      prompts,
      promptSources: resolved.sources,
      promptLayers: resolved.layers,
      promptDirs: promptDirs(path.join(dir, 'home'), cwd),
    };
    const pushed = [];
    const events = [];
    const deps = {
      session: {
        cfg,
        ledger: {},
        sandbox: new Sandbox({ cwd }),
        log: { event: (name) => events.push(name) },
        agent: null,
        history: null,
      },
      push: (m) => pushed.push(m),
      setPane() {},
      exit() {},
      refresh() {},
    };
    return { cwd, deps, pushed, events };
  }

  it('lists where each prompt comes from', async () => {
    const { deps, pushed } = setup();
    await handleCommand('/prompts', deps);
    expect(pushed[0].type).toBe('info');
    expect(pushed[0].text).toMatch(/preamble\s+default\s+built-in/);
    expect(pushed[0].text).toContain('.prompts');
  });

  it('exports every resolved prompt verbatim, and they load back unchanged', async () => {
    const prompts = { ...DEFAULT_PROMPTS, preamble: 'custom "pre" with `ticks` and \\n' };
    const { cwd, deps, pushed, events } = setup(prompts);
    await handleCommand('/prompts export', deps);
    for (const spec of PROMPT_SPECS) {
      expect(fs.readFileSync(path.join(cwd, '.prompts', spec.file), 'utf8')).toBe(prompts[spec.key]);
    }
    expect(resolvePrompts({ project: path.join(cwd, '.prompts') }).values).toEqual(prompts);
    expect(pushed.at(-1).type).toBe('notice');
    expect(events).toContain('prompts-export');
  });

  it('refuses to overwrite without --force, and writes nothing', async () => {
    const { cwd, deps, pushed } = setup();
    const out = path.join(cwd, '.prompts');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'nudge.md'), 'mine');

    await handleCommand('/prompts export', deps);
    expect(pushed.at(-1).type).toBe('warning');
    expect(pushed.at(-1).message).toMatch(/already exists/);
    expect(fs.readFileSync(path.join(out, 'nudge.md'), 'utf8')).toBe('mine');
    expect(fs.existsSync(path.join(out, 'preamble.md'))).toBe(false);

    await handleCommand('/prompts export --force', deps);
    expect(fs.readFileSync(path.join(out, 'nudge.md'), 'utf8')).toBe(DEFAULT_PROMPTS.nudge);
  });

  it('rejects an unknown subcommand or flag', async () => {
    const { deps, pushed } = setup();
    await handleCommand('/prompts frobnicate', deps);
    await handleCommand('/prompts export --yes', deps);
    expect(pushed.map((m) => m.type)).toEqual(['warning', 'warning']);
  });
});