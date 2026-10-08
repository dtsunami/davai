/**
 * Native tool calls, salvaged.
 *
 * davai offers no tools (req 8), yet some models — Mistral first — answer the da_ops
 * protocol by calling a function named `da_ops` with a perfectly good envelope as its
 * arguments. Ignoring that throws away a correct batch, and the model never learns why
 * nothing happened, so it repeats the call until the nudge budget runs out.
 *
 * So a turn with no fenced block has its native calls read as da_ops, through the same
 * parser and schema a fenced block goes through:
 *
 *   - a call named da_ops (any case, `-` or `_`, a `functions.` prefix): the arguments
 *     are a da_ops block body — an envelope, optionally with --davai payload sections
 *   - a call named after an op (`read`, `write`, ...): the arguments are that op's fields
 *   - any other call whose arguments are an ops envelope or a bare array of ops
 *
 * Payload references ("@1") resolve against --davai blocks in the arguments or, failing
 * that, in the reply text. Several calls merge into one batch, as several fenced blocks
 * do, and one that does not parse holds back the rest: a batch is atomic however it
 * arrived. A fenced block always wins; native calls alongside one are reported, not run.
 *
 * Everything here is pure. The loop logs what became of each call.
 */
import { parseDaOps } from './parser.js';

/** The op names from the protocol table. normalizeBatch still validates the fields. */
const OP_NAMES = new Set([
  'read',
  'list',
  'grep',
  'glob',
  'write',
  'replace',
  'delete',
  'move',
  'shell',
]);
const PAYLOAD_OPEN = /^--davai:([A-Za-z0-9_-]+)--[ \t]*$/;
const PAYLOAD_CLOSE = /^--davai:end--[ \t]*$/;
const REF = /"@([A-Za-z0-9_-]+)"/g;

const DETAIL = {
  unusable: 'not a da_ops batch, an op, or an ops envelope',
  held: 'not run: another native call in the same reply did not parse',
  shadowed: 'the reply also had a fenced da_ops block, which takes precedence',
};

/**
 * @typedef {{id?: string, name: string, args: string}} ToolCall
 * @typedef {'executed'|'held'|'malformed'|'unusable'|'shadowed'} Disposition
 * @typedef {{id?: string, name: string, disposition: Disposition, detail?: string}} CallReport
 * @typedef {{ops: object[]|null, parseError: string|null, block: string|null,
 *   report: CallReport[], unusable: string[]}} NativeResolution
 */

/**
 * Decide what a turn's native calls amount to.
 *
 * @param {ToolCall[]|undefined} calls
 * @param {string} text  the reply text, searched for payload blocks
 * @param {{fenced?: boolean}} [opts]  true when the reply had a da_ops block of its own
 * @returns {NativeResolution}  `block` is the fenced equivalent of `ops`, for history
 */
export function resolveNativeCalls(calls, text, { fenced = false } = {}) {
  const none = { ops: null, parseError: null, block: null, report: [], unusable: [] };
  if (!calls?.length) return none;

  if (fenced) {
    return {
      ...none,
      report: calls.map((c) => ({
        id: c.id,
        name: c.name || '?',
        disposition: 'shadowed',
        detail: DETAIL.shadowed,
      })),
    };
  }

  const payloads = prosePayloads(text || '');
  const parsed = calls.map((call) => {
    const name = call.name || '?';
    const { body, error } = callBody(call);
    if (error) return { call, name, error };
    if (body == null) return { call, name, unusable: true };
    try {
      return { call, name, ops: parseDaOps(withPayloads(body, payloads)) };
    } catch (err) {
      return { call, name, error: err.message };
    }
  });

  const failed = parsed.find((p) => p.error);
  const report = parsed.map((p) => {
    const disposition = p.unusable
      ? 'unusable'
      : p.error
        ? 'malformed'
        : failed
          ? 'held'
          : 'executed';
    const detail = p.error || DETAIL[disposition];
    return { id: p.call.id, name: p.name, disposition, ...(detail ? { detail } : {}) };
  });
  const unusable = parsed.filter((p) => p.unusable).map((p) => p.name);

  if (failed) {
    return { ...none, report, unusable, parseError: nativeError(failed.name, failed.error) };
  }
  const ops = parsed.flatMap((p) => p.ops || []);
  if (!ops.length) return { ...none, report, unusable };
  return { ops, parseError: null, block: toFencedBlock(ops), report, unusable };
}

/**
 * Render ops as the fenced block the model should have sent. Multi-line strings are
 * lifted into payload blocks, so the history shows the protocol's own form.
 * @param {object[]} ops
 */
