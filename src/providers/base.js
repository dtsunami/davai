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
  const status = err?.status ?? err?.statusCode;
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  let msg = err?.message || String(err);

  if (status === 401) msg = `${provider}: authentication failed — check your API key`;
  else if (status === 403) msg = `${provider}: permission denied — the key lacks access to this model`;
  else if (status === 404) msg = `${provider}: model not found — check the model id`;
  else if (status === 429) msg = `${provider}: rate limited — ${msg}`;

  return new ProviderError(msg, { status, retryable, provider });
}
