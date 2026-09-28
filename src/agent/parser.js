/**
 * Fenced-block scanner. Separates da_ops blocks (actions) from every other fenced
 * block (artifacts, req 7).
 *
 * The da_ops payload convention (PLAN.md §2a): a JSON envelope whose string values
 * may reference out-of-band payload blocks, so multi-line code never has to be
 * JSON-escaped.
 *
 *   {"ops": [{"op":"write","path":"a.js","text":"@1"}]}
 *   --davai:1--
 *   verbatim content, nothing escaped
 *   --davai:end--
 *
 * Strict JSON with escaped newlines is also accepted, so a model that ignores the
 * convention still works.
 */

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/;
const PAYLOAD_OPEN = /^--davai:([A-Za-z0-9_-]+)--[ \t]*$/;
const PAYLOAD_CLOSE = /^--davai:end--[ \t]*$/;

/**
 * @typedef {object} Block
 * @property {'da_ops'|'artifact'} kind
 * @property {string} lang
 * @property {string} body
 * @property {number} start  line index in the source
 */

/**
 * Split raw assistant text into fenced blocks and the prose around them.
 * @param {string} text
 * @returns {{blocks: Block[], prose: string}}
 */
export function scanBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  const prose = [];

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(FENCE);
    if (!m) {
      prose.push(lines[i]);
      i++;
      continue;
    }
    const [, indent, fence, lang] = m;
    const closer = new RegExp(`^[ \\t]*${fence[0]}{${fence.length},}[ \\t]*$`);
    const isOps = lang.toLowerCase() === 'da_ops';
    const start = i;
    const body = [];
    i++;
    let closed = false;
    // Payload blocks are verbatim by definition, so a ``` inside one is content, not
    // the end of the da_ops block. Without this, writing any file that itself contains
    // a fenced code block (a README, this very protocol doc) truncates the envelope
    // mid-JSON and the batch dies with a parse error the model cannot diagnose.
    let inPayload = false;
    while (i < lines.length) {
      const line = lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i];
      if (isOps) {
        if (!inPayload && PAYLOAD_OPEN.test(line)) inPayload = true;
        else if (inPayload && PAYLOAD_CLOSE.test(line)) inPayload = false;
      }
      if (!inPayload && closer.test(lines[i])) {
        closed = true;
        i++;
        break;
      }
      body.push(line);
      i++;
    }
    const kind = isOps ? 'da_ops' : 'artifact';
    blocks.push({
      kind,
      lang: lang || 'text',
      body: body.join('\n'),
      start,
      unterminated: !closed,
    });
  }

  return { blocks, prose: prose.join('\n').trim() };
}

export class ParseError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ParseError';
    this.detail = detail;
  }
}

/**
 * Split a da_ops block body into its JSON envelope and its payload sections.
 */
function splitPayloads(body) {
  const lines = body.split('\n');
  const envelope = [];
  const payloads = new Map();

  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(PAYLOAD_OPEN);
    if (!open) {
      envelope.push(lines[i]);
      i++;
      continue;
    }
    const id = open[1];
    const content = [];
    i++;
    let closed = false;
    while (i < lines.length) {
      if (PAYLOAD_CLOSE.test(lines[i])) {
        closed = true;
        i++;
        break;
      }
      content.push(lines[i]);
      i++;
    }
    if (!closed) {
      throw new ParseError(
        `payload block --davai:${id}-- is never closed with --davai:end--`,
      );
    }
    payloads.set(id, content.join('\n'));
  }

  return { envelope: envelope.join('\n').trim(), payloads };
}

/** Tolerant JSON parse: strips trailing commas and // comments before giving up. */
function parseEnvelope(text) {
  try {
    return JSON.parse(text);
  } catch (first) {
    const relaxed = text
      .replace(/^\s*```[a-z_]*\s*$/gim, '')
      .replace(/\/\/[^\n"]*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(relaxed);
    } catch {
      throw new ParseError(`da_ops envelope is not valid JSON: ${first.message}`);
    }
  }
}

/** Resolve "@1" style references against the payload map, recursively over the op. */
function resolveRefs(value, payloads, seen) {
  if (typeof value === 'string') {
    const m = value.match(/^@([A-Za-z0-9_-]+)$/);
    if (m) {
      if (!payloads.has(m[1])) {
        throw new ParseError(
          `op references payload "@${m[1]}" but no --davai:${m[1]}-- block is present`,
        );
      }
      seen.add(m[1]);
      return payloads.get(m[1]);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, payloads, seen));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveRefs(v, payloads, seen)]),
    );
  }
  return value;
}

/**
 * Parse one da_ops block body into raw op objects.
 * @returns {object[]}
 */
export function parseDaOps(body) {
  const { envelope, payloads } = splitPayloads(body);
  if (!envelope) throw new ParseError('da_ops block is empty');

  const parsed = parseEnvelope(envelope);

  let rawOps;
  if (Array.isArray(parsed)) {
    rawOps = parsed; // bare array is accepted
  } else if (parsed && Array.isArray(parsed.ops)) {
    rawOps = parsed.ops;
  } else if (parsed && typeof parsed === 'object') {
    throw new ParseError(
      'da_ops envelope must be {"ops": [...]} or a bare [...] array' +
        (Object.keys(parsed).length
          ? `; found keys: ${Object.keys(parsed).join(', ')}`
          : ''),
    );
  } else {
    throw new ParseError('da_ops envelope must be a JSON object or array');
  }

  if (!rawOps.length) throw new ParseError('da_ops contains no operations');

  const seen = new Set();
  const resolved = rawOps.map((o) => resolveRefs(o, payloads, seen));

  const unused = [...payloads.keys()].filter((k) => !seen.has(k));
  if (unused.length) {
    throw new ParseError(
      `payload block(s) --davai:${unused.join('--, --davai:')}-- are never referenced. ` +
        `Reference one with "@${unused[0]}" as a field value.`,
    );
  }

  return resolved;
}

/**
 * Full extraction from an assistant turn.
 * @returns {{ops: object[]|null, parseError: string|null, artifacts: Block[], prose: string}}
 */
export function extract(text) {
  const { blocks, prose } = scanBlocks(text);
  const opBlocks = blocks.filter((b) => b.kind === 'da_ops');
  const artifacts = blocks.filter((b) => b.kind === 'artifact');

  if (!opBlocks.length) return { ops: null, parseError: null, artifacts, prose };

  if (opBlocks.some((b) => b.unterminated)) {
    return {
      ops: null,
      parseError:
        'a da_ops block was never closed — the response was probably cut off. ' +
        'Resend the complete block.',
      artifacts,
      prose,
    };
  }

  // More than one block per turn is a protocol violation, but merging them is the
  // charitable read and keeps the session moving.
  const merged = [];
  try {
    for (const b of opBlocks) merged.push(...parseDaOps(b.body));
  } catch (err) {
    return { ops: null, parseError: err.message, artifacts, prose };
  }

  return { ops: merged, parseError: null, artifacts, prose };
}
