/**
 * Stream idle-stall watchdog + instant cancellation race.
 *
 * Why this exists:
 *   1. An SSE / chunked HTTP connection behind NAT, a corporate proxy, OpenRouter, or
 *      Google's Gemini gateway can go half-open: TCP stays established, no FIN/RST
 *      arrives, no keepalive fails, and `for await (const chunk of stream)` suspends
 *      forever (or for the SDK's 10-minute whole-request timeout — or unbounded on
 *      `@google/genai`).
 *   2. Even when the operator presses `Esc` (`signal.abort()`), if the underlying
 *      socket/SDK iterator fails to reject its pending `next()` promise promptly,
 *      `for await` stays parked on `iter.next()` and the REPL sits stuck on
 *      `cancelling…`.
 *
 * `iterateWithIdleTimeout` races every `iter.next()` against BOTH:
 *   - `signal` abort -> settles immediately with an `AbortError` (`wrapError` maps it
 *     to `{ cancelled: true }`), and calls `iter.return()` in the background.
 *   - an idle timer (`idleMs`, default 90s between chunks; `firstChunkMs`, default 180s
 *     before the first chunk so deep reasoning models have room to think before
 *     emitting their first delta) -> rejects with a retryable `408` timeout error so
 *     `#streamOnce` can retry cleanly or report the stall instead of hanging forever.
 */

export const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 180_000;
export const DEFAULT_IDLE_CHUNK_TIMEOUT_MS = 90_000;

function makeAbortError() {
  const err = new Error('Request was aborted.');
  err.name = 'AbortError';
  return err;
}

function makeStallError(ms, sawChunk) {
  const secs = Math.round(ms / 1000);
  const where = sawChunk
    ? `stream stalled with no data for ${secs}s mid-response`
    : `no response bytes received after ${secs}s`;
  const err = new Error(`stream timeout: ${where}`);
  err.status = 408;
  return err;
}

/**
 * Wrap an async iterable so neither a half-open socket nor a sluggish SDK abort can
 * hang `for await` indefinitely.
 *
 * @template T
 * @param {AsyncIterable<T>|Iterable<T>} iterable
 * @param {{
 *   signal?: AbortSignal,
 *   firstChunkMs?: number,
 *   idleMs?: number,
 * }} [opts]
 * @returns {AsyncGenerator<T>}
 */
export async function* iterateWithIdleTimeout(
  iterable,
  {
    signal,
    firstChunkMs = DEFAULT_FIRST_CHUNK_TIMEOUT_MS,
    idleMs = DEFAULT_IDLE_CHUNK_TIMEOUT_MS,
  } = {},
) {
  if (signal?.aborted) throw makeAbortError();

  const asyncFn = iterable?.[Symbol.asyncIterator];
  const syncFn = iterable?.[Symbol.iterator];
  const iter = asyncFn ? asyncFn.call(iterable) : syncFn.call(iterable);

  let sawChunk = false;

  const closeIter = () => {
    try {
      const ret = iter.return?.();
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    } catch {
      /* ignore teardown errors on dead streams */
    }
  };

  try {
    for (;;) {
      if (signal?.aborted) {
        closeIter();
        throw makeAbortError();
      }

      const budgetMs = sawChunk ? idleMs : firstChunkMs;
      let timer = null;
      let onAbort = null;

      const nextPromise = Promise.resolve(iter.next());
      // Prevent an unhandledRejection if timeout/abort wins the race and `nextPromise`
      // later rejects as the socket tears down.
      nextPromise.catch(() => {});

      const guards = [];
      if (budgetMs > 0 && Number.isFinite(budgetMs)) {
        guards.push(
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              closeIter();
              reject(makeStallError(budgetMs, sawChunk));
            }, budgetMs);
            timer.unref?.();
          }),
        );
      }
      if (signal) {
        guards.push(
          new Promise((_, reject) => {
            onAbort = () => {
              closeIter();
              reject(makeAbortError());
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }),
        );
      }

      let step;
      try {
        step = guards.length ? await Promise.race([nextPromise, ...guards]) : await nextPromise;
      } finally {
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      }

      if (step.done) break;
      sawChunk = true;
      yield step.value;
    }
  } finally {
    closeIter();
  }
}