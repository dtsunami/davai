/**
 * Numbered paste store (req 14).
 *
 * Multi-line pastes are stored and replaced in the input buffer with a placeholder;
 * on submit each placeholder expands into its own context segment, so it is
 * individually droppable in the context pane. Single-line pastes go in literally.
 */

const PLACEHOLDER = /\[\[paste#(\d+)(?::[^\]]*)?\]\]/g;

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
    const trimmed = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
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
