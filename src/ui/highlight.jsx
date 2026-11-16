/**
 * Live shell, slash-command, and prompt syntax highlighter + cursor renderer.
 *
 * Produces exact character-offset token spans rather than pre-baked ANSI strings, so
 * the inverse block cursor splits whichever span it sits on without ever corrupting
 * escape codes or disappearing on newline boundaries.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { colors, glyphs } from './theme.js';
import { knownSlashCommands } from './complete.js';
import {
  COMMAND_WRAPPERS,
  isKnownShellCommand,
  pathExistsCached,
} from './shell-env.js';

const SHELL_OPERATORS = [
  '2>&1', '&>>', '&>', '>>', '<<', '||', '&&', '|&', '|', ';', '&', '(', ')', '>', '<',
];
const SEGMENT_BREAK_OPS = new Set(['|', '||', '&&', '|&', ';', '&', '(']);

/**
 * Tokenize a shell command string into contiguous styled spans covering `[0, text.length)`.
 *
 * @param {string} text
 * @param {{sandbox?: object, cwd?: string, checkCommands?: boolean}} [opts]
 * @returns {Array<{start: number, end: number, color?: string, bold?: boolean, dim?: boolean, underline?: boolean}>}
 */
export function tokenizeShell(text, opts = {}) {
  const { sandbox, cwd, checkCommands = true } = opts;
  const spans = [];
  const n = text.length;
  let i = 0;
  let expectCommand = true;

  const push = (start, end, style = {}) => {
    if (end > start) spans.push({ start, end, ...style });
  };

  while (i < n) {
    const ch = text[i];

    // Whitespace (newlines reset command position).
    if (/\s/.test(ch)) {
      const start = i;
      let sawNewline = false;
      while (i < n && /\s/.test(text[i])) {
        if (text[i] === '\n') sawNewline = true;
        i++;
      }
      push(start, i);
      if (sawNewline) expectCommand = true;
      continue;
    }

    // Comment (`#` at start of command or after whitespace).
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      const start = i;
      while (i < n && text[i] !== '\n') i++;
      push(start, i, { color: colors.dim });
      continue;
    }

    // Numeric file-descriptor redirection like `2>` or `2>>`.
    const fdMatch = text.slice(i).match(/^[0-9]+(?:>>&?[0-9]*|>&?[0-9]*|<)/);
    if (fdMatch) {
      push(i, i + fdMatch[0].length, { color: colors.op, bold: true });
      i += fdMatch[0].length;
      continue;
    }

    // Shell operators (`&&`, `||`, `|`, `;`, redirections, subshell parens).
    const op = SHELL_OPERATORS.find((candidate) => text.startsWith(candidate, i));
    if (op) {
      push(i, i + op.length, { color: colors.op, bold: true });
      if (SEGMENT_BREAK_OPS.has(op)) expectCommand = true;
      i += op.length;
      continue;
    }

    // Single-quoted string: literal, red+underlined if unclosed.
    if (ch === "'") {
      const start = i++;
      while (i < n && text[i] !== "'") i++;
      if (i < n && text[i] === "'") {
        i++;
        push(start, i, { color: colors.warn });
      } else {
        push(start, i, { color: colors.err, underline: true });
      }
      expectCommand = false;
      continue;
    }

    // Double-quoted string: highlights `$VAR` / `${VAR}` expansions inside it.
    if (ch === '"') {
      const start = i++;
      let segStart = start;
      let closed = false;
      while (i < n) {
        if (text[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          closed = true;
          break;
        }
        if (text[i] === '$') {
          const varMatch = text.slice(i).match(/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_?0-9][A-Za-z0-9_]*)/);
          if (varMatch) {
            push(segStart, i, { color: colors.warn });
            push(i, i + varMatch[0].length, { color: colors.accent });
            i += varMatch[0].length;
            segStart = i;
            continue;
          }
        }
        i++;
      }
      push(segStart, i, closed ? { color: colors.warn } : { color: colors.err, underline: true });
      expectCommand = false;
      continue;
    }

    // Backtick command substitution.
    if (ch === '`') {
      const start = i++;
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\' && i + 1 < n) i += 2;
        else i++;
      }
      const closed = i < n && text[i] === '`';
      if (closed) i++;
      push(start, i, closed ? { color: colors.accent } : { color: colors.err, underline: true });
      expectCommand = false;
      continue;
    }

    // Scan a shell word (stops at whitespace, quotes, or operators unless escaped).
    const wordStart = i;
    while (i < n) {
      const c = text[i];
      if (c === '\\' && i + 1 < n) {
        i += 2;
        continue;
      }
      if (/\s/.test(c) || c === "'" || c === '"' || c === '`') break;
      if (SHELL_OPERATORS.some((cand) => text.startsWith(cand, i))) break;
      i++;
    }
    const wordEnd = i;
    const word = text.slice(wordStart, wordEnd);

    // Leading `VAR=value` environment assignment before a command.
    const envAssign = expectCommand ? word.match(/^([A-Za-z_][A-Za-z0-9_]*)(=)(.*)$/) : null;
    if (envAssign) {
      const kEnd = wordStart + envAssign[1].length;
      const eqEnd = kEnd + 1;
      push(wordStart, kEnd, { color: colors.accent });
      push(kEnd, eqEnd, { color: colors.dim });
      push(eqEnd, wordEnd, { color: colors.warn });
      continue;
    }

    if (expectCommand) {
      if (word === 'sudo') {
        push(wordStart, wordEnd, { color: colors.warn, bold: true });
        continue;
      }
      if (COMMAND_WRAPPERS.has(word)) {
        push(wordStart, wordEnd, { color: colors.ok, bold: true });
        continue;
      }
      // Flags given directly to a wrapper (`sudo -u`, `env -i`) keep command position alive.
      if (word.startsWith('-')) {
        push(wordStart, wordEnd, { color: colors.accent });
        continue;
      }
      const valid = !checkCommands || isKnownShellCommand(word, { sandbox, cwd });
      push(
        wordStart,
        wordEnd,
        valid ? { color: colors.ok, bold: true } : { color: colors.err },
      );
      expectCommand = false;
      continue;
    }

    // `$VAR`, `${VAR}`, or Windows `%VAR%`.
    if (/^\$(?:\{[^}]*\}|[A-Za-z_?0-9][A-Za-z0-9_]*)$/.test(word) || /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(word)) {
      push(wordStart, wordEnd, { color: colors.accent });
      continue;
    }

    // CLI flags (`-v`, `--model`, `--port=7878`).
    if (/^--?[A-Za-z0-9][\w-]*(?:=.*)?$/.test(word)) {
      const eq = word.indexOf('=');
      if (eq !== -1) {
        const flagEnd = wordStart + eq;
        const val = word.slice(eq + 1);
        push(wordStart, flagEnd, { color: colors.accent });
        push(flagEnd, flagEnd + 1, { color: colors.dim });
        const valExists = looksLikePathToken(val) && pathExistsCached(val, { sandbox, cwd });
        push(
          flagEnd + 1,
          wordEnd,
          valExists ? { color: colors.warn, underline: true } : { color: colors.warn },
        );
      } else {
        push(wordStart, wordEnd, { color: colors.accent });
      }
      continue;
    }

    // Underline arguments that resolve to real files/directories (fish-style feedback).
    if (looksLikePathToken(word) && pathExistsCached(word, { sandbox, cwd })) {
      push(wordStart, wordEnd, { underline: true });
      continue;
    }

    push(wordStart, wordEnd);
  }

  return spans;
}

