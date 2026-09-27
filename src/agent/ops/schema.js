/**
 * Per-op shape validation. See PLAN.md §2b for the reference table.
 *
 * Validation is pure: it never touches disk. Anything requiring filesystem state
 * (does the target exist, does `old` match exactly once) belongs in the planner.
 */

export const OPS = {
  read: { mutating: false, required: ['path'], optional: ['lines'] },
  list: { mutating: false, required: ['path'], optional: ['max'] },
  grep: { mutating: false, required: ['path', 'pattern'], optional: ['regex', 'max'] },
  glob: { mutating: false, required: ['path', 'pattern'], optional: ['max'] },
  write: { mutating: true, required: ['path', 'text'], optional: ['overwrite'] },
  replace: { mutating: true, required: ['path', 'old', 'new'], optional: ['all'] },
  delete: { mutating: true, required: ['path'], optional: ['recursive'] },
  move: { mutating: true, required: ['from', 'to'], optional: ['overwrite'] },
  shell: { mutating: true, required: ['cmd'], optional: ['cwd'], needsApproval: true },
};

export const OP_NAMES = Object.keys(OPS);

/** Aliases we accept so a model using the original repl_agent.md spelling still works. */
const FIELD_ALIASES = {
  text: 'pattern', // grep/glob used "text" for the pattern in the original spec
  command: 'cmd',
  src: 'from',
  dest: 'to',
};

export class OpError extends Error {
  constructor(index, message) {
    super(message);
    this.name = 'OpError';
    this.index = index;
  }
}

/**
 * Normalize one raw op object: resolve the `{"op": ...}` form and the original
 * `{"read": "path"}` shorthand from repl_agent.md, apply field aliases.
 * @returns {{op: string, [k: string]: any}}
 */
export function normalizeOp(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpError(index, 'each op must be a JSON object');
  }

  let op = raw.op;
  let rest = { ...raw };
  delete rest.op;

  // Shorthand: {"read": "/path", "lines": [1,20]} -> {op:"read", path:"/path", ...}
  if (!op) {
    const key = OP_NAMES.find((n) => n in raw);
    if (!key) {
      throw new OpError(
        index,
        `no recognized op. Expected an "op" field, one of: ${OP_NAMES.join(', ')}`,
      );
    }
    op = key;
    rest = { ...raw };
    delete rest[key];
    const primary = op === 'move' ? 'from' : op === 'shell' ? 'cmd' : 'path';
    rest[primary] = raw[key];
  }

  if (!OPS[op]) {
    throw new OpError(index, `unknown op "${op}". Expected one of: ${OP_NAMES.join(', ')}`);
  }

  const spec = OPS[op];
  const allowed = new Set([...spec.required, ...spec.optional]);
  const out = { op };

  for (const [k, v] of Object.entries(rest)) {
    const key = allowed.has(k) ? k : (FIELD_ALIASES[k] && allowed.has(FIELD_ALIASES[k]) ? FIELD_ALIASES[k] : k);
    if (!allowed.has(key)) {
      throw new OpError(
        index,
        `op "${op}" has no field "${k}". Allowed: ${[...allowed].join(', ')}`,
      );
    }
    out[key] = v;
  }

  for (const req of spec.required) {
    if (out[req] === undefined || out[req] === null) {
      throw new OpError(index, `op "${op}" is missing required field "${req}"`);
    }
  }

  validateTypes(out, index);
  return out;
}

function str(v) {
  return typeof v === 'string';
}

function validateTypes(o, index) {
  const bad = (msg) => {
    throw new OpError(index, `op "${o.op}": ${msg}`);
  };

  for (const f of ['path', 'from', 'to', 'cmd', 'pattern', 'text', 'old', 'new', 'cwd']) {
    if (o[f] !== undefined && !str(o[f])) bad(`"${f}" must be a string`);
  }
  for (const f of ['overwrite', 'all', 'regex', 'recursive']) {
    if (o[f] !== undefined && typeof o[f] !== 'boolean') bad(`"${f}" must be a boolean`);
  }
  if (o.max !== undefined && (!Number.isInteger(o.max) || o.max <= 0)) {
    bad('"max" must be a positive integer');
  }
  if (o.lines !== undefined) {
    if (
      !Array.isArray(o.lines) ||
      o.lines.length !== 2 ||
      !o.lines.every((n) => Number.isInteger(n) && n > 0)
    ) {
      bad('"lines" must be [min, max], 1-indexed and inclusive');
    }
    if (o.lines[0] > o.lines[1]) bad('"lines" min must be <= max');
  }
  if (o.op === 'replace' && o.old === '') bad('"old" must not be empty');
  if (o.op === 'move' && o.from === o.to) bad('"from" and "to" are the same path');
}

/**
 * Normalize a whole batch.
 * @returns {{ops: object[], errors: {index: number, message: string}[]}}
 */
export function normalizeBatch(rawOps) {
  const ops = [];
  const errors = [];
  rawOps.forEach((raw, i) => {
    try {
      ops.push(normalizeOp(raw, i));
    } catch (err) {
      errors.push({ index: i, message: err.message });
    }
  });
  return { ops, errors };
}
