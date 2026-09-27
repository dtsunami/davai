/**
 * Gemini adapter. Different content shape from the other three: `contents` with
 * `parts`, `inlineData` for images, and the system prompt as its own field.
 */
import { GoogleGenAI } from '@google/genai';
import { wrapError } from './base.js';

export function createGemini({ apiKey, model, maxTokens, temperature }) {
  const client = new GoogleGenAI({ apiKey });

  return {
    name: 'gemini',
    model,

    async *send({ system, messages, signal }) {
      const config = {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
        ...(temperature != null ? { temperature } : {}),
        ...(signal ? { abortSignal: signal } : {}),
      };

      let stream;
      try {
        stream = await client.models.generateContentStream({
          model,
          contents: messages.map(toGeminiContent),
          config,
        });
      } catch (err) {
        throw wrapError(err, 'gemini');
      }

      let usage = null;
      let finish = 'end_turn';
      try {
        for await (const chunk of stream) {
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          const cand = chunk.candidates?.[0];
          if (cand?.finishReason) finish = cand.finishReason;
          for (const part of cand?.content?.parts || []) {
            if (part.text) {
              yield part.thought ? { t: 'thinking', delta: part.text } : { t: 'text', delta: part.text };
            }
          }
        }
      } catch (err) {
        throw wrapError(err, 'gemini');
      }

      if (usage) {
        yield {
          t: 'usage',
          in: usage.promptTokenCount || 0,
          out: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
          cacheRead: usage.cachedContentTokenCount || 0,
          cacheWrite: 0,
        };
      }
      yield {
        t: 'stop',
        reason:
          finish === 'MAX_TOKENS'
            ? 'max_tokens'
            : finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT'
              ? 'refusal'
              : 'end_turn',
      };
    },

    async countTokens({ system, messages }) {
      try {
        const r = await client.models.countTokens({
          model,
          contents: messages.map(toGeminiContent),
          config: { systemInstruction: system },
        });
        return r.totalTokens ?? null;
      } catch {
        return null;
      }
    },
  };
}

function toGeminiContent(m) {
  return {
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: m.content.map((p) =>
      p.type === 'image'
        ? { inlineData: { mimeType: p.mediaType, data: p.data } }
        : { text: p.text },
    ),
  };
}
