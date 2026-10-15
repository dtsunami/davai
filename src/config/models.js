/**
 * Model registry.
 *
 * Hard lesson baked into this file's design: a hardcoded list of model ids is wrong
 * the moment a provider ships something new. So the registry is a *seed* holding the
 * things an API cannot tell us (chiefly pricing), and an unknown model id is not an
 * error — it is a model we have no local metadata for. `refineModel()` fills in the
 * real context window and capabilities from the provider's own models endpoint.
 *
 * @typedef {object} ModelSpec
 * @property {string} id
 * @property {string} provider
 * @property {string} label
 * @property {number} context         max input tokens
 * @property {number} maxOutput
 * @property {boolean} vision
 * @property {boolean} effort         supports an effort/reasoning level
 * @property {boolean} thinking       supports adaptive thinking
 * @property {number|null} inputPrice  $ per 1M input tokens, null when unknown
 * @property {number|null} outputPrice
 * @property {boolean} [unverified]   synthesized, not from the seed table
 */

/** @type {ModelSpec[]} */
export const MODELS = [
  // --- anthropic (specs confirmed against the models endpoint) ---
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    label: 'Claude Opus 5.5',
    context: 1_000_000,
    maxOutput: 128_000,
    vision: true,
    effort: true,
    thinking: true,
    inputPrice: null,
    outputPrice: null,
  },
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    label: 'Claude Opus 5',
    context: 1_000_000,
    maxOutput: 128_000,
    vision: true,
    effort: true,
    thinking: true,
    inputPrice: 5.0,
    outputPrice: 25.0,
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 5',
    context: 1_000_000,
    maxOutput: 128_000,
    vision: true,
    effort: true,
    thinking: true,
    inputPrice: 2.0,
    outputPrice: 10.0,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    context: 200_000,
    maxOutput: 64_000,
    vision: true,
    effort: false,
    thinking: false,
    inputPrice: 1.0,
    outputPrice: 5.0,
  },

  // --- openai (seed) ---
  {
    id: 'gpt-5.1',
    provider: 'openai',
    label: 'GPT-5.1',
    context: 400_000,
    maxOutput: 128_000,
    vision: true,
    effort: true,
    thinking: true,
    inputPrice: 1.25,
    outputPrice: 10.0,
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    label: 'GPT-5 mini',
    context: 400_000,
    maxOutput: 128_000,
    vision: true,
    effort: true,
    thinking: true,
    inputPrice: 0.25,
    outputPrice: 2.0,
  },

  // --- gemini (seed) ---
  {
    id: 'gemini-3-pro-preview',
    provider: 'gemini',
    label: 'Gemini 3 Pro',
    context: 1_000_000,
    maxOutput: 64_000,
    vision: true,
    effort: false,
    thinking: true,
    inputPrice: 1.25,
    outputPrice: 10.0,
  },
  {
    id: 'gemini-2.5-flash',
    provider: 'gemini',
    label: 'Gemini 2.5 Flash',
    context: 1_000_000,
    maxOutput: 64_000,
    vision: true,
    effort: false,
    thinking: true,
    inputPrice: 0.3,
    outputPrice: 2.5,
  },

  // --- grok (seed; OpenAI-compatible) ---
  {
    id: 'grok-4',
    provider: 'grok',
    label: 'Grok 4',
    context: 256_000,
    maxOutput: 64_000,
    vision: true,
    effort: false,
    thinking: false,
    inputPrice: 3.0,
    outputPrice: 15.0,
  },

  // --- openrouter (seed; full catalog + pricing fetched dynamically via /api/v1/models) ---
  {
    id: 'anthropic/claude-sonnet-4.5',
    provider: 'openrouter',
    label: 'Claude Sonnet 4.5 (OpenRouter)',
    context: 1_000_000,
    maxOutput: 64_000,
    vision: true,
    effort: true,
    thinking: true,
    inputPrice: 3.0,
    outputPrice: 15.0,
  },
  {
    id: 'anthropic/claude-opus-4.5',
    provider: 'openrouter',
    label: 'Claude Opus 4.5 (OpenRouter)',
    context: 200_000,
    maxOutput: 64_000,
    vision: true,
    effort: true,
    thinking: true,
    inputPrice: 5.0,
    outputPrice: 25.0,
  },
  {
    id: 'openai/gpt-5.1',
    provider: 'openrouter',
    label: 'GPT-5.1 (OpenRouter)',
    context: 400_000,
    maxOutput: 128_000,
    vision: true,
    effort: true,
    thinking: true,
    inputPrice: 1.25,
    outputPrice: 10.0,
  },
  {
    id: 'google/gemini-2.5-pro',
    provider: 'openrouter',
    label: 'Gemini 2.5 Pro (OpenRouter)',
    context: 1_000_000,
    maxOutput: 64_000,
    vision: true,
    effort: true,
    thinking: true,
    inputPrice: 1.25,
    outputPrice: 10.0,
  },
  {
    id: 'deepseek/deepseek-r1',
    provider: 'openrouter',
    label: 'DeepSeek R1 (OpenRouter)',
    context: 164_000,
    maxOutput: 32_000,
    vision: false,
    effort: true,
    thinking: true,
    inputPrice: 0.55,
    outputPrice: 2.19,
  },
  {
    id: 'qwen/qwen3-coder',
    provider: 'openrouter',
    label: 'Qwen3 Coder (OpenRouter)',
    context: 262_000,
    maxOutput: 64_000,
    vision: false,
    effort: false,
    thinking: false,
    inputPrice: 0.3,
    outputPrice: 1.2,
  },
];

