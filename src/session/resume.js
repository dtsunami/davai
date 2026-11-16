/**
 * Session resume (req 6). `davai --resume [id]` rebuilds the ledger from a previous
 * session's transcript and `meta.json`.
 *
 * The transcript is the resume format: user turns, steers, assistant turns, pastes,
 * media attachment references, op-results, operator shell commands, context clears,
 * and compaction summaries all replay in order. File-backed images and videos reload
 * from disk when still readable (and degrade to a text note when moved/deleted or when
 * the resumed model lacks vision/video), so `transcript.jsonl` stays compact without
 * losing attachments or leaving dangling `[image: ...]` placeholders.
 *
 * `meta.json` also carries the prior session's `TokenCalibrator` ratio + sample count,
 * so the resumed ledger reports calibrated token usage immediately on turn 0.
 *
 * Resume starts a NEW session directory. The old transcript and journal are left
 * untouched, so an undo log never spans two processes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listSessions, readTranscript } from './log.js';
import { DEFAULT_PROMPTS, steerPrompt } from '../agent/prompt.js';
import { estimate } from '../context/tokens.js';
import { loadImage } from '../context/images.js';
import { loadVideo, youtubeRef } from '../context/video.js';

/** Fraction of the context limit a replayed conversation may occupy by default. */
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
 * @param {{sandbox?: any, model?: object, prompts?: object}} [opts]
 */
export function replaySegments(dir, opts = {}) {
  const { sandbox = null, model = null, prompts = DEFAULT_PROMPTS } = opts;
  const specs = [];
  let pendingOps = null;

  const flushInterruptedOps = () => {
    if (!pendingOps) return;
    const ops = pendingOps;
    pendingOps = null;
    specs.push({
      type: 'op-result',
      label: 'batch interrupted',
      role: 'user',
      text: synthesizeInterruptedOps(ops),
    });
  };

  for (const ev of readTranscript(dir)) {
    switch (ev.type) {
      case 'user':
        flushInterruptedOps();
        if (ev.text) {
          specs.push({
            type: 'user',
            label: firstLine(ev.text) || 'user',
            role: 'user',
            text: ev.text,
          });
        }
        break;

      case 'steer':
        flushInterruptedOps();
        if (ev.text) {
          specs.push({
            type: 'user',
            label: `steer: ${firstLine(ev.text)}`,
            role: 'user',
            text: steerPrompt(ev.text, prompts),
          });
        }
        break;

      case 'paste':
        if (ev.text) {
          specs.push({
            type: 'paste',
            label: ev.label || 'paste',
            role: 'user',
            text: ev.text,
          });
        }
        break;

      case 'attachment': {
        const seg = restoreAttachment(ev, { sandbox, model });
        if (seg) specs.push(seg);
        break;
      }

      case 'assistant':
        flushInterruptedOps();
        // The assistant text still carries its da_ops block verbatim, which is what
        // lets the model reason about the results that follow it.
        if (ev.text) {
          specs.push({
            type: 'assistant',
            label: 'assistant',
            role: 'assistant',
            text: ev.text,
            ...(ev.thinking ? { thinking: ev.thinking } : {}),
          });
        }
        break;

      case 'ops':
        if (Array.isArray(ev.ops) && ev.ops.length) pendingOps = ev.ops;
        break;

      case 'ops-result':
        pendingOps = null;
        specs.push({
          type: 'op-result',
          label: ev.label || `batch ${ev.status || 'result'}`,
          role: 'user',
          text: ev.text || synthesizeResults(ev),
        });
        break;

      case 'native-calls':
        // A batch that arrived as a native tool call is not in the logged assistant
        // text. Its fenced equivalent is logged here; put it back on the turn it came
        // from, so the results that follow answer a request the model can see.
        if (ev.block) {
          const last = specs.at(-1);
          if (last?.type === 'assistant') last.text = `${last.text}\n\n${ev.block}`;
          else specs.push({ type: 'assistant', label: 'assistant', role: 'assistant', text: ev.block });
        }
        break;

      case 'operator-shell':
        if (ev.notRun) {
          specs.push({
            type: 'shell',
            label: `sh ${ev.cmd} (not run)`,
            role: 'user',
            text: `The operator tried to run a shell command in an earlier session, but it was not run:\n$ ${ev.cmd}\n${ev.notRun}`,
          });
        } else {
          specs.push({
            type: 'shell',
            label: `sh ${ev.cmd}`,
            role: 'user',
            text:
              `The operator ran a shell command in an earlier session:\n$ ${ev.cmd}\n` +
              `exit ${ev.exitCode}\n(output not retained in the session log)`,
          });
        }
        break;

      case 'context-clear':
        pendingOps = null;
        specs.length = 0;
        break;

      case 'compact':
        applyReplayedCompact(specs, ev);
        break;

      default:
        break;
    }
  }
  flushInterruptedOps();
  return specs;
}

