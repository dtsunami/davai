/**
 * Phase 1 of batch execution: validate everything, touch nothing.
 *
 * If the planner returns any error, the batch is dead and the model is asked to
 * resubmit (req 8). This is where "atomic" actually comes from — by the time the
 * executor runs, the remaining failure modes are I/O errors, not logic errors.
 */
import fs from 'node:fs';
import { OPS } from './schema.js';
import { simulateReplace } from './writers.js';
import { evaluateTx, TOMBSTONE } from './tx.js';

/**
 * @param {object[]} ops  normalized ops
 * @param {{sandbox: any}} ctx
 * @returns {{
 *   errors: {index: number, op: string, message: string}[],
 *   softErrors: Map<number, string>,
 *   needsApproval: number[]
 * }}
 */
export function planBatch(ops, ctx) {
  const errors = [];
  /**
   * Read-only target misses in a pure-exploration batch (no mutating ops). When a model
   * batches 10 reads and guesses 1 path wrong, soft-failing that single item lets the
   * other 9 succeed in one round-trip instead of rejecting the entire batch. A single-op
   * batch or any batch containing a mutation stays strictly all-or-nothing.
   * @type {Map<number, string>}
   */
  const softErrors = new Map();
  const needsApproval = [];
  const hasMutating = ops.some((o) => OPS[o.op]?.mutating);
  const canSoftFailReads = !hasMutating && ops.length > 1;

  // Track the batch's own intended effects AND virtual file contents so sequential ops
  // on the same path (write -> replace, replace -> replace, move -> replace) are
  // pre-validated in memory before touching disk.
  // Status values: 'written' | 'deleted' | 'moved-away'.
  /** @type {Map<string, string>} */
  const pending = new Map();
  /** @type {Map<string, string|null>} null when content is non-UTF8/directory */
  const overlay = new Map();

  const fail = (i, op, message) => errors.push({ index: i, op: op.op, message });
  const failReader = (i, op, message) => {
    if (canSoftFailReads) softErrors.set(i, message);
    else fail(i, op, message);
  };

  /** Read virtual UTF-8 content for `abs`, populating from disk on first touch. */
  const readVirtual = (abs) => {
    if (overlay.has(abs)) return overlay.get(abs);
    const text = fs.readFileSync(abs, 'utf8');
    overlay.set(abs, text);
    return text;
  };

  ops.forEach((op, i) => {
    const spec = OPS[op.op];
    if (spec.needsApproval) needsApproval.push(i);

    try {
      switch (op.op) {
        case 'read':
        case 'list':
        case 'grep':
        case 'glob': {
          // Sandbox / .daignore violations still throw SandboxError below, which only
          // soft-fails in a multi-op read-only batch so one ignored path doesn't nuke 9 reads.
          const abs = ctx.sandbox.resolveForRead(op.path);
          if (pending.get(abs) === 'deleted' || pending.get(abs) === 'moved-away') {
            return fail(i, op, `${ctx.sandbox.rel(abs)} is removed earlier in this batch`);
          }
          const createdEarlier = pending.get(abs) === 'written';
          if (!createdEarlier && !fs.existsSync(abs)) {
            return failReader(i, op, `${ctx.sandbox.rel(abs)} does not exist`);
          }
          const isDir = !createdEarlier && fs.statSync(abs).isDirectory();
          if (op.op === 'read' && isDir) {
            return failReader(i, op, `${ctx.sandbox.rel(abs)} is a directory — use "list"`);
          }
          if ((op.op === 'list' || op.op === 'glob') && !isDir) {
            return failReader(i, op, `${ctx.sandbox.rel(abs)} is not a directory`);
          }
          if (op.op === 'grep' && op.regex) {
            try {
              new RegExp(op.pattern);
            } catch (err) {
              return fail(i, op, `invalid regex: ${err.message}`);
            }
          }
          return;
        }

        case 'write': {
          const abs = ctx.sandbox.resolveForWrite(op.path);
          const existsOnDisk = fs.existsSync(abs) && pending.get(abs) !== 'deleted' && pending.get(abs) !== 'moved-away';
          const willExist = existsOnDisk || pending.get(abs) === 'written';
          if (willExist && !op.overwrite) {
            return fail(
              i,
              op,
              `${ctx.sandbox.rel(abs)} already exists — set "overwrite": true to replace it`,
            );
          }
          if (existsOnDisk && fs.statSync(abs).isDirectory()) {
            return fail(i, op, `${ctx.sandbox.rel(abs)} is a directory`);
          }
          pending.set(abs, 'written');
          overlay.set(abs, op.text);
          return;
        }

        case 'replace': {
          const abs = ctx.sandbox.resolveForWrite(op.path);
          const rel = ctx.sandbox.rel(abs);
          if (pending.get(abs) === 'deleted' || pending.get(abs) === 'moved-away') {
            return fail(i, op, `${rel} is removed earlier in this batch`);
          }
          const createdEarlier = pending.get(abs) === 'written';
          if (!createdEarlier && !fs.existsSync(abs)) {
            return fail(i, op, `${rel} does not exist`);
          }
          if (!createdEarlier && fs.statSync(abs).isDirectory()) {
            return fail(i, op, `${rel} is a directory`);
          }
          const content = readVirtual(abs);
          if (content !== null) {
            const { updated } = simulateReplace(content, op, rel);
            overlay.set(abs, updated);
          }
          pending.set(abs, 'written');
          return;
        }

        case 'delete': {
          const abs = ctx.sandbox.resolveForWrite(op.path);
          if (pending.get(abs) === 'deleted' || pending.get(abs) === 'moved-away') {
            return fail(i, op, `${ctx.sandbox.rel(abs)} is already removed in this batch`);
          }
          const createdEarlier = pending.get(abs) === 'written';
          if (!createdEarlier && !fs.existsSync(abs)) {
            return fail(i, op, `${ctx.sandbox.rel(abs)} does not exist`);
          }
          if (!createdEarlier && fs.statSync(abs).isDirectory() && !op.recursive) {
            return fail(
              i,
              op,
              `${ctx.sandbox.rel(abs)} is a directory — set "recursive": true to delete it`,
            );
          }
          if (abs === ctx.sandbox.writeRoot) {
            return fail(i, op, 'refusing to delete the working directory itself');
          }
          pending.set(abs, 'deleted');
          overlay.delete(abs);
          return;
        }

        case 'move': {
          const from = ctx.sandbox.resolveForWrite(op.from);
          const to = ctx.sandbox.resolveForWrite(op.to);
          if (pending.get(from) === 'deleted' || pending.get(from) === 'moved-away') {
            return fail(i, op, `${ctx.sandbox.rel(from)} is removed earlier in this batch`);
          }
          const fromCreated = pending.get(from) === 'written';
          if (!fromCreated && !fs.existsSync(from)) {
            return fail(i, op, `${ctx.sandbox.rel(from)} does not exist`);
          }
          if (from === ctx.sandbox.writeRoot) {
            return fail(i, op, 'refusing to move the working directory itself');
          }
          const destOnDisk = fs.existsSync(to) && pending.get(to) !== 'deleted' && pending.get(to) !== 'moved-away';
          const destExists = destOnDisk || pending.get(to) === 'written';
          if (destExists && !op.overwrite) {
            return fail(
              i,
              op,
              `${ctx.sandbox.rel(to)} already exists — set "overwrite": true to replace it`,
            );
          }
          // Carry virtual file content across the move so a subsequent `replace` on `to`
          // in the same batch validates against the moved file's real bytes.
          if (fromCreated) {
            overlay.set(to, overlay.get(from) ?? null);
          } else if (fs.statSync(from).isFile()) {
            overlay.set(to, readVirtual(from));
          } else {
            overlay.set(to, null);
          }
          overlay.delete(from);
          pending.set(from, 'moved-away');
          pending.set(to, 'written');
          return;
        }

        case 'tx': {
          if (!ctx.codeMode) {
            return fail(
              i,
              op,
              'op "tx" requires Code Mode (set DAVAI_CODE_MODE=true or launch with --code-mode) — use declarative da_ops instead',
            );
          }
          const { staged } = evaluateTx(op, {
            sandbox: ctx.sandbox,
            txState: ctx.txState,
            txTimeoutMs: ctx.txTimeoutMs,
            initialOverlay: overlay,
            initialPending: pending,
            dryRun: true,
          });
          // Propagate the tx's staged mutations into the planner's virtual overlay so
          // any subsequent op in the same batch validates against the post-tx tree.
          for (const [abs, meta] of staged.mutations.entries()) {
            if (meta.action === 'deleted') {
              pending.set(abs, 'deleted');
              overlay.delete(abs);
            } else {
              const v = staged.files.get(abs);
              pending.set(abs, 'written');
              overlay.set(abs, typeof v === 'string' && v !== TOMBSTONE ? v : null);
            }
          }
          return;
        }

        case 'shell': {
          if (op.cwd) ctx.sandbox.resolveForWrite(op.cwd);
          if (!op.cmd.trim()) return fail(i, op, 'empty command');
          return;
        }

        default:
          return fail(i, op, `unhandled op "${op.op}"`);
      }
    } catch (err) {
      // SandboxError (.daignore / outside jail) on one item of a multi-op pure-read
      // batch soft-fails just that op so the rest of the exploration batch runs.
      if (canSoftFailReads && err?.name === 'SandboxError' && !spec.mutating) {
        failReader(i, op, err.message);
      } else {
        fail(i, op, err.message);
      }
    }
  });

  return { errors, softErrors, needsApproval };
}
