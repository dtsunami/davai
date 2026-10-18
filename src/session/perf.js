/**
 * Performance history, read back off disk.
 *
 * The in-process ThroughputTracker only knows this session. `loadPerfHistory` walks the
 * session logs for the same figures — time to first token and total duration, both
 * measured in the harness and written onto the `assistant` event — so the perf pane can
 * say something about the machine and the models beyond the current run.
 *
 * Turns from sessions written before the harness recorded timing simply have no
 * `ttftMs`/`durationMs`. They are kept and counted, but contribute nothing to a rate,
 * rather than being dropped or scored as zero.
 */
import { listSessions, readTranscript } from './log.js';

/**
 * One row per completed assistant turn across recent sessions, newest session first — the
 * order `listSessions` returns. `rollup` re-sorts, so only a caller that wants a time
 * series rather than a table needs to care.
 *
 * The model and provider come from the session's `meta.json`: a session that switched
 * models mid-run via `/model` attributes its earlier turns to the model it ended on. A
 * known approximation, and it only misattributes sessions where the model changed partway.
 *
 * @param {string} home
 * @param {{sessions?: number, except?: string}} [opts] `except` is a session directory to
 *   skip — the live one, whose turns the in-process tracker already has.
 * @returns {Array<{at: string, model: string, provider: string, contextTokens: number|null,
 *   out: number|null, ttftMs: number|null, durationMs: number|null, tps: number|null}>}
 */
export function loadPerfHistory(home, { sessions = 20, except } = {}) {
  const rows = [];
  for (const s of listSessions(home, sessions)) {
    if (except && s.dir === except) continue;
    for (const ev of readTranscript(s.dir)) {
      if (ev?.type !== 'assistant') continue;
      const usage = ev.usage || {};
      const out = typeof usage.out === 'number' ? usage.out : null;
      const ttftMs = typeof ev.ttftMs === 'number' ? ev.ttftMs : null;
      const durationMs = typeof ev.durationMs === 'number' ? ev.durationMs : null;
      const streamMs = durationMs != null ? Math.max(1, durationMs - (ttftMs || 0)) : null;
      rows.push({
        at: ev.ts || '',
        model: s.model || '',
        provider: s.provider || '',
        // The whole billed prompt, not just the fresh part: `in` alone omits the cached
        // prefix, which on a long Anthropic session is most of the window. Transcripts
        // written before `contextIn` existed sum back to the same figure — correct for
        // Anthropic, whose fields were always split, and an overcount for the older
        // inclusive OpenAI shape, which is the lesser of the two errors here.
        contextTokens:
          typeof usage.contextIn === 'number'
            ? usage.contextIn
            : typeof usage.in === 'number'
              ? usage.in + (usage.cacheRead || 0) + (usage.cacheWrite || 0)
              : null,
        out,
        ttftMs,
        durationMs,
        tps: out != null && streamMs ? out / (streamMs / 1000) : null,
      });
    }
  }
  return rows;
}

/**
 * Roll history rows up per model. Same shape as `byModel()` in ui/throughput.js, so the
 * pane renders live and on-disk history with one component.
 *
 * @param {ReturnType<typeof loadPerfHistory>} rows
 */
export function rollup(rows) {
  /** @type {Map<string, any>} */
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.provider || '?'}/${r.model || '?'}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        provider: r.provider || '',
        model: r.model || '',
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
    g.turns++;
    if (r.out != null && r.durationMs != null) {
      g.outTokens += r.out;
      g.streamMs += Math.max(1, r.durationMs - (r.ttftMs || 0));
    }
    if (r.tps != null) g.peakTps = Math.max(g.peakTps, r.tps);
    if (r.ttftMs != null) {
      g.ttftSum += r.ttftMs;
      g.ttftN++;
    }
    if (r.contextTokens) {
      g.ctxLo = g.ctxLo == null ? r.contextTokens : Math.min(g.ctxLo, r.contextTokens);
      g.ctxHi = g.ctxHi == null ? r.contextTokens : Math.max(g.ctxHi, r.contextTokens);
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