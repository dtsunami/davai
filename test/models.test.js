import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, serializeModel, applyModelChange, EFFORTS } from '../src/session/models.js';
import { providerState } from '../src/session/models.js';

/**
 * session/models.js is the one place either view switches a model, so these cover the
 * things that used to differ between the pane and `/model`: whether cfg.provider moves,
 * whether the endpoint settings move with it, and what happens on a bad input.
 *
 * The catalog tests use a fake fetch — a real one would make the suite depend on
 * OpenRouter being up, and on its pricing not changing.
 */
const OR_BODY = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      pricing: { prompt: '0.000003', completion: '0.000015' },
      top_provider: { context_length: 1000000, max_completion_tokens: 64000 },
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: ['reasoning'],
    },
    {
      id: 'some/brand-new-model',
      name: 'Brand New',
      pricing: { prompt: '0.0000001', completion: '0.0000004' },
      context_length: 32000,
      architecture: { input_modalities: ['text'] },
      supported_parameters: [],
    },
  ],
};

let home;
let cfg;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-models-'));
  cfg = {
    cwd: home,
    home,
    provider: 'anthropic',
    model: { id: 'claude-opus-5', effort: true },
    effort: 'high',
    keys: { anthropic: 'sk-ant-x', openrouter: 'sk-or-x' },
    contextLimit: 200_000,
  };
});

describe('loadCatalog', () => {
  it('merges the fetched openrouter catalog over the seed list', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => OR_BODY }));
    const { models, error, source } = await loadCatalog(
      { ...cfg, provider: 'openrouter' },
      { provider: 'openrouter', force: true, fetchImpl },
    );
    expect(error).toBeNull();
    expect(source).toBe('openrouter catalog');
    expect(fetchImpl).toHaveBeenCalledOnce();

    const ids = models.map((m) => m.id);
    // A model only the catalog knows about appears...
    expect(ids).toContain('some/brand-new-model');
    // ...and a seeded one the catalog omitted is not dropped.
    expect(ids).toContain('qwen/qwen3-coder');

    // A full catalog spec outranks the seed, so pricing comes from the live catalog.
    const sonnet = models.find((m) => m.id === 'anthropic/claude-sonnet-4.5');
    expect(sonnet.inputPrice).toBe(3);
    expect(sonnet.vision).toBe(true);
    expect(sonnet.effort).toBe(true);
  });

  it('returns the seed list and the reason when the catalog cannot be fetched', async () => {
    const { models, error } = await loadCatalog(
      { ...cfg, provider: 'openrouter', baseURL: 'http://127.0.0.1:1/v1' },
      { provider: 'openrouter', force: true },
    );
    // An empty pane would be the worst outcome; the seed is still useful.
    expect(models.length).toBeGreaterThan(0);
    expect(error).toBeTruthy();
  });

  it('does not hit the network for a non-openrouter provider unless forced', async () => {
    const { models, error, source } = await loadCatalog(cfg, { provider: 'anthropic' });
    expect(error).toBeNull();
    expect(source).toBe('seed');
    expect(models.every((m) => m.provider === 'anthropic')).toBe(true);
  });

  it('never lets a bare remote id displace a curated spec', async () => {
    const { models } = await loadCatalog(cfg, { provider: 'anthropic' });
    const opus = models.find((m) => m.id === 'claude-opus-5');
    expect(opus.inputPrice).toBe(5);
    expect(opus.remoteOnly).toBeUndefined();
  });
});

describe('serializeModel', () => {
  it('reduces a spec to the fields a view renders', () => {
    const out = serializeModel({
      id: 'x/y', label: 'Y', context: 1000, maxOutput: 100,
      vision: true, effort: false, thinking: true,
      inputPrice: 1, outputPrice: 2, secret: 'dropped',
    });
    expect(out).toEqual({
      id: 'x/y', label: 'Y', context: 1000, maxOutput: 100,
      vision: true, effort: false, thinking: true,
      inputPrice: 1, outputPrice: 2, remoteOnly: false, unverified: false,
    });
  });

  it('keeps a missing price as null rather than inventing one', () => {
    expect(serializeModel({ id: 'a' }).inputPrice).toBeNull();
  });
});

describe('providerState', () => {
  it('lists every provider, marking the reachable ones and the live one', () => {
    const rows = providerState(cfg);
    expect(rows.find((r) => r.name === 'anthropic')).toEqual({
      name: 'anthropic', hasKey: true, current: true,
    });
    // A provider with no key is listed, not hidden: "needs a key" beats "missing".
    expect(rows.find((r) => r.name === 'gemini')).toEqual({
      name: 'gemini', hasKey: false, current: false,
    });
  });
});

describe('applyModelChange', () => {
  const makeSession = () => ({
    cfg: { ...cfg },
    ledger: { limit: 0 },
    agent: { provider: null },
  });

  it('refuses a provider with no key rather than switching to a dead session', async () => {
    const s = makeSession();
    await expect(applyModelChange(s, { provider: 'gemini' })).rejects.toThrow(/no API key/);
    expect(s.cfg.provider).toBe('anthropic');
  });

  it('refuses an unknown provider', async () => {
    await expect(applyModelChange(makeSession(), { provider: 'nope' })).rejects.toThrow(
      /unknown provider/,
    );
  });

  it('refuses an effort outside the ladder', async () => {
    await expect(applyModelChange(makeSession(), { effort: 'turbo' })).rejects.toThrow(
      /unknown effort/,
    );
    expect(EFFORTS).toContain('high');
  });

  it('leaves the session untouched when the switch is refused', async () => {
    const s = makeSession();
    const before = { ...s.cfg };
    await applyModelChange(s, { provider: 'gemini' }).catch(() => {});
    expect(s.cfg.model).toBe(before.model);
    expect(s.agent.provider).toBeNull();
  });
});