/**
 * The agents file: operator-authored standing instructions, multiplexed into grounding.
 *
 * Three things were wrong with the previous inline version in grounding.js:
 *
 *   1. It first-matched over ['DAVAI.md', 'AGENTS.md', 'CLAUDE.md'] in the working
 *      directory. A home-level file (how I want code written, everywhere) and a project
 *      file (what this repo does) are different documents, and the project one silently
 *      suppressed the home one. They are concatenated now, home first.
 *   2. It had no env var, so the one piece of the prompt the operator actually authors
 *      was the only piece with no configuration.
 *   3. It cut the text at a hard-coded 8000 characters with no warning. On this repo
 *      that discarded 42% of DAVAI.md mid-sentence, and nothing anywhere said so.
 *
 * On the third: the agents file is 88% of grounding and ~63% of the whole system prompt
 * in a typical project, so it is the only part worth bounding at all. But the bound is
 * the easy half. The important half is that **the model can read the file itself** — it
 * is a path in the working directory and `read` is the first op in the protocol. So a
 * truncation that names the path and says what was cut costs a round trip; a silent one
 * costs instructions nobody knows are missing. That asymmetry is the whole design here.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Searched in the working directory when DAVAI_AGENTS_MD is not set. First match wins. */
export const PROJECT_AGENTS_NAMES = ['AGENTS.md', 'DAVAI.md', 'CLAUDE.md'];

/** The home-level file, which applies to every project. Always in addition, never instead. */
export const HOME_AGENTS_NAME = 'AGENTS.md';

/**
 * Default budget, in estimated tokens, for all agents files combined.
 *
 * Sized against what it displaces rather than picked round: the built-in preamble and
 * protocol together are ~1200 tokens, and an operator's standing instructions earning
 * several times that is reasonable. Clamped to a fraction of the context window below,
 * because 6000 tokens is generous at 200k and absurd at 8k.
 */
export const DEFAULT_AGENTS_BUDGET = 6000;

/** No agents file may take more than this share of the context window. */
const MAX_CONTEXT_SHARE = 0.08;

/** Rough chars-per-token for prose; see context/tokens.js for the real estimator. */
const CHARS_PER_TOKEN = 3.8;

/**
 * Resolve the budget in characters.
 * @param {{agentsBudget?: number, contextLimit?: number}} cfg
 */
export function agentsBudget(cfg = {}) {
  const limit = cfg.contextLimit || 0;
  const ceiling = limit ? Math.floor(limit * MAX_CONTEXT_SHARE) : Infinity;
  const asked = cfg.agentsBudget ?? DEFAULT_AGENTS_BUDGET;
  return Math.max(1, Math.min(asked, ceiling));
}

/**
 * Which files to read, in prompt order.
 *
 * `DAVAI_AGENTS_MD` replaces the search rather than extending it, matching
 * DAVAI_RO_DIRS: a path list is already an explicit statement of intent, and an
 * explicit setting that still picks up surprise files is worse than one that does not.
 *
 * @param {{home?: string, cwd?: string, agentsFiles?: string[]}} cfg
 * @returns {{path: string, source: 'env'|'home'|'project'}[]}
 */
export function agentsFiles(cfg = {}) {
  if (cfg.agentsFiles?.length) {
    return cfg.agentsFiles.map((p) => ({
      path: path.resolve(cfg.cwd || process.cwd(), p),
      source: 'env',
    }));
  }

  const out = [];
  if (cfg.home) {
    const p = path.join(cfg.home, HOME_AGENTS_NAME);
    if (fs.existsSync(p)) out.push({ path: p, source: 'home' });
  }
  if (cfg.cwd) {
    for (const name of PROJECT_AGENTS_NAMES) {
      const p = path.join(cfg.cwd, name);
      if (fs.existsSync(p)) {
        // Home and project may resolve to the same file when $DAVAI_HOME is the project.
        if (!out.some((e) => e.path === p)) out.push({ path: p, source: 'project' });
        break;
      }
    }
  }
  return out;
}

/**
 * Cut at a structural boundary and say so.
 *
 * Markdown headings, because stopping mid-sentence produces text that reads as complete
 * and is not — which is precisely how the old 8000-char slice hid itself. A heading is
 * the one place a reader (human or model) can tell something follows.
 *
 * @returns {{text: string, truncated: boolean, keptChars: number}}
 */
export function clip(text, maxChars, displayPath) {
  if (text.length <= maxChars) return { text, truncated: false, keptChars: text.length };

  const head = text.slice(0, maxChars);
  // Prefer the last heading that fits, but not one so early that most of the budget is
  // thrown away — a single enormous section should be cut mid-section rather than
  // dropped entirely.
  const lastHeading = head.lastIndexOf('\n#');
  const cut = lastHeading > maxChars * 0.5 ? lastHeading : head.lastIndexOf('\n\n');
  const keep = text.slice(0, cut > 0 ? cut : maxChars).trimEnd();

  const remaining = text.length - keep.length;
  return {
    text:
      `${keep}\n\n` +
      `[This file continues for a further ${remaining.toLocaleString()} characters, ` +
      `which did not fit the grounding budget. The full text is on disk at ` +
      `${displayPath} — read it if you need the rest.]`,
    truncated: true,
    keptChars: keep.length,
  };
}

/**
 * Read and assemble every agents file.
 *
 * @param {{home?: string, cwd?: string, agentsFiles?: string[], agentsBudget?: number,
 *          contextLimit?: number}} cfg
 * @returns {{sections: {path: string, source: string, text: string, truncated: boolean,
 *            bytes: number}[], notices: string[]}}
 */
export function resolveAgents(cfg = {}) {
  const wanted = agentsFiles(cfg);
  const budgetChars = Math.floor(agentsBudget(cfg) * CHARS_PER_TOKEN);
  const sections = [];
  const notices = [];
  let spent = 0;

  for (const entry of wanted) {
    let raw;
    try {
      raw = fs.readFileSync(entry.path, 'utf8').trim();
    } catch (err) {
      // An explicitly configured file that cannot be read is worth saying out loud; a
      // conventional one that happens not to exist is not. agentsFiles() only returns
      // paths it has already seen for home/project, so this is the env case.
      if (entry.source === 'env') {
        notices.push(`DAVAI_AGENTS_MD: ${entry.path} could not be read (${err.code || err.message})`);
      }
      continue;
    }
    if (!raw) continue;

    const room = budgetChars - spent;
    if (room <= 0) {
      notices.push(
        `${entry.path} was not included: the agents budget (${agentsBudget(cfg).toLocaleString()} ` +
          `tokens) was already spent by earlier files. Raise DAVAI_AGENTS_BUDGET or shorten them.`,
      );
      continue;
    }

    const { text, truncated, keptChars } = clip(raw, room, entry.path);
    if (truncated) {
      notices.push(
        `${entry.path} is ${raw.length.toLocaleString()} characters and was clipped to ` +
          `${keptChars.toLocaleString()} for the system prompt (budget ` +
          `${agentsBudget(cfg).toLocaleString()} tokens). The model is told where to read the rest; ` +
          `raise DAVAI_AGENTS_BUDGET to include more of it.`,
      );
    }
    spent += text.length;
    sections.push({ path: entry.path, source: entry.source, text, truncated, bytes: raw.length });
  }

  return { sections, notices };
}

/** Render the resolved sections as grounding markdown. */
export function renderAgents(sections) {
  const out = [];
  for (const s of sections) {
    out.push('');
    out.push(`## Project instructions (from ${s.path})`);
    out.push(s.text);
  }
  return out;
}