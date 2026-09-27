import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { colors, glyphs } from './theme.js';
import { completeInput } from './complete.js';

/**
 * Input composer: multiline, history, @path completion, bracketed paste (req 14),
 * and shell mode (req 13).
 *
 * Ink's own TextInput does not give us paste capture or completion, so the line
 * editor is hand-rolled on top of raw key events.
 */
export function Composer({ onSubmit, session, busy }) {
  const { pastes } = session;
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState([]);
  const [histIndex, setHistIndex] = useState(-1);
  const [shellMode, setShellMode] = useState(false);
  const [hint, setHint] = useState('');
  const pasteBuf = useRef({ active: false, data: '' });
  const { stdin } = useStdin();

  const insert = useCallback(
    (text) => {
      setValue((v) => v.slice(0, cursor) + text + v.slice(cursor));
      setCursor((c) => c + text.length);
    },
    [cursor],
  );

  const submit = useCallback(() => {
    const text = value;
    if (!text.trim()) return;
    setHistory((h) => [...h, text]);
    setHistIndex(-1);
    setValue('');
    setCursor(0);
    setHint('');
    onSubmit(shellMode && !text.startsWith('sh ') ? `sh ${text}` : text);
  }, [value, shellMode, onSubmit]);

  useInput(
    (input, key) => {
      // --- bracketed paste ---
      // A burst arriving as one chunk with newlines is a paste, not typing.
      if (input && input.length > 1 && input.includes('\n')) {
        const captured = pastes.capture(input);
        if (captured) {
          insert(captured.placeholder);
          setHint(`paste#${captured.n} stored — it expands when you submit`);
          return;
        }
        insert(input.replace(/\n/g, ' '));
        return;
      }

      if (key.return) {
        // Shift+Enter (and Alt+Enter) insert a newline instead of submitting.
        if (key.shift || key.meta) {
          insert('\n');
          return;
        }
        submit();
        return;
      }

      if (key.tab) {
        const completed = completeInput(value, cursor, session);
        if (completed) {
          setValue(completed.value);
          setCursor(completed.cursor);
          setHint(completed.hint || '');
        }
        return;
      }

      if (key.ctrl && input === 's') {
        setShellMode((s) => !s);
        return;
      }

      if (key.upArrow) {
        if (!history.length) return;
        const i = histIndex === -1 ? history.length - 1 : Math.max(0, histIndex - 1);
        setHistIndex(i);
        setValue(history[i]);
        setCursor(history[i].length);
        return;
      }
      if (key.downArrow) {
        if (histIndex === -1) return;
        const i = histIndex + 1;
        if (i >= history.length) {
          setHistIndex(-1);
          setValue('');
          setCursor(0);
        } else {
          setHistIndex(i);
          setValue(history[i]);
          setCursor(history[i].length);
        }
        return;
      }

      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setCursor((c) => Math.min(value.length, c + 1));

      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor((c) => Math.max(0, c - 1));
        return;
      }

      if (key.ctrl && input === 'u') {
        setValue('');
        setCursor(0);
        return;
      }
      if (key.ctrl && input === 'a') return; // reserved: artifacts pane
      if (key.ctrl && input === 'e') return setCursor(value.length);

      // Ignore remaining control chords so they don't land in the buffer.
      if (key.ctrl || key.meta || key.escape) return;

      if (input) insert(input);
    },
    { isActive: !busy },
  );

  const prompt = shellMode ? '$' : glyphs.prompt;
  const promptColor = shellMode ? colors.warn : colors.accent;
  const display = value.length ? value : '';

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box>
        <Text color={promptColor} bold>
          {prompt}{' '}
        </Text>
        <Text>{renderWithCursor(display, cursor, busy)}</Text>
      </Box>
      {hint ? <Text color={colors.dim}>  {hint}</Text> : null}
      {shellMode ? (
        <Text color={colors.dim}>  shell mode — output is added to context (ctrl+s to exit)</Text>
      ) : null}
    </Box>
  );
}

function renderWithCursor(value, cursor, busy) {
  if (busy) return value;
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);
  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </>
  );
}
