/**
 * Auto-compaction (req 12).
 *
 * Order matters, and it is not arbitrary:
 *   1. evict unpinned op-results, oldest first — they are the largest consumers and
 *      are re-derivable by re-reading the file
 *   2. summarize shell and paste segments
 *   3. summarize the oldest user/assistant pairs with the cheap model
 *   4. never touch grounding or the last N turns
 *
 * Compaction is append-only with respect to the cached prefix: the system prompt and
 * grounding are never rewritten, because doing so would invalidate the prompt cache
 * and cost more than the compaction saves.
 */
import { SUMMARIZER_MODEL } from '../config/models.js';

const KEEP_RECENT_TURNS = 3;

/**
 * @param {import('./ledger.js').Ledger} ledger
 * @param {{cfg: object, makeProvider: (model: string) => any, onEvent?: Function}} deps
 * @returns {Promise<{freed: number, actions: string[]}>}
 */
export async function compact(ledger, { cfg, makeProvider, onEvent }) {
  const before = ledger.tokens;
  const actions = [];
  const target = Math.floor(ledger.limit * (ledger.compactAt - 0.15));

  const recentIds = new Set(recentTurnIds(ledger));
  const currentIds = new Set(currentExchangeIds(ledger));
  const evictable = (s) =>
    !s.pinned && s.type !== 'grounding' && !recentIds.has(s.id);

  // --- 1. drop op-results, oldest first ---
  // Op-results are re-derivable by re-reading the file, so they only need
  // protecting for the exchange in flight — applying the full recent-turns window
  // here would leave the largest consumers untouchable in a short session, which is
  // exactly when compaction matters most.
  for (const s of [...ledger.segments].sort((a, b) => a.createdAt - b.createdAt)) {
    if (ledger.tokens <= target) break;
    if (s.type === 'op-result' && !s.pinned && !currentIds.has(s.id)) {
      ledger.drop(s.id);
      actions.push(`dropped op-result #${s.id} (${s.label}, ~${s.tokens} tok)`);
    }
  }

  // --- 2. truncate shell and paste segments ---
  for (const s of [...ledger.segments].sort((a, b) => a.createdAt - b.createdAt)) {
    if (ledger.tokens <= target) break;
    if ((s.type === 'shell' || s.type === 'paste') && evictable(s) && s.part.type === 'text') {
      const head = s.part.text.split('\n').slice(0, 6).join('\n');
      if (head.length < s.part.text.length) {
        const saved = s.tokens;
        s.part.text = `${head}\n… [${s.type} #${s.id} truncated by auto-compact; full text is in the session log]`;
        s.tokens = Math.ceil(s.tokens * (head.length / s.part.text.length)) || 1;
        actions.push(`truncated ${s.type} #${s.id} (~${saved - s.tokens} tok)`);
      }
    }
  }

  // --- 3. summarize the oldest conversation turns ---
  if (ledger.tokens > target) {
    const old = ledger.segments.filter(
      (s) => (s.type === 'user' || s.type === 'assistant') && evictable(s),
    );
    if (old.length >= 2) {
      const transcript = old
        .filter((s) => s.part.type === 'text')
        .map((s) => `${s.role.toUpperCase()}: ${s.part.text}`)
        .join('\n\n');

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
        : `[${freedIds.length} earlier turns dropped by auto-compact; see the session log]`;
      const seg = ledger.add({
        type: 'summary',
        label: `summary of ${freedIds.length} earlier turns`,
        role: 'user',
        text,
        pinned: true,
      });
      // Put the summary where the turns it replaces used to be.
      const at = ledger.segments.findIndex((s) => s.id === seg.id);
      if (anchor >= 0 && at >= 0) {
        ledger.segments.splice(anchor, 0, ledger.segments.splice(at, 1)[0]);
      }
      actions.push(`summarized ${freedIds.length} turns into #${seg.id}`);
    }
  }

  const freed = before - ledger.tokens;
  return { freed, actions };
}

/** Segments belonging to the last KEEP_RECENT_TURNS operator exchanges. */
function recentTurnIds(ledger) {
  const ids = [];
  let turns = 0;
  for (let i = ledger.segments.length - 1; i >= 0 && turns < KEEP_RECENT_TURNS; i--) {
    const s = ledger.segments[i];
    ids.push(s.id);
    if (s.type === 'user') turns++;
  }
  return ids;
}

/** Segments added since the most recent operator message — the exchange in flight. */
function currentExchangeIds(ledger) {
  const ids = [];
  for (let i = ledger.segments.length - 1; i >= 0; i--) {
    const s = ledger.segments[i];
    ids.push(s.id);
    if (s.type === 'user') break;
  }
  return ids;
}

async function summarize(transcript, { cfg, makeProvider }) {
  const model = SUMMARIZER_MODEL[cfg.provider];
  const provider = makeProvider(model);
  const system =
    'You compress engineering conversations. Produce a dense factual summary: ' +
    'decisions made, files changed and how, commands run and their outcome, and any ' +
    'open problems. Keep file paths and identifiers exact. No preamble, no advice.';

  let out = '';
  for await (const ev of provider.send({
    system,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `Summarize:\n\n${transcript}` }],
      },
    ],
  })) {
    if (ev.t === 'text') out += ev.delta;
  }
  return out.trim();
}
