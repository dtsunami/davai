/**
 * Gemini adapter. Different content shape from the other three: `contents` with
 * `parts`, `inlineData` for images and video, and the system prompt as its own field.
 */
import { GoogleGenAI } from '@google/genai';
import { wrapError } from './base.js';
import { iterateWithIdleTimeout } from './watchdog.js';

/**
 * Localized thought-block headers Gemini 4 emits at index 0 of `part.text` when an
 * upstream gateway misfires `<ctrl94>` instead of splitting `part.thought: true`:
 *   - `" düşünceler\n..."` (Turkish)
 *   - `"sthought\n..."` (raw `s` + `thought` control token)
 *   - `" 생각하는 과정:\n..."` / `" 생각하는 과정...\n..."` (Korean)
 *   - `"思考过程：\n..."` (Chinese)
 */
export const LEAKED_THOUGHT_HEADER_RE =
  /^[ \t]*(?:düşünceler|sthought|생각하는 과정(?:\.{3}|:)?|思考过程[:：]?)[ \t]*\r?\n/;

const LEAKED_PREFIX_TOKENS = [
  'düşünceler',
  'sthought',
  '생각하는 과정...',
  '생각하는 과정:',
  '생각하는 과정',
  '思考过程：',
  '思考过程:',
  '思考过程',
];

/**
 * Map davai's 5 effort rungs onto Gemini 3+ / 4 `ThinkingConfig.thinkingLevel`.
 */
export const GEMINI_THINKING_LEVEL = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  xhigh: 'HIGH',
  max: 'HIGH',
};

function supportsGeminiThinkingLevel(modelId) {
  return /^gemini-(?:[3-9]|\d{2})/i.test(String(modelId || ''));
}

/**
 * True while an initial chunk buffer without a newline yet can still grow into a
 * `LEAKED_THOUGHT_HEADER_RE` match.
 */
function couldBeLeakedHeader(buf) {
  const s = buf.replace(/^[ \t]+/, '');
  if (!s) return buf.length < 16;
  if (s.includes('\n')) return LEAKED_THOUGHT_HEADER_RE.test(buf);
  const core = s.replace(/[ \t\r]+$/, '');
  return LEAKED_PREFIX_TOKENS.some((tok) => tok.startsWith(core));
}

/**
 * Find the first real `da_ops` opening fence inside a leaked thought buffer — either on
 * its own line (`\n```da_ops\n`) or glued onto the end of the final thought sentence when
 * `<ctrl95>` was stripped (`...let's run it!```da_ops\n`). Skips 4-backtick inline code.
 *
 * @param {string} s
 * @param {{allowEof?: boolean}} [opts]
 * @returns {{thought: string, text: string}|null}
 */
function findDaOpsFenceSeam(s, { allowEof = false } = {}) {
  const lookahead = allowEof ? '(?=\\r?\\n|$)' : '(?=\\r?\\n)';
  const re = new RegExp(`(?:^|\\n)([^\\n]*?)([ \\t]*\`{3,}[ \\t]*da_ops[ \\t]*)${lookahead}`, 'i');
  let offset = 0;
  let m;
  while ((m = re.exec(s.slice(offset))) !== null) {
    const absIdx = offset + m.index;
    if (m[1].includes('````')) {
      offset = absIdx + m[0].length;
      continue;
    }
    const lineStart = absIdx + (s[absIdx] === '\n' ? 1 : 0);
    const fenceStart = lineStart + m[1].length;
    return {
      thought: s.slice(0, fenceStart).trim(),
      text: s.slice(fenceStart).replace(/^[ \t]+/, ''),
    };
  }
  return null;
}

/**
 * Find where Gemini's `<ctrl95>` (end-of-thought) control token was stripped with zero
 * whitespace between the end of the internal monologue and the start of the visible
 * prose reply (e.g. `...for the operator.Yes — ...` or `...(`P2_BLENDER_OK`)**.**P2...`).
 *
 * Scans outside fenced code blocks and inline backtick spans so `a.b` or `TexCoord.Object`
 * never false-trigger.
 */
