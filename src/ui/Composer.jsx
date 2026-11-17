import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { colors, glyphs } from './theme.js';
import { completeInput } from './complete.js';
import { HighlightedInput } from './highlight.jsx';
import { useLineEditor } from './editor.js';

/** Control keys owned by App.jsx or Composer mode-switching rather than readline. */
const COMPOSER_RESERVED_CTRL = new Set(['g', 't', 's', 'x', 'c']);

/**
 * Input composer: shell-grade cursor movement, multiline editing, history + ctrl+r
 * reverse search, Tab / Shift+Tab completion, live syntax highlighting, bracketed
 * paste (req 14), shell mode (`ctrl+s`), and Code Mode `tx` REPL (`ctrl+x`).
 */
export function Composer({ onSubmit, session, busy, active = true }) {
  const { pastes } = session;
  const [shellMode, setShellMode] = useState(false);
  const [txMode, setTxMode] = useState(false);

  const editor = useLineEditor({
    initialHistory: session.history?.all() ?? [],
    isActive: active,
    multiline: true,
    enableHistory: true,
    enableSearch: true,
    reservedCtrl: COMPOSER_RESERVED_CTRL,
    onKeystroke: () => session.throughput?.recordKeystroke?.(),
    complete: (val, cur) =>
      completeInput(val, cur, session, { mode: txMode ? 'plain' : 'composer', shellMode }),
    onPaste: (raw, { insert }) => {
      const captured = pastes.capture(raw);
      if (captured) {
        insert(captured.placeholder, `paste#${captured.n} stored — it expands when you submit`);
        return true;
      }
      // Single line with a trailing break: insert literally without submitting.
      insert(raw.replace(/[\r\n]+/g, ' ').trimEnd());
      return true;
    },
    onSubmit: (text) => {
      if (!text.trim()) return;
      editor.pushHistory(text);
      editor.setBuffer('', 0);
      if (shellMode && !text.startsWith('sh ')) return onSubmit(`sh ${text}`);
      if (txMode && !text.startsWith('/') && text !== 'tx' && !/^tx[\s\n]/.test(text)) {
        return onSubmit(`tx ${text}`);
      }
      return onSubmit(text);
    },
    onEffect: (effect) => {
      if (effect.type === 'ctrl' && effect.key === 's') {
        setTxMode(false);
        setShellMode((s) => !s);
      } else if (effect.type === 'ctrl' && effect.key === 'x') {
        setShellMode(false);
        setTxMode((x) => !x);
      }
    },
    onChange: (next) => {
      session._composerHasText = Boolean(next.value.length);
    },
  });

  useEffect(() => {
    session._composerHasText = Boolean(editor.value.length);
    session._clearComposer = () => {
      if (!editor.value.length && !editor.search) return false;
      editor.setBuffer('', 0);
      return true;
    };
    return () => {
      session._composerHasText = false;
      delete session._clearComposer;
    };
  }, [session, editor]);

  if (!active) return null;

  const prompt = shellMode ? '$' : txMode ? `tx${glyphs.prompt}` : glyphs.prompt;
  const promptColor = shellMode
    ? colors.warn
    : txMode
      ? colors.op
      : busy
        ? colors.warn
        : colors.accent;
  const { value, cursor, hint, search } = editor;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <HighlightedInput
        value={value}
        cursor={cursor}
        // Hide the cursor during a run until the operator starts typing a steer.
        hideCursor={busy && !value}
        mode={txMode ? 'plain' : 'composer'}
        shellMode={shellMode}
        sandbox={session.sandbox}
        prefix={
          <Text color={promptColor} bold>
            {prompt}{' '}
          </Text>
        }
      />
      {search ? (
        <Text color={colors.accent}>
          {'  '}bck-i-search: &quot;{search.query}&quot;
          <Text color={colors.dim}>
            {search.matchIndex >= 0 ? '' : ' (no match)'} · ctrl+r older · tab/→ edit · enter send · esc cancel
          </Text>
        </Text>
      ) : null}
      {hint ? <Text color={colors.dim}>  {hint}</Text> : null}
      {busy && value.trim() && !shellMode && !txMode ? (
        <Text color={colors.dim}>  enter steers the run in progress</Text>
      ) : null}
      {shellMode ? (
        <Text color={colors.dim}>  shell mode — output is added to context (ctrl+s to exit)</Text>
      ) : null}
      {txMode ? (
        <Text color={colors.dim}>
          {'  '}tx repl mode — {busy ? 'queues for next turn boundary' : 'CoW JS sandbox, added to context'} (ctrl+x to exit, /tx for pane)
        </Text>
      ) : null}
    </Box>
  );
}