function looksLikePathToken(word) {
  if (!word) return false;
  if (word.includes('/') || word.includes('\\') || word.startsWith('.')) return true;
  // Bare filenames with an extension (`package.json`, `App.jsx`).
  return /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(word);
}

/** Tokenize a REPL slash command (`/model anthropic --save`). */
function tokenizeSlash(text, { sandbox, cwd } = {}) {
  const spans = [];
  const push = (start, end, style = {}) => {
    if (end > start) spans.push({ start, end, ...style });
  };

  const firstSpace = text.search(/\s/);
  const cmdEnd = firstSpace === -1 ? text.length : firstSpace;
  const cmdToken = text.slice(0, cmdEnd);
  const commands = knownSlashCommands();

  const exact = commands.includes(cmdToken);
  const partialMatch = !exact && firstSpace === -1 && commands.some((c) => c.startsWith(cmdToken));
  push(
    0,
    cmdEnd,
    exact
      ? { color: colors.accent, bold: true }
      : partialMatch
        ? { color: colors.warn }
        : { color: colors.err },
  );

  let i = cmdEnd;
  const n = text.length;
  while (i < n) {
    if (/\s/.test(text[i])) {
      const s = i;
      while (i < n && /\s/.test(text[i])) i++;
      push(s, i);
      continue;
    }
    const s = i;
    while (i < n && !/\s/.test(text[i])) i++;
    const w = text.slice(s, i);
    if (w.startsWith('--')) {
      push(s, i, { color: colors.op });
    } else if (w.includes('=')) {
      const eq = w.indexOf('=');
      push(s, s + eq, { color: colors.accent });
      push(s + eq, s + eq + 1, { color: colors.dim });
      push(s + eq + 1, i, { color: colors.warn });
    } else if (looksLikePathToken(w) && pathExistsCached(w, { sandbox, cwd })) {
      push(s, i, { color: colors.accent, underline: true });
    } else {
      push(s, i, { color: colors.ok });
    }
  }
  return spans;
}