export const PROVIDERS = ['anthropic', 'openai', 'gemini', 'grok', 'openrouter'];

export const DEFAULT_MODEL = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5.1',
  gemini: 'gemini-3-pro-preview',
  grok: 'grok-4',
  openrouter: 'anthropic/claude-sonnet-4.5',
};

/** Cheap model used for compaction summaries. */
export const SUMMARIZER_MODEL = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  gemini: 'gemini-2.5-flash',
  grok: 'grok-4',
  openrouter: 'google/gemini-2.5-flash',
};

export function findModel(id) {
  return MODELS.find((m) => m.id === id);
}

export function modelsFor(provider) {
  return MODELS.filter((m) => m.provider === provider);
}

function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * Resolve a model id to a spec. An id we don't recognize is assumed real — the
 * provider is the authority, not this file — and gets a conservative synthesized
 * spec plus a `suggestion` when something similar is in the seed table.
 *
 * @returns {ModelSpec}
 */
export function resolveModel(provider, id) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(
      `Unknown DAVAI_PROVIDER "${provider}". Expected one of: ${PROVIDERS.join(', ')}`,
    );
  }
  const wanted = (id || DEFAULT_MODEL[provider]).trim();
  const found = findModel(wanted);
  if (found) {
    if (found.provider !== provider) {
      throw new Error(
        `Model "${wanted}" belongs to provider "${found.provider}", but DAVAI_PROVIDER is "${provider}".`,
      );
    }
    return found;
  }

  const candidates = modelsFor(provider);
  const nearest = candidates.map((m) => ({ m, d: distance(wanted, m.id) })).sort((a, b) => a.d - b.d)[0];

  return {
    id: wanted,
    provider,
    label: wanted,
    // Conservative until refineModel() hears otherwise: assuming a big window and
    // being wrong means blowing past the real limit mid-session.
    context: 200_000,
    maxOutput: 32_000,
    vision: true,
    effort: provider === 'anthropic' || provider === 'openai' || provider === 'openrouter',
    thinking: provider !== 'grok',
    inputPrice: null,
    outputPrice: null,
    unverified: true,
    suggestion: nearest && nearest.d <= 3 ? nearest.m.id : undefined,
  };
}

/** In-memory cache of OpenRouter's model catalog so refineModel and /model share one fetch. */
let openRouterCatalogCache = null;

/**
 * Parse a raw OpenRouter `/api/v1/models` entry into a Davai ModelSpec shape.
 * @param {any} raw
 * @returns {ModelSpec|null}
 */
export function parseOpenRouterModel(raw) {
  if (!raw || typeof raw.id !== 'string') return null;
  const promptPerTok = Number(raw.pricing?.prompt);
  const compPerTok = Number(raw.pricing?.completion);
  const inputPrice =
    Number.isFinite(promptPerTok) && promptPerTok >= 0
      ? Number((promptPerTok * 1e6).toFixed(4))
      : null;
  const outputPrice =
    Number.isFinite(compPerTok) && compPerTok >= 0
      ? Number((compPerTok * 1e6).toFixed(4))
      : null;
  const context = Number(raw.top_provider?.context_length || raw.context_length) || 128_000;
  const maxOutput =
    Number(raw.top_provider?.max_completion_tokens) || Math.min(64_000, Math.floor(context / 2));
  const modalities = raw.architecture?.input_modalities || [];
  const params = raw.supported_parameters || [];
  const hasReasoning =
    params.includes('reasoning') ||
    params.includes('include_reasoning') ||
    /claude-(3\.7|4|opus-4|sonnet-4)|gpt-5|o1|o3|o4|r1|thinking|qwq/i.test(raw.id);

  return {
    id: raw.id,
    provider: 'openrouter',
    label: raw.name || raw.id,
    context,
    maxOutput,
    vision: Array.isArray(modalities)
      ? modalities.includes('image')
      : /vision|claude|gpt-4|gpt-5|gemini/i.test(raw.id),
    effort: hasReasoning,
    thinking: hasReasoning,
    inputPrice,
    outputPrice,
    refined: true,
  };
}

