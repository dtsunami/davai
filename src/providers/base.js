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
 *   { t:'usage',    in, out, cacheRead, cacheWrite }
 *   { t:'stop',     reason }   end_turn | max_tokens | refusal | cancelled | error
 *
 * A `message` is { role: 'user'|'assistant', content: Part[] } where a Part is
 * { type:'text', text } or { type:'image', mediaType, data }  (data = base64).
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
  return { message: message.trim(), status, code, retryAfterMs, raw };
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

  const { message, status, retryAfterMs, raw } = unwrapError(err);
  let retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  let msg = `${provider}: ${condense(message)}`;

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
    msg = `${provider}: ${kind} (${status}) — ${condense(message)}`;
  }

  const e = new ProviderError(msg, { status, retryable, provider });
  e.retryAfterMs = retryAfterMs;
  e.detail = raw === message ? undefined : raw;
  return e;
}
