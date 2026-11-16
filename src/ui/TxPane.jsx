import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors, glyphs } from './theme.js';
import { HighlightedInput } from './highlight.jsx';
import { useLineEditor } from './editor.js';

/**
 * Interactive Code Mode (`tx`) REPL pane: full session transcript of both agent and
 * operator `tx` runs, live `state` scratchpad inspection, queued turn-boundary items,
 * and an interactive JS prompt sharing `agent.txState` and Copy-on-Write `StagedFS`.
 */
export function TxPane({ session, width, onClose, onSubmit }) {
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

  const current = entries[sel];
  const stateKeys = snap.stateKeys || [];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.op} paddingX={1}>
      <Box>
        <Text bold color={colors.op}>
          Code Mode REPL (tx)
        </Text>
        <Text color={colors.dim}>
          {'  '}
          {cfg.codeMode ? 'llm + operator enabled' : 'operator active · llm tx off (--code-mode to enable)'}
          {agent?.busy ? ` ${glyphs.bullet} turn running (inputs queue for next boundary)` : ''}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.dim}>
          state ({stateKeys.length} key{stateKeys.length === 1 ? '' : 's'}):{' '}
          {stateKeys.length
            ? stateKeys
                .slice(0, 6)
                .map((k) => `${k}=${ truncateInline(snap.statePreview[k], 28) }`)
                .join(` ${glyphs.bullet} `) + (stateKeys.length > 6 ? ` ${glyphs.ellipsis}` : '')
            : '(empty — assign properties on `state` to persist across turns)'}
        </Text>
        {snap.queued?.length ? (
          <Text color={colors.warn}>
            {glyphs.warn} {snap.queued.length} operator tx snippet{snap.queued.length > 1 ? 's' : ''} queued for next turn boundary
          </Text>
        ) : null}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {!entries.length ? (
          <Text color={colors.dim}>
            No tx runs yet. Globals: read, exists, list, glob, grep, write, replace, remove, move, fileset, state, log, preview
          </Text>
        ) : (
          entries.slice(-8).map((e) => {
            const idx = entries.indexOf(e);
            const active = !editing && idx === sel;
            const badge = e.origin === 'operator' ? 'you' : `llm${e.turn ? `#${e.turn}` : ''}`;
            const statusGlyph = e.ok ? glyphs.check : glyphs.cross;
            const statusColor = e.ok ? colors.ok : colors.err;
            const summary = e.ok
              ? `${e.changes?.length || 0} changed, ${e.opsCount || 0} fs ops`
              : truncateInline(e.error || 'failed', 44);
            return (
              <Box key={e.seq}>
                <Text color={active ? colors.accent : colors.dim}>
                  {active ? glyphs.prompt : ' '} #{e.seq} [{badge}]{' '}
                </Text>
                <Text color={statusColor}>{statusGlyph} </Text>
                <Text color={active ? colors.accent : undefined}>
                  {truncateInline(e.description || firstLine(e.code), Math.max(20, width - 48))}
                </Text>
                <Text color={colors.dim}>{'  '}{summary}</Text>
              </Box>
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
          <Text color={colors.op}>
            #{current.seq} ({current.origin}) {glyphs.bullet}{' '}
            {current.ok
              ? `${current.changes?.length || 0} file(s) changed (${current.opsCount || 0} fs ops)`
              : `error: ${current.error}`}
          </Text>
          {String(current.code || '')
            .split('\n')
            .slice(0, 10)
            .map((line, i) => (
              <Text key={`c-${i}`} color={colors.dim}>
                {'  '}
                {line}
              </Text>
            ))}
          {current.logs?.length ? (
            <Text color={colors.accent}>
              logs: {truncateInline(current.logs.join(' | '), Math.max(30, width - 14))}
            </Text>
          ) : null}
          {current.output !== undefined ? (
            String(current.output)
              .split('\n')
              .slice(0, 8)
              .map((line, i) => (
                <Text key={`o-${i}`} color={colors.ok}>
                  {i === 0 ? `${glyphs.arrow} ${line}` : `  ${line}`}
                </Text>
              ))
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
              {'tx❯ '}
            </Text>
          }
        />
        <Text color={colors.dim}>
          {editing
            ? 'enter run/queue · shift+enter newline · tab browse history · esc close'
            : '↑/↓ select · v toggle detail · tab/i focus prompt · esc/q close'}
        </Text>
      </Box>
    </Box>
  );
}

function firstLine(s) {
  return String(s || '').trim().split('\n')[0] || '';
}

function truncateInline(s, max) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}${glyphs.ellipsis}` : flat;
}