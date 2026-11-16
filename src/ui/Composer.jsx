import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { colors, glyphs } from './theme.js';
import { completeInput } from './complete.js';
import { HighlightedInput } from './highlight.jsx';
import { useLineEditor } from './editor.js';

/** Control keys owned by App.jsx or Composer mode-switching rather than readline. */
const COMPOSER_RESERVED_CTRL = new Set(['g', 't', 's', 'c']);

/**
 * Input composer: shell-grade cursor movement, multiline editing, history + ctrl+r
 * reverse search, Tab / Shift+Tab completion, live syntax highlighting, bracketed
 * paste (req 14), and shell mode (req 13).
 */
export function Composer({ onSubmit, session, busy, active = true }) {
  const { pastes } = session;
  const [shellMode, setShellMode] = useState(false);

  const editor = useLineEditor({
    initialHistory: session.history?.all() ?? [],
    isActive: active,
    multiline: true,
    enableHistory: true,
    enableSearch: true,
    reservedCtrl: COMPOSER_RESERVED_CTRL,
    onKeystroke: () => session.throughput?.recordKeystroke?.(),
    complete: (val, cur) =>
      completeInput(val, cur, session, { mode: 'composer', shellMode }),
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
      onSubmit(shellMode && !text.startsWith('sh ') ? `sh ${text}` : text);
    },
    onEffect: (effect) => {
      if (effect.type === 'ctrl' && effect.key === 's') {
        setShellMode((s) => !s);
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

  const prompt = shellMode ? '$' : glyphs.prompt;
  const promptColor = shellMode ? colors.warn : busy ? colors.warn : colors.accent;
  const { value, cursor, hint, search } = editor;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <HighlightedInput
        value={value}
        cursor={cursor}
        // Hide the cursor during a run until the operator starts typing a steer.
        hideCursor={busy && !value}
        mode="composer"
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
      {busy && value.trim() && !shellMode ? (
        <Text color={colors.dim}>  enter steers the run in progress</Text>
      ) : null}
      {shellMode ? (
        <Text color={colors.dim}>  shell mode — output is added to context (ctrl+s to exit)</Text>
      ) : null}
    </Box>
  );
}