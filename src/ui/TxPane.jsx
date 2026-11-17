import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  colors,
  glyphs,
  formatPreviewBlock,
  formatTokens,
  truncateInline,
} from './theme.js';
import { HighlightedInput } from './highlight.jsx';
import { useLineEditor } from './editor.js';

/**
 * Interactive Code Mode (`tx`) REPL pane: full session transcript of both agent and
 * operator `tx` runs, live `state` scratchpad inspection, queued turn-boundary items,
 * and an interactive JS prompt sharing `agent.txState` and Copy-on-Write `StagedFS`.
 */
export function TxPane({ session, width, rows = 30, onClose, onSubmit }) {
  const { agent, cfg } = session;
  const snap = agent?.txSnapshot ? agent.txSnapshot() : { entries: [], queued: [], stateKeys: [], statePreview: {} };
  const entries = snap.entries || [];

  const [sel, setSel] = useState(() => Math.max(0, entries.length - 1));
  const [editing, setEditing] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    setSel(Math.max(0, entries.length - 1));
  }, [entries.length]);

  useEffect(() => {
    session._paneEditing = editing;
    return () => {
      session._paneEditing = false;
    };
  }, [session, editing]);

  const editor = useLineEditor({
    initialValue: '',
    isActive: editing,
    multiline: true,
    enableHistory: true,
    onSubmit: (code) => {
      const trimmed = code.trim();
      if (!trimmed) return;
      editor.pushHistory(trimmed);
      editor.setBuffer('', 0);
      onSubmit(`tx ${trimmed}`);
    },
    onEscape: () => {
      if (editor.value.length) {
        editor.setBuffer('', 0);
      } else {
        onClose();
      }
    },
    onEffect: (effect) => {
      if (effect.type === 'ctrl' && effect.key === 'c') {
        if (editor.value.length) editor.setBuffer('', 0);
        else onClose();
      }
    },
  });

  useInput(
    (input, key) => {
      if (key.tab) {
        setEditing((e) => !e);
        return;
      }
      if (!editing) {
        if (key.escape || input === 'q') return onClose();
        if (key.upArrow || input === 'k') return setSel((s) => Math.max(0, s - 1));
        if (key.downArrow || input === 'j') return setSel((s) => Math.min(entries.length - 1, s + 1));
        if (input === 'v' || key.return) return setExpanded((x) => !x);
        if (input === 'i') return setEditing(true);
      }
    },
    { isActive: true },
  );

  const paneWidth = Math.max(40, (width || 80) - 2);
  const innerCols = Math.max(24, paneWidth - 8);
  const current = entries[sel];
  const stateKeys = snap.stateKeys || [];

  // Budget dynamic rows so <TxPane> + <StatusBar> stays strictly <= stdout.rows.
  // Any Ink dynamic region taller than the terminal viewport breaks cursor-up erase and
  // stamps duplicate borders into scrollback on every keystroke or meter tick.
  const fixedChrome = 19 + (snap.queued?.length ? 1 : 0);
  const spareRows = Math.max(5, (rows || 30) - fixedChrome);
  const maxEntries = Math.min(8, Math.max(2, Math.floor(spareRows * 0.35)));
  const maxCode = Math.min(8, Math.max(2, Math.floor(spareRows * 0.35)));
  const maxOut = Math.min(6, Math.max(1, spareRows - maxEntries - maxCode));

  const codePreview =
    expanded && current?.code
      ? formatPreviewBlock(current.code, { maxLines: maxCode, maxCols: innerCols - 2 })
      : null;
  const outPreview =
    expanded && current?.output !== undefined
      ? formatPreviewBlock(current.output, { maxLines: maxOut, maxCols: innerCols - 4 })
      : null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.op}
      paddingX={1}
      marginLeft={1}
      width={paneWidth}
    >
      <Text wrap="truncate-end">
        <Text bold color={colors.op}>
          Code Mode REPL (tx)
        </Text>
        <Text color={colors.dim}>
          {'  '}
          {cfg.codeMode ? 'llm + operator enabled' : 'operator active · llm tx off (--code-mode to enable)'}
          {agent?.busy ? ` ${glyphs.bullet} turn running (inputs queue for next boundary)` : ''}
        </Text>
      </Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.dim} wrap="truncate-end">
          state ({stateKeys.length} key{stateKeys.length === 1 ? '' : 's'}):{' '}
          {stateKeys.length
            ? stateKeys
                .slice(0, 6)
                .map((k) => `${truncateInline(k, 18)}=${truncateInline(snap.statePreview[k], 24)}`)
                .join(` ${glyphs.bullet} `) + (stateKeys.length > 6 ? ` ${glyphs.ellipsis}` : '')
            : '(empty — assign properties on `state` to persist across turns)'}
        </Text>
        {snap.queued?.length ? (
          <Text color={colors.warn} wrap="truncate-end">
            {glyphs.warn} {snap.queued.length} operator tx snippet{snap.queued.length > 1 ? 's' : ''} queued for next turn boundary
          </Text>
        ) : null}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {!entries.length ? (
          <Text color={colors.dim} wrap="truncate-end">
            No tx runs yet. Globals: read, exists, list, glob, grep, write, replace, remove, move, fileset, state, log, preview
          </Text>
        ) : (
          entries.slice(-maxEntries).map((e) => {
            const idx = entries.indexOf(e);
            const active = !editing && idx === sel;
            const badge = e.origin === 'operator' ? 'you' : `llm${e.turn ? `#${e.turn}` : ''}`;
            const statusGlyph = e.ok ? glyphs.check : glyphs.cross;
            const statusColor = e.ok ? colors.ok : colors.err;
            const summary = e.ok
              ? `${e.changes?.length || 0} changed, ${e.opsCount || 0} fs ops`
              : truncateInline(e.error || 'failed', 36);
            const descBudget = Math.max(16, innerCols - summary.length - badge.length - 14);
            return (
              <Text key={e.seq} wrap="truncate-end">
                <Text color={active ? colors.accent : colors.dim}>
                  {active ? glyphs.prompt : ' '} #{e.seq} [{badge}]{' '}
                </Text>
                <Text color={statusColor}>{statusGlyph} </Text>
                <Text color={active ? colors.accent : undefined}>
                  {truncateInline(e.description || firstLine(e.code), descBudget)}
                </Text>
                <Text color={colors.dim}>{'  '}{summary}</Text>
              </Text>
            );
          })
        )}
      </Box>

      {expanded && current ? (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="single"
          borderColor={colors.dim}
          paddingX={1}
        >
          <Text color={colors.op} wrap="truncate-end">
            #{current.seq} ({current.origin}) {glyphs.bullet}{' '}
            {current.ok
              ? `${current.changes?.length || 0} file(s) changed (${current.opsCount || 0} fs ops)`
              : `error: ${truncateInline(current.error, innerCols - 16)}`}
          </Text>
          {codePreview
            ? codePreview.lines.map((line, i) => (
                <Text key={`c-${i}`} color={colors.dim} wrap="truncate-end">
                  {'  '}
                  {line}
                </Text>
              ))
            : null}
          {codePreview?.hiddenLines ? (
            <Text color={colors.dim} wrap="truncate-end">
              {'  '}
              {glyphs.ellipsis} +{codePreview.hiddenLines} more line(s)
            </Text>
          ) : null}
          {current.logs?.length ? (
            <Text color={colors.accent} wrap="truncate-end">
              logs: {truncateInline(current.logs.join(' | '), Math.max(20, innerCols - 8))}
            </Text>
          ) : null}
          {outPreview
            ? outPreview.lines.map((line, i) => (
                <Text key={`o-${i}`} color={colors.ok} wrap="truncate-end">
                  {i === 0 ? `${glyphs.arrow} ${line}` : `  ${line}`}
                </Text>
              ))
            : null}
          {outPreview?.truncated ? (
            <Text color={colors.dim} wrap="truncate-end">
              {'  '}
              {glyphs.ellipsis} ({formatTokens(outPreview.totalChars)} chars, {outPreview.totalLines} line{outPreview.totalLines === 1 ? '' : 's'})
            </Text>
          ) : null}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <HighlightedInput
          value={editor.value}
          cursor={editor.cursor}
          hideCursor={!editing}
          mode="plain"
          prefix={
            <Text color={editing ? colors.op : colors.dim} bold>
              {`tx${glyphs.prompt} `}
            </Text>
          }
        />
        <Text color={colors.dim} wrap="truncate-end">
          {editing
            ? 'enter run/queue · shift+enter newline · tab browse history · esc close'
            : '↑/↓ select · v toggle detail · tab/i focus prompt · esc/q close'}
        </Text>
      </Box>
    </Box>
  );
}

function firstLine(s) {
  return String(s || '').replace(/\r\n?/g, '\n').trim().split('\n')[0] || '';
}