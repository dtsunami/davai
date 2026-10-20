import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_AGENTS_BUDGET,
  agentsBudget,
  agentsFiles,
  clip,
  resolveAgents,
  renderAgents,
} from '../src/agent/agents.js';
import { buildGrounding } from '../src/agent/grounding.js';
import { Sandbox } from '../src/agent/sandbox.js';
import { loadConfig } from '../src/config/env.js';

let dir;
let home;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-agents-'));
  home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

describe('which files are read', () => {
  it('multiplexes home and project rather than first-matching', () => {
    // The bug this replaces: a project file silently suppressed the home one, so
    // conventions that apply everywhere vanished the moment a repo had its own file.
    write(path.join(home, 'AGENTS.md'), '# home rules');
    write(path.join(dir, 'AGENTS.md'), '# project rules');

    const found = agentsFiles({ home, cwd: dir });
    expect(found.map((f) => f.source)).toEqual(['home', 'project']);
  });

  it('takes the first project name that exists, in preference order', () => {
    write(path.join(dir, 'DAVAI.md'), '# davai');
    write(path.join(dir, 'CLAUDE.md'), '# claude');
    const found = agentsFiles({ cwd: dir });
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe(path.join(dir, 'DAVAI.md'));
  });

  it('prefers AGENTS.md over the legacy names', () => {
    write(path.join(dir, 'AGENTS.md'), '# agents');
    write(path.join(dir, 'DAVAI.md'), '# davai');
    expect(agentsFiles({ cwd: dir })[0].path).toBe(path.join(dir, 'AGENTS.md'));
  });

  it('lets DAVAI_AGENTS_MD replace the search entirely', () => {
    // Replacing, not extending: an explicit list that still picks up a stray DAVAI.md
    // is worse than one that does not. Same rule as DAVAI_RO_DIRS.
    write(path.join(home, 'AGENTS.md'), '# home');
    write(path.join(dir, 'AGENTS.md'), '# project');
    const custom = write(path.join(dir, 'docs', 'rules.md'), '# custom');

    const found = agentsFiles({ home, cwd: dir, agentsFiles: [custom] });
    expect(found).toEqual([{ path: custom, source: 'env' }]);
  });

  it('does not list the same file twice when home is the project', () => {
    write(path.join(dir, 'AGENTS.md'), '# one');
    expect(agentsFiles({ home: dir, cwd: dir })).toHaveLength(1);
  });

  it('reads DAVAI_AGENTS_MD from a .env as a path list', () => {
    const a = write(path.join(dir, 'a.md'), '# a');
    const b = write(path.join(dir, 'b.md'), '# b');
    write(path.join(dir, '.env'), `DAVAI_AGENTS_MD=${[a, b].join(path.delimiter)}\n`);
    const cfg = loadConfig({ cwd: dir, env: { DAVAI_HOME: home } });
    expect(cfg.agentsFiles).toEqual([a, b]);
  });
});

describe('the budget', () => {
  it('defaults, and is clamped to a share of the context window', () => {
    expect(agentsBudget({ contextLimit: 1_000_000 })).toBe(DEFAULT_AGENTS_BUDGET);
    // 6000 tokens of standing instructions is generous at 200k and absurd at 8k.
    expect(agentsBudget({ contextLimit: 8_000 })).toBe(640);
  });

  it('honours an explicit budget under the ceiling', () => {
    expect(agentsBudget({ contextLimit: 1_000_000, agentsBudget: 1_000 })).toBe(1_000);
  });

  it('refuses to let an explicit budget exceed the ceiling', () => {
    expect(agentsBudget({ contextLimit: 100_000, agentsBudget: 99_000 })).toBe(8_000);
  });
});

