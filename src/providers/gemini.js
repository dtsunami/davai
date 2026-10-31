/**
 * Gemini adapter. Different content shape from the other three: `contents` with
 * `parts`, `inlineData` for images and video, and the system prompt as its own field.
 */
import { GoogleGenAI } from '@google/genai';
import { wrapError } from './base.js';

export function createGemini({ apiKey, model, maxTokens, temperature, thinkingVisible, baseURL }) {
  // `baseURL` was accepted by every other adapter and dropped here, while endpointOf()
  // in providers/index.js reported it for gemini regardless — so an auth diagnostic
  // named a server the request had never gone to. Threading it makes the two agree,
  // which matters now that meta.json records the endpoint per session.
  const client = new GoogleGenAI({
    apiKey,
    ...(baseURL ? { httpOptions: { baseUrl: baseURL } } : {}),
  });

  return {
    name: 'gemini',
    model,

    async *send({ system, messages, signal }) {
      const config = {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
        // Gemini thinks either way and bills thoughtsTokenCount for it, but only
        // returns thought parts when asked — without this the `part.thought` branch
        // below can never fire.
        ...(thinkingVisible ? { thinkingConfig: { includeThoughts: true } } : {}),
        ...(temperature != null ? { temperature } : {}),
        ...(signal ? { abortSignal: signal } : {}),
      };

      // Built before the request rather than inline, so the wire shape can ride an error.
      // "What did davai actually put on the wire" is the first question on a rejected
      // attachment and the last one the transcript can answer: by the time wrapError has
      // condensed the response, the request is gone.
      const contents = messages.map(toGeminiContent);
      const media = describeGeminiParts(contents);

      let stream;
      try {
        stream = await client.models.generateContentStream({ model, contents, config });
      } catch (err) {
        throw annotateMedia(wrapError(err, 'gemini'), media);
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
        throw annotateMedia(wrapError(err, 'gemini'), media);
      }

      if (usage) {
        const cached = usage.cachedContentTokenCount || 0;
        const prompt = usage.promptTokenCount || 0;
        yield {
          t: 'usage',
          // promptTokenCount already includes the cached content; `in` is fresh-only.
          in: Math.max(0, prompt - cached),
          out: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
          cacheRead: cached,
          cacheWrite: 0,
          contextIn: prompt,
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

/**
 * The media parts of a built request, as Gemini will receive them — payloads excluded.
 *
 * Distinct from `describeParts` in base.js, which describes the *ledger's* parts. The
 * two differing is itself the bug worth catching: a ledger video part that leaves here
 * as neither fileData nor inlineData has been silently dropped by the mapper.
 */
function describeGeminiParts(contents) {
  const out = [];
  for (const c of contents || []) {
    for (const p of c.parts || []) {
      if (p.fileData) {
        out.push({
          kind: 'fileData',
          role: c.role,
          uri: p.fileData.fileUri,
          mimeType: p.fileData.mimeType ?? null,
        });
      } else if (p.inlineData) {
        out.push({
          kind: 'inlineData',
          role: c.role,
          mimeType: p.inlineData.mimeType ?? null,
          bytes: Math.floor(((p.inlineData.data?.length || 0) * 3) / 4),
        });
      }
    }
  }
  return out;
}

/** Attach the request's media shape to an error so the loop can log the pair together. */
function annotateMedia(err, media) {
  if (media.length) err.requestMedia = media;
  return err;
}

function toGeminiContent(m) {
  return {
    role: m.role === 'assistant' ? 'model' : 'user',
    // Uploaded video rides the same inlineData envelope as an image — the mime type and
    // the billing differ, the wire shape does not.
    //
    // A YouTube video is the exception: it is passed by reference as fileData and never
    // uploaded, so it is the one part davai sends without holding its bytes. The mime
    // type is omitted there deliberately — the backend resolves the URL itself, and
    // asserting video/mp4 for a stream we have not seen is a claim we cannot support.
    parts: m.content.map((p) => {
      if (p.type === 'video' && p.uri) {
        return { fileData: { fileUri: p.uri, ...(p.mediaType ? { mimeType: p.mediaType } : {}) } };
      }
      if (p.type === 'image' || p.type === 'video') {
        return { inlineData: { mimeType: p.mediaType, data: p.data } };
      }
      return { text: p.text };
    }),
  };
}
