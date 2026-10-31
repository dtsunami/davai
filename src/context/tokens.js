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
 * Observed/estimated ratios outside this band are discarded rather than folded into the
 * EMA. Above 5x the provider is answering a different question than the one we estimated;
 * below 0.2x is a mis-count, and letting even one through yanks the live bar down for the
 * rest of the session while the EMA slowly climbs back.
 */
const MIN_RATIO = 0.2;
const MAX_RATIO = 5;

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
 * Gemini bills video by *duration*: 263 tokens per second of footage at the default
 * media resolution, plus ~32/s when the audio track is read. Duration is the number we
 * do not have — reading it means parsing container metadata, and the formats we accept
 * put it in nine different places — so it is inferred from file size against an assumed
 * bitrate.
 *
 * That inference is the weakest number in this file and it is deliberately visible
 * rather than buried in a magic divisor: a 4K clip at 40 Mbit/s is over-estimated by
 * ~20x, and a heavily-compressed screen recording under-estimated by similar. It is
 * here because the alternative is pricing video at zero in the context pane, and video
 * is the one attachment that can spend a six-figure token budget from a 10MB file.
 * Reconciliation against the provider's reported usage corrects it after the first turn.
 */
const VIDEO_BYTES_PER_SECOND = 187_500; // ~1.5 Mbit/s, typical compressed 1080p
export const VIDEO_TOKENS_PER_SECOND = 295; // 263 visual + ~32 audio

export function estimateVideo(bytes) {
  const seconds = bytes / VIDEO_BYTES_PER_SECOND;
  return Math.max(VIDEO_TOKENS_PER_SECOND, Math.round(seconds * VIDEO_TOKENS_PER_SECOND));
}

/** Seconds of footage implied by a byte count, for labelling an attachment. */
export function videoSeconds(bytes) {
  return bytes / VIDEO_BYTES_PER_SECOND;
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

  /**
   * @param {number} estimated @param {number} actual
   *
   * Implausible ratios are dropped in both directions. A high one is a provider reporting
   * something other than what we estimated; a low one would yank the live bar down for the
   * rest of the session before the EMA had any chance to climb back.
   */
  observe(estimated, actual) {
    if (!estimated || !actual) return;
    const r = actual / estimated;
    if (!Number.isFinite(r) || r < MIN_RATIO || r > MAX_RATIO) return;
    this.samples++;
    // Exponential moving average, weighted toward recent turns.
    const alpha = this.samples === 1 ? 1 : 0.3;
    this.ratio = this.ratio * (1 - alpha) + r * alpha;
  }

  apply(estimated) {
    return Math.round(estimated * this.ratio);
  }
}
