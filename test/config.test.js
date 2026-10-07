import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveLimits, applyModelLimits, DEFAULT_MAX_TOKENS } from '../src/config/env.js';
import { resolveModel } from '../src/config/models.js';
import { loadSettings, saveSettings } from '../src/config/settings.js';

let base;
let savedHome;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-config-'));
  savedHome = process.env.DAVAI_HOME;
  process.env.DAVAI_HOME = base;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.DAVAI_HOME;
  else process.env.DAVAI_HOME = savedHome;
  fs.rmSync(base, { recursive: true, force: true });
});

const opus = () => resolveModel('anthropic', 'claude-opus-5-5');

describe('resolveLimits', () => {
  it('defaults to a capped output and the full context window', () => {
    const m = opus();
    expect(resolveLimits(m)).toEqual({
      maxTokens: Math.min(m.maxOutput, DEFAULT_MAX_TOKENS),
      contextLimit: m.context,
      clamped: [],
    });
  });

  it('keeps requests within the model limits', () => {
    const r = resolveLimits(opus(), { maxTokens: 64_000, contextLimit: 200_000 });
    expect(r).toEqual({ maxTokens: 64_000, contextLimit: 200_000, clamped: [] });
  });

  it('clamps requests past the model limits and says so', () => {
    const m = opus();
    const r = resolveLimits(m, { maxTokens: m.maxOutput + 1, contextLimit: m.context * 2 });
    expect(r.maxTokens).toBe(m.maxOutput);
    expect(r.contextLimit).toBe(m.context);
    expect(r.clamped).toHaveLength(2);
    expect(r.clamped[0]).toMatch(/DAVAI_MAX_TOKENS/);
    expect(r.clamped[1]).toMatch(/DAVAI_CONTEXT_LIMIT/);
  });

  it('trusts explicit requests on a synthesized spec', () => {
    const m = resolveModel('anthropic', 'claude-something-new');
    expect(m.unverified).toBe(true);
    const r = resolveLimits(m, { maxTokens: 100_000, contextLimit: 500_000 });
    expect(r).toEqual({ maxTokens: 100_000, contextLimit: 500_000, clamped: [] });
  });
});

describe('applyModelLimits', () => {
  it('re-derives from the request, so a smaller model does not ratchet limits down', () => {
    const cfg = { model: opus(), limitsRequested: { maxTokens: 100_000, contextLimit: 300_000 } };
    expect(applyModelLimits(cfg)).toEqual([]);
    expect(cfg).toMatchObject({ maxTokens: 100_000, contextLimit: 300_000 });

    cfg.model = { id: 'small', maxOutput: 64_000, context: 200_000 };
    expect(applyModelLimits(cfg)).toHaveLength(2);
    expect(cfg).toMatchObject({ maxTokens: 64_000, contextLimit: 200_000 });

    cfg.model = opus();
    expect(applyModelLimits(cfg)).toEqual([]);
    expect(cfg).toMatchObject({ maxTokens: 100_000, contextLimit: 300_000 });
  });

  it('falls back to defaults when nothing was requested', () => {
    const cfg = { model: opus() };
    applyModelLimits(cfg);
    expect(cfg.contextLimit).toBe(cfg.model.context);
    expect(cfg.maxTokens).toBe(Math.min(cfg.model.maxOutput, DEFAULT_MAX_TOKENS));
  });
});

describe('loadConfig limits', () => {
  const load = (overrides) =>
    loadConfig({
      cwd: base,
      overrides: { DAVAI_PROVIDER: 'anthropic', DAVAI_MODEL: 'claude-opus-5-5', ...overrides },
    });

  it('records what was requested alongside the effective value', () => {
    const cfg = load({ DAVAI_MAX_TOKENS: '64_000', DAVAI_CONTEXT_LIMIT: '200000' });
    expect(cfg.limitsRequested).toEqual({ maxTokens: 64_000, contextLimit: 200_000 });
    expect(cfg.maxTokens).toBe(64_000);
    expect(cfg.contextLimit).toBe(200_000);
  });

  it('rejects token counts that are not positive integers', () => {
    expect(() => load({ DAVAI_MAX_TOKENS: '0' })).toThrow(/DAVAI_MAX_TOKENS/);
    expect(() => load({ DAVAI_MAX_TOKENS: 'lots' })).toThrow(/DAVAI_MAX_TOKENS/);
    expect(() => load({ DAVAI_CONTEXT_LIMIT: '1.5' })).toThrow(/DAVAI_CONTEXT_LIMIT/);
  });
});