/**
 * Fetch and parse OpenRouter's catalog (`GET /api/v1/models`).
 * @param {{baseURL?: string, force?: boolean, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<ModelSpec[]>}
 */
export async function fetchOpenRouterCatalog({
  baseURL = 'https://openrouter.ai/api/v1',
  force = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (openRouterCatalogCache && !force && fetchImpl === globalThis.fetch) {
    return openRouterCatalogCache;
  }
  const url = `${baseURL.replace(/\/+$/, '')}/models`;
  const res = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`OpenRouter models HTTP ${res.status}`);
  const body = await res.json();
  const list = Array.isArray(body?.data) ? body.data : [];
  const specs = list.map(parseOpenRouterModel).filter(Boolean);
  if (fetchImpl === globalThis.fetch) openRouterCatalogCache = specs;
  return specs;
}

/**
 * Ask the provider for a model's real limits and capabilities, and fold them into
 * the spec. Anthropic and OpenRouter expose rich model metadata; the others keep
 * the seed / conservative defaults.
 *
 * @returns {Promise<ModelSpec>} the same spec, mutated in place
 */
export async function refineModel(spec, { apiKey, baseURL, fetchImpl } = {}) {
  if (spec.provider === 'openrouter') {
    try {
      const catalog = await fetchOpenRouterCatalog({
        baseURL: baseURL || 'https://openrouter.ai/api/v1',
        fetchImpl,
      });
      const match = catalog.find((m) => m.id === spec.id);
      if (match) {
        Object.assign(spec, match);
        delete spec.unverified;
      }
    } catch {
      /* offline or custom proxy without /models — keep conservative defaults */
    }
    return spec;
  }
  if (spec.provider !== 'anthropic' || !apiKey) return spec;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey, maxRetries: 1 });
    const m = await client.models.retrieve(spec.id);
    const caps = m.capabilities || {};
    if (m.max_input_tokens) spec.context = m.max_input_tokens;
    if (m.max_tokens) spec.maxOutput = m.max_tokens;
    if (m.display_name) spec.label = m.display_name;
    spec.vision = caps.image_input?.supported ?? spec.vision;
    spec.effort = caps.effort?.supported ?? spec.effort;
    spec.thinking = caps.thinking?.types?.adaptive?.supported ?? spec.thinking;
    spec.refined = true;
    delete spec.unverified;
  } catch {
    // A 404 here means the id really is wrong; the first send() will say so clearly.
  }
  return spec;
}

/**
 * Pricing for a model the seed table has no price for: roughly the mean of the priced
 * frontier models above ($2.50 / $14 per Mtok when this was set), rounded up so the
 * estimate errs toward overstating spend. "cost n/a" made DAVAI_MAX_COST useless on
 * exactly the models nobody had priced, the default one included. Every display marks
 * an estimated figure with "~" so it is never passed off as exact.
 */
export const FALLBACK_PRICE = { input: 3.0, output: 15.0 };

/** True when costOf will fall back to FALLBACK_PRICE for this model. */
export function isPriceEstimated(spec) {
  return !spec || spec.inputPrice == null || spec.outputPrice == null;
}

/**
 * Cost in dollars. Uses FALLBACK_PRICE for whatever the spec does not price; check
 * isPriceEstimated() before presenting the figure as exact.
 * @returns {number}
 */
export function costOf(spec, usage) {
  if (!spec || !usage) return 0;
  const inputPrice = spec.inputPrice ?? FALLBACK_PRICE.input;
  const outputPrice = spec.outputPrice ?? FALLBACK_PRICE.output;
  const fresh = usage.in || 0;
  const write = usage.cacheWrite || 0;
  const cached = usage.cacheRead || 0;
  return (
    (fresh * inputPrice) / 1e6 +
    (write * inputPrice * 1.25) / 1e6 +
    (cached * inputPrice * 0.1) / 1e6 +
    ((usage.out || 0) * outputPrice) / 1e6
  );
}
