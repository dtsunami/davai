import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors, glyphs } from './theme.js';
import { buildThroughputChart } from './throughput.js';

/**
 * Realtime & per-turn token throughput plotter (/tps or ctrl+t).
 * Visualizes tok/s over time for the active or completed turns so slowdowns during
 * complex structured generation (e.g. large da_ops blocks) are easy to spot.
 */
export function ThroughputPane({ tracker, width, onClose }) {
  const turns = tracker.turns;
  const [selectedIdx, setSelectedIdx] = useState(-1); // -1 = latest / live

  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 't')) {
      onClose();
      return;
    }
    if (key.leftArrow || input === 'h') {
      setSelectedIdx((idx) => {
        if (!turns.length) return -1;
        const cur = idx < 0 ? turns.length - 1 : idx;
        return Math.max(0, cur - 1);
      });
    } else if (key.rightArrow || input === 'l') {
      setSelectedIdx((idx) => {
        if (idx < 0) return -1;
        return idx + 1 >= turns.length ? -1 : idx + 1;
      });
    }
  });

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
              {'  '}turn #{snap.turn}/{turns.length} {glyphs.bullet} {snap.model}
              {snap.active ? ' (live)' : ''}
            </Text>
          ) : null}
        </Box>
        {snap.turn ? (
          <Box>
            <Text color={colors.accent} bold>
              {snap.active ? `${snap.currentTps.toFixed(1)} tok/s` : `avg ${snap.avgTps.toFixed(1)} tok/s`}
            </Text>
            <Text color={colors.dim}>
              {'  '}peak {snap.peakTps.toFixed(0)} {glyphs.bullet} low {snap.lowTps.toFixed(0)}{' '}
              {glyphs.bullet} {snap.totalTokens} tok
              {snap.ttftMs != null ? ` ${glyphs.bullet} ttft ${(snap.ttftMs / 1000).toFixed(2)}s` : ''}
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
          ctrl+t or esc close
        </Text>
      </Box>
    </Box>
  );
}