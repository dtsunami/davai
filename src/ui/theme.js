/**
 * Terminal capability detection and palette.
 *
 * Windows Terminal and the legacy conhost differ enough on glyph support that
 * guessing wrong leaves boxes of garbage on screen, so we probe rather than assume.
 */
import { execFileSync } from 'node:child_process';

const isWin = process.platform === 'win32';

/** Windows Terminal, VS Code and most modern emulators set these. */
const modernTerminal =
  Boolean(process.env.WT_SESSION) ||
  process.env.TERM_PROGRAM === 'vscode' ||
  process.env.TERM_PROGRAM === 'Windows_Terminal' ||
  !isWin;

export const glyphs = modernTerminal
  ? {
      bullet: '·',
      arrow: '→',
      check: '✓',
      cross: '✗',
      warn: '▲',
      bar: '█',
      barEmpty: '░',
      prompt: '❯',
      ellipsis: '…',
      pin: '•',
    }
  : {
      bullet: '-',
      arrow: '->',
      check: 'ok',
      cross: 'x',
      warn: '!',
      bar: '#',
      barEmpty: '.',
      prompt: '>',
      ellipsis: '...',
      pin: '*',
    };

export const colors = {
  dim: 'gray',
  accent: 'cyan',
  user: 'cyan',
  assistant: 'white',
  ok: 'green',
  warn: 'yellow',
  err: 'red',
  op: 'magenta',
  artifact: 'blue',
};

/** Colour for a context-usage percentage. */
export function usageColor(pct) {
  if (pct >= 85) return colors.err;
  if (pct >= 65) return colors.warn;
  return colors.ok;
}

/** Draw a mini progress bar. */
export function bar(fraction, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return glyphs.bar.repeat(filled) + glyphs.barEmpty.repeat(width - filled);
}

/** Put the Windows console into a state where VT and UTF-8 both work. */
export function prepareTerminal() {
  if (!isWin) return;
  try {
    // Node enables VT on modern Windows automatically; the codepage is the part
    // that still bites, and only for the legacy console host.
    if (!process.env.WT_SESSION && process.stdout.isTTY) {
      execFileSync('chcp.com', ['65001'], { stdio: 'ignore' });
    }
  } catch {
    /* cosmetic only */
  }
}

/**
 * `12.4s · 1.2k chars · 2 ops` — elapsed API time, characters streamed and ops run for
 * the request in flight. Thought characters are counted separately: they are streamed and
 * billed but never appear in the answer, so folding them into `chars` would overstate it.
 */
export function formatMeter({ ms, chars, thought, ops, tps, spark }) {
  const parts = [formatElapsed(ms)];
  if (chars) parts.push(`${countLabel(chars)} chars`);
  if (thought) parts.push(`${countLabel(thought)} thought`);
  if (tps != null && tps > 0) {
    parts.push(`${tps.toFixed(1)} tok/s${spark ? ` ${spark}` : ''}`);
  }
  if (ops) parts.push(`${ops} op${ops === 1 ? '' : 's'}`);
  return parts.join(` ${glyphs.bullet} `);
}

function formatElapsed(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

function countLabel(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** "~" marks a figure computed from FALLBACK_PRICE rather than real pricing. */
export function formatCost(cost, unknown, estimated = false) {
  if (unknown || cost == null) return 'cost n/a';
  const sign = estimated ? '~$' : '$';
  if (cost < 0.01) return `${sign}${cost.toFixed(4)}`;
  return `${sign}${cost.toFixed(2)}`;
}

export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Slice a UTF-16 string without splitting a surrogate pair at the boundary.
 * @param {string} s
 * @param {number} max
 */
export function safeSlice(s, max) {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return s.slice(0, Math.max(0, end));
}

// eslint-disable-next-line no-control-regex
const ANSI_SEQ = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CTRL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE = /(?<![\ud800-\udbff])[\udc00-\udfff]|[\ud800-\udbff](?![\udc00-\udfff])/g;

/**
 * Make one line safe for Ink / terminal rendering:
 * - strips raw ANSI/CSI/OSC sequences so file contents cannot mutate terminal state
 * - expands `\t` to spaces (`string-width` scores `\t` as 0 cols while terminals jump
 *   up to 8, which causes uncounted line wraps and smears Ink's dynamic region)
 * - strips `\r` and C0/C1 control characters
 * - replaces lone UTF-16 surrogates with `?`
 */
export function sanitizeTerminalLine(s) {
  return String(s ?? '')
    .replace(ANSI_SEQ, '')
    .replace(/\r/g, '')
    .replace(/\t/g, '  ')
    .replace(CTRL_CHARS, '')
    .replace(LONE_SURROGATE, '?');
}

/** Sanitize multi-line text while preserving `\n` breaks. */
export function sanitizeTerminalText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(sanitizeTerminalLine)
    .join('\n');
}

/** Flatten arbitrary text onto a single sanitized, width-capped line. */
export function truncateInline(s, maxCols = 80) {
  const flat = sanitizeTerminalLine(String(s ?? '').replace(/[\r\n]+/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= maxCols) return flat;
  const keep = Math.max(1, maxCols - glyphs.ellipsis.length);
  return `${safeSlice(flat, keep)}${glyphs.ellipsis}`;
}

/**
 * Bound a multi-line `tx` code/output string in BOTH dimensions (line count AND columns).
 *
 * `JSON.stringify(obj, null, 2)` escapes entire multi-kilobyte file contents onto single
 * lines (`"path.py": "...55,000 chars..."`). Splitting on `\n` and taking `.slice(0, 8)`
 * without a column cap dumped all 64KB into Ink `<Text>`, wrapping into hundreds of rows
 * and overflowing `TxPane` past `stdout.rows`.
 *
 * @param {string} raw
 * @param {{maxLines?: number, maxCols?: number}} [opts]
 */
export function formatPreviewBlock(raw, { maxLines = 8, maxCols = 80 } = {}) {
  const str = String(raw ?? '').replace(/\r\n?/g, '\n');
  const rawLines = str.split('\n');
  const cols = Math.max(16, maxCols);
  let clippedCols = false;
  const lines = rawLines.slice(0, maxLines).map((line) => {
    const clean = sanitizeTerminalLine(line);
    if (clean.length <= cols) return clean;
    clippedCols = true;
    const keep = Math.max(1, cols - glyphs.ellipsis.length);
    return `${safeSlice(clean, keep)}${glyphs.ellipsis}`;
  });
  const hiddenLines = Math.max(0, rawLines.length - maxLines);
  return {
    lines,
    totalLines: rawLines.length,
    totalChars: str.length,
    hiddenLines,
    clippedCols,
    truncated: hiddenLines > 0 || clippedCols,
  };
}