/** Tokenize a natural-language prompt (`@path/to/file`, `[[paste#1]]`, `` `code` ``). */
function tokenizePrompt(text, { sandbox, cwd } = {}) {
  const spans = [];
  const push = (start, end, style = {}) => {
    if (end > start) spans.push({ start, end, ...style });
  };

  const pattern = /(\[\[paste#\d+(?::[^\]]*)?\]\])|(`[^`\n]+`)|((?:^|(?<=\s))@\S+)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index;
    const full = m[0];
    const end = start + full.length;
    if (start > last) push(last, start);
    if (m[1]) {
      push(start, end, { color: colors.op });
    } else if (m[2]) {
      push(start, end, { color: colors.accent });
    } else if (m[3]) {
      const ref = full.slice(1);
      const exists = pathExistsCached(ref, { sandbox, cwd });
      push(start, end, { color: colors.accent, bold: true, underline: exists });
    }
    last = end;
  }
  if (last < text.length) push(last, text.length);
  return spans;
}

/** Tokenize a file path input (`ArtifactPane` `save as:`). */
function tokenizePathInput(text) {
  const slash = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  if (slash === -1) return text.length ? [{ start: 0, end: text.length, color: colors.accent }] : [];
  const spans = [{ start: 0, end: slash + 1, color: colors.dim }];
  if (slash + 1 < text.length) {
    spans.push({ start: slash + 1, end: text.length, color: colors.accent, bold: true });
  }
  return spans;
}

/**
 * Tokenize input according to editor mode.
 *
 * @param {string} text
 * @param {{mode?: 'composer'|'shell'|'path'|'plain', shellMode?: boolean, sandbox?: object, cwd?: string}} [opts]
 */
export function tokenizeInput(text, opts = {}) {
  if (!text) return [];
  const { mode = 'composer', shellMode = false, sandbox, cwd } = opts;

  if (mode === 'plain') return [{ start: 0, end: text.length }];
  if (mode === 'path') return tokenizePathInput(text);
  if (mode === 'shell' || shellMode) return tokenizeShell(text, { sandbox, cwd });

  if (text === 'sh' || text.startsWith('sh ')) {
    const head = [{ start: 0, end: 2, color: colors.warn, bold: true }];
    if (text.length === 2) return head;
    const rest = tokenizeShell(text.slice(2), { sandbox, cwd }).map((s) => ({
      ...s,
      start: s.start + 2,
      end: s.end + 2,
    }));
    return [...head, ...rest];
  }

  if (text === 'tx' || /^tx[\s\n]/.test(text)) {
    const head = [{ start: 0, end: 2, color: colors.op, bold: true }];
    if (text.length === 2) return head;
    return [...head, { start: 2, end: text.length, color: colors.accent }];
  }

  if (text.startsWith('/')) return tokenizeSlash(text, { sandbox, cwd });
  return tokenizePrompt(text, { sandbox, cwd });
}

/** Render one `[lineStart, lineEnd]` slice of `text` with syntax spans and optional cursor. */
function renderLineSpans(text, spans, lineStart, lineEnd, cursor, hideCursor) {
  const cursorInLine =
    !hideCursor && cursor >= lineStart && cursor <= lineEnd ? cursor : -1;

  const lineSpans = spans
    .filter((s) => s.end > lineStart && s.start < lineEnd)
    .map((s) => ({
      ...s,
      start: Math.max(s.start, lineStart),
      end: Math.min(s.end, lineEnd),
    }));

  const parts = [];
  let key = 0;

  for (const s of lineSpans) {
    const props = {
      ...(s.color ? { color: s.color } : {}),
      ...(s.bold ? { bold: true } : {}),
      ...(s.dim ? { dimColor: true } : {}),
      ...(s.underline ? { underline: true } : {}),
    };
    if (cursorInLine >= s.start && cursorInLine < s.end) {
      // If cursor sits on a high surrogate, invert the whole astral code point.
      const code = text.charCodeAt(cursorInLine);
      const step =
        code >= 0xd800 && code <= 0xdbff && cursorInLine + 1 < s.end ? 2 : 1;
      const before = text.slice(s.start, cursorInLine);
      const at = text.slice(cursorInLine, cursorInLine + step);
      const after = text.slice(cursorInLine + step, s.end);
      if (before) parts.push(<Text key={key++} {...props}>{before}</Text>);
      parts.push(<Text key={key++} {...props} inverse>{at}</Text>);
      if (after) parts.push(<Text key={key++} {...props}>{after}</Text>);
    } else {
      parts.push(<Text key={key++} {...props}>{text.slice(s.start, s.end)}</Text>);
    }
  }

  if (cursorInLine === lineEnd) {
    parts.push(<Text key={key++} inverse> </Text>);
  }

  return parts;
}

/**
 * Render syntax-highlighted text (with or without a live block cursor).
 * Supports both single-line and multiline buffers with aligned continuation prompts.
 */
export function HighlightedInput({
  value,
  cursor = 0,
  hideCursor = false,
  mode = 'composer',
  shellMode = false,
  sandbox,
  cwd,
  prefix = null,
  continuationPrefix = `${glyphs.bullet} `,
}) {
  const spans = tokenizeInput(value, { mode, shellMode, sandbox, cwd });

  if (!value.includes('\n')) {
    return (
      <Box>
        {prefix}
        <Text>{renderLineSpans(value, spans, 0, value.length, cursor, hideCursor)}</Text>
      </Box>
    );
  }

  const lines = [];
  let pos = 0;
  for (const rawLine of value.split('\n')) {
    lines.push({ start: pos, end: pos + rawLine.length });
    pos += rawLine.length + 1;
  }

  return (
    <Box flexDirection="column">
      {lines.map((ln, idx) => (
        <Box key={idx}>
          {idx === 0 ? prefix : <Text color={colors.dim}>{continuationPrefix}</Text>}
          <Text>
            {renderLineSpans(value, spans, ln.start, ln.end, cursor, hideCursor)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}