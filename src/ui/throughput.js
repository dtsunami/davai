/**
 * Streaming throughput tracker & terminal plots.
 *
 * Tracks output token rate over time as thinking and text deltas arrive, bucketed into
 * 1-second intervals so stalls or sharp drops during complex structured generation
 * (e.g. large da_ops payloads) are immediately visible on the live sparkline and in the
 * /tps (ctrl+t) time-series chart.
 *
 * During streaming, deltas are converted to estimated tokens (`estimate(delta)`). When
 * the provider's authoritative `usage.out` arrives at turn-end, the turn's buckets are
 * rescaled so the area under the curve matches the exact billed output token count.
 */
import { estimate } from '../context/tokens.js';
import { billedInput } from '../providers/base.js';
import { glyphs } from './theme.js';

const BUCKET_MS = 1000;
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const ASCII_SPARK = ['.', ':', '-', '=', '+', '*', '#', '@'];

const modernSpark = glyphs.bar === '█';

export class ThroughputTracker {
  /** @param {{bucketMs?: number, maxBuckets?: number}} [opts] */
  constructor({ bucketMs = BUCKET_MS, maxBuckets = 600 } = {}) {
    this.bucketMs = bucketMs;
    this.maxBuckets = maxBuckets;
    /**
     * Completed and active turns.
     *
     * `contextTokens` is the provider's billed input count for the turn, and `ttftMs` /
     * `durationMs` are the harness's own wall-clock measurements. Those three are what
     * the perf history is built from, so they are recorded here rather than derived from
     * the UI's delta-arrival timestamps, which a busy event loop can skew.
     *
     * @type {Array<{
     *   turn: number,
     *   model: string,
     *   provider: string,
     *   startedAt: number,
     *   firstTokenAt: number|null,
     *   endedAt: number|null,
     *   buckets: Array<{t: number, tok: number, thinkTok: number, textTok: number, chars: number}>,
     *   rawTokens: number,
     *   actualTokens: number|null,
     *   scale: number,
     *   contextTokens: number|null,
     *   ttftMs: number|null,
     *   durationMs: number|null,
     * }>}
     */
    this.turns = [];
    this.active = null;
  }

  /**
   * Start tracking a new assistant turn.
   * @param {{turn?: number, model?: string, provider?: string, now?: number}} [info]
   */
  startTurn({ turn = this.turns.length + 1, model = '', provider = '', now = Date.now() } = {}) {
    if (this.active && !this.active.endedAt) {
      this.active.endedAt = now;
    }
    const entry = {
      turn,
      model,
      provider,
      startedAt: now,
      firstTokenAt: null,
      endedAt: null,
      buckets: [],
      rawTokens: 0,
      actualTokens: null,
      scale: 1,
      contextTokens: null,
      ttftMs: null,
      durationMs: null,
    };
    this.turns.push(entry);
    this.active = entry;
    return entry;
  }

  /**
   * Record a streamed delta.
   * @param {'thinking'|'text'} kind
   * @param {string} delta
   * @param {number} [now]
   */
  record(kind, delta, now = Date.now()) {
    if (!delta) return;
    if (!this.active) this.startTurn({ now });
    const t = this.active;
    if (t.firstTokenAt == null) t.firstTokenAt = now;

    // estimate() adds a per-line term that dominates a one-character delta, so short
    // fragments are counted at the estimator's own prose rate. Using a different rate
    // here made one turn's rawTokens mix two scales and the live rate step at the
    // boundary. Reconcile rescales the turn against the provider's count regardless.
    const tok = delta.length < 12 ? delta.length / 4.2 : estimate(delta);
    t.rawTokens += tok;

    const idx = Math.max(0, Math.floor((now - t.startedAt) / this.bucketMs));
    while (t.buckets.length <= idx && t.buckets.length < this.maxBuckets) {
      t.buckets.push({
        t: t.startedAt + t.buckets.length * this.bucketMs,
        tok: 0,
        thinkTok: 0,
        textTok: 0,
        chars: 0,
      });
    }
    const b = t.buckets[Math.min(idx, t.buckets.length - 1)];
    if (b) {
      b.tok += tok;
      if (kind === 'thinking') b.thinkTok += tok;
      else b.textTok += tok;
      b.chars += delta.length;
    }
  }

  /**
   * Fill zero-token buckets up to `now` so a stall mid-stream visibly drops the plot to 0
   * rather than freezing the last non-zero bar.
   */
  tick(now = Date.now()) {
    const t = this.active;
    if (!t || t.endedAt || t.firstTokenAt == null) return;
    const idx = Math.max(0, Math.floor((now - t.startedAt) / this.bucketMs));
    while (t.buckets.length <= idx && t.buckets.length < this.maxBuckets) {
      t.buckets.push({
        t: t.startedAt + t.buckets.length * this.bucketMs,
        tok: 0,
        thinkTok: 0,
        textTok: 0,
        chars: 0,
      });
    }
  }

