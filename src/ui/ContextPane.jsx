import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors, glyphs, bar, usageColor, formatTokens } from './theme.js';

/**
 * The context breakdown (req 12). Pareto-ordered: biggest consumers first, because
 * that is where the operator's attention should go.
 */
export function ContextPane({ ledger, width, onClose }) {
  const [sel, setSel] = useState(0);
  const [viewing, setViewing] = useState(null);
  const [, force] = useState(0);

  const rows = ledger.breakdown();
  const total = ledger.tokens;
  const pct = (total / ledger.limit) * 100;

  useInput((input, key) => {
    if (viewing !== null) {
      if (key.escape || input === 'q' || key.return) setViewing(null);
      return;
    }
    if (key.escape || input === 'q') return onClose();
    if (key.upArrow || input === 'k') return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') return setSel((s) => Math.min(rows.length - 1, s + 1));

    const row = rows[sel];
    if (!row) return;

    if (input === 'd' || key.delete) {
      if (row.id === 0) return; // system prompt is the cached prefix
      ledger.drop(row.id);
      setSel((s) => Math.min(s, Math.max(0, rows.length - 2)));
      force((n) => n + 1);
      return;
    }
    if (input === 'p') {
      if (row.id === 0) return;
      ledger.pin(row.id, !row.pinned);
      force((n) => n + 1);
      return;
    }
    if (input === 'v' || key.return) {
      setViewing(row.id);
    }
  });

  if (viewing !== null) {
    const seg = viewing === 0 ? { part: { type: 'text', text: ledger.system } } : ledger.get(viewing);
    const text = seg?.part?.type === 'text' ? seg.part.text : '(binary or image content)';
    const lines = text.split('\n').slice(0, 40);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
        <Text bold color={colors.accent}>
          Segment #{viewing}
        </Text>
        {lines.map((l, i) => (
          <Text key={i}>{l.slice(0, width - 6)}</Text>
        ))}
        {text.split('\n').length > 40 ? (
          <Text color={colors.dim}>{glyphs.ellipsis} truncated</Text>
        ) : null}
        <Text color={colors.dim}>esc to go back</Text>
      </Box>
    );
  }

  const labelWidth = Math.max(20, Math.min(40, width - 44));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Box>
        <Text bold color={colors.accent}>
          Context{' '}
        </Text>
        <Text color={usageColor(pct)}>
          {formatTokens(total)} / {formatTokens(ledger.limit)} ({pct.toFixed(1)}%)
        </Text>
        <Text color={colors.dim}>
          {'  '}auto-compact at {Math.round(ledger.compactAt * 100)}%
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {rows.slice(0, 18).map((r, i) => (
          <Box key={r.id}>
            <Text color={i === sel ? colors.accent : undefined}>
              {i === sel ? glyphs.prompt : ' '}{' '}
            </Text>
            <Text color={colors.dim}>{r.pinned ? glyphs.pin : ' '}</Text>
            <Text color={i === sel ? colors.accent : undefined}>
              {' '}
              {pad(r.label || r.type, labelWidth)}
            </Text>
            <Text color={colors.dim}> {pad(r.type, 11)}</Text>
            <Text color={usageColor(r.pct * 3)}>{bar(r.pct / 100, 10)}</Text>
            <Text color={colors.dim}> {padStart(formatTokens(r.tokens), 7)}</Text>
            <Text color={colors.dim}> {padStart(r.pct.toFixed(1) + '%', 6)}</Text>
          </Box>
        ))}
        {rows.length > 18 ? (
          <Text color={colors.dim}>
            {'  '}
            {glyphs.ellipsis} {rows.length - 18} more segments
          </Text>
        ) : null}
      </Box>

      <Box marginTop={1}>
        <Text color={colors.dim}>
          j/k move {glyphs.bullet} v view {glyphs.bullet} d drop {glyphs.bullet} p pin {glyphs.bullet} esc close
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
