/**
 * OpenAI adapter on the Responses API.
 *
 * Chat Completions never exposes reasoning: the model thinks, you are billed for the
 * tokens, and you see nothing. Responses is the only OpenAI surface that streams
 * reasoning summaries, which is the whole reason this adapter exists alongside
 * openai.js — that one still serves Grok, whose API is Chat-Completions-shaped and has
 * no /v1/responses.
 *
 * Notes that matter here and nowhere else:
 *  - the system prompt is `instructions`, not a message with role "system"
 *  - `max_output_tokens`, not `max_completion_tokens`
 *  - summaries arrive only when reasoning.summary is set, and some organisations must
 *    be verified before OpenAI will return them at all — so absence is not an error
 *  - assistant history uses output_text parts, user history input_text; mixing them up
 *    is a 400 that reads like a schema complaint
 *  - store defaults to true, retaining the conversation server-side. davai resends its
 *    own history every turn and never uses previous_response_id, so it opts out.
 */
import OpenAI from 'openai';
import { OPENAI_EFFORT, wrapError } from './base.js';

export function createOpenAIResponses({
  apiKey,
  model,
  maxTokens,
  effort,
  temperature,
  thinkingVisible,
  baseURL = undefined,
  name = 'openai',
  client = new OpenAI({ apiKey, baseURL, maxRetries: 3, timeout: 10 * 60 * 1000 }),
}) {
  return {
    name,
    model,
    api: 'responses',

    async *send({ system, messages, signal }) {
      const params = {
        model,
        instructions: system,
        input: messages.map(toResponsesItem),
        max_output_tokens: maxTokens,
        stream: true,
        store: false,
      };
      if (temperature != null) params.temperature = temperature;
      if (effort) {
        params.reasoning = {
          effort: OPENAI_EFFORT[effort] || 'medium',
          // Without this the model still reasons and still bills reasoning tokens; it
          // just never tells you what it was weighing.
          ...(thinkingVisible ? { summary: 'auto' } : {}),
        };
      }

      let stream;
      try {
        stream = await client.responses.create(params, { signal });
      } catch (err) {
        // Non-reasoning models reject the reasoning block outright. Same shape as the
        // Chat adapter's retry: drop the hint rather than fail the turn.
        if (err?.status === 400 && params.reasoning) {
          delete params.reasoning;
          try {
            stream = await client.responses.create(params, { signal });
          } catch (retryErr) {
            throw wrapError(retryErr, name);
          }
        } else {
          throw wrapError(err, name);
        }
      }

      yield* translateStream(stream, name);
    },

    async countTokens() {
      return null; // no pre-flight endpoint; the heuristic covers it
    },
  };
}

/**
 * Responses events -> davai events.
 *
 * Separate and exported so the mapping can be tested against recorded event shapes
 * without a network call, which is the only way to cover a translation this fiddly.
 *
 * @param {AsyncIterable<object>|Iterable<object>} stream
 * @param {string} name provider name for error messages
 */
export async function* translateStream(stream, name = 'openai') {
  let usage = null;
  let stop = null;
  let refusal = '';

  try {
    for await (const event of stream) {
      const type = event?.type || '';

      if (type === 'response.output_text.delta') {
        if (event.delta) yield { t: 'text', delta: event.delta };
        continue;
      }

      // reasoning_summary_text is the documented name; reasoning_summary is accepted
      // too, because the event names moved during the API's preview.
      if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_summary.delta') {
        if (event.delta) yield { t: 'thinking', delta: event.delta };
        continue;
      }

      // A summary can arrive in several parts; keep them from running together.
      if (type === 'response.reasoning_summary_part.added' && event.summary_index > 0) {
        yield { t: 'thinking', delta: '\n\n' };
        continue;
      }

      if (type === 'response.refusal.delta') {
        refusal += event.delta || '';
        continue;
      }

      if (type === 'response.completed' || type === 'response.incomplete') {
        usage = event.response?.usage || usage;
        const reason = event.response?.incomplete_details?.reason;
        if (reason === 'max_output_tokens') stop = { reason: 'max_tokens' };
        else if (type === 'response.incomplete') stop = { reason: reason || 'incomplete' };
        else stop = { reason: 'end_turn' };
        continue;
      }

      if (type === 'response.failed') {
        const message = event.response?.error?.message || 'the response failed';
        throw wrapError({ message, status: event.response?.error?.status }, name);
      }

      if (type === 'error') {
        throw wrapError({ message: event.message || 'stream error', status: event.code }, name);
      }
    }
  } catch (err) {
    throw wrapError(err, name);
  }

  if (usage) {
    yield {
      t: 'usage',
      in: usage.input_tokens || 0,
      // Reasoning tokens are already inside output_tokens — counted, not added twice.
      out: usage.output_tokens || 0,
      cacheRead: usage.input_tokens_details?.cached_tokens || 0,
      cacheWrite: 0,
    };
  }

  if (refusal) {
    yield { t: 'stop', reason: 'refusal', detail: refusal };
    return;
  }
  yield { t: 'stop', reason: stop?.reason || 'end_turn' };
}

/**
 * One davai message as a Responses input item. Assistant turns carry output_text parts
 * and user turns input_text — the API rejects the pair swapped.
 */
function toResponsesItem(m) {
  const assistant = m.role === 'assistant';
  return {
    role: m.role,
    content: m.content.map((p) => {
      if (p.type === 'image') {
        return { type: 'input_image', image_url: `data:${p.mediaType};base64,${p.data}` };
      }
      return { type: assistant ? 'output_text' : 'input_text', text: p.text };
    }),
  };
}
