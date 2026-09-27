/**
 * Terminal capability detection and palette.
 *
 * Windows Terminal and the legacy conhost differ enough on glyph support that
 * guessing wrong leaves boxes of garbage on screen, so we probe rather than assume.
 */

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
      const { execFileSync } = require('node:child_process');
      execFileSync('chcp.com', ['65001'], { stdio: 'ignore' });
    }
  } catch {
    /* cosmetic only */
  }
}

export function formatCost(cost, unknown) {
  if (unknown || cost == null) return 'cost n/a';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
