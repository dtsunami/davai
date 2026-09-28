/**
 * Phase 1 of batch execution: validate everything, touch nothing.
 *
 * If the planner returns any error, the batch is dead and the model is asked to
 * resubmit (req 8). This is where "atomic" actually comes from — by the time the
 * executor runs, the remaining failure modes are I/O errors, not logic errors.
 */
import fs from 'node:fs';
import { OPS } from './schema.js';
import { alignNewlines, countOccurrences } from './writers.js';

/**
 * @param {object[]} ops  normalized ops
 * @param {{sandbox: any}} ctx
 * @returns {{errors: {index: number, op: string, message: string}[], needsApproval: number[]}}
 */
export function planBatch(ops, ctx) {
  const errors = [];
  const needsApproval = [];

  // Track the batch's own intended effects so we can catch self-conflicts before
  // any of them happen. Values: 'written' | 'deleted' | 'moved-away'.
  /** @type {Map<string, string>} */
  const pending = new Map();

  const fail = (i, op, message) => errors.push({ index: i, op: op.op, message });

  ops.forEach((op, i) => {
    const spec = OPS[op.op];
    if (spec.needsApproval) needsApproval.push(i);

    try {
      switch (op.op) {
        case 'read':
        case 'list':
        case 'grep':
        case 'glob': {
          const abs = ctx.sandbox.resolveForRead(op.path);
          if (pending.get(abs) === 'deleted' || pending.get(abs) === 'moved-away') {
            return fail(i, op, `${ctx.sandbox.rel(abs)} is removed earlier in this batch`);
          }
          if (!fs.existsSync(abs)) {
            return fail(i, op, `${ctx.sandbox.rel(abs)} does not exist`);
          }
          const isDir = fs.statSync(abs).isDirectory();
          if (op.op === 'read' && isDir) {
            return fail(i, op, `${ctx.sandbox.rel(abs)} is a directory — use "list"`);
          }
          if ((op.op === 'list' || op.op === 'glob') && !isDir) {
            return fail(i, op, `${ctx.sandbox.rel(abs)} is not a directory`);
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
          const existsNow = fs.existsSync(abs) && pending.get(abs) !== 'deleted';
          const willExist = existsNow || pending.get(abs) === 'written';
          if (willExist && !op.overwrite) {
            return fail(
              i,
              op,
              `${ctx.sandbox.rel(abs)} already exists — set "overwrite": true to replace it`,
            );
          }
          if (existsNow && fs.statSync(abs).isDirectory()) {
            return fail(i, op, `${ctx.sandbox.rel(abs)} is a directory`);
          }
          pending.set(abs, 'written');
          return;
        }

        case 'replace': {
          const abs = ctx.sandbox.resolveForWrite(op.path);
          if (pending.get(abs) === 'deleted' || pending.get(abs) === 'moved-away') {
            return fail(i, op, `${ctx.sandbox.rel(abs)} is removed earlier in this batch`);
          }
          if (!fs.existsSync(abs)) {
            return fail(i, op, `${ctx.sandbox.rel(abs)} does not exist`);
          }
          if (fs.statSync(abs).isDirectory()) {
            return fail(i, op, `${ctx.sandbox.rel(abs)} is a directory`);
          }
          // An earlier op in this batch may have changed the content; in that case we
          // cannot pre-verify uniqueness, and the executor's re-check is the guard.
          if (pending.get(abs) !== 'written') {
            const content = fs.readFileSync(abs, 'utf8');
            const n = countOccurrences(content, alignNewlines(content, op.old));
            if (n === 0) {
              return fail(
                i,
                op,
                `"old" text not found in ${ctx.sandbox.rel(abs)}. ` +
                  `Read the file and copy the exact text, including indentation.`,
              );
            }
            if (n > 1 && !op.all) {
              return fail(
                i,
                op,
                `"old" text occurs ${n} times in ${ctx.sandbox.rel(abs)} — ` +
                  `include more surrounding context to make it unique, or set "all": true`,
              );
            }
          }
          pending.set(abs, 'written');
          return;
        }

        case 'delete': {
          const abs = ctx.sandbox.resolveForWrite(op.path);
          if (pending.get(abs) === 'deleted' || pending.get(abs) === 'moved-away') {
            return fail(i, op, `${ctx.sandbox.rel(abs)} is already removed in this batch`);
          }
          if (!fs.existsSync(abs)) {
            return fail(i, op, `${ctx.sandbox.rel(abs)} does not exist`);
          }
          if (fs.statSync(abs).isDirectory() && !op.recursive) {
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
          return;
        }

        case 'move': {
          const from = ctx.sandbox.resolveForWrite(op.from);
          const to = ctx.sandbox.resolveForWrite(op.to);
          if (pending.get(from) === 'deleted' || pending.get(from) === 'moved-away') {
            return fail(i, op, `${ctx.sandbox.rel(from)} is removed earlier in this batch`);
          }
          if (!fs.existsSync(from)) {
            return fail(i, op, `${ctx.sandbox.rel(from)} does not exist`);
          }
          if (from === ctx.sandbox.writeRoot) {
            return fail(i, op, 'refusing to move the working directory itself');
          }
          const destExists = fs.existsSync(to) && pending.get(to) !== 'deleted';
          if (destExists && !op.overwrite) {
            return fail(
              i,
              op,
              `${ctx.sandbox.rel(to)} already exists — set "overwrite": true to replace it`,
            );
          }
          pending.set(from, 'moved-away');
          pending.set(to, 'written');
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
      // SandboxError and unexpected fs errors both land here.
      fail(i, op, err.message);
    }
  });

  return { errors, needsApproval };
}