  /**
   * Reconcile the turn's estimated buckets against the provider's reported output tokens.
   */
  reconcileUsage(usage) {
    const t = this.active || this.turns.at(-1);
    if (!t || !usage) return;
    // The context point is recorded even when the turn produced no output. A refusal or a
    // budget-blown turn still billed its input, and dropping it made the context axis
    // understate how full the window was. It is the billed prompt — cache reads included —
    // not the fresh part, which is the figure the provider and we actually agree on.
    const ctx = billedInput(usage);
    if (ctx) t.contextTokens = ctx;
    // Left null rather than 0 when the turn produced nothing: a refusal has no rate to
    // score, and every rollup treats a null as "count the turn, score it no rate" while a
    // 0 would add this turn's whole duration to the denominator and dilute the average.
    if (!usage.out) return;
    t.actualTokens = usage.out;
    if (t.rawTokens > 0) {
      const s = usage.out / t.rawTokens;
      if (Number.isFinite(s) && s > 0.1 && s < 10) t.scale = s;
    }
  }

  /**
   * Attach the harness's own wall-clock timing to the turn that just finished.
   *
   * The tracker's delta-arrival timestamps are good enough to drive a live display, but
   * these are the numbers that went into the session log, and the display should not
   * disagree with the record.
   * @param {{ttftMs?: number|null, durationMs?: number|null}} [timing]
   */
  applyTiming({ ttftMs = null, durationMs = null } = {}) {
    const t = this.active || this.turns.at(-1);
    if (!t) return;
    if (ttftMs != null) t.ttftMs = ttftMs;
    if (durationMs != null) t.durationMs = durationMs;
  }

  endTurn(now = Date.now()) {
    if (!this.active) return;
    this.tick(now);
    this.active.endedAt = now;
    this.active = null;
  }

  /**
   * Instantaneous tok/s over the trailing `windowMs` (default 3s), plus turn average,
   * peak, minimum non-zero trough, and recent per-second series for sparklines.
   */
  snapshot(now = Date.now(), { seriesPoints = 24, turnIndex = -1 } = {}) {
    const t =
      turnIndex >= 0
        ? this.turns[turnIndex]
        : this.active || this.turns.at(-1) || null;
    if (!t) {
      return {
        turn: 0,
        model: '',
        provider: '',
        contextTokens: null,
        active: false,
        currentTps: 0,
        avgTps: 0,
        peakTps: 0,
        lowTps: 0,
        totalTokens: 0,
        ttftMs: null,
        durationMs: 0,
        series: [],
        buckets: [],
      };
    }

    if (t === this.active) this.tick(now);

    const endMs = t.endedAt || now;
    const durationMs = t.durationMs ?? Math.max(0, endMs - t.startedAt);
    // The harness's measured value wins where we have it. The first delta we saw is the
    // same instant to within a frame, and while a turn is still running it is all there is.
    const ttftMs =
      t.ttftMs ?? (t.firstTokenAt != null ? Math.max(0, t.firstTokenAt - t.startedAt) : null);
    const streamMs =
      t.firstTokenAt != null ? Math.max(250, endMs - t.firstTokenAt) : Math.max(250, durationMs);
    const scale = t.scale || 1;
    const perSecScale = (1000 / this.bucketMs) * scale;

    const rates = t.buckets.map((b) => ({
      t: b.t,
      tps: b.tok * perSecScale,
      thinkTps: b.thinkTok * perSecScale,
      textTps: b.textTok * perSecScale,
    }));

    // Trailing 3-bucket weighted rate while active; last 2 buckets when finished.
    const tail = rates.slice(-3);
    let currentTps = 0;
    if (tail.length) {
      const weights = tail.length === 3 ? [0.2, 0.3, 0.5] : tail.length === 2 ? [0.4, 0.6] : [1];
      currentTps = tail.reduce((acc, r, i) => acc + r.tps * weights[i], 0);
    }

    const totalTokens = Math.round(t.actualTokens ?? t.rawTokens * scale);
    const avgTps = totalTokens > 0 ? totalTokens / (streamMs / 1000) : 0;

    // Exclude the pre-TTFT waiting buckets when computing peak/low streaming rates.
    const firstIdx =
      t.firstTokenAt != null
        ? Math.max(0, Math.floor((t.firstTokenAt - t.startedAt) / this.bucketMs))
        : 0;
    const activeRates = rates.slice(firstIdx).map((r) => r.tps);
    const peakTps = activeRates.length ? Math.max(...activeRates) : 0;
    // Skip the very first and last partial buckets for the trough calculation if we have >2 buckets.
    const interior = activeRates.length > 2 ? activeRates.slice(1, -1) : activeRates;
    const lowTps = interior.length ? Math.min(...interior) : 0;

    const series = rates.slice(-seriesPoints).map((r) => r.tps);

    return {
      turn: t.turn,
      model: t.model,
      provider: t.provider || '',
      contextTokens: t.contextTokens,
      active: t === this.active && !t.endedAt,
      currentTps,
      avgTps,
      peakTps,
      lowTps,
      totalTokens,
      ttftMs,
      durationMs,
      series,
      buckets: rates,
    };
  }
}

