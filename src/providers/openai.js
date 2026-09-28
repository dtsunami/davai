/**
 * Chat Completions adapter. Grok's API is this shape, so this is its only path; for
 * OpenAI it is the fallback behind DAVAI_OPENAI_API=chat, because Chat Completions
 * cannot return reasoning summaries — openai-responses.js exists for that.
 *
 * `delta.reasoning_content` is not an OpenAI field. It is xAI's and DeepSeek's, present
 * on smaller reasoning models like grok-3-mini and absent on grok-4, so the branch below
 * is a cheap accommodation rather than a supported path.
 */
import OpenAI from 'openai';
import { OPENAI_EFFORT, wrapError } from './base.js';

export function createOpenAI({
  apiKey,
  model,
  maxTokens,
  effort,
  temperature,
  baseURL = undefined,
  name = 'openai',
}) {
  const client = new OpenAI({ apiKey, baseURL, maxRetries: 3, timeout: 10 * 60 * 1000 });

  return {
    name,
    model,

    async *send({ system, messages, signal }) {
      const params = {
        model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          ...messages.map(toOpenAIMessage),
        ],
        stream: true,
        stream_options: { include_usage: true },
      };
      if (temperature != null) params.temperature = temperature;
      // Reasoning-capable models take an effort hint; older ones reject it, so this
      // is best-effort and stripped on a 400 below.
      if (effort) params.reasoning_effort = OPENAI_EFFORT[effort] || 'medium';

      let stream;
      try {
        stream = await client.chat.completions.create(params, { signal });
      } catch (err) {
        if (err?.status === 400 && params.reasoning_effort) {
          delete params.reasoning_effort;
          try {
            stream = await client.chat.completions.create(params, { signal });
          } catch (retryErr) {
            throw wrapError(retryErr, name);
          }
        } else {
          throw wrapError(err, name);
        }
      }

      let usage = null;
      let finish = 'end_turn';
      try {
        for await (const chunk of stream) {
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const d = choice.delta;
          if (d?.content) yield { t: 'text', delta: d.content };
          if (d?.reasoning_content) yield { t: 'thinking', delta: d.reasoning_content };
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      } catch (err) {
        throw wrapError(err, name);
      }

      if (usage) {
        yield {
          t: 'usage',
          in: usage.prompt_tokens || 0,
          out: usage.completion_tokens || 0,
          cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
          cacheWrite: 0,
        };
      }
      yield {
        t: 'stop',
        reason: finish === 'length' ? 'max_tokens' : finish === 'stop' ? 'end_turn' : finish,
      };
    },

    async countTokens() {
      return null; // no pre-flight endpoint; the heuristic covers it
    },
  };
}

function toOpenAIMessage(m) {
  const parts = m.content.map((p) =>
    p.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } }
      : { type: 'text', text: p.text },
  );
  // A text-only message is cheaper to send as a plain string.
  if (parts.every((p) => p.type === 'text')) {
    return { role: m.role, content: parts.map((p) => p.text).join('\n') };
  }
  return { role: m.role, content: parts };
}
