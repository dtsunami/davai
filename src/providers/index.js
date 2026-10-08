/**
 * Provider factory. One place that knows which adapter serves which provider name.
 */
import { createAnthropic } from './anthropic.js';
import { createOpenAI } from './openai.js';
import { createOpenAIResponses } from './openai-responses.js';
import { createGemini } from './gemini.js';

const GROK_BASE_URL = 'https://api.x.ai/v1';

const DEFAULT_ENDPOINTS = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  grok: GROK_BASE_URL,
  gemini: 'https://generativelanguage.googleapis.com',
};

/** Statuses where "which key went where" is the first question. */
const AUTH_STATUSES = new Set([401, 403]);

/** Prefixes that identify a key's issuer. Showing them leaks nothing secret. */
const KEY_PREFIX = /^(sk-ant-|sk-proj-|sk-svcacct-|sk-|xai-|AIza)/;

/**
 * Describe a key without revealing it: issuer prefix, length, last four characters,
 * and anything that would make a correct key fail (quotes, whitespace, a pasted \r).
 * @returns {string}
 */
export function maskKey(key) {
  if (!key) return '(none)';
  const k = String(key);
  const prefix = KEY_PREFIX.exec(k)?.[1];
  const parts = [`${k.length} chars`];
  if (prefix) parts.push(`starts ${prefix}`);
  if (k.length >= 16) parts.push(`ends …${k.slice(-4)}`);
  const notes = [];
  if (k !== k.trim()) notes.push('leading/trailing whitespace');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(k)) notes.push('control characters (e.g. \\r)');
  if (/^['"`]|['"`]$/.test(k)) notes.push('quote characters');
  return parts.join(', ') + (notes.length ? ` — contains ${notes.join(', ')}` : '');
}

/** The URL a request actually goes to, as the adapter will build it. */
function endpointOf(cfg) {
  const base = cfg.baseURL || DEFAULT_ENDPOINTS[cfg.provider] || '(provider default)';
  if (cfg.provider === 'anthropic') return `${base}/messages`;
  if (cfg.provider === 'gemini') return base;
  const route =
    cfg.provider === 'openai' && cfg.openaiApi !== 'chat' ? 'responses' : 'chat/completions';
  return `${base}/${route}`;
}

/**
 * The resolved request context, for appending to an auth failure.
 * @param {import('../config/env.js').Config} cfg
 * @param {string} model
 * @returns {string}
 */
export function describeAuth(cfg, model) {
  const key = cfg.keys?.[cfg.provider];
  const ko = cfg.keyOrigins?.[cfg.provider];
  const bo = cfg.baseURLOrigin;
  const custom = cfg.provider === 'openai' || cfg.provider === 'grok';
  const endpointSource = bo
    ? `${bo.name} from ${bo.from || 'unknown source'}`
    : custom
      ? 'default — DAVAI_BASE_URL not set'
      : 'provider default';
  const keySource = ko ? `${ko.name} from ${ko.from || 'unknown source'}` : 'unknown source';
  const lines = [
    `  endpoint  ${endpointOf(cfg)}  (${endpointSource})`,
    `  model     ${model}`,
    `  key       ${maskKey(key)}  (${keySource})`,
  ];
  if (cfg.provider === 'openai' && !cfg.baseURL && key && !String(key).startsWith('sk-')) {
    lines.push(
      `  note      this key has no sk- prefix but is being sent to OpenAI. For Mistral or ` +
        `another OpenAI-compatible server, set DAVAI_BASE_URL in $DAVAI_HOME/.env.`,
    );
  }
  return lines.join('\n');
}

/**
 * Wrap an adapter so an auth failure says where the request went and which key it
 * carried. Lives here rather than in wrapError because only the factory knows the
 * resolved config; adapters stay unaware of it.
 */
export function withAuthDiagnostics(adapter, cfg, model) {
  const send = adapter.send.bind(adapter);
  return {
    ...adapter,
    async *send(args) {
      try {
        yield* send(args);
      } catch (err) {
        if (AUTH_STATUSES.has(err?.status) && !err.authContext) {
          err.authContext = describeAuth(cfg, model);
          err.message = `${err.message}\n${err.authContext}`;
        }
        throw err;
      }
    },
  };
}

/**
 * @param {import('../config/env.js').Config} cfg
 * @param {{model?: string}} [override]
 */
export function createProvider(cfg, override = {}) {
  const apiKey = cfg.keys[cfg.provider];
  const common = {
    apiKey,
    model: override.model || cfg.model.id,
    maxTokens: cfg.maxTokens,
    // Overridable so the harness can re-ask a reasoning-blown turn at lower effort.
    effort: override.effort || cfg.effort,
    temperature: cfg.temperature,
    thinkingVisible: cfg.thinkingVisible,
    baseURL: cfg.baseURL,
  };

  return withAuthDiagnostics(adapterFor(cfg, common), cfg, common.model);
}

function adapterFor(cfg, common) {
  switch (cfg.provider) {
    case 'anthropic':
      return createAnthropic(common);
    case 'openai':
      // Responses is the only OpenAI surface that streams reasoning summaries, so it is
      // the default; DAVAI_OPENAI_API=chat is the way back to Chat Completions.
      return cfg.openaiApi === 'chat' ? createOpenAI(common) : createOpenAIResponses(common);
    case 'grok':
      return createOpenAI({ ...common, baseURL: cfg.baseURL || GROK_BASE_URL, name: 'grok' });
    case 'gemini':
      return createGemini(common);
    default:
      throw new Error(`No adapter for provider "${cfg.provider}"`);
  }
}

/**
 * Ask the provider what models it actually serves. The registry in config/models.js
 * is a seed; this is the authority.
 * @returns {Promise<string[]>}
 */
export async function listRemoteModels(cfg) {
  const apiKey = cfg.keys[cfg.provider];
  if (!apiKey) throw new Error(`no API key for ${cfg.provider}`);

  switch (cfg.provider) {
    case 'anthropic': {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const out = [];
      for await (const m of client.models.list()) out.push(m.id);
      return out;
    }
    case 'openai':
    case 'grok': {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({
        apiKey,
        baseURL: cfg.baseURL || (cfg.provider === 'grok' ? GROK_BASE_URL : undefined),
      });
      const res = await client.models.list();
      return res.data.map((m) => m.id).sort();
    }
    case 'gemini': {
      const { GoogleGenAI } = await import('@google/genai');
      const client = new GoogleGenAI({ apiKey });
      const out = [];
      for await (const m of await client.models.list()) {
        out.push(String(m.name || '').replace(/^models\//, ''));
      }
      return out.sort();
    }
    default:
      throw new Error(`cannot list models for "${cfg.provider}"`);
  }
}
