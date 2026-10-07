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
    const decision = await gateShell(op, i, ctx);
    if (decision.failed) {
      return {
        status: 'apply-failed',
        results,
        errors: [{ index: i, op: 'shell', message: decision.message }],
      };
    }
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

    const out = await runShell(decision.op, ctx, { secret: decision.secret });
    // sudo asked twice in one process: the password it was given is stale, so drop it.
    if (out.sudo?.refused) ctx.sudo?.forget();
    const result = decision.auth ? { ...out, auth: decision.auth } : out;
    const ok = out.exitCode === 0;
    results.push({ index: i, op: 'shell', ok, result });
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

const MAX_PASSWORD_TRIES = 3;

/**
 * Approval for one shell op, plus a sudo password when the command needs one.
 *
 * The password is asked for in the approval request itself (`sudo: {state:
 * 'password'}`), checked with a throwaway `sudo -A true`, and only then does the real
 * command run, so a wrong password never costs a half-run command. An approval that
 * comes back without a password (headless, yolo in a front end that cannot ask) runs
 * the command as before, where sudo fails fast with a note. `auth` records which of
 * these happened, for the model.
 *
 * @returns {Promise<{allow: boolean, op?: object, secret?: string|null, auth?: string,
 *   reason?: string, failed?: boolean, message?: string}>}
 */
export async function gateShell(op, index, ctx) {
  const ask = (o, extra) =>
    ctx.approve ? ctx.approve(o, index, extra) : Promise.resolve({ allow: true });
  const sudo = ctx.sudo;

  let status = sudo ? await sudo.status(op.cmd) : { state: 'none' };
  const decision = await ask(
    op,
    status.state === 'password' ? { sudo: { state: 'password' } } : undefined,
  );
  if (!decision.allow) return { allow: false, reason: decision.reason };

  const current = decision.cmd ? { ...op, cmd: decision.cmd } : op;
  if (!sudo) return { allow: true, op: current };
  // An edit can add sudo to a command, or take it away.
  const edited = current.cmd !== op.cmd;
  if (edited) status = await sudo.status(current.cmd);

  switch (status.state) {
    case 'none':
      return { allow: true, op: current };
    case 'nopasswd':
      return { allow: true, op: current, auth: 'sudo: no password needed' };
    case 'unavailable':
      return { allow: true, op: current, auth: `sudo unavailable: ${status.detail}` };
    case 'cached':
      return {
        allow: true,
        op: current,
        secret: sudo.take(),
        auth: 'sudo: cached password supplied',
      };
  }

  let secret = edited ? null : (decision.secret ?? null);
  let asked = !edited;
  let retry;
  for (let tries = 0; tries < MAX_PASSWORD_TRIES; ) {
    if (secret == null) {
      if (asked) {
        return {
          allow: true,
          op: current,
          auth:
            'sudo: a password is needed but none was supplied (headless or non-interactive ' +
            'approval), so the command ran without one',
        };
      }
      const d = await ask(current, { sudo: { state: 'password', retry } });
      if (!d.allow) {
        return { allow: false, reason: d.reason || 'operator did not give the sudo password' };
      }
      secret = d.secret ?? null;
      asked = true;
      continue;
    }

    const check = await sudo.verify(secret);
    if (check.ok) {
      return { allow: true, op: current, secret, auth: 'sudo: password checked and supplied' };
    }
    if (!check.wrong) {
      return {
        allow: false,
        failed: true,
        message: `sudo password check failed, so the command was not run: ${check.detail}`,
      };
    }
    tries++;
    secret = null;
    asked = false;
    retry = `incorrect password, try again (${tries}/${MAX_PASSWORD_TRIES})`;
  }
  return {
    allow: false,
    failed: true,
    message: `the operator entered an incorrect sudo password ${MAX_PASSWORD_TRIES} times; the command was not run`,
  };
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
      // A failed shell op carries its result (exit code, stderr, notes). Printing only
      // r.error, which it never sets, told the model "ERROR undefined" and hid exactly
      // the output it needed to work out what went wrong.
      parts.push(
        r.result
          ? `${head}: FAILED ${summarize(r.op, r.result)}`
          : `${head}: ERROR ${r.error}`,
      );
      continue;
    }
    parts.push(`${head}: ${summarize(r.op, r.result)}`);
  }
  for (const e of outcome.errors) {
    parts.push(`[${e.index}] ${e.op}: ERROR ${e.message}`);
  }
  // Shell ops run only after every file op has applied, and a shell failure does not roll
  // them back (see the header). Saying it did sent the model off to redo edits that were
  // already on disk.
  const shellStopped = outcome.errors.some((e) => e.op === 'shell');
  if (outcome.status === 'apply-failed') {
    parts.push(
      shellStopped
        ? 'BATCH STOPPED at the failed shell op — file changes earlier in the batch were kept. Remaining ops did not run.'
        : 'BATCH ABORTED — file changes were rolled back. Remaining ops did not run.',
    );
  }
  if (outcome.status === 'denied') {
    parts.push('BATCH STOPPED — file changes earlier in the batch were kept. Remaining ops did not run.');
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
        (r.auth ? ` [${r.auth}]` : '') +
        (r.note ? ` [${r.note}]` : '') +
        (body ? `\n${body}` : '\n(no output)')
      );
    }
    default:
      return JSON.stringify(r);
  }
}
