/**
 * Session resume (req 6). `davai --resume [id]` rebuilds the ledger from a previous
 * session's transcript.
 *
 * The transcript is the resume format. The events the REPL already writes — user,
 * assistant, ops-result, operator-shell — are exactly the segments the ledger needs
 * back, so replay is a pure transform with no model call and no second on-disk format
 * to keep in sync.
 *
 * Three things deliberately do not come back:
 *   - pastes and images, which are not logged at all (the transcript would balloon)
 *   - operator shell output, which is logged only as a command and exit code
 *   - compaction, which is re-derived rather than replayed: compact() records prose
 *     actions, not the summary text, so a resumed ledger that lands over the threshold
 *     is compacted again on the next turn by the normal policy
 *
 * Resume starts a NEW session directory. The old transcript and journal are left
 * untouched, so an undo log never spans two processes.
 */
import fs from 'node:fs';
import { listSessions, readTranscript } from './log.js';

/** Fraction of the context limit a replayed conversation may occupy. */
const REPLAY_BUDGET = 0.5;

/**
 * Resolve a session by full id, unique id prefix, or (with no id) the most recent.
 * @param {string} home
 * @param {string} [id]
 * @returns {object|null} the session meta, plus `dir`
 */
export function findSession(home, id) {
  const rows = listSessions(home, 200);
  if (!rows.length) return null;
  if (!id || id === 'last') return rows[0];

  const exact = rows.find((s) => s.id === id);
  if (exact) return exact;

  const prefixed = rows.filter((s) => s.id.startsWith(id));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    throw new Error(
      `session id "${id}" is ambiguous: ${prefixed.map((s) => s.id).join(', ')}`,
    );
  }
  return null;
}

/**
 * Ledger-shaped segment specs from a session directory, oldest first.
 * @param {string} dir
 */
export function replaySegments(dir) {
  const specs = [];
  for (const ev of readTranscript(dir)) {
    switch (ev.type) {
      case 'user':
        if (ev.text) specs.push({ type: 'user', label: 'user', role: 'user', text: ev.text });
        break;

      case 'assistant':
        // The assistant text still carries its da_ops block verbatim, which is what
        // lets the model reason about the results that follow it.
        if (ev.text) {
          specs.push({ type: 'assistant', label: 'assistant', role: 'assistant', text: ev.text });
        }
        break;

      case 'ops-result':
        specs.push({
          type: 'op-result',
          label: ev.label || `batch ${ev.status || 'result'}`,
          role: 'user',
          text: ev.text || synthesizeResults(ev),
        });
        break;

      case 'operator-shell':
        specs.push({
          type: 'shell',
          label: `sh ${ev.cmd}`,
          role: 'user',
          text:
            `The operator ran a shell command in an earlier session:\n$ ${ev.cmd}\n` +
            `exit ${ev.exitCode}\n(output not retained in the session log)`,
        });
        break;

      default:
        break;
    }
  }
  return specs;
}

/**
 * Replay a session into a ledger. Must be called after `ledger.setSystem`, so the
 * budget accounts for the system prompt and grounding.
 *
 * @param {import('../context/ledger.js').Ledger} ledger
 * @param {{id: string, dir: string}} session
 * @returns {{id: string, turns: number, segments: number, omitted: number}}
 */
export function restoreLedger(ledger, session) {
  if (!fs.existsSync(session.dir)) {
    throw new Error(`session ${session.id} is no longer on disk at ${session.dir}`);
  }

  const specs = replaySegments(session.dir);
  const budget = Math.max(0, Math.floor(ledger.limit * REPLAY_BUDGET) - ledger.systemTokens);
  const kept = trimToBudget(specs, budget);

  if (kept.omitted) {
    ledger.add({
      type: 'summary',
      label: `${kept.omitted} earlier segment(s) omitted on resume`,
      role: 'user',
      text:
        `[resumed from session ${session.id}; the ${kept.omitted} oldest segment(s) ` +
        `did not fit the replay budget and were omitted. The full transcript is at ` +
        `${session.dir}.]`,
      pinned: true,
    });
  }
  for (const spec of kept.specs) ledger.add(spec);

  return {
    id: session.id,
    turns: kept.specs.filter((s) => s.type === 'user').length,
    segments: kept.specs.length,
    omitted: kept.omitted,
  };
}

/**
 * Keep the newest segments that fit. Op-results go first — they are re-derivable by
 * re-reading the file, which is the same reasoning auto-compaction uses.
 */
function trimToBudget(specs, budget) {
  const sized = specs.map((s) => ({ spec: s, tokens: roughTokens(s) }));
  let total = sized.reduce((n, s) => n + s.tokens, 0);
  const dropped = new Set();

  for (const pass of [(s) => s.spec.type === 'op-result', () => true]) {
    for (const s of sized) {
      if (total <= budget) break;
      if (dropped.has(s) || !pass(s)) continue;
      dropped.add(s);
      total -= s.tokens;
    }
  }

  return {
    specs: sized.filter((s) => !dropped.has(s)).map((s) => s.spec),
    omitted: dropped.size,
  };
}

/** Cheap standalone estimate — the ledger's own estimator needs a built segment. */
function roughTokens(spec) {
  return Math.ceil((spec.text?.length || 0) / 4);
}

/** Older transcripts logged per-op status but not the formatted result text. */
function synthesizeResults(ev) {
  const lines = [`Batch ${ev.status || 'result'} (reconstructed on resume).`];
  for (const r of ev.results || []) {
    lines.push(`  [${r.index}] ${r.op}: ${r.ok ? 'ok' : 'failed'}`);
  }
  for (const e of ev.errors || []) {
    lines.push(`  ! [${e.index}] ${e.op}: ${e.message}`);
  }
  return lines.join('\n');
}
