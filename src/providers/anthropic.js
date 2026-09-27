/**
 * Anthropic adapter.
 *
 * Notes that matter here and nowhere else in this codebase:
 *  - adaptive thinking; budget_tokens is rejected with a 400 on current models
 *  - effort lives in output_config, not top-level
 *  - reasoning streams empty unless thinking.display is set
 *  - stop_reason "refusal" arrives as HTTP 200, so check before reading content
 *  - the system prefix is marked cache_control: a REPL resends history every turn,
 *    so caching it is the single largest cost lever available
 */
import Anthropic from '@anthropic-ai/sdk';
import { wrapError } from './base.js';

export function createAnthropic({ apiKey, model, maxTokens, effort, temperature, thinkingVisible }) {
  const client = new Anthropic({ apiKey, maxRetries: 3, timeout: 10 * 60 * 1000 });

  return {
    name: 'anthropic',
    model,

    async *send({ system, messages, signal }) {
      const params = {
        model,
        max_tokens: maxTokens,
        // Cache the stable prefix (system prompt + protocol + grounding).
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: messages.map(toAnthropicMessage),
      };

      if (model.startsWith('claude-haiku')) {
        // Haiku 4.5 predates adaptive thinking and rejects output_config.effort.
        if (temperature != null) params.temperature = temperature;
      } else {
        params.thinking = {
          type: 'adaptive',
          ...(thinkingVisible ? { display: 'summarized' } : {}),
        };
        params.output_config = { effort };
      }

      let stream;
      try {
        stream = client.messages.stream(params, { signal });
      } catch (err) {
        throw wrapError(err, 'anthropic');
      }

      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              yield { t: 'text', delta: event.delta.text };
            } else if (event.delta.type === 'thinking_delta') {
              yield { t: 'thinking', delta: event.delta.thinking };
            }
          } else if (event.type === 'message_delta' && event.usage) {
            // interim usage; the final message carries the authoritative numbers
          }
        }

        const final = await stream.finalMessage();
        yield {
          t: 'usage',
          in: final.usage.input_tokens || 0,
          out: final.usage.output_tokens || 0,
          cacheRead: final.usage.cache_read_input_tokens || 0,
          cacheWrite: final.usage.cache_creation_input_tokens || 0,
        };

        if (final.stop_reason === 'refusal') {
          yield {
            t: 'stop',
            reason: 'refusal',
            detail:
              final.stop_details?.explanation ||
              `declined (${final.stop_details?.category || 'unspecified'})`,
          };
        } else {
          yield { t: 'stop', reason: final.stop_reason || 'end_turn' };
        }
      } catch (err) {
        throw wrapError(err, 'anthropic');
      }
    },

    /** Exact pre-flight token count — Anthropic is the only provider that offers this. */
    async countTokens({ system, messages }) {
      try {
        const r = await client.messages.countTokens({
          model,
          system,
          messages: messages.map(toAnthropicMessage),
        });
        return r.input_tokens;
      } catch {
        return null; // fall back to the heuristic
      }
    },
  };
}

function toAnthropicMessage(m) {
  return {
    role: m.role,
    content: m.content.map((p) =>
      p.type === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }
        : { type: 'text', text: p.text },
    ),
  };
}
