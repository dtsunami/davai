/**
 * Numbered paste store (req 14).
 *
 * Multi-line pastes are stored and replaced in the input buffer with a placeholder;
 * on submit each placeholder expands into its own context segment, so it is
 * individually droppable in the context pane. Single-line pastes go in literally.
 */

const PLACEHOLDER = /\[\[paste#(\d+)(?::[^\]]*)?\]\]/g;

/**
 * Does this input chunk look pasted rather than typed?
 *
 * The separator test has to accept a bare CR. Windows terminals send Enter as "\r", so a
 * multi-line paste in Windows Terminal or the legacy console arrives as one burst with no
 * "\n" in it at all. Ink hands that burst over as a single chunk with key.return unset,
 * so a newline-only test missed it entirely and the raw text — carriage returns and all —
 * was inserted into the line buffer instead of being stored as a paste.
 */
export function looksLikePaste(input) {
  return Boolean(input) && input.length > 1 && /[\r\n]/.test(input);
}

export class Pastes {
  constructor() {
    this.items = new Map();
    this.n = 0;
  }

  /**
   * @returns {{placeholder: string, n: number}|null} null when the paste should be
   * inserted literally instead of stored.
   */
  capture(text) {
    // \r\n and a lone \r both normalize to \n — see looksLikePaste.
    const trimmed = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    const lines = trimmed.split('\n');
    if (lines.length <= 1) return null;

    const n = ++this.n;
    this.items.set(n, { n, text: trimmed, lines: lines.length, createdAt: Date.now() });
    return {
      n,
      placeholder: `[[paste#${n}: ${lines.length} lines]]`,
    };
  }

  get(n) {
    return this.items.get(Number(n));
  }

  /**
   * Split an input string into the prose (placeholders removed) and the pastes it
   * referenced, so the caller can add each as its own segment.
   * @returns {{text: string, referenced: {n:number,text:string,lines:number}[]}}
   */
  expand(input) {
    const referenced = [];
    const seen = new Set();
    const text = input.replace(PLACEHOLDER, (match, n) => {
      const item = this.get(n);
      if (!item) return match; // unknown id: leave it visible rather than silently dropping
      if (!seen.has(item.n)) {
        seen.add(item.n);
        referenced.push(item);
      }
      return `[paste#${item.n}]`;
    });
    return { text, referenced };
  }
}
