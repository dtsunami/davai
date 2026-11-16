/**
 * Shell-grade line editor state machine and Ink input hook.
 *
 * Keeps authoritative buffer/cursor state in a synchronous ref so rapid bursts and
 * multi-sequence terminal chunks (e.g. arrow movement + typing in one SSH packet)
 * never suffer from React stale-closure cursor drift.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useInput, useStdin } from 'ink';
import { looksLikePaste } from '../context/pastes.js';

const MAX_UNDO = 64;

/** Step one UTF-16 code point left without splitting surrogate pairs. */
export function prevCharIndex(str, idx) {
  if (idx <= 0) return 0;
  if (idx >= 2) {
    const lo = str.charCodeAt(idx - 1);
    const hi = str.charCodeAt(idx - 2);
    if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff) return idx - 2;
  }
  return idx - 1;
}

/** Step one UTF-16 code point right without splitting surrogate pairs. */
export function nextCharIndex(str, idx) {
  if (idx >= str.length) return str.length;
  const hi = str.charCodeAt(idx);
  if (hi >= 0xd800 && hi <= 0xdbff && idx + 1 < str.length) {
    const lo = str.charCodeAt(idx + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return idx + 2;
  }
  return idx + 1;
}

const isWordAlnum = (ch) => /[A-Za-z0-9_]/.test(ch);
const isSpace = (ch) => /\s/.test(ch);

/**
 * Move one shell subword left (`Ctrl+←` / `Alt+←` / `Alt+B`).
 * Stops at path segments (`/`), extensions (`.`), flags (`--foo-bar`), and whitespace.
 */
export function wordLeft(str, cursor) {
  let i = Math.max(0, Math.min(str.length, cursor));
  while (i > 0 && isSpace(str[i - 1])) i--;
  if (i === 0) return 0;
  if (isWordAlnum(str[i - 1])) {
    while (i > 0 && isWordAlnum(str[i - 1])) i--;
  } else {
    while (i > 0 && !isSpace(str[i - 1]) && !isWordAlnum(str[i - 1])) i--;
  }
  return i;
}

/** Move one shell subword right (`Ctrl+→` / `Alt+→` / `Alt+F`). */
export function wordRight(str, cursor) {
  const n = str.length;
  let i = Math.max(0, Math.min(n, cursor));
  while (i < n && isSpace(str[i])) i++;
  if (i >= n) return n;
  if (isWordAlnum(str[i])) {
    while (i < n && isWordAlnum(str[i])) i++;
  } else {
    while (i < n && !isSpace(str[i]) && !isWordAlnum(str[i])) i++;
  }
  return i;
}

/** Classic Unix `Ctrl+W`: rub out back to whitespace or path slash. */
export function unixWordLeft(str, cursor) {
  let i = Math.max(0, Math.min(str.length, cursor));
  while (i > 0 && isSpace(str[i - 1])) i--;
  if (i > 0 && (str[i - 1] === '/' || str[i - 1] === '\\')) {
    i--;
  }
  while (i > 0 && !isSpace(str[i - 1]) && str[i - 1] !== '/' && str[i - 1] !== '\\') {
    i--;
  }
  return i;
}

/** Line geometry around `cursor` for multiline navigation and `Home`/`End`/`Ctrl+K`. */
export function lineBounds(text, cursor) {
  const clamped = Math.max(0, Math.min(text.length, cursor));
  const rawLines = text.split('\n');
  const lines = [];
  let pos = 0;
  let lineIndex = 0;
  for (let idx = 0; idx < rawLines.length; idx++) {
    const start = pos;
    const end = pos + rawLines[idx].length;
    lines.push({ start, end });
    if (clamped >= start && clamped <= end) lineIndex = idx;
    pos = end + 1;
  }
  const cur = lines[lineIndex] || { start: 0, end: text.length };
  return {
    start: cur.start,
    end: cur.end,
    col: clamped - cur.start,
    lineIndex,
    lineCount: lines.length,
    lines,
  };
}

/**
 * Parse a raw terminal input chunk into ordered editor events.
 * Handles standard VT/xterm CSI/SS3, rxvt, Kitty CSI-u, modifyOtherKeys, readline
 * chords, and bracketed/burst pastes.
 *
 * @param {string} raw
 * @param {{buffer?: string, active?: boolean}} [pasteState]
 */
export function tokenizeRawInput(raw, pasteState) {
  if (!raw) return [];
  const events = [];
  let s = raw;

  // Ongoing bracketed paste spanning multiple stdin chunks.
  if (pasteState?.active) {
    const closeIdx = s.indexOf('\x1b[201~');
    if (closeIdx === -1) {
      pasteState.buffer += s;
      return [];
    }
    const full = pasteState.buffer + s.slice(0, closeIdx);
    pasteState.buffer = '';
    pasteState.active = false;
    events.push({ type: 'paste', text: full, bracketed: true });
    s = s.slice(closeIdx + 6);
    if (!s) return events;
  }

  // Unbracketed multi-line paste arriving in one chunk (e.g. Windows ConHost / tests).
  if (!s.includes('\x1b') && looksLikePaste(s)) {
    return [{ type: 'paste', text: s, bracketed: false }];
  }

  let i = 0;
  let textBuf = '';
  const flushText = () => {
    if (textBuf) {
      events.push({ type: 'text', text: textBuf });
      textBuf = '';
    }
  };

  while (i < s.length) {
    // Bracketed paste start `\x1b[200~`
    if (s.startsWith('\x1b[200~', i)) {
      flushText();
      const bodyStart = i + 6;
      const closeIdx = s.indexOf('\x1b[201~', bodyStart);
      if (closeIdx === -1) {
        const rest = s.slice(bodyStart);
        if (pasteState) {
          pasteState.active = true;
          pasteState.buffer = rest;
        } else {
          events.push({ type: 'paste', text: rest, bracketed: true });
        }
        return events;
      }
      events.push({ type: 'paste', text: s.slice(bodyStart, closeIdx), bracketed: true });
      i = closeIdx + 6;
      continue;
    }

    const ch = s[i];

    if (ch === '\x1b') {
      flushText();
      const tail = s.slice(i);

      // Double-ESC + arrow (`\x1b\x1b[D` / `\x1b\x1b[C` — macOS Terminal Alt+Arrow)
      const dblArrow = tail[1] === '\x1b' ? tail.slice(2).match(/^\[([ABCD])/) : null;
      if (dblArrow) {
        const d = dblArrow[1];
        if (d === 'D') events.push({ type: 'wordLeft' });
        else if (d === 'C') events.push({ type: 'wordRight' });
        else if (d === 'A') events.push({ type: 'up' });
        else if (d === 'B') events.push({ type: 'down' });
        i += 2 + dblArrow[0].length;
        continue;
      }

      // CSI sequences: `\x1b[...`
      const csi = tail.slice(1).match(/^\[([0-9;?]*)([A-Za-z~])/);
      if (csi) {
        const params = csi[1];
        const final = csi[2];
        const parts = params ? params.split(';').map(Number) : [];
        const mod = parts.length >= 2 ? parts[1] : 1;
        const hasWordMod = mod === 3 || mod === 4 || mod === 5 || mod === 6 || mod === 7 || mod === 8;
        const hasCtrl = mod === 5 || mod === 6 || mod === 7 || mod === 8;

        if (final === 'D') events.push({ type: hasWordMod ? 'wordLeft' : 'left' });
        else if (final === 'C') events.push({ type: hasWordMod ? 'wordRight' : 'right' });
        else if (final === 'A') events.push({ type: 'up', ctrl: hasCtrl });
        else if (final === 'B') events.push({ type: 'down', ctrl: hasCtrl });
        else if (final === 'H') events.push({ type: hasCtrl ? 'bufferStart' : 'home' });
        else if (final === 'F') events.push({ type: hasCtrl ? 'bufferEnd' : 'end' });
        else if (final === 'Z') events.push({ type: 'tab', shift: true });
        else if (final === 'u') {
          // Kitty / CSI-u keyboard protocol (`\x1b[<codepoint>;<mod>u`)
          const code = parts[0];
          if (code === 13) {
            events.push({ type: mod > 1 ? 'newline' : 'enter' });
          } else if (code === 9) {
            events.push({ type: 'tab', shift: mod === 2 || mod === 6 });
          } else if (code === 27) {
            events.push({ type: 'escape' });
          } else if (code === 127 || code === 8) {
            events.push({ type: hasWordMod ? 'deleteWordBack' : 'backspace' });
          } else if (hasCtrl && code >= 97 && code <= 122) {
            events.push({ type: 'ctrl', key: String.fromCharCode(code) });
          } else if (code >= 32 && mod <= 2) {
            textBuf += String.fromCodePoint(code);
          }
        } else if (final === '~') {
          const code = parts[0];
          if (code === 1 || code === 7) events.push({ type: hasCtrl ? 'bufferStart' : 'home' });
          else if (code === 4 || code === 8) events.push({ type: hasCtrl ? 'bufferEnd' : 'end' });
          else if (code === 3) events.push({ type: hasWordMod ? 'deleteWordForward' : 'delete' });
          else if (code === 5) events.push({ type: 'pageUp' });
          else if (code === 6) events.push({ type: 'pageDown' });
          else if (code === 27 && parts[2] === 13) events.push({ type: 'newline' });
        }
        i += 1 + csi[0].length;
        continue;
      }

      // SS3 / rxvt sequences: `\x1bO<char>`
      if (tail.length >= 3 && tail[1] === 'O') {
        const f = tail[2];
        if (f === 'D') events.push({ type: 'left' });
        else if (f === 'C') events.push({ type: 'right' });
        else if (f === 'A') events.push({ type: 'up' });
        else if (f === 'B') events.push({ type: 'down' });
        else if (f === 'H') events.push({ type: 'home' });
        else if (f === 'F') events.push({ type: 'end' });
        else if (f === 'd') events.push({ type: 'wordLeft' });
        else if (f === 'c') events.push({ type: 'wordRight' });
        else if (f === 'M') events.push({ type: 'enter' });
        i += 3;
        continue;
      }

      // Alt/Meta two-byte chords: `\x1b<char>`
      if (tail.length >= 2) {
        const next = tail[1];
        if (next === '\r' || next === '\n') {
          events.push({ type: 'newline' });
          i += 2;
          continue;
        }
        if (next === '\x7f' || next === '\x08') {
          events.push({ type: 'deleteWordBack' });
          i += 2;
          continue;
        }
        if (next === 'b' || next === 'B') {
          events.push({ type: 'wordLeft' });
          i += 2;
          continue;
        }
        if (next === 'f' || next === 'F') {
          events.push({ type: 'wordRight' });
          i += 2;
          continue;
        }
        if (next === 'd' || next === 'D') {
          events.push({ type: 'deleteWordForward' });
          i += 2;
          continue;
        }
        // Unknown Alt+<key>: consume both bytes so neither lands in the text buffer.
        i += 2;
        continue;
      }

      // Lone ESC key.
      events.push({ type: 'escape' });
      i += 1;
      continue;
    }

    // Standard single-byte control characters.
    if (ch === '\r' || ch === '\n') {
      flushText();
      // Collapse CRLF into one enter event.
      if (ch === '\r' && s[i + 1] === '\n') i += 2;
      else i += 1;
      events.push({ type: 'enter' });
      continue;
    }
    if (ch === '\t') {
      flushText();
      events.push({ type: 'tab', shift: false });
      i++;
      continue;
    }
    if (ch === '\x7f' || ch === '\x08') {
      flushText();
      events.push({ type: 'backspace' });
      i++;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 32) {
      flushText();
      if (code === 2) events.push({ type: 'left' }); // Ctrl+B
      else if (code === 6) events.push({ type: 'right' }); // Ctrl+F
      else if (code === 16) events.push({ type: 'up' }); // Ctrl+P
      else if (code === 14) events.push({ type: 'down' }); // Ctrl+N
      else if (code === 23) events.push({ type: 'killWordBack' }); // Ctrl+W
      else if (code === 31 || code === 26) events.push({ type: 'undo' }); // Ctrl+_ / Ctrl+Z
      else if (code >= 1 && code <= 26) {
        events.push({ type: 'ctrl', key: String.fromCharCode(code + 96) });
      }
      i++;
      continue;
    }

    textBuf += ch;
    i++;
  }

  flushText();
  return events;
}

/** Create initial synchronous editor state. */
export function createEditorState(initialValue = '', history = []) {
  return {
    value: initialValue,
    cursor: initialValue.length,
    preferredCol: null,
    killRing: '',
    undoStack: [],
    hint: '',
    cycle: null, // { items, index, start, currentEnd }
    history: [...history],
    histIndex: -1,
    draft: '',
    search: null, // { query, matchIndex, savedValue, savedCursor }
  };
}

function pushUndo(state) {
  const prev = state.undoStack.at(-1);
  if (prev && prev.value === state.value && prev.cursor === state.cursor) return state.undoStack;
  const next = [...state.undoStack, { value: state.value, cursor: state.cursor }];
  return next.length > MAX_UNDO ? next.slice(next.length - MAX_UNDO) : next;
}

function mutateText(state, value, cursor, extra = {}) {
  return {
    ...state,
    undoStack: pushUndo(state),
    value,
    cursor: Math.max(0, Math.min(value.length, cursor)),
    preferredCol: null,
    cycle: null,
    hint: '',
    ...extra,
  };
}

function findHistoryReverse(history, query, fromIndex) {
  if (!history.length) return -1;
  const q = query.toLowerCase();
  for (let i = Math.min(fromIndex, history.length - 1); i >= 0; i--) {
    if (!q || history[i].toLowerCase().includes(q)) return i;
  }
  return -1;
}

function stepPrefixHistory(state, dir, strictPrefix) {
  const { history } = state;
  if (!history.length) return state;

  const starting = state.histIndex === -1;
  const draft = starting ? state.value : state.draft;
  const prefix = strictPrefix ? draft : '';

  if (dir < 0) {
    let idx = starting ? history.length - 1 : state.histIndex - 1;
    while (idx >= 0) {
      if (!prefix || history[idx].startsWith(prefix)) {
        return {
          ...state,
          draft,
          histIndex: idx,
          value: history[idx],
          cursor: history[idx].length,
          preferredCol: null,
          cycle: null,
          hint: '',
        };
      }
      idx--;
    }
    return state;
  }

  // Moving forward (`down` / `pageDown`)
  if (state.histIndex === -1) return state;
  let idx = state.histIndex + 1;
  while (idx < history.length) {
    if (!prefix || history[idx].startsWith(prefix)) {
      return {
        ...state,
        histIndex: idx,
        value: history[idx],
        cursor: history[idx].length,
        preferredCol: null,
        cycle: null,
        hint: '',
      };
    }
    idx++;
  }
  return {
    ...state,
    histIndex: -1,
    value: state.draft,
    cursor: state.draft.length,
    preferredCol: null,
    cycle: null,
    hint: '',
  };
}

/**
 * Pure reducer for a single parsed editor event.
 *
 * @param {ReturnType<typeof createEditorState>} state
 * @param {object} ev
 * @param {{
 *   multiline?: boolean,
 *   enableHistory?: boolean,
 *   enableSearch?: boolean,
 *   complete?: (value: string, cursor: number) => any,
 *   reservedCtrl?: Set<string>,
 * }} [opts]
 * @returns {{state: ReturnType<typeof createEditorState>, effect?: any}}
 */
export function applyEditorEvent(state, ev, opts = {}) {
  const {
    multiline = false,
    enableHistory = false,
    enableSearch = false,
    complete = null,
    reservedCtrl = new Set(),
  } = opts;

  // --- Reverse incremental history search (`ctrl+r`) ---
  if (state.search) {
    const s = state.search;
    if (ev.type === 'escape' || (ev.type === 'ctrl' && (ev.key === 'g' || ev.key === 'c'))) {
      return {
        state: {
          ...state,
          value: s.savedValue,
          cursor: s.savedCursor,
          search: null,
          hint: '',
        },
      };
    }
    if (ev.type === 'ctrl' && ev.key === 'r') {
      const startFrom = s.matchIndex > 0 ? s.matchIndex - 1 : state.history.length - 1;
      const hit = findHistoryReverse(state.history, s.query, startFrom);
      if (hit >= 0) {
        return {
          state: {
            ...state,
            value: state.history[hit],
            cursor: state.history[hit].length,
            search: { ...s, matchIndex: hit },
          },
        };
      }
      return { state };
    }
    if (ev.type === 'backspace') {
      const nextQuery = s.query.slice(0, prevCharIndex(s.query, s.query.length));
      const hit = findHistoryReverse(state.history, nextQuery, state.history.length - 1);
      const matched = hit >= 0 ? state.history[hit] : s.savedValue;
      return {
        state: {
          ...state,
          value: matched,
          cursor: matched.length,
          search: { ...s, query: nextQuery, matchIndex: hit },
        },
      };
    }
    if (ev.type === 'text') {
      const nextQuery = s.query + ev.text;
      const from = s.matchIndex >= 0 ? s.matchIndex : state.history.length - 1;
      const hit = findHistoryReverse(state.history, nextQuery, from);
      const nextVal = hit >= 0 ? state.history[hit] : state.value;
      return {
        state: {
          ...state,
          value: nextVal,
          cursor: nextVal.length,
          search: { ...s, query: nextQuery, matchIndex: hit },
        },
      };
    }
    if (ev.type === 'enter') {
      // Accept matched history command into the buffer or submit directly?
      // Standard bash/zsh submits on Enter and accepts-for-editing on Tab/Right/Left!
      // Accepting on Tab/Arrows and submitting on Enter matches bash/zsh muscle memory,
      // EXCEPT when editing is safer: let's check — if search matched something, Enter
      // submits it if non-empty, while Tab/Left/Right/Home/End lands you in the editor!
      const accepted = { ...state, search: null };
      if (!accepted.value.trim()) return { state: accepted };
      return applyEditorEvent(accepted, ev, opts);
    }
    // Any navigation/tab key accepts the matched line into normal editing and runs the key!
    state = { ...state, search: null };
  }

  switch (ev.type) {
    case 'left': {
      const c = prevCharIndex(state.value, state.cursor);
      return { state: { ...state, cursor: c, preferredCol: null, cycle: null } };
    }

    case 'right': {
      const c = nextCharIndex(state.value, state.cursor);
      return { state: { ...state, cursor: c, preferredCol: null, cycle: null } };
    }

    case 'wordLeft': {
      const c = wordLeft(state.value, state.cursor);
      return { state: { ...state, cursor: c, preferredCol: null, cycle: null } };
    }

    case 'wordRight': {
      const c = wordRight(state.value, state.cursor);
      return { state: { ...state, cursor: c, preferredCol: null, cycle: null } };
    }

    case 'home': {
      const { start } = lineBounds(state.value, state.cursor);
      return { state: { ...state, cursor: start, preferredCol: 0, cycle: null } };
    }

    case 'end': {
      const { end } = lineBounds(state.value, state.cursor);
      return { state: { ...state, cursor: end, preferredCol: null, cycle: null } };
    }

    case 'bufferStart':
      return { state: { ...state, cursor: 0, preferredCol: 0, cycle: null } };

    case 'bufferEnd':
      return { state: { ...state, cursor: state.value.length, preferredCol: null, cycle: null } };

    case 'up': {
      if (multiline && state.value.includes('\n')) {
        const b = lineBounds(state.value, state.cursor);
        if (b.lineIndex > 0) {
          const wantCol = state.preferredCol ?? b.col;
          const prev = b.lines[b.lineIndex - 1];
          const nextCursor = Math.min(prev.end, prev.start + wantCol);
          return { state: { ...state, cursor: nextCursor, preferredCol: wantCol, cycle: null } };
        }
      }
      if (enableHistory) {
        return { state: stepPrefixHistory(state, -1, false) };
      }
      return { state, effect: { type: 'up' } };
    }

    case 'down': {
      if (multiline && state.value.includes('\n')) {
        const b = lineBounds(state.value, state.cursor);
        if (b.lineIndex < b.lineCount - 1) {
          const wantCol = state.preferredCol ?? b.col;
          const next = b.lines[b.lineIndex + 1];
          const nextCursor = Math.min(next.end, next.start + wantCol);
          return { state: { ...state, cursor: nextCursor, preferredCol: wantCol, cycle: null } };
        }
      }
      if (enableHistory) {
        return { state: stepPrefixHistory(state, 1, false) };
      }
      return { state, effect: { type: 'down' } };
    }

    case 'pageUp':
      return enableHistory ? { state: stepPrefixHistory(state, -1, true) } : { state };

    case 'pageDown':
      return enableHistory ? { state: stepPrefixHistory(state, 1, true) } : { state };

    case 'backspace': {
      if (state.cursor === 0) return { state };
      const from = prevCharIndex(state.value, state.cursor);
      const next = state.value.slice(0, from) + state.value.slice(state.cursor);
      return { state: mutateText(state, next, from) };
    }

    case 'delete': {
      if (state.cursor >= state.value.length) return { state };
      const to = nextCharIndex(state.value, state.cursor);
      const next = state.value.slice(0, state.cursor) + state.value.slice(to);
      return { state: mutateText(state, next, state.cursor) };
    }

    case 'deleteWordBack': {
      if (state.cursor === 0) return { state };
      const from = wordLeft(state.value, state.cursor);
      const killed = state.value.slice(from, state.cursor);
      const next = state.value.slice(0, from) + state.value.slice(state.cursor);
      return { state: mutateText(state, next, from, { killRing: killed }) };
    }

    case 'killWordBack': {
      if (state.cursor === 0) return { state };
      const from = unixWordLeft(state.value, state.cursor);
      const killed = state.value.slice(from, state.cursor);
      const next = state.value.slice(0, from) + state.value.slice(state.cursor);
      return { state: mutateText(state, next, from, { killRing: killed }) };
    }

    case 'deleteWordForward': {
      if (state.cursor >= state.value.length) return { state };
      const to = wordRight(state.value, state.cursor);
      const killed = state.value.slice(state.cursor, to);
      const next = state.value.slice(0, state.cursor) + state.value.slice(to);
      return { state: mutateText(state, next, state.cursor, { killRing: killed }) };
    }

    case 'undo': {
      if (!state.undoStack.length) return { state };
      const prev = state.undoStack.at(-1);
      return {
        state: {
          ...state,
          value: prev.value,
          cursor: prev.cursor,
          undoStack: state.undoStack.slice(0, -1),
          preferredCol: null,
          cycle: null,
          hint: '',
        },
      };
    }

    case 'tab': {
      if (!complete) return { state, effect: { type: 'tab', shift: Boolean(ev.shift) } };

      // Subsequent Tab / Shift+Tab while a multi-item candidate menu is open: cycle!
      if (state.cycle && state.cycle.items.length > 1) {
        const { items, index, start, currentEnd } = state.cycle;
        const delta = ev.shift ? -1 : 1;
        const nextIdx =
          index === -1
            ? ev.shift
              ? items.length - 1
              : 0
            : (index + delta + items.length) % items.length;
        const chosen = items[nextIdx];
        const tail = state.value.slice(currentEnd);
        const ins =
          tail.startsWith(' ') && chosen.insert.endsWith(' ')
            ? chosen.insert.slice(0, -1)
            : chosen.insert;
        const head = state.value.slice(0, start) + ins;
        const nextVal = head + tail;
        return {
          state: {
            ...state,
            undoStack: pushUndo(state),
            value: nextVal,
            cursor: head.length,
            preferredCol: null,
            cycle: { items, index: nextIdx, start, currentEnd: head.length },
            hint: formatCycleHint(items, nextIdx),
          },
        };
      }

      const res = complete(state.value, state.cursor);
      if (!res) return { state };

      const items = res.items || [];
      const [start = 0] = res.replaceRange || [0, state.cursor];

      // If multiple candidates exist and the prefix did not advance on this Tab, jump
      // straight to selecting the first candidate so the first Tab after typing a common
      // prefix visibly cycles instead of requiring two presses.
      if (items.length > 1 && res.value === state.value && res.cursor === state.cursor) {
        // Wait: preserve `completeInput('/c', 2)` style hint on the VERY FIRST Tab so
        // the operator sees all candidates before committing one; the second Tab cycles!
        return {
          state: {
            ...state,
            hint: res.hint || formatCycleHint(items, -1),
            cycle: { items, index: -1, start, currentEnd: res.cursor },
          },
        };
      }

      return {
        state: {
          ...state,
          undoStack: pushUndo(state),
          value: res.value,
          cursor: res.cursor,
          preferredCol: null,
          hint: res.hint || '',
          cycle:
            items.length > 1
              ? { items, index: -1, start, currentEnd: res.cursor }
              : null,
        },
      };
    }

    case 'newline': {
      if (!multiline) return applyEditorEvent(state, { type: 'enter' }, opts);
      const head = state.value.slice(0, state.cursor) + '\n';
      return { state: mutateText(state, head + state.value.slice(state.cursor), head.length) };
    }

    case 'enter': {
      return { state: { ...state, cycle: null }, effect: { type: 'submit', value: state.value } };
    }

    case 'escape': {
      if (state.cycle || state.hint) {
        return { state: { ...state, cycle: null, hint: '' } };
      }
      return { state, effect: { type: 'escape' } };
    }

    case 'paste': {
      return { state, effect: { type: 'paste', text: ev.text, bracketed: ev.bracketed } };
    }

    case 'ctrl': {
      if (reservedCtrl.has(ev.key)) {
        return { state, effect: { type: 'ctrl', key: ev.key } };
      }
      switch (ev.key) {
        case 'a': {
          const { start } = lineBounds(state.value, state.cursor);
          const target = state.cursor === start ? 0 : start;
          return { state: { ...state, cursor: target, preferredCol: 0, cycle: null } };
        }
        case 'e': {
          const { end } = lineBounds(state.value, state.cursor);
          const target = state.cursor === end ? state.value.length : end;
          return { state: { ...state, cursor: target, preferredCol: null, cycle: null } };
        }
        case 'd': {
          if (state.cursor >= state.value.length) return { state };
          const to = nextCharIndex(state.value, state.cursor);
          const next = state.value.slice(0, state.cursor) + state.value.slice(to);
          return { state: mutateText(state, next, state.cursor) };
        }
        case 'k': {
          const { end } = lineBounds(state.value, state.cursor);
          // At a newline, Ctrl+K kills the newline itself (joins the next line), like readline.
          const killEnd =
            state.cursor === end && state.cursor < state.value.length
              ? state.cursor + 1
              : end;
          if (killEnd <= state.cursor) return { state };
          const killed = state.value.slice(state.cursor, killEnd);
          const next = state.value.slice(0, state.cursor) + state.value.slice(killEnd);
          return { state: mutateText(state, next, state.cursor, { killRing: killed }) };
        }
        case 'u': {
          if (!state.value.length) return { state };
          const { start } = lineBounds(state.value, state.cursor);
          // If already at position 0, clear the whole buffer (`ctrl+u clear the input line`).
          if (state.cursor === 0) {
            return { state: mutateText(state, '', 0, { killRing: state.value }) };
          }
          const from = state.cursor === start && start > 0 ? start - 1 : start;
          const killed = state.value.slice(from, state.cursor);
          const next = state.value.slice(0, from) + state.value.slice(state.cursor);
          return { state: mutateText(state, next, from, { killRing: killed }) };
        }
        case 'y': {
          if (!state.killRing) return { state };
          const head = state.value.slice(0, state.cursor) + state.killRing;
          return { state: mutateText(state, head + state.value.slice(state.cursor), head.length) };
        }
        case 'r': {
          if (!enableSearch || !state.history.length) return { state };
          const hit = findHistoryReverse(state.history, '', state.history.length - 1);
          const matched = hit >= 0 ? state.history[hit] : state.value;
          return {
            state: {
              ...state,
              value: matched,
              cursor: matched.length,
              cycle: null,
              hint: '',
              search: {
                query: '',
                matchIndex: hit,
                savedValue: state.value,
                savedCursor: state.cursor,
              },
            },
          };
        }
        default:
          return { state, effect: { type: 'ctrl', key: ev.key } };
      }
    }

    case 'text': {
      if (!ev.text) return { state };
      const head = state.value.slice(0, state.cursor) + ev.text;
      return { state: mutateText(state, head + state.value.slice(state.cursor), head.length) };
    }

    default:
      return { state };
  }
}

function formatCycleHint(items, activeIdx) {
  const maxShow = 10;
  const total = items.length;
  let start = 0;
  if (activeIdx >= 0 && total > maxShow) {
    start = Math.max(0, Math.min(activeIdx - Math.floor(maxShow / 2), total - maxShow));
  }
  const slice = items.slice(start, start + maxShow);
  const parts = slice.map((it, idx) => {
    const real = start + idx;
    return real === activeIdx ? `[${it.label}]` : it.label;
  });
  if (start > 0) parts.unshift('…');
  if (start + maxShow < total) parts.push('…');
  const activeDesc = activeIdx >= 0 && items[activeIdx]?.desc ? ` — ${items[activeIdx].desc}` : '';
  return parts.join('  ') + activeDesc;
}

/** Translate Ink's parsed `(input, key)` as a fallback when no raw emitter is attached. */
function inkKeyToEvent(input, key) {
  if (looksLikePaste(input)) return { type: 'paste', text: input, bracketed: false };
  if (key.return) return { type: key.shift || key.meta ? 'newline' : 'enter' };
  if (key.tab) return { type: 'tab', shift: Boolean(key.shift) };
  if (key.escape) return { type: 'escape' };
  if (key.leftArrow) return { type: key.ctrl || key.meta ? 'wordLeft' : 'left' };
  if (key.rightArrow) return { type: key.ctrl || key.meta ? 'wordRight' : 'right' };
  if (key.upArrow) return { type: 'up' };
  if (key.downArrow) return { type: 'down' };
  if (key.pageUp) return { type: 'pageUp' };
  if (key.pageDown) return { type: 'pageDown' };
  if (key.home) return { type: 'home' };
  if (key.end) return { type: 'end' };
  if (key.backspace || key.delete) {
    return { type: key.meta || key.ctrl ? 'deleteWordBack' : 'backspace' };
  }
  if (key.ctrl && input) return { type: 'ctrl', key: input.toLowerCase() };
  if (key.meta && input === 'b') return { type: 'wordLeft' };
  if (key.meta && input === 'f') return { type: 'wordRight' };
  if (key.meta && input === 'd') return { type: 'deleteWordForward' };
  if (key.ctrl || key.meta) return null;
  if (input) return { type: 'text', text: input };
  return null;
}

/**
 * Ink hook wrapping `applyEditorEvent` with raw terminal input decoding.
 *
 * @param {object} opts
 * @param {string} [opts.initialValue]
 * @param {string[]} [opts.initialHistory]
 * @param {boolean} [opts.isActive]
 * @param {boolean} [opts.multiline]
 * @param {boolean} [opts.enableHistory]
 * @param {boolean} [opts.enableSearch]
 * @param {Set<string>} [opts.reservedCtrl]
 * @param {(value: string, cursor: number) => any} [opts.complete]
 * @param {(text: string, helpers: {insert: (t: string, hint?: string) => void}) => boolean|void} [opts.onPaste]
 * @param {(value: string) => void} [opts.onSubmit]
 * @param {() => void} [opts.onEscape]
 * @param {(effect: any, helpers: any) => void} [opts.onEffect]
 * @param {() => void} [opts.onKeystroke]
 */
export function useLineEditor({
  initialValue = '',
  initialHistory = [],
  isActive = true,
  multiline = false,
  enableHistory = false,
  enableSearch = false,
  reservedCtrl,
  complete,
  onPaste,
  onSubmit,
  onEscape,
  onEffect,
  onChange,
  onKeystroke,
} = {}) {
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const stateRef = useRef(null);
  if (!stateRef.current) {
    stateRef.current = createEditorState(initialValue, initialHistory);
  }
  const pasteStateRef = useRef({ active: false, buffer: '' });

  // Keep latest callbacks in a ref so the stdin listener never has to re-bind per keystroke.
  const optsRef = useRef({});
  optsRef.current = {
    multiline,
    enableHistory,
    enableSearch,
    reservedCtrl,
    complete,
    onPaste,
    onSubmit,
    onEscape,
    onEffect,
    onChange,
    onKeystroke,
  };

  const setBuffer = useCallback(
    (value, cursor = value.length, extra = {}) => {
      stateRef.current = {
        ...stateRef.current,
        value,
        cursor: Math.max(0, Math.min(value.length, cursor)),
        preferredCol: null,
        cycle: null,
        hint: '',
        search: null,
        ...extra,
      };
      optsRef.current.onChange?.(stateRef.current);
      rerender();
    },
    [rerender],
  );

  const insertAtCursor = useCallback(
    (text, hint = '') => {
      const s = stateRef.current;
      const head = s.value.slice(0, s.cursor) + text;
      stateRef.current = mutateText(s, head + s.value.slice(s.cursor), head.length, { hint });
      optsRef.current.onChange?.(stateRef.current);
      rerender();
    },
    [rerender],
  );

  const pushHistory = useCallback((entry) => {
    const s = stateRef.current;
    stateRef.current = {
      ...s,
      history: [...s.history, entry],
      histIndex: -1,
      draft: '',
    };
  }, []);

  const handleEvents = useCallback(
    (events) => {
      if (!events.length) return;
      const curOpts = optsRef.current;
      curOpts.onKeystroke?.();

      let changed = false;
      for (const ev of events) {
        const prev = stateRef.current;
        const { state: next, effect } = applyEditorEvent(prev, ev, {
          multiline: curOpts.multiline,
          enableHistory: curOpts.enableHistory,
          enableSearch: curOpts.enableSearch,
          reservedCtrl: curOpts.reservedCtrl,
          complete: curOpts.complete,
        });
        if (next !== prev) {
          stateRef.current = next;
          changed = true;
          curOpts.onChange?.(next);
        }
        if (effect) {
          if (effect.type === 'paste') {
            const handled = curOpts.onPaste?.(effect.text, { insert: insertAtCursor });
            if (!handled) {
              const clean = curOpts.multiline
                ? effect.text.replace(/\r\n?/g, '\n')
                : effect.text.replace(/[\r\n]+/g, ' ').trimEnd();
              const s = stateRef.current;
              const head = s.value.slice(0, s.cursor) + clean;
              stateRef.current = mutateText(s, head + s.value.slice(s.cursor), head.length);
              changed = true;
              curOpts.onChange?.(stateRef.current);
            }
          } else if (effect.type === 'submit') {
            curOpts.onSubmit?.(stateRef.current.value);
          } else if (effect.type === 'escape') {
            curOpts.onEscape?.();
          } else {
            curOpts.onEffect?.(effect, { setBuffer, insertAtCursor });
          }
        }
      }
      if (changed) rerender();
    },
    [insertAtCursor, rerender, setBuffer],
  );

  const { internal_eventEmitter } = useStdin();
  const hasRawEmitter = Boolean(internal_eventEmitter);

  // Keep `useInput` mounted so Ink's raw-mode refcount stays accurate.
  useInput(
    (input, key) => {
      if (hasRawEmitter) return;
      const ev = inkKeyToEvent(input, key);
      if (ev) handleEvents([ev]);
    },
    { isActive },
  );

  useEffect(() => {
    if (!isActive || !internal_eventEmitter) return undefined;
    const onData = (chunk) => {
      const str = typeof chunk === 'string' ? chunk : String(chunk ?? '');
      const events = tokenizeRawInput(str, pasteStateRef.current);
      handleEvents(events);
    };
    internal_eventEmitter.on('input', onData);
    return () => {
      internal_eventEmitter.off('input', onData);
    };
  }, [isActive, internal_eventEmitter, handleEvents]);

  const st = stateRef.current;
  return {
    value: st.value,
    cursor: st.cursor,
    hint: st.hint,
    cycle: st.cycle,
    search: st.search,
    setBuffer,
    insertAtCursor,
    pushHistory,
    setHint: (hint) => {
      stateRef.current = { ...stateRef.current, hint };
      rerender();
    },
  };
}