/**
 * Render a compact 1-line sparkline of tok/s values.
 * @param {number[]} values
 * @param {{width?: number, max?: number}} [opts]
 * @returns {string}
 */
export function renderSparkline(values, { width = 16, max = 0 } = {}) {
  if (!values || !values.length) return '';
  const slice = values.slice(-width);
  const ceiling = Math.max(max, ...slice, 1);
  const chars = modernSpark ? SPARK_CHARS : ASCII_SPARK;
  return slice
    .map((v) => {
      if (v <= 0) return modernSpark ? '·' : '.';
      const idx = Math.min(
        chars.length - 1,
        Math.max(0, Math.floor((v / ceiling) * (chars.length - 1))),
      );
      return chars[idx];
    })
    .join('');
}

/**
 * Render a multi-row ASCII/Unicode chart of tok/s over time.
 * Distinguishes thinking vs text output and marks slowdown troughs.
 *
 * @param {Array<{tps: number, thinkTps?: number, textTps?: number}>} buckets
 * @param {{width?: number, height?: number}} [opts]
 * @returns {{lines: Array<{label: string, cells: Array<{ch: string, kind: 'think'|'text'|'low'|'empty'}>}>, maxTps: number, spanSec: number}}
 */
export function buildThroughputChart(buckets, { width = 56, height = 8 } = {}) {
  const cols = Math.max(10, Math.min(width, buckets.length || 1));
  const resampled = resampleBuckets(buckets, cols);
  const maxTps = Math.max(10, ...resampled.map((b) => b.tps));
  const avgTps =
    resampled.length > 0
      ? resampled.reduce((s, b) => s + b.tps, 0) / resampled.length
      : 0;

  const lines = [];
  for (let row = height - 1; row >= 0; row--) {
    const rowBottom = (row / height) * maxTps;
    const rowTop = ((row + 1) / height) * maxTps;
    const label =
      row === height - 1
        ? `${Math.round(maxTps)}`
        : row === Math.floor(height / 2)
          ? `${Math.round(maxTps / 2)}`
          : row === 0
            ? '0'
            : '';

    const cells = resampled.map((b) => {
      if (b.tps <= rowBottom) return { ch: ' ', kind: 'empty' };
      const fill = Math.min(1, (b.tps - rowBottom) / Math.max(1e-6, rowTop - rowBottom));
      const chars = modernSpark ? SPARK_CHARS : ASCII_SPARK;
      const idx = Math.min(chars.length - 1, Math.max(0, Math.ceil(fill * (chars.length - 1))));
      const ch = fill >= 0.95 ? (modernSpark ? '█' : '#') : chars[idx];
      // Highlight steep drops (< 40% of average once streaming is underway) in warn color.
      const isLow = avgTps > 15 && b.tps > 0 && b.tps < avgTps * 0.45;
      const kind = isLow ? 'low' : b.thinkTps > b.textTps ? 'think' : 'text';
      return { ch, kind };
    });

    lines.push({ label: label.padStart(5), cells });
  }

  return {
    lines,
    maxTps,
    spanSec: buckets.length,
  };
}

function resampleBuckets(buckets, targetCols) {
  if (!buckets.length) return [];
  if (buckets.length <= targetCols) return buckets;
  const out = [];
  const step = buckets.length / targetCols;
  for (let i = 0; i < targetCols; i++) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    const slice = buckets.slice(start, end);
    const avg = (fn) => slice.reduce((s, x) => s + fn(x), 0) / slice.length;
    out.push({
      tps: avg((x) => x.tps),
      thinkTps: avg((x) => x.thinkTps || 0),
      textTps: avg((x) => x.textTps || 0),
    });
  }
  return out;
}

/**
 * Roll the session's completed turns up per model.
 *
 * Deliberately the same shape as `rollup()` in session/perf.js, so the pane renders live
 * and on-disk history with one component. A turn with no measured duration contributes
 * its tokens and its context point but no rate, rather than being scored as instant.
 *
 * @param {Array<object>} turns
 */
