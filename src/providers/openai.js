/**
 * Chat Completions adapter. Grok's API is this shape, so this is its only path; for
 * OpenAI it is the fallback behind DAVAI_OPENAI_API=chat, because Chat Completions
 * cannot return reasoning summaries — openai-responses.js exists for that.
 *
 * `delta.reasoning_content` is not an OpenAI field. It is xAI's and DeepSeek's, present
 * on smaller reasoning models like grok-3-mini and absent on grok-4, so the branch below
 * is a cheap accommodation rather than a supported path.
 *
 * `delta.content` is a string on OpenAI and xAI, but Mistral's newer models stream it
 * as an array of chunks: `{type:'text', text}` and, at higher effort,
 * `{type:'thinking', thinking:[{type:'text', text}]}`. contentDeltas() flattens both.
 *
 * davai sends no `tools`, yet some models (Mistral, at least) emit native function
 * calls anyway and finish with `finish_reason: "tool_calls"`. Mistral's carry a valid
 * da_ops envelope, so they are reassembled and surfaced as a `tool_calls` event; the
 * loop runs any that hold a batch (agent/native.js) and logs every one.
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
  client = new OpenAI({ apiKey, baseURL, maxRetries: 3, timeout: 10 * 60 * 1000 }),
}) {

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
      let finish = null;
      /** @type {Map<number, {id?: string, name: string, args: string}>} */
      const toolCalls = new Map();
      try {
        for await (const chunk of stream) {
          if (chunk.usage) usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const d = choice.delta;
          if (d?.content) yield* contentDeltas(d.content);
          if (d?.reasoning_content) yield { t: 'thinking', delta: d.reasoning_content };
          if (d?.tool_calls) mergeToolCallDeltas(toolCalls, d.tool_calls);
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      } catch (err) {
        throw wrapError(err, name);
      }

      if (toolCalls.size) yield { t: 'tool_calls', calls: [...toolCalls.values()] };

      if (usage) {
        yield {
          t: 'usage',
          in: usage.prompt_tokens || 0,
          out: usage.completion_tokens || 0,
          cacheRead: usage.prompt_tokens_details?.cached_tokens || 0,
          cacheWrite: 0,
        };
      }
      // A stream that closes without a finish_reason was cut off (dropped connection,
      // proxy timeout), not finished. Calling it end_turn hid a 4-minute Mistral stall.
      yield {
        t: 'stop',
        reason:
          finish == null
            ? 'error'
            : finish === 'length'
              ? 'max_tokens'
              : finish === 'stop'
                ? 'end_turn'
                : finish,
      };
    },

    async countTokens() {
      return null; // no pre-flight endpoint; the heuristic covers it
    },
  };
}

/**
 * Normalise a Chat Completions `delta.content` into harness events. Accepts a plain
 * string or an array of typed chunks; unknown chunk types are dropped, never stringified.
 * @param {unknown} content
 */
export function* contentDeltas(content) {
  if (typeof content === 'string') {
    if (content) yield { t: 'text', delta: content };
    return;
  }
  if (!Array.isArray(content)) return;
  for (const c of content) {
    if (typeof c === 'string') {
      if (c) yield { t: 'text', delta: c };
    } else if (c?.type === 'text') {
      if (c.text) yield { t: 'text', delta: c.text };
    } else if (c?.type === 'thinking') {
      const th = c.thinking;
      const text =
        typeof th === 'string'
          ? th
          : Array.isArray(th)
            ? th.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('')
            : '';
      if (text) yield { t: 'thinking', delta: text };
    }
  }
}

/**
 * Fold streamed `delta.tool_calls` fragments into `acc`, keyed by index. The first
 * fragment for an index carries the id and name; later ones append to `arguments`.
 * A fragment without an index is treated as a complete call of its own.
 * @param {Map<number, {id?: string, name: string, args: string}>} acc
 * @param {unknown} deltas
 */
export function mergeToolCallDeltas(acc, deltas) {
  if (!Array.isArray(deltas)) return;
  for (const d of deltas) {
    if (!d || typeof d !== 'object') continue;
    const i = typeof d.index === 'number' ? d.index : acc.size;
    const call = acc.get(i) || { id: undefined, name: '', args: '' };
    if (d.id) call.id = d.id;
    const fn = d.function;
    if (fn?.name && !call.name) call.name = fn.name;
    if (typeof fn?.arguments === 'string') call.args += fn.arguments;
    else if (fn?.arguments && typeof fn.arguments === 'object') call.args += JSON.stringify(fn.arguments);
    acc.set(i, call);
  }
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
