import React from 'react';
import { Box, Text } from 'ink';
import { colors, glyphs, formatTokens } from './theme.js';

/**
 * One-line perf readout, right-aligned at the top of the live region.
 *
 * Aimed at a Pi over ssh: plain text only, nothing a default font lacks, and short enough
 * for an 80-column terminal. It shows the live rate while a turn streams, then that turn's
 * average alongside its time to first token.
 *
 * It is not pinned to the terminal's top-right, and Ink cannot put it there. The live
 * region renders *below* <Static>, and no amount of layout floats above committed
 * scrollback. The top of the live region is as high as this model goes, which puts it
 * directly under the transcript and above the composer — visible without scrolling, and
 * always in the same place.
 */
export function PerfHud({ tracker, width }) {
  const snap = tracker.snapshot(Date.now(), { seriesPoints: 1 });
  if (!snap.turn) return null;

  const tps = snap.active ? snap.currentTps : snap.avgTps;
  const parts = [];
  if (tps > 0) parts.push(`${tps.toFixed(1)} tok/s`);
  if (snap.ttftMs != null) parts.push(`ttft ${(snap.ttftMs / 1000).toFixed(2)}s`);
  // Context only earns its place once the turn is over and the provider has told us what
  // it actually billed; mid-stream it is the context the turn was sent with.
  if (!snap.active && snap.contextTokens && width >= 72) {
    parts.push(`${formatTokens(snap.contextTokens)} ctx`);
  }
  if (!parts.length) return null;

  return (
    <Box paddingX={1} width={width} justifyContent="flex-end">
      <Text color={snap.active ? colors.accent : colors.dim}>
        {parts.join(` ${glyphs.bullet} `)}
      </Text>
    </Box>
  );
}