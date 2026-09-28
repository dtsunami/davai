/**
 * Provider factory. One place that knows which adapter serves which provider name.
 */
import { createAnthropic } from './anthropic.js';
import { createOpenAI } from './openai.js';
import { createOpenAIResponses } from './openai-responses.js';
import { createGemini } from './gemini.js';

const GROK_BASE_URL = 'https://api.x.ai/v1';

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
    effort: cfg.effort,
    temperature: cfg.temperature,
    thinkingVisible: cfg.thinkingVisible,
  };

  switch (cfg.provider) {
    case 'anthropic':
      return createAnthropic(common);
    case 'openai':
      // Responses is the only OpenAI surface that streams reasoning summaries, so it is
      // the default; DAVAI_OPENAI_API=chat is the way back to Chat Completions.
      return cfg.openaiApi === 'chat' ? createOpenAI(common) : createOpenAIResponses(common);
    case 'grok':
      return createOpenAI({ ...common, baseURL: GROK_BASE_URL, name: 'grok' });
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
        baseURL: cfg.provider === 'grok' ? GROK_BASE_URL : undefined,
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
