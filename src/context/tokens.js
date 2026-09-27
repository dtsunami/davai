/**
 * Token counting.
 *
 * Two tiers: a cheap synchronous heuristic that keeps the live status bar responsive,
 * and reconciliation against the authoritative `usage` returned by each response.
 * Anthropic additionally offers exact pre-flight counts via countTokens().
 *
 * Deliberately not using tiktoken: it is an OpenAI tokenizer and would be wrong for
 * three of the four providers.
 */

/**
 * Heuristic estimate. Code tokenizes denser than prose (more punctuation, more short
 * identifiers), so a flat chars/4 under-counts source files noticeably.
 */
export function estimate(text) {
  if (!text) return 0;
  const chars = text.length;
  const lines = text.split('\n').length;
  const nonWord = (text.match(/[^\w\s]/g) || []).length;
  const density = nonWord / Math.max(chars, 1);
  // ~3.4 chars/token for punctuation-heavy code, ~4.2 for prose.
  const perToken = density > 0.12 ? 3.4 : 4.2;
  return Math.ceil(chars / perToken) + Math.ceil(lines * 0.15);
}

/** Estimate an image's token cost. Rough, but far better than treating it as free. */
export function estimateImage(bytes) {
  // Roughly (w*h)/750 for Anthropic; we only have byte size, so approximate from it.
  return Math.min(1600, Math.max(85, Math.round(bytes / 750)));
}

/**
 * Tracks the ratio between our estimate and the provider's reported count, so the
 * live bar converges on reality over a session instead of staying permanently wrong.
 */
export class TokenCalibrator {
  constructor() {
    this.ratio = 1;
    this.samples = 0;
  }

  /** @param {number} estimated @param {number} actual */
  observe(estimated, actual) {
    if (!estimated || !actual) return;
    const r = actual / estimated;
    if (!Number.isFinite(r) || r <= 0 || r > 5) return;
    this.samples++;
    // Exponential moving average, weighted toward recent turns.
    const alpha = this.samples === 1 ? 1 : 0.3;
    this.ratio = this.ratio * (1 - alpha) + r * alpha;
  }

  apply(estimated) {
    return Math.round(estimated * this.ratio);
  }
}
