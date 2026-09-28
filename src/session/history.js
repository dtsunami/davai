/**
 * Persistent prompt history ($DAVAI_HOME/history.jsonl).
 *
 * Distinct from the composer's up-arrow buffer, which lives and dies with the process.
 * This is the record of what you asked, across sessions and across directories, so a
 * prompt worth writing once can be replayed instead of retyped.
 *
 * JSONL rather than plain lines because prompts are routinely multi-line: a pasted
 * stack trace in a plain-text history would be indistinguishable from four prompts.
 *
 * Only real prompts are recorded. Slash commands and `sh` lines are operating the tool
 * rather than asking it something, and replaying them is either a no-op or a surprise.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LIMIT = 500;

export class PromptHistory {
  /** @param {{home: string, cwd?: string, limit?: number}} opts */
  constructor({ home, cwd, limit = DEFAULT_LIMIT }) {
    this.file = path.join(home, 'history.jsonl');
    this.cwd = cwd;
    this.limit = limit;
    /** @type {{text: string, at: string, cwd?: string}[]} oldest first */
    this.entries = this.#read();
  }

  #read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return []; // no history yet is the normal first run
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.text === 'string' && entry.text) out.push(entry);
      } catch {
        // A truncated final line after a hard kill. Skipping beats refusing to start.
      }
    }
    return out.slice(-this.limit);
  }

  /**
   * Record a prompt. Consecutive duplicates collapse: re-running the same thing twice
   * is common and two identical rows help nobody.
   * @param {string} text
   */
  add(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    if (this.entries.at(-1)?.text === trimmed) return null;

    const entry = { text: trimmed, at: new Date().toISOString(), ...(this.cwd ? { cwd: this.cwd } : {}) };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries = this.entries.slice(-this.limit);
    this.#write();
    return entry;
  }

  #write() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Rewritten whole rather than appended: the file is capped at `limit` lines, so
      // this stays cheap, and it is the only way to enforce the cap at all.
      fs.writeFileSync(this.file, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    } catch {
      // History is a convenience. Losing it must never take down the REPL.
    }
  }

  /** Every prompt, oldest first — what the composer seeds its up-arrow buffer from. */
  all() {
    return this.entries.map((e) => e.text);
  }

  /** The most recent `n`, oldest first, paired with the 1-based index `/replay` takes. */
  recent(n = 15) {
    const start = Math.max(0, this.entries.length - n);
    return this.entries.slice(start).map((e, i) => ({ ...e, n: start + i + 1 }));
  }

  /** @param {number} n 1-based, as shown by /history. Negative counts back from the end. */
  at(n) {
    const i = n < 0 ? this.entries.length + n : n - 1;
    return this.entries[i]?.text ?? null;
  }

  get length() {
    return this.entries.length;
  }
}
