/**
 * Phase 2 of batch execution: apply, or roll everything back.
 *
 * Shell is segregated. File ops apply atomically first; shell ops then run one at a
 * time behind approval. A denied or failed shell op kills the remainder of the batch,
 * but does not roll back the file ops that already succeeded — those are committed
 * work the model can reason about, and the shell command may have had real effects
 * we cannot undo anyway.
 */
import { planBatch } from './planner.js';
import { opRead, opList, opGrep, opGlob } from './readers.js';
import { opWrite, opReplace, opDelete, opMove } from './writers.js';
import { runShell } from './shell.js';

const READERS = { read: opRead, list: opList, grep: opGrep, glob: opGlob };
const WRITERS = { write: opWrite, replace: opReplace, delete: opDelete, move: opMove };

/**
 * @typedef {object} BatchOutcome
 * @property {'ok'|'plan-failed'|'apply-failed'|'denied'} status
 * @property {{index: number, op: string, ok: boolean, result?: any, error?: string}[]} results
 * @property {{index: number, op: string, message: string}[]} errors
 * @property {string[]} [rollbackFailures]
 */

/**
 * @param {object[]} ops normalized ops
 * @param {object} ctx {sandbox, journal, shellTimeout, signal, approve}
 * @returns {Promise<BatchOutcome>}
 */
export async function executeBatch(ops, ctx) {
  const plan = planBatch(ops, ctx);
  if (plan.errors.length) {
    return { status: 'plan-failed', results: [], errors: plan.errors };
  }

  const results = [];
  const applied = []; // journal entries, for rollback
  const shellQueue = [];

  // --- pass 1: readers and file mutations, atomic as a unit ---
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.op === 'shell') {
      shellQueue.push(i);
      continue;
    }
    try {
      if (READERS[op.op]) {
        results.push({ index: i, op: op.op, ok: true, result: READERS[op.op](op, ctx) });
      } else {
        const { entry, result } = WRITERS[op.op](op, ctx);
        applied.push(entry);
        results.push({ index: i, op: op.op, ok: true, result });
      }
    } catch (err) {
      const rollbackFailures = ctx.journal.rollback(applied);
      return {
        status: 'apply-failed',
        results: [],
        errors: [{ index: i, op: op.op, message: err.message }],
        ...(rollbackFailures.length ? { rollbackFailures } : {}),
      };
    }
  }

  // --- pass 2: shell ops, serially, each behind approval ---
  for (const i of shellQueue) {
    const op = ops[i];
    const decision = ctx.approve ? await ctx.approve(op, i) : { allow: true };
    if (!decision.allow) {
      results.push({
        index: i,
        op: 'shell',
        ok: false,
        error: decision.reason || 'denied by operator',
      });
      return {
        status: 'denied',
        results,
        errors: [
          {
            index: i,
            op: 'shell',
            message: decision.reason
              ? `operator denied: ${decision.reason}`
              : 'operator denied this command',
          },
        ],
      };
    }

    const effective = decision.cmd ? { ...op, cmd: decision.cmd } : op;
    const out = await runShell(effective, ctx);
    const ok = out.exitCode === 0;
    results.push({ index: i, op: 'shell', ok, result: out });
    if (!ok) {
      return {
        status: 'apply-failed',
        results,
        errors: [
          {
            index: i,
            op: 'shell',
            message: `command exited ${out.exitCode}${out.error ? `: ${out.error}` : ''}`,
          },
        ],
      };
    }
  }

  return { status: 'ok', results, errors: [] };
}

/**
 * Render a batch outcome as the da_results block fed back to the model.
 * Kept terse: this text is charged as input tokens on every subsequent turn.
 */
export function formatResults(outcome) {
  if (outcome.status === 'plan-failed') {
    const lines = outcome.errors.map(
      (e) => `  [${e.index}] ${e.op}: ${e.message}`,
    );
    return (
      '```da_results\n' +
      'BATCH REJECTED — nothing was applied. Fix and resubmit the whole batch.\n' +
      lines.join('\n') +
      '\n```'
    );
  }

  const parts = [];
  for (const r of outcome.results) {
    const head = `[${r.index}] ${r.op}`;
    if (!r.ok) {
      parts.push(`${head}: ERROR ${r.error}`);
      continue;
    }
    parts.push(`${head}: ${summarize(r.op, r.result)}`);
  }
  for (const e of outcome.errors) {
    parts.push(`[${e.index}] ${e.op}: ERROR ${e.message}`);
  }
  if (outcome.status === 'apply-failed') {
    parts.push(
      'BATCH ABORTED — file changes were rolled back. Remaining ops did not run.',
    );
  }
  if (outcome.rollbackFailures?.length) {
    parts.push(`ROLLBACK INCOMPLETE: ${outcome.rollbackFailures.join('; ')}`);
  }
  return '```da_results\n' + parts.join('\n') + '\n```';
}

function summarize(op, r) {
  switch (op) {
    case 'read':
      if (r.binary) return `${r.path} is binary (${r.bytes} bytes), not shown`;
      return (
        `${r.path} lines ${r.lines[0]}-${r.lines[1]} of ${r.totalLines}` +
        (r.note ? ` (${r.note})` : '') +
        `\n${r.content}`
      );
    case 'list':
      return (
        `${r.path} (${r.entries.length} entries)${r.skipped ? ` [${r.skipped}]` : ''}\n` +
        r.entries.map((e) => `  ${e.name}${e.size !== undefined ? `  ${e.size}b` : ''}`).join('\n')
      );
    case 'grep':
      return (
        `"${r.pattern}" in ${r.root}: ${r.matches.length} matches across ${r.filesScanned} files` +
        (r.note ? ` (${r.note})` : '') +
        (r.matches.length
          ? '\n' + r.matches.map((m) => `  ${m.path}:${m.line}: ${m.text}`).join('\n')
          : '')
      );
    case 'glob':
      return (
        `"${r.pattern}" in ${r.root}: ${r.files.length} files` +
        (r.note ? ` (${r.note})` : '') +
        (r.files.length ? '\n' + r.files.map((f) => `  ${f}`).join('\n') : '')
      );
    case 'write':
      return `${r.path} ${r.action} (${r.lines} lines, ${r.bytes} bytes)`;
    case 'replace':
      return `${r.path} ${r.action} (${r.occurrences}x, ${r.delta >= 0 ? '+' : ''}${r.delta} lines)`;
    case 'delete':
      return `${r.path} ${r.action} (${r.type})`;
    case 'move':
      return `${r.from} -> ${r.to} ${r.action}${r.note ? ` (${r.note})` : ''}`;
    case 'shell': {
      const body = [r.stdout, r.stderr && `stderr:\n${r.stderr}`].filter(Boolean).join('\n');
      return (
        `$ ${r.cmd} (exit ${r.exitCode}, ${r.durationMs}ms)` +
        (r.note ? ` [${r.note}]` : '') +
        (body ? `\n${body}` : '\n(no output)')
      );
    }
    default:
      return JSON.stringify(r);
  }
}
