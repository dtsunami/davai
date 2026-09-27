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
];

export const PROVIDERS = ['anthropic', 'openai', 'gemini', 'grok'];

export const DEFAULT_MODEL = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5.1',
  gemini: 'gemini-3-pro-preview',
  grok: 'grok-4',
};

/** Cheap model used for compaction summaries. */
export const SUMMARIZER_MODEL = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5-mini',
  gemini: 'gemini-2.5-flash',
  grok: 'grok-4',
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
    effort: provider === 'anthropic' || provider === 'openai',
    thinking: provider !== 'grok',
    inputPrice: null,
    outputPrice: null,
    unverified: true,
    suggestion: nearest && nearest.d <= 3 ? nearest.m.id : undefined,
  };
}

/**
 * Ask the provider for a model's real limits and capabilities, and fold them into
 * the spec. Only Anthropic exposes this today; the others return null and keep the
 * conservative defaults.
 *
 * @returns {Promise<ModelSpec>} the same spec, mutated in place
 */
export async function refineModel(spec, { apiKey }) {
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
 * Cost in dollars, or null when we have no pricing for this model — better to show
 * "—" than a confidently wrong number.
 * @returns {number|null}
 */
export function costOf(spec, usage) {
  if (!spec || !usage) return 0;
  if (spec.inputPrice == null || spec.outputPrice == null) return null;
  const fresh = usage.in || 0;
  const write = usage.cacheWrite || 0;
  const cached = usage.cacheRead || 0;
  return (
    (fresh * spec.inputPrice) / 1e6 +
    (write * spec.inputPrice * 1.25) / 1e6 +
    (cached * spec.inputPrice * 0.1) / 1e6 +
    ((usage.out || 0) * spec.outputPrice) / 1e6
  );
}
