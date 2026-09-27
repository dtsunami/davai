import React from 'react';
import { Box, Text } from 'ink';
import path from 'node:path';
import { colors, glyphs, bar, usageColor, formatCost, formatTokens } from './theme.js';

export function StatusBar({ cfg, ledger, stats, width, exitArmed }) {
  const tokens = ledger.tokens;
  const pct = Math.min(100, (tokens / ledger.limit) * 100);
  const dir = path.basename(cfg.cwd) || cfg.cwd;
  const compact = width < 100;

  return (
    <Box paddingX={1} marginTop={1} flexDirection="column">
      <Box>
        <Text color={colors.dim}>{dir}</Text>
        {cfg.yolo ? (
          <>
            <Text color={colors.dim}> {glyphs.bullet} </Text>
            <Text color={colors.err}>yolo</Text>
          </>
        ) : null}
        <Text color={colors.dim}> {glyphs.bullet} </Text>
        <Text color={colors.accent}>{cfg.model.id}</Text>
        {cfg.model.effort ? <Text color={colors.dim}>/{cfg.effort}</Text> : null}
        <Text color={colors.dim}> {glyphs.bullet} </Text>
        <Text color={usageColor(pct)}>
          {bar(tokens / ledger.limit, compact ? 6 : 10)} {pct.toFixed(0)}%
        </Text>
        <Text color={colors.dim}>
          {' '}
          {formatTokens(tokens)}/{formatTokens(ledger.limit)}
        </Text>
        {!compact ? (
          <>
            <Text color={colors.dim}> {glyphs.bullet} </Text>
            <Text color={colors.dim}>
              {stats.turns || 0}t {stats.ops || 0}ops
            </Text>
            <Text color={colors.dim}> {glyphs.bullet} </Text>
            <Text color={colors.dim}>{formatCost(stats.cost, stats.costUnknown)}</Text>
          </>
        ) : null}
      </Box>
      {exitArmed ? (
        <Text color={colors.warn}>{glyphs.warn} press ctrl+c again to exit</Text>
      ) : null}
    </Box>
  );
}
