/**
 * Switching provider blocks as a session operation: the file is edited, the config is
 * rebuilt from it, and a block that cannot be loaded leaves nothing changed.
 *
 * config/profiles.js is covered in profiles.test.js against text alone. What is tested
 * here is the part that can strand a session — reload, rollback, and the masking that
 * stops a key reaching a view.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { profileState, switchProfile, setProfileVar } from '../src/session/profiles.js';

let home;
let cwd;
let savedHome;
let savedEnv;

const ENV = [
  'DAVAI_EFFORT=low',
  '',
  '#---# anth',
  'DAVAI_PROVIDER=anthropic',
  'DAVAI_ANTHROPIC_API_KEY=sk-ant-aaa',
  '#-end-provider-#',
  '',
  '#---# oai',
  '#DAVAI_PROVIDER=openai',
  '#DAVAI_BASE_URL=https://api.mistral.ai/v1',
  '#DAVAI_OPENAI_API_KEY=sk-bbb',
  '',
].join('\n');

/** A session just real enough for profiles.js: a cfg, an agent to re-provider. */
function makeSession(extra = {}) {
  const cfg = loadConfig({ cwd, defaults: {}, overrides: {} });
  return {
    cfg,
    agent: { provider: null },
    ledger: { limit: cfg.contextLimit },
    ...extra,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-blocks-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-blocks-cwd-'));
  savedHome = process.env.DAVAI_HOME;
  process.env.DAVAI_HOME = home;
  // The real environment outranks every file, so a key exported in the shell running
  // the tests would defeat the block being tested.
  savedEnv = {};
  for (const k of Object.keys(process.env)) {
    if (/^(DAVAI_|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_|XAI_|GROK_|OPENROUTER_)/.test(k) && k !== 'DAVAI_HOME') {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  fs.writeFileSync(path.join(home, '.env'), ENV);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.DAVAI_HOME;
  else process.env.DAVAI_HOME = savedHome;
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('profileState', () => {
  it('reports each block, which is live, and what applies regardless', () => {
    const s = makeSession();
    const state = profileState(s.cfg);
    expect(state.blocks.map((b) => b.name)).toEqual(['anth', 'oai']);
    expect(state.active).toEqual(['anth']);
    expect(state.preamble).toEqual(['DAVAI_EFFORT']);
    expect(state.blocks[1].baseURL).toBe('https://api.mistral.ai/v1');
  });

  it('masks a key before it leaves the process', () => {
    const state = profileState(makeSession().cfg);
    const key = state.blocks[0].vars.find((v) => v.name === 'DAVAI_ANTHROPIC_API_KEY');
    expect(key.secret).toBe(true);
    expect(key.value).not.toContain('aaa');
    // A base URL is not a secret and must stay legible: it is the whole point of the row.
    expect(state.blocks[1].vars.find((v) => v.name === 'DAVAI_BASE_URL').value).toBe(
      'https://api.mistral.ai/v1',
    );
  });
});

describe('switchProfile', () => {
  it('rewrites the file and rebuilds the session config from it', async () => {
    const s = makeSession();
    expect(s.cfg.provider).toBe('anthropic');

    const r = await switchProfile(s, 'oai');
    expect(r.block).toBe('oai');
    expect(s.cfg.provider).toBe('openai');
    expect(s.cfg.baseURL).toBe('https://api.mistral.ai/v1');
    expect(s.cfg.keys.openai).toBe('sk-bbb');
    // The provider adapter has to be rebuilt, or the session keeps talking to the old
    // endpoint with the new config on screen.
    expect(s.agent.provider).toBeTruthy();
  });

  it('keeps the inactive block in the file, commented', async () => {
    const s = makeSession();
    await switchProfile(s, 'oai');
    const text = fs.readFileSync(path.join(home, '.env'), 'utf8');
    expect(text).toContain('#DAVAI_ANTHROPIC_API_KEY=sk-ant-aaa');
    expect(s.cfg.keys.anthropic).toBeUndefined();
  });

  it('round-trips back to the original file', async () => {
    const s = makeSession();
    await switchProfile(s, 'oai');
    await switchProfile(s, 'anth');
    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe(ENV);
    expect(s.cfg.provider).toBe('anthropic');
  });

  it('leaves the preamble in effect whichever block is live', async () => {
    const s = makeSession();
    await switchProfile(s, 'oai');
    expect(s.cfg.effort).toBe('low');
  });

  it('disables every block for null', async () => {
    const s = makeSession();
    const r = await switchProfile(s, null);
    expect(r.block).toBeNull();
    expect(profileState(s.cfg).active).toEqual([]);
    // Nothing names a provider any more, so the built-in default applies.
    expect(s.cfg.provider).toBe('anthropic');
    expect(s.cfg.baseURL).toBeUndefined();
  });

  it('warns when a shell export will outrank the block it just enabled', async () => {
    const s = makeSession();
    // Exported after the session exists, so this is the switch being shadowed rather
    // than a config that never loaded.
    process.env.DAVAI_OPENAI_API_KEY = 'sk-from-the-shell';
    try {
      const r = await switchProfile(s, 'oai');
      expect(r.notices.join(' ')).toMatch(/DAVAI_OPENAI_API_KEY.*exported/s);
      // And the warning is true: the export is what the session is actually using.
      expect(s.cfg.keys.openai).toBe('sk-from-the-shell');
    } finally {
      delete process.env.DAVAI_OPENAI_API_KEY;
    }
  });

  it('says so, rather than failing silently, when the new block has no key', async () => {
    fs.writeFileSync(
      path.join(home, '.env'),
      ['#---# a', 'DAVAI_PROVIDER=anthropic', 'DAVAI_ANTHROPIC_API_KEY=sk-ant-x', '', '#---# b', '#DAVAI_PROVIDER=gemini', ''].join('\n'),
    );
    const s = makeSession();
    const r = await switchProfile(s, 'b');
    expect(r.notices.join(' ')).toMatch(/no key for gemini/);
  });

  it('rolls the file back when the new block cannot be loaded', async () => {
    fs.writeFileSync(
      path.join(home, '.env'),
      [
        '#---# good',
        'DAVAI_PROVIDER=anthropic',
        'DAVAI_ANTHROPIC_API_KEY=sk-ant-x',
        '',
        '#---# bad',
        // A base URL on a provider that cannot take one: loadConfig throws.
        '#DAVAI_PROVIDER=anthropic',
        '#DAVAI_BASE_URL=https://nope.example/v1',
        '',
      ].join('\n'),
    );
    const before = fs.readFileSync(path.join(home, '.env'), 'utf8');
    const s = makeSession();

    await expect(switchProfile(s, 'bad')).rejects.toThrow(/not usable/);
    // Neither half-switched: the file is as it was and the session still works.
    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe(before);
    expect(s.cfg.provider).toBe('anthropic');
    expect(s.cfg.keys.anthropic).toBe('sk-ant-x');
  });

  it('refuses a block that is not there', async () => {
    const s = makeSession();
    await expect(switchProfile(s, 'ghost')).rejects.toThrow(/no provider block/);
  });

  it('does not re-arm approvals that /yolo turned off', async () => {
    const s = makeSession();
    s.cfg.yolo = true;
    await switchProfile(s, 'oai');
    expect(s.cfg.yolo).toBe(true);
  });
});

describe('setProfileVar', () => {
  it('parks a key in an inert block without changing the session', async () => {
    const s = makeSession();
    const r = await setProfileVar(s, {
      block: 'oai',
      name: 'DAVAI_OPENAI_API_KEY',
      value: 'sk-parked',
    });
    expect(r.enabled).toBe(false);
    expect(r.masked).not.toContain('parked');
    expect(s.cfg.provider).toBe('anthropic');
    expect(profileState(s.cfg).active).toEqual(['anth']);
    const text = fs.readFileSync(path.join(home, '.env'), 'utf8');
    expect(text).toContain('#DAVAI_OPENAI_API_KEY=sk-parked');
  });

  it('creates a block rather than appending below every block', async () => {
    const s = makeSession();
    await setProfileVar(s, { block: 'deepseek', name: 'DAVAI_OPENAI_API_KEY', value: 'sk-ds' });
    const state = profileState(s.cfg);
    expect(state.blocks.map((b) => b.name)).toContain('deepseek');
    // The live block is untouched: a parked key must not become the effective one.
    expect(s.cfg.keys.anthropic).toBe('sk-ant-aaa');
  });
});