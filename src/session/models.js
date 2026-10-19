/**
 * Model selection, as machinery rather than as a pane.
 *
 * This was the body of ModelPane's `applyModel` plus the catalog merge above it. It moved
 * here for the same reason `dispatch.js` did: the browser needs to switch models too, and
 * a second implementation of "load config, refine, re-create the provider, persist" would
 * drift from this one the first time either side was fixed. `/model <id>` in commands.js
 * had already drifted — it set `cfg.provider` where the pane did not.
 *
 * Ink-free. Everything here mutates the session the harness owns; views render the result.
 */
import {
  PROVIDERS,
  DEFAULT_MODEL,
  modelsFor,
  refineModel,
  fetchOpenRouterCatalog,
} from '../config/models.js';
import { listRemoteModels, createProvider } from '../providers/index.js';
import { loadConfig, applyModelLimits } from '../config/env.js';
import { saveSettings } from '../config/settings.js';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_HELP = {
  low: 'fastest, cheapest — simple edits',
  medium: 'balanced',
  high: 'default — most coding work',
  xhigh: 'harder problems, more tool calls',
  max: 'correctness over cost',
};

/**
 * Every provider, and whether this config can actually reach it. A provider with no key
 * is listed rather than hidden: "openrouter is missing a key" is more useful than
 * openrouter not being there.
 * @param {object} cfg
 */
export function providerState(cfg) {
  return PROVIDERS.map((name) => ({
    name,
    hasKey: Boolean(cfg.keys?.[name]),
    current: name === cfg.provider,
  }));
}

/**
 * The seed registry merged with whatever the provider itself reports.
 *
 * OpenRouter is the case that matters: its catalog is 300+ models with real pricing,
 * context windows and modality flags, and it is the only provider whose list is worth
 * browsing rather than knowing. For the others a remote list is bare ids, so it is only
 * fetched when asked for (`force`) and the rows are marked `remoteOnly` — present, but
 * with no local metadata to show.
 *
 * A fetch failure is returned, not thrown: a stale or seed-only list is far more useful
 * than an empty pane, and the caller can show the reason next to it.
 *
 * @param {object} cfg
 * @param {{provider?: string, force?: boolean, fetchImpl?: typeof fetch}} [opts]
 *   `fetchImpl` exists so the tests can exercise the merge without depending on
 *   OpenRouter being reachable, or on its pricing staying put.
 * @returns {Promise<{models: object[], error: string|null, source: string}>}
 */
export async function loadCatalog(cfg, { provider = cfg.provider, force = false, fetchImpl } = {}) {
  const seed = modelsFor(provider);
  let remote = [];
  let error = null;
  let source = 'seed';

  if (provider === 'openrouter') {
    try {
      remote = await fetchOpenRouterCatalog({ baseURL: cfg.baseURL, force, fetchImpl });
      source = 'openrouter catalog';
    } catch (err) {
      error = err.message;
    }
  } else if (force) {
    try {
      // listRemoteModels keys off cfg.provider, so it has to see the one being browsed.
      const ids = await listRemoteModels({ ...cfg, provider });
      remote = ids.map((id) => ({ id, provider, remoteOnly: true }));
      source = `${provider} models endpoint`;
    } catch (err) {
      error = err.message;
    }
  }

  const known = new Set(seed.map((m) => m.id));
  const byId = new Map();
  for (const m of seed) byId.set(m.id, m);
  for (const r of remote) {
    // A bare id never displaces a curated spec; a full spec always wins.
    if (!known.has(r.id) || !r.remoteOnly) byId.set(r.id, r);
  }
  return { models: [...byId.values()], error, source };
}

/** Trim a spec to what a view needs. Keeps a 300-model payload to something sensible. */
export function serializeModel(m) {
  return {
    id: m.id,
    label: m.label || m.id,
    context: m.context ?? null,
    maxOutput: m.maxOutput ?? null,
    vision: Boolean(m.vision),
    effort: Boolean(m.effort),
    thinking: Boolean(m.thinking),
    inputPrice: m.inputPrice ?? null,
    outputPrice: m.outputPrice ?? null,
    remoteOnly: Boolean(m.remoteOnly),
    unverified: Boolean(m.unverified),
  };
}

