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
export function formatMeter({ ms, chars, thought, ops }) {
  const parts = [formatElapsed(ms)];
  if (chars) parts.push(`${countLabel(chars)} chars`);
  if (thought) parts.push(`${countLabel(thought)} thought`);
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