function findProseGlueOutsideCode(s, { requireLookahead = true } = {}) {
  let inFence = false;
  let inInlineCode = false;
  for (let i = 0; i < s.length; i++) {
    if ((i === 0 || s[i - 1] === '\n') && s.startsWith('```', i)) {
      inFence = !inFence;
      i += 2;
      continue;
    }
    if (inFence) continue;
    if (s[i] === '`') {
      inInlineCode = !inInlineCode;
      continue;
    }
    if (inInlineCode) continue;

    const ch = s[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      if (s[i + 1] === '.' || s[i - 1] === '.') continue;
      const prev = s[i - 1] || '';
      if (!/[a-zA-Z)`*"]/.test(prev)) continue;
      // Skip single-letter initials / abbreviations like `e.g.` or `U.S.`
      if (ch === '.' && /[A-Z]/.test(prev) && !/[a-z)`*"]/.test(prev)) continue;

      const rest = s.slice(i + 1, i + 16);
      if (requireLookahead && rest.length < 6) continue;
      if (/^(?:[A-Z][a-z —–-]|I |\*\*[A-Z0-9`]|#{1,4} [A-Z])/.test(rest)) {
        return i + 1;
      }
    }
  }
  return -1;
}

/**
 * Split a completed assistant text that has a leaked Gemini thought block into
 * `{ thinking, text }`, stripping any stray `{% endraw %}` lines. Used to sanitize
 * prior assistant turns before re-sending history to Gemini and on `--resume`.
 *
 * @param {string} raw
 * @returns {{leaked: boolean, thinking: string, text: string}}
 */
/**
 * Strip post-fence Jinja `{% endraw %}` leak blocks (where Gemini slips back into
 * internal monologue after closing a `da_ops` fence and even hallucinates
 * `[superseded da_ops payload omitted — ...]` stubs).
 *
 * If another `da_ops` fence appears later in the turn, only the `{% endraw %}...`
 * monologue before that next fence is dropped; otherwise everything from `{% endraw %}`
 * to the end of the turn is stripped.
 */
function stripEndrawTail(text) {
  if (!text || !text.includes('endraw')) return text;
  const lines = String(text).split('\n');
  const out = [];
  let inOps = false;
  let inPayload = false;
  let skippingEndraw = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (skippingEndraw) {
      if (/^[ \t]*`{3,}[ \t]*da_ops[ \t]*$/i.test(line)) {
        skippingEndraw = false;
        inOps = true;
        out.push(line);
      }
      continue;
    }

    if (!inOps) {
      if (/(?:^|\S)[ \t]*`{3,}[ \t]*da_ops[ \t]*$/i.test(line) && !line.includes('````')) {
        inOps = true;
        out.push(line);
        continue;
      }
      if (/^[ \t]*\{%[ \t]*endraw[ \t]*%\}[ \t]*\r?$/.test(line)) {
        skippingEndraw = true;
        continue;
      }
      if (/^[ \t]*\[superseded da_ops (?:payload|batch) omitted — .*\][ \t]*\r?$/.test(line)) {
        continue;
      }
      out.push(line);
      continue;
    }

    // Inside a `da_ops` block
    if (!inPayload && /^--davai:[A-Za-z0-9_-]+--[ \t]*\r?$/.test(line)) {
      inPayload = true;
      out.push(line);
      continue;
    }
    if (inPayload && /^--davai:end--[ \t]*\r?$/.test(line)) {
      inPayload = false;
      out.push(line);
      continue;
    }
    if (!inPayload) {
      const closeEndraw = line.match(/^([ \t]*`{3,})[ \t]*\{%[ \t]*endraw[ \t]*%\}[ \t]*\r?$/);
      if (closeEndraw) {
        out.push(closeEndraw[1]);
        inOps = false;
        skippingEndraw = true;
        continue;
      }
      if (/^[ \t]*`{3,}[ \t]*\r?$/.test(line)) {
        inOps = false;
        out.push(line);
        continue;
      }
    }
    out.push(line);
  }

  return out.join('\n');
}

export function splitLeakedGeminiText(raw) {
  if (!raw) return { leaked: false, thinking: '', text: raw || '' };
  const cleaned = stripEndrawTail(String(raw)).replace(
    /^[ \t]*\{%[ \t]*endraw[ \t]*%\}[ \t]*\r?\n?/gm,
    '',
  );
  const m = LEAKED_THOUGHT_HEADER_RE.exec(cleaned);
  if (!m) return { leaked: false, thinking: '', text: cleaned };

  const body = cleaned.slice(m[0].length);
  const trimmed = body.replace(/^[ \t\r\n]+/, '');
  if (/^`{3,}[ \t]*da_ops\b/i.test(trimmed)) {
    return { leaked: true, thinking: '', text: trimmed };
  }

  const fenceSeam = findDaOpsFenceSeam(body, { allowEof: true });
  if (fenceSeam) {
    return { leaked: true, thinking: fenceSeam.thought, text: fenceSeam.text };
  }

  const pg = findProseGlueOutsideCode(body, { requireLookahead: false });
  if (pg > 0) {
    return {
      leaked: true,
      thinking: body.slice(0, pg).trim(),
      text: body.slice(pg),
    };
  }

  // Empty thought before direct reply (e.g. ` 생각하는 과정:\nClean reply.`): keep visible text.
  return { leaked: true, thinking: '', text: body };
}

/**
 * Streaming state machine that routes unflagged Gemini `<ctrl94>`...`<ctrl95>` leaks
 * onto `{ t: 'thinking' }` and emits only the clean post-`<ctrl95>` reply / `da_ops`
 * block on `{ t: 'text' }`.
 */
export class GeminiThoughtSanitizer {
  constructor() {
    this.sawFlaggedThought = false;
    /** @type {'init'|'leaked'|'text'} */
    this.mode = 'init';
    this.prefixBuf = '';
    this.leakedBuf = '';
    this.inPostEndrawThought = false;
    this.textLineCarry = '';
  }

  /**
   * Filter live `{ t: 'text' }` chunks so a `{% endraw %}` line emitted after a closing
   * fence (and the leaked self-talk / hallucinated `[superseded da_ops ...]` stub that
   * follows it) routes to `{ t: 'thinking' }` instead of polluting visible text.
   *
   * @param {string} chunk
   * @returns {Array<{t: 'thinking'|'text', delta: string}>}
   */
  #filterPostFenceText(chunk) {
    if (
      !this.inPostEndrawThought &&
      !this.textLineCarry &&
      !chunk.includes('{%') &&
      !chunk.includes('endraw')
    ) {
      return [{ t: 'text', delta: chunk }];
    }

    const buf = this.textLineCarry + chunk;
    const parts = buf.split('\n');
    this.textLineCarry = parts.pop() ?? '';

    const out = [];
    for (const rawLine of parts) {
      this.#processPostFenceLine(`${rawLine}\n`, out);
    }
    return out;
  }

  #processPostFenceLine(lineWithNl, out) {
    const trimmed = lineWithNl.replace(/\r?\n$/, '');
    if (this.inPostEndrawThought) {
      if (/^[ \t]*`{3,}[ \t]*da_ops[ \t]*$/i.test(trimmed)) {
        this.inPostEndrawThought = false;
        out.push({ t: 'text', delta: lineWithNl });
      } else if (
        !/^[ \t]*\[superseded da_ops (?:payload|batch) omitted — .*\][ \t]*$/.test(trimmed)
      ) {
        out.push({ t: 'thinking', delta: lineWithNl });
      }
      return;
    }

    const inlineCloseEndraw = trimmed.match(/^([ \t]*`{3,})[ \t]*\{%[ \t]*endraw[ \t]*%\}[ \t]*$/);
    if (inlineCloseEndraw) {
      out.push({ t: 'text', delta: `${inlineCloseEndraw[1]}\n` });
      this.inPostEndrawThought = true;
      return;
    }

    if (/^[ \t]*\{%[ \t]*endraw[ \t]*%\}[ \t]*$/.test(trimmed)) {
      this.inPostEndrawThought = true;
      return;
    }

    out.push({ t: 'text', delta: lineWithNl });
  }

  /**
   * @param {string} delta
   * @param {{isThought?: boolean, partIndex?: number}} [opts]
   * @returns {Array<{t: 'thinking'|'text', delta: string}>}
   */
  feed(delta, { isThought = false, partIndex = 0 } = {}) {
    if (!delta) return [];
    if (isThought) {
      this.sawFlaggedThought = true;
      return [{ t: 'thinking', delta }];
    }
    if (this.sawFlaggedThought || this.mode === 'text') {
      this.mode = 'text';
      return this.#filterPostFenceText(delta);
    }

    const events = [];

    // Multi-part boundary within a candidate while inside a leaked thought:
    // Part 0 was pre-`<ctrl95>` reasoning, Part 1+ is the visible answer.
    if (this.mode === 'leaked' && partIndex > 0) {
      const thought = this.leakedBuf.trim();
      if (thought) events.push({ t: 'thinking', delta: thought });
      this.leakedBuf = '';
      this.mode = 'text';
      events.push(...this.#filterPostFenceText(delta));
      return events;
    }

    if (this.mode === 'init') {
      this.prefixBuf += delta;
      const m = LEAKED_THOUGHT_HEADER_RE.exec(this.prefixBuf);
      if (m) {
        this.mode = 'leaked';
        const rem = this.prefixBuf.slice(m[0].length);
        this.prefixBuf = '';
        if (!rem) return events;
        delta = rem;
      } else if (couldBeLeakedHeader(this.prefixBuf)) {
        return events;
      } else {
        this.mode = 'text';
        const txt = this.prefixBuf;
        this.prefixBuf = '';
        events.push(...this.#filterPostFenceText(txt));
        return events;
      }
    }

    // mode === 'leaked'
    this.leakedBuf += delta;

    const trimmed = this.leakedBuf.replace(/^[ \t\r\n]+/, '');
    if (/^`{3,}[ \t]*da_ops\b/i.test(trimmed)) {
      this.mode = 'text';
      this.leakedBuf = '';
      events.push(...this.#filterPostFenceText(trimmed));
      return events;
    }

    const fenceSeam = findDaOpsFenceSeam(this.leakedBuf, { allowEof: false });
    if (fenceSeam) {
      if (fenceSeam.thought) events.push({ t: 'thinking', delta: `${fenceSeam.thought}\n` });
      this.mode = 'text';
      this.leakedBuf = '';
      events.push(...this.#filterPostFenceText(fenceSeam.text));
      return events;
    }

    const pg = findProseGlueOutsideCode(this.leakedBuf, { requireLookahead: true });
    if (pg > 0) {
      const thought = this.leakedBuf.slice(0, pg).trim();
      const ans = this.leakedBuf.slice(pg);
      this.mode = 'text';
      this.leakedBuf = '';
      if (thought) events.push({ t: 'thinking', delta: thought });
      if (ans) events.push(...this.#filterPostFenceText(ans));
      return events;
    }

    return events;
  }

  /**
   * Flush any remaining buffered text at stream end.
   * @returns {Array<{t: 'thinking'|'text', delta: string}>}
   */
  flush() {
    const events = [];
    if (this.mode === 'init' && this.prefixBuf) {
      if (!LEAKED_THOUGHT_HEADER_RE.test(`${this.prefixBuf}\n`)) {
        events.push(...this.#filterPostFenceText(this.prefixBuf));
      }
      this.prefixBuf = '';
    } else if (this.mode === 'leaked' && this.leakedBuf) {
      const fenceSeam = findDaOpsFenceSeam(this.leakedBuf, { allowEof: true });
      if (fenceSeam) {
        if (fenceSeam.thought) events.push({ t: 'thinking', delta: `${fenceSeam.thought}\n` });
        if (fenceSeam.text) events.push(...this.#filterPostFenceText(fenceSeam.text));
      } else {
        const pg = findProseGlueOutsideCode(this.leakedBuf, { requireLookahead: false });
        if (pg > 0) {
          const thought = this.leakedBuf.slice(0, pg).trim();
          const ans = this.leakedBuf.slice(pg);
          if (thought) events.push({ t: 'thinking', delta: thought });
          if (ans) events.push(...this.#filterPostFenceText(ans));
        } else {
          // Empty thought before direct reply (` 생각하는 과정:\nClean reply.`): emit as text
          // so valid short answers are never swallowed.
          events.push(...this.#filterPostFenceText(this.leakedBuf));
        }
      }
      this.leakedBuf = '';
      this.mode = 'text';
    }
    if (this.textLineCarry) {
      const carry = this.textLineCarry;
      this.textLineCarry = '';
      this.#processPostFenceLine(carry, events);
    }
    return events;
  }
}

export function createGemini({
  apiKey,
  model,
  maxTokens,
  effort,
  temperature,
  thinkingVisible,
  baseURL,
  streamTimeout,
  client: injectedClient,
}) {
  if (!thinkingVisible) {
    throw new Error(
      'Gemini requires thinking enabled (DAVAI_THINKING=true). With DAVAI_THINKING=false, ' +
        'Gemini models leak raw internal reasoning ("düşünceler\\n…") straight into the ' +
        'text channel and corrupt da_ops fences. Set DAVAI_THINKING=true (or unset ' +
        'DAVAI_THINKING=false) in $DAVAI_HOME/.env.',
    );
  }

  // `baseURL` was accepted by every other adapter and dropped here, while endpointOf()
  // in providers/index.js reported it for gemini regardless — so an auth diagnostic
  // named a server the request had never gone to. Threading it makes the two agree,
  // which matters now that meta.json records the endpoint per session.
  const client =
    injectedClient ||
    new GoogleGenAI({
      apiKey,
      httpOptions: {
        ...(baseURL ? { baseUrl: baseURL } : {}),
        timeout: 10 * 60 * 1000,
      },
    });

  return {
    name: 'gemini',
    model,

    async *send({ system, messages, signal }) {
      const thinkingLevel =
        effort && supportsGeminiThinkingLevel(model) ? GEMINI_THINKING_LEVEL[effort] : undefined;
      const baseConfig = {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
        ...(temperature != null ? { temperature } : {}),
        ...(signal ? { abortSignal: signal } : {}),
      };
      const config = {
        ...baseConfig,
        // Always request structured thought parts on Gemini (`includeThoughts: true`),
        // so reasoning stays on `part.thought` rather than leaking into `part.text`.
        thinkingConfig: {
          includeThoughts: true,
          ...(thinkingLevel ? { thinkingLevel } : {}),
        },
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
        // Older or custom Gemini slugs that reject `thinkingLevel` fall back cleanly to
        // `{ includeThoughts: true }`.
        if (err?.status === 400 && thinkingLevel) {
          try {
            stream = await client.models.generateContentStream({
              model,
              contents,
              config: { ...baseConfig, thinkingConfig: { includeThoughts: true } },
            });
          } catch (retryErr) {
            throw annotateMedia(wrapError(retryErr, 'gemini'), media);
          }
        } else {
          throw annotateMedia(wrapError(err, 'gemini'), media);
        }
      }

      let usage = null;
      let finish = 'end_turn';
      const sanitizer = new GeminiThoughtSanitizer();
      const watchdogOpts = {
        signal,
        ...(streamTimeout != null ? { firstChunkMs: streamTimeout, idleMs: streamTimeout } : {}),
      };
      try {
        for await (const chunk of iterateWithIdleTimeout(stream, watchdogOpts)) {
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          const cand = chunk.candidates?.[0];
          if (cand?.finishReason) finish = cand.finishReason;
          const parts = cand?.content?.parts || [];
          for (let pIdx = 0; pIdx < parts.length; pIdx++) {
            const part = parts[pIdx];
            if (!part?.text) continue;
            for (const outEv of sanitizer.feed(part.text, {
              isThought: Boolean(part.thought),
              partIndex: pIdx,
            })) {
              yield outEv;
            }
          }
        }
        for (const tailEv of sanitizer.flush()) {
          yield tailEv;
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

/**
 * Strip leaked Gemini reasoning bodies (up to the `<ctrl95>` fence or prose seam) and
 * stray Jinja `{% endraw %}` scaffolding from prior assistant turns before re-sending
 * history to Gemini, so an unsplit gateway response in an earlier turn or resumed
 * session never primes subsequent turns to dump thoughts into `part.text`.
 */
function sanitizePriorModelText(text) {
  if (!text) return text;
  const split = splitLeakedGeminiText(text);
  return split.text || text;
}

function toGeminiContent(m) {
  const isModel = m.role === 'assistant';
  return {
    role: isModel ? 'model' : 'user',
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
      return { text: isModel ? sanitizePriorModelText(p.text) : p.text };
    }),
  };
}