describe('loadConfig base URL', () => {
  const load = (overrides) =>
    loadConfig({
      cwd: base,
      overrides: { DAVAI_PROVIDER: 'openai', DAVAI_MODEL: 'mistral-large-latest', ...overrides },
    });

  it('reads DAVAI_BASE_URL from .env and defaults to Chat Completions', () => {
    fs.writeFileSync(path.join(base, '.env'), 'DAVAI_BASE_URL=https://api.mistral.ai/v1/\n');
    const cfg = load();
    expect(cfg.baseURL).toBe('https://api.mistral.ai/v1');
    expect(cfg.openaiApi).toBe('chat');
  });

  it('honours OPENAI_BASE_URL from .env, which the SDK alone would miss', () => {
    fs.writeFileSync(path.join(base, '.env'), 'OPENAI_BASE_URL=http://localhost:8000/v1\n');
    expect(load().baseURL).toBe('http://localhost:8000/v1');
  });

  it('keeps the Responses API when asked for explicitly', () => {
    const cfg = load({ DAVAI_BASE_URL: 'https://x.example/v1', DAVAI_OPENAI_API: 'responses' });
    expect(cfg.openaiApi).toBe('responses');
  });

  it('is unset by default and leaves the Responses default alone', () => {
    const cfg = load({ DAVAI_BASE_URL: '', OPENAI_BASE_URL: '' });
    expect(cfg.baseURL).toBeUndefined();
    expect(cfg.openaiApi).toBe('responses');
  });

  it('rejects a bad URL and a provider that cannot use one', () => {
    expect(() => load({ DAVAI_BASE_URL: 'api.mistral.ai' })).toThrow(/DAVAI_BASE_URL/);
    expect(() => load({ DAVAI_BASE_URL: 'ftp://x.example' })).toThrow(/http or https/);
    expect(() =>
      load({
        DAVAI_PROVIDER: 'anthropic',
        DAVAI_MODEL: 'claude-opus-5-5',
        DAVAI_BASE_URL: 'https://x.example',
      }),
    ).toThrow(/anthropic/);
  });
});

describe('loadConfig base URL from a project .env', () => {
  let proj;
  let homeEnv;
  const saved = {};
  const VARS = ['DAVAI_BASE_URL', 'OPENAI_BASE_URL'];

  beforeEach(() => {
    proj = path.join(base, 'proj');
    homeEnv = path.join(base, '.env');
    fs.mkdirSync(proj);
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  const load = (overrides) =>
    loadConfig({
      cwd: proj,
      overrides: { DAVAI_PROVIDER: 'openai', DAVAI_MODEL: 'mistral-large-latest', ...overrides },
    });

  it('ignores it and warns with the command that adopts it', () => {
    fs.writeFileSync(path.join(proj, '.env'), 'DAVAI_BASE_URL=https://evil.example/v1\n');
    const cfg = load();
    expect(cfg.baseURL).toBeUndefined();
    expect(cfg.openaiApi).toBe('responses');
    expect(cfg.warnings).toHaveLength(1);
    expect(cfg.warnings[0]).toMatch(/ignored/);
    expect(cfg.warnings[0]).toContain(`export DAVAI_BASE_URL='https://evil.example/v1'`);
  });

  it('falls back to the home .env value', () => {
    fs.writeFileSync(homeEnv, 'DAVAI_BASE_URL=https://api.mistral.ai/v1\n');
    fs.writeFileSync(path.join(proj, '.env'), 'DAVAI_BASE_URL=https://evil.example/v1\n');
    const cfg = load();
    expect(cfg.baseURL).toBe('https://api.mistral.ai/v1');
    expect(cfg.warnings[0]).toMatch(/Using https:\/\/api\.mistral\.ai\/v1/);
  });

  it('ignores OPENAI_BASE_URL there too', () => {
    fs.writeFileSync(path.join(proj, '.env'), 'OPENAI_BASE_URL=https://evil.example/v1\n');
    const cfg = load();
    expect(cfg.baseURL).toBeUndefined();
    expect(cfg.warnings[0]).toContain("export OPENAI_BASE_URL='https://evil.example/v1'");
  });

  it('still lets the real environment and explicit overrides set it', () => {
    fs.writeFileSync(path.join(proj, '.env'), 'DAVAI_BASE_URL=https://evil.example/v1\n');
    expect(load({ DAVAI_BASE_URL: 'https://mine.example/v1' })).toMatchObject({
      baseURL: 'https://mine.example/v1',
      warnings: [],
    });
    process.env.DAVAI_BASE_URL = 'https://shell.example/v1';
    expect(load()).toMatchObject({ baseURL: 'https://shell.example/v1', warnings: [] });
  });

  it('quotes a value with a single quote so the command stays safe to paste', () => {
    fs.writeFileSync(path.join(proj, '.env'), `DAVAI_BASE_URL="https://x.example/a'b"\n`);
    expect(load().warnings[0]).toContain(`export DAVAI_BASE_URL='https://x.example/a'\\''b'`);
  });
});

describe('saveSettings', () => {
  it('merges into what is persisted instead of replacing it', () => {
    saveSettings(base, { maxTokens: 64_000, compactAt: 0.8 });
    saveSettings(base, { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' });
    expect(loadSettings(base)).toEqual({
      maxTokens: 64_000,
      compactAt: 0.8,
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
  });

  it('removes a field on null and leaves it on undefined', () => {
    saveSettings(base, { maxTokens: 64_000, compactAt: 0.8 });
    saveSettings(base, { maxTokens: null, compactAt: undefined });
    expect(loadSettings(base)).toEqual({ compactAt: 0.8 });
  });
});