export function byModel(turns) {
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const t of turns) {
    if (t.endedAt == null) continue; // still streaming: no final figures yet
    const key = `${t.provider || '?'}/${t.model || '?'}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        provider: t.provider || '',
        model: t.model || '',
        turns: 0,
        outTokens: 0,
        streamMs: 0,
        peakTps: 0,
        ttftSum: 0,
        ttftN: 0,
        ctxLo: null,
        ctxHi: null,
      };
      groups.set(key, g);
    }
    const durationMs = t.durationMs ?? Math.max(0, t.endedAt - t.startedAt);
    const ttftMs = t.ttftMs ?? null;
    const streamMs = Math.max(1, durationMs - (ttftMs || 0));
    const out = t.actualTokens;

    g.turns++;
    if (out != null) {
      g.outTokens += out;
      g.streamMs += streamMs;
      g.peakTps = Math.max(g.peakTps, out / (streamMs / 1000));
    }
    if (ttftMs != null) {
      g.ttftSum += ttftMs;
      g.ttftN++;
    }
    if (t.contextTokens) {
      g.ctxLo = g.ctxLo == null ? t.contextTokens : Math.min(g.ctxLo, t.contextTokens);
      g.ctxHi = g.ctxHi == null ? t.contextTokens : Math.max(g.ctxHi, t.contextTokens);
    }
  }
  return [...groups.values()]
    .map((g) => ({
      key: g.key,
      provider: g.provider,
      model: g.model,
      turns: g.turns,
      outTokens: g.outTokens,
      avgTps: g.streamMs > 0 ? g.outTokens / (g.streamMs / 1000) : 0,
      peakTps: g.peakTps,
      avgTtftMs: g.ttftN ? g.ttftSum / g.ttftN : null,
      contextRange: g.ctxLo != null ? [g.ctxLo, g.ctxHi] : null,
    }))
    .sort((a, b) => b.turns - a.turns || b.avgTps - a.avgTps);
}

/**
 * One point per completed turn: the rate it ran at against the context it ran with.
 *
 * Time is the axis that shows a stall; context is the axis that explains a drift. This is
 * what answers "is it slow because the conversation got long, or is it slow at 4k too?" —
 * and those two have completely different remedies, so it is worth being able to tell.
 *
 * @param {Array<object>} turns
 * @returns {Array<{ctx: number, tps: number, model: string, provider: string}>}
 */
export function byContextSeries(turns) {
  const out = [];
  for (const t of turns) {
    if (t.endedAt == null) continue;
    if (!t.contextTokens || !t.actualTokens) continue;
    const durationMs = t.durationMs ?? Math.max(0, t.endedAt - t.startedAt);
    const streamMs = Math.max(1, durationMs - (t.ttftMs || 0));
    out.push({
      ctx: t.contextTokens,
      tps: t.actualTokens / (streamMs / 1000),
      model: t.model || '',
      provider: t.provider || '',
    });
  }
  return out;
}

/**
 * Bin context-vs-rate points into a readable trend.
 *
 * Bins are log-spaced because context grows multiplicatively and the interesting range
 * spans two orders of magnitude: 2k and 4k are worth separating, 100k and 102k are not.
 * A bin with a single point is still shown — flagged, so a one-turn "trend" is not read
 * as one.
 *
 * @param {Array<{ctx: number, tps: number}>} points
 * @param {{bins?: number}} [opts]
 * @returns {Array<{lo: number, hi: number, avgTps: number, n: number, sparse: boolean}>}
 */
export function buildContextTrend(points, { bins = 9 } = {}) {
  const live = points.filter((p) => p.ctx > 0 && p.tps > 0);
  if (!live.length) return [];

  const lo = Math.min(...live.map((p) => p.ctx));
  const hi = Math.max(...live.map((p) => p.ctx));
  // Everything landed in one narrow band: one bin, rather than nine empty ones.
  if (hi - lo < lo * 0.1) {
    return [
      {
        lo,
        hi,
        avgTps: live.reduce((s, p) => s + p.tps, 0) / live.length,
        n: live.length,
        sparse: live.length < 3,
      },
    ];
  }

  const logLo = Math.log2(lo);
  const logHi = Math.log2(hi);
  const step = (logHi - logLo) / bins;
  const buckets = Array.from({ length: bins }, () => []);

  for (const p of live) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((Math.log2(p.ctx) - logLo) / step)));
    buckets[i].push(p);
  }

  return buckets
    .map((b, i) => {
      if (!b.length) return null;
      return {
        lo: 2 ** (logLo + i * step),
        hi: 2 ** (logLo + (i + 1) * step),
        avgTps: b.reduce((s, p) => s + p.tps, 0) / b.length,
        n: b.length,
        sparse: b.length < 3,
      };
    })
    .filter(Boolean);
}