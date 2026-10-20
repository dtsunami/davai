/**
 * Manual context management actions — the interactive counterpart to the auto-compactor.
 *
 * Auto-compaction is policy: it decides what to evict, truncate and summarize. These
 * helpers are the operator's own hands: drop/pin are direct ledger calls, summarize
 * selects specific segments and collapses them into one summary segment with the same
 * cheap model the auto-compactor uses. The server routes call these, so the web UI and
 * any future REPL commands share one implementation.
 */
import { summarize } from './compact.js';

/** @param {import('./ledger.js').Ledger} ledger @param {number} id */
export function dropSegment(ledger, id) {
  const n = Number(id);
  if (!Number.isInteger(n)) return false;
  return ledger.drop(n);
}

/** @param {import('./ledger.js').Ledger} ledger @param {number} id @param {boolean} value */
export function pinSegment(ledger, id, value) {
  const n = Number(id);
  if (!Number.isInteger(n)) return false;
  return ledger.pin(n, Boolean(value));
}

/**
 * Summarize the given segments into one pinned summary segment placed where the oldest
 * selected segment sat. Only text user/assistant segments are eligible; anything else is
 * silently skipped.
 *
 * @param {import('./ledger.js').Ledger} ledger
 * @param {number[]} ids
 * @param {{cfg: object, makeProvider: (model: string) => any, onEvent?: Function}} deps
 * @returns {Promise<{freed: number, actions: string[]}>}
 */
export async function summarizeSegments(ledger, ids, { cfg, makeProvider, onEvent }) {
  const before = ledger.tokens;
  const actions = [];

  const selected = [...new Set(ids.map(Number))]
    .map((id) => ledger.get(id))
    .filter(Boolean);

  const old = selected.filter(
    (s) =>
      (s.type === 'user' || s.type === 'assistant') &&
      s.part.type === 'text' &&
      !s.pinned &&
      s.type !== 'grounding',
  );
  if (!old.length) throw new Error('no summarizable segments selected');

  const transcript = old.map((s) => `${s.role.toUpperCase()}: ${s.part.text}`).join('\n\n');

  let summary = null;
  try {
    summary = await summarize(transcript, { cfg, makeProvider });
  } catch (err) {
    onEvent?.({ type: 'compact-warning', message: `summarizer failed: ${err.message}` });
  }

  const freedIds = old.map((s) => s.id);
  const anchor = ledger.segments.findIndex((s) => s.id === freedIds[0]);
  for (const id of freedIds) ledger.drop(id);

  const text = summary
    ? `[earlier conversation, summarized]\n${summary}`
    : `[${freedIds.length} segments dropped; see the session log]`;
  const seg = ledger.add({
    type: 'summary',
    label: `summary of ${freedIds.length} segments`,
    role: 'user',
    text,
    pinned: true,
  });
  // Put the summary where the turns it replaces used to be.
  const at = ledger.segments.findIndex((s) => s.id === seg.id);
  if (anchor >= 0 && at >= 0 && anchor !== at) {
    ledger.segments.splice(anchor, 0, ledger.segments.splice(at, 1)[0]);
  }

  actions.push(`summarized ${freedIds.length} segments into #${seg.id}`);
  return { freed: before - ledger.tokens, actions };
}

/**
 * Run the same compaction policy the harness uses at the auto-compact threshold.
 * @param {import('./ledger.js').Ledger} ledger
 * @param {{cfg: object, makeProvider: (model: string) => any, onEvent?: Function}} deps
 */
export async function runCompact(ledger, deps) {
  const { compact } = await import('./compact.js');
  return compact(ledger, deps);
}