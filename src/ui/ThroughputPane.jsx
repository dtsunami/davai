import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors, glyphs, formatTokens } from './theme.js';
import {
  buildThroughputChart,
  buildContextTrend,
  byModel,
  byContextSeries,
} from './throughput.js';
import { loadPerfHistory, rollup } from '../session/perf.js';

/**
 * Throughput, over two axes.
 *
 * `turn` is the live view: tok/s second by second for a single turn, so a stall during a
 * large da_ops payload shows up as a hole rather than being averaged away.
 *
 * `history` is the retrospective one: every turn this session has run, rolled up per
 * model, plus whatever the session logs on disk still remember. Below it is the
 * throughput-against-context chart, which is the view that answers "is it slow because
 * the conversation got long, or is it slow at 4k too?" — two questions with entirely
 * different remedies.
 *
 * ctrl+t or /tps opens it; tab switches view.
 */
export function ThroughputPane({ tracker, width, home, excludeDir, onClose }) {
  const turns = tracker.turns;
  const [selectedIdx, setSelectedIdx] = useState(-1); // -1 = latest / live
  const [mode, setMode] = useState('turn');
  const [disk, setDisk] = useState(null);

  // Read previous sessions once, off the render path. It is a directory walk over every
  // recent transcript, and a Pi has no cycles to spare for repeating it on a keystroke.
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => (home ? loadPerfHistory(home, { except: excludeDir }) : []))
      .then((rows) => {
        if (live) setDisk(rows);
      })
      .catch(() => {
        if (live) setDisk([]);
      });
    return () => {
      live = false;
    };
  }, [home, excludeDir]);

  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 't')) {
      onClose();
      return;
    }
    if (key.tab || input === 'p') {
      setMode((m) => (m === 'turn' ? 'history' : 'turn'));
      return;
    }
    if (mode !== 'turn') return;
    if (key.leftArrow || input === 'h') {
      setSelectedIdx((idx) => {
        if (!turns.length) return -1;
        const cur = idx < 0 ? turns.length - 1 : idx;
        return Math.max(0, cur - 1);
      });
    } else if (key.rightArrow || input === 'l') {
      setSelectedIdx((idx) => (idx < 0 ? -1 : idx + 1 >= turns.length ? -1 : idx + 1));
    }
  });

  if (mode === 'history') {
    return <HistoryView tracker={tracker} disk={disk} width={width} />;
  }
  return (
    <TurnView tracker={tracker} turns={turns} selectedIdx={selectedIdx} width={width} />
  );
}

