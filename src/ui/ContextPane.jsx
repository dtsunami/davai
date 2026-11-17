import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors, glyphs, bar, usageColor, formatTokens } from './theme.js';
import { dropSegment, pinSegment } from '../context/manage.js';

/**
 * The context breakdown (req 12). Pareto-ordered: biggest consumers first, because
 * that is where the operator's attention should go.
 *
 * Mutations go through `context/manage.js` — the same entry points the web routes use —
 * and report through `onChange`. Calling `ledger.drop` directly and re-rendering only
 * this component left the status bar and any attached browser showing figures this pane
 * had already changed.
 */
const PAGE_LINES = 32;

export function ContextPane({ ledger, width, onChange, onClose }) {
  const [sel, setSel] = useState(0);
  const [viewing, setViewing] = useState(null);
  const [scroll, setScroll] = useState(0);
  const [, force] = useState(0);

  const rows = ledger.breakdown();
  const total = ledger.tokens;
  const pct = (total / ledger.limit) * 100;

  // Re-render this pane *and* tell the rest of the session. `force` alone redrew the
  // table over a status bar and a browser still showing the old totals.
  const changed = (message) => {
    force((n) => n + 1);
    onChange?.(message);
  };

  useInput((input, key) => {
    if (viewing !== null) {
      if (key.escape || input === 'q') {
        setViewing(null);
        setScroll(0);
        return;
      }
      if (key.upArrow || input === 'k') setScroll((s) => Math.max(0, s - 4));
      if (key.downArrow || input === 'j') setScroll((s) => s + 4);
      if (key.pageUp) setScroll((s) => Math.max(0, s - PAGE_LINES));
      if (key.pageDown || input === ' ') setScroll((s) => s + PAGE_LINES);
      return;
    }
    if (key.escape || input === 'q') return onClose();
    if (key.upArrow || input === 'k') return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') return setSel((s) => Math.min(rows.length - 1, s + 1));

    const row = rows[sel];
    if (!row) return;

    if (input === 'd' || key.delete) {
      // The system prompt is the cached prefix and grounding is structural; the ledger
      // refuses both, but the browser greys them out and this pane should agree.
      if (row.id === 0 || row.type === 'grounding') return;
      if (!dropSegment(ledger, row.id)) return;
      setSel((s) => Math.min(s, Math.max(0, rows.length - 2)));
      changed(`dropped segment #${row.id}`);
      return;
    }
    if (input === 'p') {
      if (row.id === 0 || row.type === 'grounding') return;
      if (!pinSegment(ledger, row.id, !row.pinned)) return;
      changed(`segment #${row.id} ${row.pinned ? 'unpinned' : 'pinned'}`);
      return;
    }
    if (input === 'v' || key.return) {
      setScroll(0);
      setViewing(row.id);
    }
  });

  if (viewing !== null) {
    const seg = viewing === 0 ? { part: { type: 'text', text: ledger.system } } : ledger.get(viewing);
    const text = seg?.part?.type === 'text' ? seg.part.text : `(${seg?.part?.type || 'binary'} content)`;
    const allLines = text.split('\n');
    const maxScroll = Math.max(0, allLines.length - PAGE_LINES);
    const top = Math.min(scroll, maxScroll);
    const lines = allLines.slice(top, top + PAGE_LINES);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
        <Text bold color={colors.accent}>
          Segment #{viewing} (lines {top + 1}-{Math.min(allLines.length, top + lines.length)} of {allLines.length})
        </Text>
        {lines.map((l, i) => (
          <Text key={i}>{l.slice(0, width - 6)}</Text>
        ))}
        <Text color={colors.dim}>
          j/k or space to scroll {glyphs.bullet} esc/q to go back
        </Text>
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
