<<<<<<< Updated upstream
import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
=======
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
>>>>>>> Stashed changes
import { colors, glyphs } from './theme.js';
import { completeInput } from './complete.js';
import { HighlightedInput } from './highlight.jsx';
import { useLineEditor } from './editor.js';

/** Control keys owned by App.jsx or Composer mode-switching rather than readline. */
const COMPOSER_RESERVED_CTRL = new Set(['g', 't', 's', 'c']);

/**
<<<<<<< Updated upstream
 * Input composer: shell-grade cursor movement, multiline editing, history + ctrl+r
 * reverse search, Tab / Shift+Tab completion, live syntax highlighting, bracketed
 * paste (req 14), and shell mode (req 13).
=======
 * Settle window for a multi-chunk paste burst (ms).
 *
 * Node/libuv delivers large console pastes on Windows in ~1–4 KB `data` chunks across
 * consecutive ticks rather than one buffer, and even with DECSET 2004 bracketed paste
 * enabled (`\x1b[200~` … `\x1b[201~`) Ink strips the markers or splits across reads.
 * Without coalescing, an 85 KB paste became 85 separate `paste#N` segments; worse,
 * closing over React's `cursor` state meant every synchronous chunk spliced at the same
 * initial cursor offset and reversed the order (`[paste#85]…[paste#1]`).
 */
const PASTE_SETTLE_MS = 30;