export function toFencedBlock(ops) {
  const payloads = [];
  const lift = (value) => {
    // A string with a payload marker line of its own stays inline: lifting it would
    // end the payload early.
    if (typeof value !== 'string' || !value.includes('\n') || /^--davai:/m.test(value)) {
      return value;
    }
    const name = `p${payloads.length + 1}`;
    payloads.push(`--davai:${name}--\n${value}\n--davai:end--`);
    return `@${name}`;
  };
  const lines = ops.map((op) => {
    const lifted = Object.fromEntries(Object.entries(op).map(([k, v]) => [k, lift(v)]));
    return '  ' + JSON.stringify({ op: op.op, ...lifted });
  });
  return ['```da_ops', '{"ops": [', lines.join(',\n'), ']}', ...payloads, '```'].join('\n');
}

/** One warning line saying what became of a turn's native calls. */
export function describeNative({ report, ops }) {
  const names = (d) => report.filter((r) => r.disposition === d).map((r) => r.name);
  const parts = [];
  const ran = names('executed');
  if (ran.length) {
    parts.push(
      `ran native tool call ${ran.join(', ')} as a da_ops batch ` +
        `(${ops.length} op${ops.length === 1 ? '' : 's'})`,
    );
  }
  const bad = names('malformed');
  if (bad.length) parts.push(`native tool call ${bad.join(', ')} did not parse — asked the model to resend`);
  const held = names('held');
  if (held.length) parts.push(`held back ${held.join(', ')} with it`);
  const shadowed = names('shadowed');
  if (shadowed.length) {
    parts.push(`ignored native tool call ${shadowed.join(', ')}: the reply had a fenced da_ops block`);
  }
  const unusable = names('unusable');
  if (unusable.length) parts.push(`ignored native tool call ${unusable.join(', ')}: not a da_ops batch`);
  return parts.join('; ');
}

/** Told to the model when its native calls were all unmappable. */
export function nativeCallPrompt(names) {
  return (
    `Your reply made native tool call(s) — ${names.join(', ')} — and none of them ran: ` +
    'davai has no tool-calling interface. Put a da_ops fenced block in your reply text ' +
    'to act, or state plainly that the work is complete.'
  );
}

/** Prefixed to the results of a batch that arrived as a native call. */
export function salvageNote(unusable = []) {
  return (
    '(Received as a native tool call and run as a da_ops block. Prefer a fenced block in ' +
    'your reply text: native calls cannot carry --davai payload blocks.' +
    (unusable.length ? ` Not run: ${unusable.join(', ')} — davai has no such tool.` : '') +
    ')'
  );
}

function nativeError(name, error) {
  const end = /[.!?]$/.test(error) ? '' : '.';
  const hint = /payload/.test(error)
    ? ' A native tool call cannot carry --davai payload blocks: put the batch in a ' +
      '```da_ops fenced block in your reply text.'
    : '';
  return `native ${name} tool call: ${error}${end}${hint}`;
}

/**
 * The da_ops block body a call stands for.
 * @returns {{body?: string, error?: string}}  neither when the call is not an op at all
 */
function callBody(call) {
  const name = String(call.name || '')
    .trim()
    .replace(/^functions\./i, '')
    .toLowerCase();
  let args =
    typeof call.args === 'string' ? call.args : call.args == null ? '' : JSON.stringify(call.args);
  let value = tryJSON(args);
  // Some models double-encode: the arguments are a JSON string that holds the JSON.
  if (typeof value === 'string') {
    args = value;
    value = tryJSON(args);
  }

  // parseDaOps judges the body, so payload sections and relaxed JSON work as in a fence.
  if (name.replace(/[^a-z0-9]/g, '') === 'daops') return { body: args };

  if (OP_NAMES.has(name)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { error: `arguments must be a JSON object of the "${name}" op's fields` };
    }
    const fields = Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'op'));
    return { body: JSON.stringify({ ops: [{ op: name, ...fields }] }) };
  }

  if (isOpList(value) || isOpList(value?.ops)) return { body: args };
  return {};
}

function isOpList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((o) => o && typeof o === 'object' && typeof o.op === 'string')
  );
}

function tryJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Append reply-text payload blocks the body references but does not define. */
function withPayloads(body, payloads) {
  const extra = new Map();
  for (const [, name] of body.matchAll(REF)) {
    if (payloads.has(name) && !extra.has(name) && !body.includes(`--davai:${name}--`)) {
      extra.set(name, payloads.get(name));
    }
  }
  if (!extra.size) return body;
  const sections = [...extra].map(([name, content]) => `--davai:${name}--\n${content}\n--davai:end--`);
  return [body.trimEnd(), ...sections].join('\n');
}

/** --davai:NAME-- blocks anywhere in the reply text. The first of a name wins. */
function prosePayloads(text) {
  const out = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(PAYLOAD_OPEN);
    if (!open || open[1] === 'end') continue;
    const content = [];
    let j = i + 1;
    for (; j < lines.length && !PAYLOAD_CLOSE.test(lines[j]); j++) content.push(lines[j]);
    if (j >= lines.length) break; // never closed
    if (!out.has(open[1])) out.set(open[1], content.join('\n'));
    i = j;
  }
  return out;
}