describe('clipping', () => {
  it('leaves a file that fits completely alone', () => {
    const r = clip('# short\n\nbody', 1000, '/p/AGENTS.md');
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('# short\n\nbody');
  });

  it('cuts at a heading and says where the rest is', () => {
    // The old code sliced at 8000 characters mid-sentence, which reads as a complete
    // document. A heading boundary plus a pointer is the difference between the model
    // knowing to go and read the file and it never finding out.
    const text = `# one\n${'a'.repeat(400)}\n\n# two\n${'b'.repeat(400)}\n\n# three\n${'c'.repeat(400)}`;
    const r = clip(text, 500, '/p/AGENTS.md');
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('# one');
    expect(r.text).not.toContain('# three');
    expect(r.text).toMatch(/continues for a further [\d,]+ characters/);
    expect(r.text).toContain('/p/AGENTS.md');
  });

  it('cuts mid-section rather than dropping a single huge section', () => {
    // One enormous heading: the last-heading rule would throw the whole budget away.
    const text = `# only\n${'x'.repeat(5000)}`;
    const r = clip(text, 1000, '/p/AGENTS.md');
    expect(r.truncated).toBe(true);
    expect(r.keptChars).toBeGreaterThan(500);
  });
});

describe('resolveAgents', () => {
  const deps = { contextLimit: 1_000_000 };

  it('concatenates home then project, each with its own attribution', () => {
    write(path.join(home, 'AGENTS.md'), '# home rules');
    write(path.join(dir, 'AGENTS.md'), '# project rules');

    const { sections, notices } = resolveAgents({ ...deps, home, cwd: dir });
    expect(notices).toEqual([]);
    expect(sections.map((s) => s.source)).toEqual(['home', 'project']);

    const rendered = renderAgents(sections).join('\n');
    expect(rendered).toContain('# home rules');
    expect(rendered).toContain('# project rules');
    expect(rendered.indexOf('# home rules')).toBeLessThan(rendered.indexOf('# project rules'));
  });

  it('reports a configured file it cannot read, and carries on', () => {
    const missing = path.join(dir, 'nope.md');
    const { sections, notices } = resolveAgents({ ...deps, cwd: dir, agentsFiles: [missing] });
    expect(sections).toEqual([]);
    expect(notices.join(' ')).toContain('nope.md');
  });

  it('says nothing when a conventional file simply is not there', () => {
    const { sections, notices } = resolveAgents({ ...deps, home, cwd: dir });
    expect(sections).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('skips an empty file without a notice', () => {
    write(path.join(dir, 'AGENTS.md'), '   \n  \n');
    const { sections, notices } = resolveAgents({ ...deps, cwd: dir });
    expect(sections).toEqual([]);
    expect(notices).toEqual([]);
  });

  it('warns loudly when a file is clipped', () => {
    write(path.join(dir, 'AGENTS.md'), `# a\n${'x'.repeat(40_000)}`);
    const { sections, notices } = resolveAgents({ ...deps, cwd: dir, agentsBudget: 500 });
    expect(sections[0].truncated).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/clipped/);
    expect(notices[0]).toMatch(/DAVAI_AGENTS_BUDGET/);
  });

  it('spends the budget across files and reports one that got nothing', () => {
    write(path.join(home, 'AGENTS.md'), `# home\n${'x'.repeat(40_000)}`);
    write(path.join(dir, 'AGENTS.md'), '# project');
    const { sections, notices } = resolveAgents({ ...deps, home, cwd: dir, agentsBudget: 500 });
    expect(sections.map((s) => s.source)).toEqual(['home']);
    expect(notices.some((n) => n.includes('was not included'))).toBe(true);
  });
});

describe('grounding integration', () => {
  it('returns the agents sections and notices alongside the text', () => {
    write(path.join(dir, 'AGENTS.md'), '# project rules\n\nuse tabs');
    const sandbox = new Sandbox({ cwd: dir, roDirs: [], ignore: { isIgnored: () => false } });
    const g = buildGrounding({
      sandbox,
      cfg: { roDirs: [], cwd: dir, home, contextLimit: 1_000_000 },
    });
    expect(g.text).toContain('# Project grounding');
    expect(g.text).toContain('use tabs');
    expect(g.text).toContain(path.join(dir, 'AGENTS.md'));
    expect(g.agents).toHaveLength(1);
    expect(g.notices).toEqual([]);
  });

  it('puts the agents file last, after the directory listing', () => {
    write(path.join(dir, 'AGENTS.md'), '# rules');
    const sandbox = new Sandbox({ cwd: dir, roDirs: [], ignore: { isIgnored: () => false } });
    const g = buildGrounding({
      sandbox,
      cfg: { roDirs: [], cwd: dir, home, contextLimit: 1_000_000 },
    });
    expect(g.text.indexOf('## Directory')).toBeLessThan(g.text.indexOf('## Project instructions'));
  });
});