// Bracketed paste escape sequences (DECSET 2004), stripped if the terminal sends them
// and Ink passes any fragment through raw.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
// eslint-disable-next-line no-control-regex
const BRACKET_RE = /\x1b\[20[01]~|\[20[01]~/g;

/**
 * Input composer: multiline, history, @path completion, bracketed paste (req 14),
 * and shell mode (req 13).
 *
 * Ink's own TextInput does not give us paste capture or completion, so the line
 * editor is hand-rolled on top of raw key events.
>>>>>>> Stashed changes
 */
export function Composer({ onSubmit, session, busy, active = true }) {
  const { pastes } = session;
<<<<<<< Updated upstream
=======
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  // Authoritative synchronous mirror of (value, cursor). Multiple stdin chunks routinely
  // fire useInput in the same tick before React re-renders; reading from state closures
  // splices every chunk at the stale cursor and reverses their order.
  const bufRef = useRef({ value: '', cursor: 0 });
  // Accumulator for an in-flight paste burst.
  const pasteBufRef = useRef({ text: '', timer: null, bracketed: false });

  // Seeded from $DAVAI_HOME/history.jsonl, so the up arrow reaches past this session.
  const [history, setHistory] = useState(() => session.history?.all() ?? []);
  const [histIndex, setHistIndex] = useState(-1);
>>>>>>> Stashed changes
  const [shellMode, setShellMode] = useState(false);

<<<<<<< Updated upstream
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
=======
  const syncBuffer = useCallback((nextValue, nextCursor) => {
    bufRef.current = { value: nextValue, cursor: nextCursor };
    setValue(nextValue);
    setCursor(nextCursor);
  }, []);

  const insert = useCallback(
    (text) => {
      if (!text) return;
      const { value: v, cursor: c } = bufRef.current;
      const nextValue = v.slice(0, c) + text + v.slice(c);
      const nextCursor = c + text.length;
      syncBuffer(nextValue, nextCursor);
    },
    [syncBuffer],
  );

  const commitPasteBurst = useCallback(() => {
    const p = pasteBufRef.current;
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
    p.bracketed = false;
    const raw = p.text;
    p.text = '';
    if (!raw) return;

    const captured = pastes.capture(raw);
    if (captured) {
      insert(captured.placeholder);
      setHint(`paste#${captured.n} stored — it expands when you submit`);
      return;
    }
    // One line (with or without a trailing break): paste the text, drop the break, and
    // do not submit — the operator pasted, they did not press Enter.
    insert(raw.replace(/[\r\n]+/g, ' ').replace(/[\r\n]+$/, ''));
  }, [pastes, insert]);

  useEffect(() => {
    const pasteBuf = pasteBufRef.current;
    return () => {
      if (pasteBuf.timer) clearTimeout(pasteBuf.timer);
    };
  }, []);

  const submit = useCallback(() => {
    // If the user hits Enter inside the 30ms settle window right after pasting, flush
    // the buffered paste into `bufRef` first so it is never lost or left behind.
    if (pasteBufRef.current.text) commitPasteBurst();
    const text = bufRef.current.value;
    if (!text.trim()) return;
    setHistory((h) => [...h, text]);
    setHistIndex(-1);
    syncBuffer('', 0);
    setHint('');
    onSubmit(shellMode && !text.startsWith('sh ') ? `sh ${text}` : text);
  }, [commitPasteBurst, syncBuffer, shellMode, onSubmit]);

  useInput(
    (input, key) => {
      session.throughput?.recordKeystroke?.();

      const p = pasteBufRef.current;
      const hasStart = typeof input === 'string' && (input.includes(PASTE_START) || input.includes('[200~'));
      const hasEnd = typeof input === 'string' && (input.includes(PASTE_END) || input.includes('[201~'));
      const cleaned = typeof input === 'string' ? input.replace(BRACKET_RE, '') : '';

      // --- bracketed or multi-chunk paste burst ---
      // Once a paste starts (either via DECSET 2004 marker or a multi-char chunk with
      // line breaks, or a large single-read burst > 128 chars), coalesce every rapid
      // follow-up chunk — including mid-paste chunks that happen not to contain a
      // newline, and raw `\r` chunks if a terminal splits CRLF across reads — until
      // `\x1b[201~` arrives or stdin goes quiet for PASTE_SETTLE_MS.
      const isBurstChunk =
        hasStart ||
        hasEnd ||
        looksLikePaste(cleaned) ||
        (cleaned.length > 128 && !key.ctrl && !key.meta);

      if (p.bracketed || p.timer || isBurstChunk) {
        if (hasStart) p.bracketed = true;
        if (cleaned) p.text += cleaned;
        else if (key.return && (p.bracketed || p.timer)) p.text += '\n';

        if (hasEnd) {
          commitPasteBurst();
          return;
        }

        if (p.timer) clearTimeout(p.timer);
        // Even inside bracketed mode, arm a fallback timer in case the end marker was
        // swallowed by Ink's key parser so the buffer can never wedge.
        p.timer = setTimeout(commitPasteBurst, p.bracketed ? 150 : PASTE_SETTLE_MS);
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
        const { value: curVal, cursor: curPos } = bufRef.current;
        const completed = completeInput(curVal, curPos, session);
        if (completed) {
          syncBuffer(completed.value, completed.cursor);
          setHint(completed.hint || '');
        }
        return;
      }

      if (key.ctrl && input === 's') {
>>>>>>> Stashed changes
        setShellMode((s) => !s);
      }
<<<<<<< Updated upstream
=======

      if (key.upArrow) {
        if (!history.length) return;
        const i = histIndex === -1 ? history.length - 1 : Math.max(0, histIndex - 1);
        setHistIndex(i);
        syncBuffer(history[i], history[i].length);
        return;
      }
      if (key.downArrow) {
        if (histIndex === -1) return;
        const i = histIndex + 1;
        if (i >= history.length) {
          setHistIndex(-1);
          syncBuffer('', 0);
        } else {
          setHistIndex(i);
          syncBuffer(history[i], history[i].length);
        }
        return;
      }

      if (key.leftArrow) {
        const next = Math.max(0, bufRef.current.cursor - 1);
        bufRef.current.cursor = next;
        return setCursor(next);
      }
      if (key.rightArrow) {
        const next = Math.min(bufRef.current.value.length, bufRef.current.cursor + 1);
        bufRef.current.cursor = next;
        return setCursor(next);
      }

      if (key.backspace || key.delete) {
        const { value: v, cursor: c } = bufRef.current;
        if (c === 0) return;
        syncBuffer(v.slice(0, c - 1) + v.slice(c), Math.max(0, c - 1));
        return;
      }

      if (key.ctrl && input === 'u') {
        syncBuffer('', 0);
        return;
      }
      if (key.ctrl && input === 'a') return; // reserved: artifacts pane
      if (key.ctrl && input === 't') return; // reserved: throughput pane
      if (key.ctrl && input === 'e') {
        const end = bufRef.current.value.length;
        bufRef.current.cursor = end;
        return setCursor(end);
      }

      // Ignore remaining control chords so they don't land in the buffer.
      if (key.ctrl || key.meta || key.escape) return;

      if (input) insert(input);
>>>>>>> Stashed changes
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