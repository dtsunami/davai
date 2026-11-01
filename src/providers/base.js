/**
 * Provider contract.
 *
 * Because da_ops replaces tool-calling entirely (req 8), an adapter needs only
 * streaming text, image parts, usage and cancellation. That keeps each one small.
 *
 * send({system, messages, signal}) -> AsyncIterable<Event>
 *
 *   { t:'text',     delta }
 *   { t:'thinking', delta }
 *   { t:'tool_calls', calls }  [{id, name, args}] — native calls the model made despite
 *                              being offered no tools; the loop runs any that carry a
 *                              da_ops batch (agent/native.js) and logs every one
 *   { t:'usage',    in, out, cacheRead, cacheWrite, contextIn }
 *   { t:'stop',     reason }   end_turn | max_tokens | refusal | cancelled | error
 *                              (or a provider's own reason, passed through, e.g. tool_calls)
 *
 * A `message` is { role: 'user'|'assistant', content: Part[] } where a Part is
 * { type:'text', text }, { type:'image', mediaType, data } or
 * { type:'video', mediaType, data }  (data = base64).
 *
 * Only the Gemini adapter accepts a video part; the rest throw videoUnsupported() when
 * they meet one. Video is gated on `cfg.model.video` before it ever reaches a ledger,
 * so a throw here means the capability flag and the adapter disagree — which is a bug
 * worth a loud failure rather than a request that silently omits the thing the prompt
 * is asking about.
 */

/**
 * davai has five effort levels; OpenAI reasoning takes four. Shared by both
 * OpenAI-shaped adapters so they cannot drift — sending "max" is a 400.
 */
export const OPENAI_EFFORT = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

/**
 * OpenRouter takes a `reasoning` object and maps the effort onto whichever upstream
 * provider it routes the request to. The OpenAI-shaped `reasoning_effort` field is not
 * honoured for routed models — depending on the upstream it is ignored or 400s — so the
 * two providers need different fields even though they share this adapter.
 */
export const OPENROUTER_EFFORT = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

export class ProviderError extends Error {
  constructor(message, { status, retryable = false, provider } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.provider = provider;
  }
}