/**
 * Switch provider, model and/or effort on a live session.
 *
 * Goes through loadConfig rather than poking cfg, so a switch is validated by the same
 * code path as startup — including the base-URL rules, which is why `baseURL` and
 * `openaiApi` are copied across afterwards. Leaving them at the old provider's values is
 * how a switch to openrouter could keep sending requests to a custom OpenAI endpoint.
 *
 * Session-scoped by default. `persist: true` also writes settings.json, which is the
 * floor the next session starts from — but only the floor: a DAVAI_MODEL in a .env
 * outranks it, so persisting under one is reported as having no effect next run rather
 * than appearing to have worked. `/keys` and the key pane are where a .env gets edited.
 *
 * @param {object} session
 * @param {{provider?: string, model?: string, effort?: string}} want
 * @param {{persist?: boolean}} [opts]
 * @returns {Promise<{provider: string, model: object, effort: string, contextLimit: number,
 *   notices: string[], persisted: boolean}>}
 */
export async function applyModelChange(session, want = {}, opts = {}) {
  const { cfg, ledger, agent } = session;

  const provider = (want.provider || cfg.provider).trim().toLowerCase();
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`unknown provider "${provider}" — expected one of: ${PROVIDERS.join(', ')}`);
  }
  if (!cfg.keys?.[provider]) throw new Error(`no API key configured for ${provider}`);

  const effort = (want.effort || cfg.effort).trim().toLowerCase();
  if (!EFFORTS.includes(effort)) {
    throw new Error(`unknown effort "${effort}" — expected one of: ${EFFORTS.join(', ')}`);
  }

  // Changing provider without naming a model lands on that provider's default rather
  // than carrying across an id it does not serve.
  const model = (
    want.model || (provider === cfg.provider ? cfg.model.id : DEFAULT_MODEL[provider])
  ).trim();
  if (!model) throw new Error('no model id');

  // As `overrides`: an explicit switch beats the .env for this session, exactly as a
  // command-line flag would. Persisting it is a separate, weaker act.
  const next = loadConfig({
    cwd: cfg.cwd,
    overrides: { DAVAI_PROVIDER: provider, DAVAI_MODEL: model, DAVAI_EFFORT: effort },
  });
  await refineModel(next.model, { apiKey: cfg.keys[provider], baseURL: next.baseURL });

  cfg.provider = provider;
  cfg.model = next.model;
  cfg.effort = effort;
  cfg.baseURL = next.baseURL;
  cfg.baseURLOrigin = next.baseURLOrigin;
  cfg.openaiApi = next.openaiApi;

  const notices = applyModelLimits(cfg);
  ledger.limit = cfg.contextLimit;
  agent.provider = createProvider(cfg);

  // The live config also carries the new key origin, so an auth failure right after a
  // switch names the variable that supplied the key it actually used.
  cfg.keyOrigins = next.keyOrigins;
  cfg.varOrigins = next.varOrigins;

  let persisted = false;
  if (opts.persist) {
    saveSettings(cfg.home, { provider, model, effort });
    persisted = true;
    // settings.json is the floor. Saying "saved" when a .env will win next run is the
    // same lie the old precedence told, just in the other direction.
    const shadowed = ['DAVAI_PROVIDER', 'DAVAI_MODEL', 'DAVAI_EFFORT'].filter((v) => {
      const from = cfg.varOrigins?.[v];
      return from && from !== 'settings.json' && from !== 'command-line flag';
    });
    if (shadowed.length) {
      notices.push(
        `saved as the default, but ${shadowed.join(', ')} ${shadowed.length > 1 ? 'are' : 'is'} ` +
          `set in ${cfg.varOrigins[shadowed[0]]} and will win on the next run. ` +
          `\`/keys --save\` edits that file; this session is unaffected.`,
      );
    }
  }

  return {
    provider,
    model: cfg.model,
    effort,
    contextLimit: cfg.contextLimit,
    notices,
    persisted,
  };
}