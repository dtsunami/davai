import { describe, it, expect } from 'vitest';
import { unwrapError, wrapError, ProviderError } from '../src/providers/base.js';

/**
 * Google nests its error body: a JSON document, serialised, placed in the `message` of
 * another JSON document. Built with JSON.stringify rather than hand-escaped so the
 * fixture is the real shape and not a transcription of one.
 */
function googleError(inner, outerStatus) {
  const innerBody = JSON.stringify({ error: inner }, null, 2) + '\n';
  return {
    message: JSON.stringify({
      error: { message: innerBody, code: inner.code, status: outerStatus },
    }),
  };
}

const QUOTA_TEXT =
  'You exceeded your current quota, please check your plan and billing details. For more ' +
  'information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n' +
  '* Quota exceeded for metric: ' +
  'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, ' +
  'limit: 0, model: gemini-3.1-pro\n' +
  '* Quota exceeded for metric: ' +
  'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, ' +
  'model: gemini-3.1-pro\n' +
  'Please retry in 12.928263376s.';

const GEMINI_503 = googleError(
  {
    code: 503,
    message:
      'This model is currently experiencing high demand. Spikes in demand are usually ' +
      'temporary. Please try again later.',
    status: 'UNAVAILABLE',
  },
  'Service Unavailable',
);

const GEMINI_429 = googleError(
  {
    code: 429,
    message: QUOTA_TEXT,
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' },
    ],
  },
  'Too Many Requests',
);

describe('unwrapError', () => {
  it('digs the sentence out of a doubly nested body', () => {
    const { message, status, code } = unwrapError(GEMINI_503);
    expect(message).toBe(
      'This model is currently experiencing high demand. Spikes in demand are usually ' +
        'temporary. Please try again later.',
    );
    expect(status).toBe(503);
    // The canonical rpc code from the inner body, not the outer HTTP reason phrase.
    expect(code).toBe('UNAVAILABLE');
  });

  it('reads RetryInfo from the details array', () => {
    expect(unwrapError(GEMINI_429).retryAfterMs).toBe(12000);
  });

  it('falls back to a "retry in Ns" hint in the prose', () => {
    const err = { status: 429, message: 'Rate limited. Please retry in 2.5s.' };
    expect(unwrapError(err).retryAfterMs).toBe(2500);
  });

  it('leaves a plain message alone', () => {
    const { message, raw } = unwrapError(new Error('socket hang up'));
    expect(message).toBe('socket hang up');
    expect(raw).toBe('socket hang up');
  });

  it('survives a message that only looks like JSON', () => {
    const { message } = unwrapError({ message: '{not actually json' });
    expect(message).toBe('{not actually json');
  });

  it('accepts a bare string', () => {
    expect(unwrapError('something broke').message).toBe('something broke');
  });
});

describe('wrapError', () => {
  it('reports a 503 as a transient service problem, and retryable', () => {
    const e = wrapError(GEMINI_503, 'gemini');
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toBe(
      'gemini: service unavailable (503) — This model is currently experiencing high ' +
        'demand. Spikes in demand are usually temporary. Please try again later.',
    );
    expect(e.retryable).toBe(true);
    expect(e.status).toBe(503);
  });

  it('treats "limit: 0" as a plan problem, not a rate limit', () => {
    const e = wrapError(GEMINI_429, 'gemini');
    expect(e.message).toContain('no quota for gemini-3.1-pro on the current plan');
    expect(e.message).toContain('enable billing');
    expect(e.message).toContain('Retrying will not help');
    // The crux: the API sends a retryDelay, and honouring it would loop forever.
    expect(e.retryable).toBe(false);
  });

  it('still treats a genuine throttle as retryable', () => {
    const e = wrapError(
      { status: 429, message: 'Rate limit reached for gpt-5, limit: 10000. Please retry in 2s.' },
      'openai',
    );
    expect(e.message).toContain('rate limited');
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(2000);
  });

  it('keeps the long body as detail rather than in the headline', () => {
    const e = wrapError(GEMINI_429, 'gemini');
    expect(e.message.length).toBeLessThan(300);
    expect(e.detail).toContain('generate_content_free_tier_requests');
  });

  it('maps auth and lookup failures to advice', () => {
    expect(wrapError({ status: 401, message: 'x' }, 'openai').message).toMatch(/check your API key/);
    expect(wrapError({ status: 403, message: 'x' }, 'openai').message).toMatch(/permission denied/);
    expect(wrapError({ status: 404, message: 'x' }, 'openai').message).toMatch(/model not found/);
    expect(wrapError({ status: 401, message: 'x' }, 'openai').retryable).toBe(false);
  });

  it('passes cancellation through untouched', () => {
    const e = wrapError(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'gemini');
    expect(e.cancelled).toBe(true);
    expect(e.message).toBe('cancelled');
  });

  it('condenses a multi-line body to its first line', () => {
    const e = wrapError({ status: 500, message: 'first line\nsecond line\nthird' }, 'grok');
    expect(e.message).toBe('grok: server error (500) — first line');
  });
});
