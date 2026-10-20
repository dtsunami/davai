import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DAVAI_VERSION,
  checkForks,
  hashText,
  readManifest,
  snapshot,
  stampFork,
} from '../src/agent/promptfork.js';
import { PROMPT_SPECS } from '../src/agent/prompt.js';
import {
  applyPrompts,
  cancelApply,
  drainPendingPrompts,
  promptState,
  revertPrompt,
  savePrompt,
  stageApply,
} from '../src/session/promptedit.js';

let dir;
const protocolSpec = PROMPT_SPECS.find((s) => s.key === 'protocol');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-fork-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A session shaped like the real one, with just the parts promptedit touches. */
function fakeSession({ project, home } = {}) {
  const cwd = path.join(dir, 'proj');
  const homeDir = path.join(dir, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  const dirs = { home: path.join(homeDir, 'prompts'), project: path.join(cwd, '.prompts') };
  if (project) {
    fs.mkdirSync(dirs.project, { recursive: true });
    for (const [file, text] of Object.entries(project)) {
      fs.writeFileSync(path.join(dirs.project, file), text);
    }
  }
  if (home) {
    fs.mkdirSync(dirs.home, { recursive: true });
    for (const [file, text] of Object.entries(home)) {
      fs.writeFileSync(path.join(dirs.home, file), text);
    }
  }
  const ledger = {
    system: '',
    systemTokens: 0,
    setSystem(text) {
      this.system = text;
      this.systemTokens = text.length;
    },
  };
  return {
    cfg: {
      home: homeDir,
      cwd,
      promptDirs: dirs,
      prompts: Object.fromEntries(PROMPT_SPECS.map((s) => [s.key, s.text])),
      promptSources: Object.fromEntries(PROMPT_SPECS.map((s) => [s.key, 'default'])),
      promptLayers: Object.fromEntries(PROMPT_SPECS.map((s) => [s.key, 'default'])),
      roDirs: [],
      contextLimit: 1_000_000,
    },
    ledger,
    sandbox: { writeRoot: cwd, isIgnored: () => false },
    agent: { busy: false, prompts: null },
    pendingPrompts: null,
  };
}

describe('fork provenance', () => {
  it('says nothing about prompts that are not overridden', () => {
    const r = checkForks({ sources: {}, layers: {} });
    expect(r.stale).toEqual([]);
    expect(r.unstamped).toEqual([]);
  });

  it('flags an override with no manifest as unstamped, not stale', () => {
    // Every fork predating this feature looks like this. Absence of a record is not
    // evidence of drift, so it must not block.
    const file = path.join(dir, 'protocol.md');
    fs.writeFileSync(file, 'my protocol');
    const r = checkForks({ sources: { protocol: file }, layers: { protocol: 'project' } });
    expect(r.stale).toEqual([]);
    expect(r.unstamped.map((u) => u.key)).toEqual(['protocol']);
  });

  it('is silent when the fork point matches the current built-in', () => {
    const file = path.join(dir, 'protocol.md');
    fs.writeFileSync(file, 'my protocol');
    stampFork(dir, ['protocol']);
    const r = checkForks({ sources: { protocol: file }, layers: { protocol: 'project' } });
    expect(r.stale).toEqual([]);
    expect(r.unstamped).toEqual([]);
  });

  it('detects drift when the built-in has changed since the fork', () => {
    // The failure this whole module exists for: davai gains an op, protocol.md changes,
    // and a fork taken last year still describes the old one with nothing complaining.
    const file = path.join(dir, 'protocol.md');
    fs.writeFileSync(file, 'my protocol');
    stampFork(dir, ['protocol']);
    const m = readManifest(dir);
    m.prompts.protocol.defaultHash = hashText('an older built-in protocol');
    m.prompts.protocol.davaiVersion = '0.0.1';
    fs.writeFileSync(path.join(dir, '.davai-prompts.json'), JSON.stringify(m));

    const r = checkForks({ sources: { protocol: file }, layers: { protocol: 'project' } });
    expect(r.stale).toHaveLength(1);
    expect(r.stale[0]).toMatchObject({
      key: 'protocol',
      forkedVersion: '0.0.1',
      currentVersion: DAVAI_VERSION,
      currentHash: hashText(protocolSpec.text),
    });
  });

  it('stamps the hash of the built-in as it is today', () => {
    stampFork(dir, ['protocol']);
    expect(readManifest(dir).prompts.protocol.defaultHash).toBe(hashText(protocolSpec.text));
  });

  it('keeps a copy before overwriting', () => {
    const file = path.join(dir, 'protocol.md');
    fs.writeFileSync(file, 'original');
    const kept = snapshot(file);
    fs.writeFileSync(file, 'replaced');
    expect(fs.readFileSync(kept, 'utf8')).toBe('original');
  });
});

describe('saving is independent of the session', () => {
  it('writes the file and leaves the live prompt alone', () => {
    // The point of save/apply being separate: a save mid-turn must not touch the
    // cached prefix the request in flight was built with.
    const session = fakeSession();
    const before = session.cfg.prompts.nudge;
    const r = savePrompt(session, { key: 'nudge', text: 'try harder' });

    expect(fs.readFileSync(r.file, 'utf8')).toBe('try harder');
    expect(session.cfg.prompts.nudge).toBe(before);
    expect(session.ledger.system).toBe('');
  });

  it('stamps the fork point, so a hand-edit does not look stale', () => {
    const session = fakeSession();
    const r = savePrompt(session, { key: 'protocol', text: 'mine' });
    const entry = readManifest(path.dirname(r.file)).prompts.protocol;
    expect(entry.defaultHash).toBe(hashText(protocolSpec.text));
  });

  it('refuses a save that drops a required placeholder', () => {
    // resolvePrompts would reject this at next startup; catching it here means the
    // editor refuses rather than writing a file that bricks the next launch.
    const session = fakeSession();
    expect(() => savePrompt(session, { key: 'steer', text: 'no placeholder here' })).toThrow(
      /\{text\}/,
    );
  });

  it('refuses an empty save', () => {
    const session = fakeSession();
    expect(() => savePrompt(session, { key: 'nudge', text: '   ' })).toThrow(/empty/);
  });

  it('keeps a snapshot when overwriting an existing override', () => {
    const session = fakeSession({ project: { 'nudge.md': 'first' } });
    const r = savePrompt(session, { key: 'nudge', text: 'second' });
    expect(r.snapshot).toBeTruthy();
    expect(fs.readFileSync(r.snapshot, 'utf8')).toBe('first');
  });

  it('reverts by removing the override, keeping a copy', () => {
    const session = fakeSession({ project: { 'nudge.md': 'mine' } });
    const r = revertPrompt(session, { key: 'nudge' });
    expect(r.removed).toBe(true);
    expect(fs.existsSync(r.file)).toBe(false);
    expect(fs.readFileSync(r.snapshot, 'utf8')).toBe('mine');
  });
});

describe('apply is queued against the turn, not the clock', () => {
  it('reports what is on disk as dirty before it is applied', () => {
    const session = fakeSession();
    savePrompt(session, { key: 'nudge', text: 'try harder' });
    const state = promptState(session);
    const row = state.prompts.find((p) => p.key === 'nudge');
    expect(row.dirty).toBe(true);
    expect(row.disk).toBe('try harder');
    expect(row.live).not.toBe('try harder');
  });

  it('stages without touching the live prompt', () => {
    const session = fakeSession();
    savePrompt(session, { key: 'nudge', text: 'try harder' });
    stageApply(session);
    expect(session.pendingPrompts).toBeTruthy();
    expect(session.cfg.prompts.nudge).not.toBe('try harder');
  });

  it('applies at the drain, which is where the agent calls it', () => {
    const session = fakeSession();
    savePrompt(session, { key: 'nudge', text: 'try harder' });
    stageApply(session);

    const r = drainPendingPrompts(session);
    expect(r.applied).toBe(true);
    expect(session.cfg.prompts.nudge).toBe('try harder');
    expect(session.agent.prompts.nudge).toBe('try harder');
    expect(session.pendingPrompts).toBe(null);
  });

  it('drains to null when nothing is staged, so the step boundary is free', () => {
    expect(drainPendingPrompts(fakeSession())).toBe(null);
  });

  it('rebuilds the system prompt, which is the cost being paid', () => {
    const session = fakeSession();
    applyPrompts(session);
    expect(session.ledger.system).toContain('da_ops');
    expect(session.ledger.systemTokens).toBeGreaterThan(0);
  });

  it('can be cancelled before it lands', () => {
    const session = fakeSession();
    savePrompt(session, { key: 'nudge', text: 'try harder' });
    stageApply(session);
    cancelApply(session);
    expect(drainPendingPrompts(session)).toBe(null);
    expect(session.cfg.prompts.nudge).not.toBe('try harder');
  });

  it('refuses to stage a broken override rather than failing at the boundary', () => {
    // An error at the button is actionable; the same error three minutes later in a
    // transcript nobody is watching is not.
    const session = fakeSession({ project: { 'steer.md': 'no placeholder' } });
    expect(() => stageApply(session)).toThrow(/\{text\}/);
    expect(session.pendingPrompts).toBe(null);
  });
});