function firstLine(text) {
  if (!text) return '';
  const line = String(text).trim().split('\n')[0];
  return line.length > 70 ? line.slice(0, 67) + '…' : line;
}

/**
 * Rebuild a media attachment segment on resume when possible, or leave a concise note
 * explaining why the binary payload is absent so `[image: ...]` / `[video: ...]` in the
 * conversation never looks like a mysterious omission.
 */
function restoreAttachment(ev, { sandbox, model }) {
  const label = ev.label || `${ev.kind || 'attachment'} ${ev.name || ev.uri || ''}`.trim();

  if (ev.kind === 'youtube' && ev.uri) {
    if (!model || model.video) {
      try {
        const yt = youtubeRef(ev.uri, { minutes: ev.assumed ? undefined : ev.minutes });
        return { type: 'paste', label, role: 'user', video: yt };
      } catch {
        /* fall through to text note */
      }
    }
    return {
      type: 'paste',
      label,
      role: 'user',
      text: `[earlier session attached YouTube video ${ev.uri}; current model does not accept video]`,
    };
  }

  if (ev.kind === 'image') {
    if (ev.path && sandbox && (!model || model.vision !== false)) {
      try {
        const img = loadImage(ev.path, sandbox);
        return { type: 'paste', label, role: 'user', image: img };
      } catch {
        /* file moved/deleted or outside sandbox — fall through to note */
      }
    }
    const reason =
      model && model.vision === false
        ? 'current model has no vision support'
        : ev.path
          ? `file "${ev.path}" is no longer readable`
          : 'clipboard image bytes are not stored in the session log';
    return {
      type: 'paste',
      label,
      role: 'user',
      text: `[earlier session attached ${label}; not re-attached on resume (${reason})]`,
    };
  }

  if (ev.kind === 'video') {
    if (ev.path && sandbox && (!model || model.video)) {
      try {
        const vid = loadVideo(ev.path, sandbox);
        return { type: 'paste', label, role: 'user', video: vid };
      } catch {
        /* file moved/deleted or outside sandbox — fall through to note */
      }
    }
    const reason =
      model && !model.video
        ? 'current model does not accept video'
        : ev.path
          ? `file "${ev.path}" is no longer readable`
          : 'video bytes are not stored in the session log';
    return {
      type: 'paste',
      label,
      role: 'user',
      text: `[earlier session attached ${label}; not re-attached on resume (${reason})]`,
    };
  }

  return null;
}

/**
 * Replay a logged compaction/summarization summary so old sessions that already
 * compressed dozens of turns keep their dense summary instead of hitting the replay
 * budget raw and losing those turns un-summarized.
 */
function applyReplayedCompact(specs, ev) {
  if (!ev?.summary?.text) return;
  const count = Number(ev.summary.replacedCount) || 0;
  if (count > 0) {
    let remaining = count;
    let firstRemoved = -1;
    for (let i = 0; i < specs.length && remaining > 0; ) {
      const s = specs[i];
      if ((s.type === 'user' || s.type === 'assistant') && !s.pinned) {
        if (firstRemoved === -1) firstRemoved = i;
        specs.splice(i, 1);
        remaining--;
      } else {
        i++;
      }
    }
    const summarySpec = {
      type: 'summary',
      label: ev.summary.label || `summary of ${count} earlier turns`,
      role: 'user',
      text: ev.summary.text,
      pinned: true,
    };
    if (firstRemoved >= 0) specs.splice(firstRemoved, 0, summarySpec);
    else specs.unshift(summarySpec);
  } else {
    specs.push({
      type: 'summary',
      label: ev.summary.label || 'summary',
      role: 'user',
      text: ev.summary.text,
      pinned: true,
    });
  }
}