function TurnView({ tracker, turns, selectedIdx, width }) {
  const effIdx = selectedIdx >= 0 && selectedIdx < turns.length ? selectedIdx : turns.length - 1;
  const snap = tracker.snapshot(Date.now(), { turnIndex: effIdx, seriesPoints: 48 });
  const chartWidth = Math.max(20, Math.min(72, width - 16));
  const chart = buildThroughputChart(snap.buckets, { width: chartWidth, height: 8 });

  const cellColor = (kind) => {
    if (kind === 'low') return colors.warn;
    if (kind === 'think') return colors.op;
    if (kind === 'text') return colors.accent;
    return undefined;
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.accent}
      paddingX={1}
      marginTop={1}
    >
      <Box justifyContent="space-between">
        <Box>
          <Text bold color={colors.accent}>
            Throughput (tok/s)
          </Text>
          {snap.turn ? (
            <Text color={colors.dim}>
              {'  '}turn #{snap.turn}/{turns.length} {glyphs.bullet} {snap.provider}
              {snap.provider ? '/' : ''}
              {snap.model}
              {snap.active ? ' (live)' : ''}
            </Text>
          ) : null}
        </Box>
        {snap.turn ? (
          <Box>
            <Text color={colors.accent} bold>
              {snap.active
                ? `${snap.currentTps.toFixed(1)} tok/s`
                : `avg ${snap.avgTps.toFixed(1)} tok/s`}
            </Text>
            <Text color={colors.dim}>
              {'  '}peak {snap.peakTps.toFixed(0)} {glyphs.bullet} low {snap.lowTps.toFixed(0)}{' '}
              {glyphs.bullet} {snap.totalTokens} tok
              {snap.ttftMs != null
                ? ` ${glyphs.bullet} ttft ${(snap.ttftMs / 1000).toFixed(2)}s`
                : ''}
            </Text>
          </Box>
        ) : null}
      </Box>

      {!snap.buckets.length ? (
        <Box marginTop={1}>
          <Text color={colors.dim}>
            No tokens streamed yet. Start a prompt and watch tok/s in real time.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {chart.lines.map((row, rIdx) => (
            <Box key={rIdx}>
              <Text color={colors.dim}>{row.label} ┤</Text>
              {row.cells.map((c, cIdx) => (
                <Text key={cIdx} color={cellColor(c.kind)}>
                  {c.ch}
                </Text>
              ))}
            </Box>
          ))}
          <Box>
            <Text color={colors.dim}>
              {'      └' + '─'.repeat(Math.max(1, chart.lines[0]?.cells.length || 1))}
            </Text>
          </Box>
          <Box justifyContent="space-between" width={(chart.lines[0]?.cells.length || 20) + 7}>
            <Text color={colors.dim}>      0s</Text>
            <Text color={colors.dim}>
              <Text color={colors.accent}>■</Text> text{'  '}
              <Text color={colors.op}>■</Text> thinking{'  '}
              <Text color={colors.warn}>■</Text> slowdown (&lt;45% avg)
            </Text>
            <Text color={colors.dim}>{(snap.durationMs / 1000).toFixed(1)}s</Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={colors.dim}>
          {turns.length > 1 ? `←/→ turn (${effIdx + 1}/${turns.length}) ${glyphs.bullet} ` : ''}
          tab history {glyphs.bullet} ctrl+t or esc close
        </Text>
      </Box>
    </Box>
  );
}

function fmtDur(ms) {
  const sec = Math.max(0, ms || 0) / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function HistoryView({ tracker, disk, width }) {
  const live = byModel(tracker.turns);
  const past = disk === null ? null : rollup(disk);
  const acc = tracker.sessionSummary ? tracker.sessionSummary() : null;
  const modelWidth = Math.max(18, Math.min(30, width - 54));

  // Live first, then anything on disk this session has not seen. A model that appears in
  // both is shown twice rather than merged: the live row is the one the operator can act
  // on right now, and silently folding yesterday's turns into it would hide that.
  const rows = [
    ...live.map((g) => ({ ...g, source: 'now' })),
    ...(past || []).map((g) => ({ ...g, source: 'disk' })),
  ];

  const ctxPoints = [
    ...byContextSeries(tracker.turns),
    ...(disk || [])
      .filter((r) => r.contextTokens && r.tps)
      .map((r) => ({ ctx: r.contextTokens, tps: r.tps, model: r.model, provider: r.provider })),
  ];
  const trend = buildContextTrend(ctxPoints);
  const trendMax = Math.max(1, ...trend.map((b) => b.avgTps));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.accent}
      paddingX={1}
      marginTop={1}
    >
      {acc ? (
        <Box flexDirection="column" marginBottom={1}>
          <Box justifyContent="space-between">
            <Text bold color={colors.accent}>
              Session accumulator
            </Text>
            <Text color={colors.dim}>
              {fmtDur(acc.elapsedMs)} total {glyphs.bullet} state: *{acc.state}*
            </Text>
          </Box>
          <Box>
            <Text color={colors.accent}>model {fmtDur(acc.totals.modelMs)}</Text>
            <Text color={colors.dim}> {glyphs.bullet} </Text>
            <Text color={colors.op}>ops {fmtDur(acc.totals.opsMs)}</Text>
            <Text color={colors.dim}> {glyphs.bullet} </Text>
            <Text color={colors.ok}>*user-typing* {fmtDur(acc.totals.userTypingMs)}</Text>
            <Text color={colors.dim}> {glyphs.bullet} </Text>
            <Text color={colors.dim}>*user-idle* {fmtDur(acc.totals.userIdleMs)}</Text>
          </Box>
        </Box>
      ) : null}

      <Box justifyContent="space-between">
        <Text bold color={colors.accent}>
          Throughput by model
        </Text>
        <Text color={colors.dim}>
          {live.reduce((n, g) => n + g.turns, 0)} turn(s) this session
          {past ? ` ${glyphs.bullet} ${past.reduce((n, g) => n + g.turns, 0)} on disk` : ''}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={colors.dim}>{pad('model', modelWidth)} </Text>
          <Text color={colors.dim}>{padStart('turns', 5)} </Text>
          <Text color={colors.dim}>{padStart('tok/s', 7)} </Text>
          <Text color={colors.dim}>{padStart('peak', 5)} </Text>
          <Text color={colors.dim}>{padStart('ttft', 7)} </Text>
          <Text color={colors.dim}> {padStart('ctx', 9)}</Text>
        </Box>

        {!rows.length ? (
          <Text color={colors.dim}>
            No completed turns yet. A turn has to finish before it has a rate.
          </Text>
        ) : null}

        {rows.slice(0, 12).map((g, i) => (
          <Box key={`${g.key}-${g.source}-${i}`}>
            <Text color={g.source === 'now' ? colors.accent : undefined}>
              {pad(g.key, modelWidth)}
            </Text>
            <Text color={colors.dim}> {padStart(String(g.turns), 5)} </Text>
            <Text color={colors.ok}> {padStart(g.avgTps.toFixed(1), 6)} </Text>
            <Text color={colors.dim}> {padStart(g.peakTps.toFixed(0), 4)} </Text>
            <Text color={colors.dim}>
              {' '}
              {padStart(g.avgTtftMs != null ? `${(g.avgTtftMs / 1000).toFixed(2)}s` : '-', 6)}
            </Text>
            <Text color={colors.dim}>
              {' '}
              {padStart(
                g.contextRange
                  ? `${formatTokens(g.contextRange[0])}-${formatTokens(g.contextRange[1])}`
                  : '-',
                9,
              )}
            </Text>
          </Box>
        ))}
        {rows.length > 12 ? (
          <Text color={colors.dim}>
            {'  '}
            {glyphs.ellipsis} {rows.length - 12} more
          </Text>
        ) : null}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold color={colors.accent}>
          Throughput vs context
        </Text>
        {!trend.length ? (
          <Text color={colors.dim}>
            Needs a completed turn with billed usage. The context axis is the whole input
            the provider counted, cache reads included, so a turn with no usage event
            cannot be placed on it.
          </Text>
        ) : (
          trend.map((b, i) => (
            <Box key={i}>
              <Text color={colors.dim}>{pad(`${formatTokens(b.lo)}-${formatTokens(b.hi)}`, 11)}</Text>
              <Text color={b.sparse ? colors.warn : colors.ok}>
                {bar(b.avgTps / trendMax, 20)}
              </Text>
              <Text color={colors.dim}>
                {' '}
                {b.avgTps.toFixed(1)} tok/s {glyphs.bullet} n={b.n}
                {b.sparse ? ' (thin)' : ''}
              </Text>
            </Box>
          ))
        )}
        {trend.length ? (
          <Text color={colors.dim}>
            log-spaced bins {glyphs.bullet} a downward slope is the context costing you rate
          </Text>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text color={colors.dim}>
          tab turn view {glyphs.bullet} ctrl+t or esc close
        </Text>
      </Box>
    </Box>
  );
}

function pad(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + glyphs.ellipsis : t.padEnd(n);
}
function padStart(s, n) {
  return String(s).padStart(n);
}
function bar(fraction, width) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}