/** Convenience: collapse a message's parts to plain text. */
export function textOf(message) {
  return (message.content || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** True when a message carries at least one image part. */
export function hasImages(messages) {
  return messages.some((m) => (m.content || []).some((p) => p.type === 'image'));
}

/** True when a message carries at least one video part. */
export function hasVideo(messages) {
  return messages.some((m) => (m.content || []).some((p) => p.type === 'video'));
}

/**
 * Describe the non-text parts of an outgoing request, payloads excluded.
 *
 * The transcript records the prompt text, so an attachment that was rejected by the
 * provider leaves no trace of what was actually attached — the `[video: url]` substituted
 * into the text proves a ref was *recognised*, not that a part was built from it or what
 * shape it took. Logging the descriptor closes that gap for the cost of a few bytes a
 * turn; logging the part itself would put a 10MB base64 blob in a jsonl file.
 *
 * Byte counts are derived from the base64 length rather than carried, because a ledger
 * part keeps no file size once it is encoded.
 *
 * @param {{role: string, content: object[]}[]} messages
 * @returns {{role: string, type: string, mediaType: string|null, uri?: string, bytes?: number}[]}
 */
export function describeParts(messages) {
  const out = [];
  for (const m of messages || []) {
    for (const p of m.content || []) {
      if (!p || p.type === 'text') continue;
      out.push({
        role: m.role,
        type: p.type,
        mediaType: p.mediaType ?? null,
        // A part carries bytes or a URI, never both (context/ledger.js).
        ...(p.uri ? { uri: p.uri } : {}),
        ...(p.data ? { bytes: Math.floor((p.data.length * 3) / 4) } : {}),
      });
    }
  }
  return out;
}

/**
 * Raised by every adapter except Gemini's when a video part reaches it.
 *
 * Deliberately not a silent drop. The alternative — omitting the part and sending the
 * prompt anyway — produces a model confidently answering a question about a video it
 * was never given, which is indistinguishable from a hallucination at the transcript.
 */
export function videoUnsupported(provider) {
  return new ProviderError(
    `${provider}: video input is not supported — only Gemini models take video natively. ` +
      'Switch model, or extract frames and attach them as images.',
    { provider },
  );
}

/**
 * Total input the provider actually read, cache hits and writes included.
 *
 * `in` on a usage event is *fresh* input by contract, not the whole prompt. The
 * adapters normalise each provider's shape onto that so downstream code never has to
 * know which API it came from: Anthropic reports `input_tokens` with the cache fields
 * separate, while the OpenAI-shaped APIs report a prompt total that already contains
 * the cached subset. Costing the inclusive figure at full price and again at the cache
 * rate charged for the same tokens twice.
 *
 * `contextIn` carries the prompt total where the adapter knows it. The sum is the
 * fallback for a provider that reports the parts separately, and for transcripts
 * written before `contextIn` existed.
 *
 * @param {{in?: number, cacheRead?: number, cacheWrite?: number, contextIn?: number}} usage
 * @returns {number}
 */
export function billedInput(usage) {
  if (!usage) return 0;
  if (typeof usage.contextIn === 'number') return usage.contextIn;
  return (usage.in || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
}

const MAX_UNWRAP = 5;
const MAX_MESSAGE = 300;

/**
 * Dig the human sentence out of an SDK error.
 *
 * Google nests it two deep — a JSON string inside `error.message` of a JSON string —
 * so `err.message` is a forty-line blob with one useful clause in it. Returns the
 * innermost message plus whatever status and retry hint were found along the way.
 *
 * @returns {{message: string, status?: number, code?: string, retryAfterMs?: number, raw: string}}
 */
export function unwrapError(err) {
  const raw = typeof err === 'string' ? err : err?.message || String(err);
  let message = raw;
  let status = err?.status ?? err?.statusCode;
  let code;
  let retryAfterMs;

  for (let i = 0; i < MAX_UNWRAP; i++) {
    const parsed = tryParse(message);
    if (!parsed) break;
    const body = parsed.error ?? parsed;
    if (typeof body?.code === 'number') status ??= body.code;
    else if (typeof parsed.code === 'number') status ??= parsed.code;
    // Innermost wins: the outer layer carries the HTTP reason phrase ("Service
    // Unavailable"), the inner one the canonical code ("UNAVAILABLE").
    if (typeof body?.status === 'string') code = body.status;
    retryAfterMs ??= retryDelayOf(body?.details);
    if (typeof body?.message !== 'string') break;
    message = body.message;
  }

  retryAfterMs ??= retryDelayOf(err?.details) ?? secondsHintOf(message);
  return { message: message.trim(), status, code, retryAfterMs, raw, upstream: upstreamOf(err) };
}

/**
 * Dig the *routed* provider's rejection out of an OpenRouter error.
 *
 * OpenRouter is a proxy, so its `error.message` describes its own layer — "Provider
 * returned error" — and the upstream's actual sentence is a JSON string parked in
 * `error.metadata.raw`. The OpenAI SDK builds `err.message` from `error.message` alone,
 * so unwrapError's walk never reaches the metadata and the one clause that says *why*
 * the request was rejected is discarded before it ever reaches the transcript.
 *
 * Returns null for every other provider, which carries no metadata envelope.
 *
 * @returns {{provider?: string, message: string}|null}
 */
function upstreamOf(err) {
  // `err.error` is the SDK's parsed body; the string form is the fallback for an error
  // that was re-thrown or logged and re-read.
  const meta =
    err?.error?.metadata ??
    tryParse(String(err?.message || '').replace(/^\d+\s+/, ''))?.error?.metadata;
  if (!meta || typeof meta !== 'object') return null;

  const provider = typeof meta.provider_name === 'string' ? meta.provider_name : undefined;
  const raw = meta.raw;
  let message = '';
  if (typeof raw === 'string') {
    const parsed = tryParse(raw);
    const body = parsed?.error ?? parsed;
    message = typeof body?.message === 'string' ? body.message : raw;
  } else if (raw && typeof raw === 'object') {
    const body = raw.error ?? raw;
    message = typeof body?.message === 'string' ? body.message : JSON.stringify(raw);
  }

  message = message.trim();
  if (!message && !provider) return null;
  return { provider, message };
}

/** google.rpc.RetryInfo, when the API bothered to send one. */
function retryDelayOf(details) {
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    const s = /^(\d+(?:\.\d+)?)s$/.exec(String(d?.retryDelay ?? ''));
    if (s) return Math.ceil(Number(s[1]) * 1000);
  }
  return undefined;
}

/** "Please retry in 12.928263376s." — the only hint some errors carry. */
function secondsHintOf(message) {
  const m = /retry in (\d+(?:\.\d+)?)s/i.exec(message || '');
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

function tryParse(text) {
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** First sentence or line, capped — the rest stays in `detail`. */
function condense(message) {
  const firstLine = message.split('\n').find((l) => l.trim()) || message;
  const line = firstLine.trim();
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE - 1)}…` : line;
}

/**
 * Map a thrown SDK error into a ProviderError with a usable message.
 * Every adapter funnels through this so the REPL shows one consistent shape.
 */
export function wrapError(err, provider) {
  if (err?.name === 'AbortError' || err?.message === 'Request was aborted.') {
    const e = new ProviderError('cancelled', { provider });
    e.cancelled = true;
    return e;
  }

  const { message, status, retryAfterMs, raw, upstream } = unwrapError(err);
  let retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  // A proxy's own message is a routing-layer placeholder. When the upstream said
  // something, that is the sentence the operator needs.
  const primary = upstream?.message || message;
  let msg = `${provider}: ${condense(primary)}`;

  if (status === 401) msg = `${provider}: authentication failed — check your API key`;
  else if (status === 403) msg = `${provider}: permission denied — the key lacks access to this model`;
  else if (status === 404) msg = `${provider}: model not found — check the model id`;
  else if (status === 429) {
    // "limit: 0" is not a throttle. The model has no quota on this plan at all, so the
    // retry hint the API sends alongside it is a lie — waiting cannot help.
    const zero = /limit:\s*0\b/.test(raw);
    const model = /model:\s*([\w.:-]+)/.exec(raw)?.[1];
    if (zero) {
      retryable = false;
      msg =
        `${provider}: no quota for ${model || 'this model'} on the current plan ` +
        `(429) — enable billing for the project or choose a model your plan covers. ` +
        `Retrying will not help.`;
    } else {
      msg = `${provider}: rate limited — ${condense(message)}`;
    }
  } else if (status >= 500) {
    const kind = status === 503 ? 'service unavailable' : 'server error';
    msg = `${provider}: ${kind} (${status}) — ${condense(primary)}`;
  }
  // Which backend produced it: on a router the same model id can reach several, and
  // "works on one, 400s on another" is otherwise invisible from the transcript.
  if (upstream?.provider) msg += ` [upstream: ${upstream.provider}]`;

  const e = new ProviderError(msg, { status, retryable, provider });
  e.retryAfterMs = retryAfterMs;
  e.detail = raw === primary ? undefined : raw;
  return e;
}
