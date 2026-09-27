/**
 * Minimal markdown-to-ANSI rendering for streamed assistant text.
 *
 * Deliberately small: a full markdown engine in the hot path costs more than it
 * returns in a terminal. Handles the things models actually emit — fenced code,
 * inline code, bold, headings and list bullets.
 */
import { highlight, supportsLanguage } from 'cli-highlight';
import { glyphs } from './theme.js';

const ESC = '\u001b';
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;
const CYAN = `${ESC}[36m`;

/**
 * @param {string} text
 * @param {{width?: number, syntax?: boolean}} [opts]
 */
export function renderMarkdown(text, { syntax = true } = {}) {
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  let inFence = false;
  let fenceLang = '';
  let buffer = [];

  const flushFence = () => {
    const code = buffer.join('\n');
    buffer = [];
    if (syntax && fenceLang && supportsLanguage(fenceLang)) {
      try {
        out.push(highlight(code, { language: fenceLang, ignoreIllegals: true }));
        return;
      } catch {
        /* fall through to plain */
      }
    }
    out.push(DIM + code + RESET);
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      if (inFence) {
        flushFence();
        inFence = false;
        fenceLang = '';
      } else {
        inFence = true;
        fenceLang = fence[1] || '';
        out.push(DIM + '─'.repeat(3) + (fenceLang ? ` ${fenceLang} ` : ' ') + '─'.repeat(3) + RESET);
      }
      continue;
    }

    if (inFence) {
      buffer.push(line);
      continue;
    }

    out.push(inline(line));
  }

  if (inFence) flushFence();
  return out.join('\n');
}

function inline(line) {
  let s = line;

  // Headings
  const h = s.match(/^(#{1,6})\s+(.*)$/);
  if (h) return BOLD + CYAN + h[2] + RESET;

  // List bullets
  s = s.replace(/^(\s*)[-*]\s+/, (_, indent) => `${indent}${glyphs.bullet} `);

  // Inline code
  s = s.replace(/`([^`]+)`/g, (_, code) => CYAN + code + RESET);

  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => BOLD + t + RESET);

  return s;
}

/** Strip ANSI, for width calculations. */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}