/**
 * A transcript with `ops` and no matching `ops-result` ended mid-batch (crash, SIGKILL,
 * or a hung command that forced the terminal closed). Tell the resumed model what was in
 * flight so it verifies disk state instead of blindly re-applying file edits.
 */
function synthesizeInterruptedOps(ops) {
  const lines = [
    'Batch interrupted — the previous session ended while these ops were running, so no ops-result was recorded:',
  ];
  ops.forEach((o, i) => {
    const detail = o.path || o.cmd || (o.from ? `${o.from} -> ${o.to}` : '');
    lines.push(`  [${i}] ${o.op}${detail ? `: ${detail}` : ''}`);
  });
  lines.push(
    'Earlier file changes in this batch may already be applied on disk — read files to verify before re-applying.',
  );
  return lines.join('\n');
}

function readPersistedCalibrator(session) {
  if (session?.calibrator) return session.calibrator;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(session.dir, 'meta.json'), 'utf8'));
    return meta?.calibrator || null;
  } catch {
    return null;
  }
}

/**
 * Replay a session into a ledger. Must be called after `ledger.setSystem`, so the
 * budget accounts for the cached prefix.
 *
 * @param {import('../context/ledger.js').Ledger} ledger
 * @param {{id: string, dir: string, model?: string, calibrator?: {ratio: number, samples: number}}} session
 * @param {{sandbox?: any, model?: object, prompts?: object, replayBudget?: number}} [opts]
 * @returns {{id: string, turns: number, segments: number, omitted: number, calibrated: boolean}}
 */
export function restoreLedger(ledger, session, opts = {}) {
  if (!fs.existsSync(session.dir)) {
    throw new Error(`session ${session.id} is no longer on disk at ${session.dir}`);
  }

  // Restore TokenCalibrator heuristic before sizing the replay budget, provided we are
  // resuming onto the same model (or no target model was specified). A different model
  // family has its own tokenizer ratio and recalibrates on turn 1.
  let calibrated = false;
  const savedCal = readPersistedCalibrator(session);
  const sameModel = !opts.model?.id || !session.model || opts.model.id === session.model;
  if (savedCal && sameModel && ledger.calibrator?.restore) {
    calibrated = ledger.calibrator.restore(savedCal);
  }

  const specs = replaySegments(session.dir, opts);
  const budgetFrac = opts.replayBudget ?? REPLAY_BUDGET;
  const applyCal = (n) => (ledger.calibrator ? ledger.calibrator.apply(n) : n);
  const budget = Math.max(
    0,
    Math.floor(ledger.limit * budgetFrac) - applyCal(ledger.systemTokens),
  );
  const kept = trimToBudget(specs, budget, applyCal);

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
    calibrated,
  };
}

/**
 * Keep the newest segments that fit. Unpinned op-results go first — they are
 * re-derivable by re-reading the file, which is the same reasoning auto-compaction uses.
 * Pinned summaries survive the op-result pass and only drop if the entire window is tiny.
 */
function trimToBudget(specs, budget, applyCal = (n) => n) {
  const sized = specs.map((s) => ({ spec: s, tokens: applyCal(specTokens(s)) }));
  let total = sized.reduce((n, s) => n + s.tokens, 0);
  const dropped = new Set();

  for (const pass of [
    (s) => s.spec.type === 'op-result' && !s.spec.pinned,
    (s) => !s.spec.pinned,
    () => true,
  ]) {
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

/** Match `Ledger.add` token estimation so replay budgeting agrees with live accounting. */
function specTokens(spec) {
  if (spec.video) return spec.video.tokens ?? 0;
  if (spec.image) return spec.image.tokens ?? 0;
  return estimate(spec.text || '');
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