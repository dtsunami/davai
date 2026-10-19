/**
 * Provider blocks in a .env: several endpoint-and-key sets in one file, one live at a
 * time.
 *
 * config/env.js reads a .env as one flat namespace, so two OpenAI-compatible endpoints —
 * Mistral, a local llama.cpp, DeepSeek — collide on DAVAI_BASE_URL and
 * DAVAI_OPENAI_API_KEY, and the last assignment silently wins. The fix is not another
 * variable. It is to keep every set in the file and have exactly one of them
 * uncommented.
 *
 * That the inactive sets are *ordinary comments* is the whole design. A block-aware
 * reader would have meant a .env that dotenv, `set -a; . ./.env`, Docker and every other
 * tool parse differently from davai — a sentinel that looks like it gates something but
 * doesn't, with the last duplicate quietly in effect. Here the file stays an ordinary
 * .env, switching is a comment/uncomment edit, and nothing is ever deleted: a key pasted
 * six months ago survives every switch since.
 *
 *   #---# mistral
 *   DAVAI_PROVIDER=openai
 *   DAVAI_BASE_URL=https://api.mistral.ai/v1
 *   DAVAI_OPENAI_API_KEY=sk-...
 *   #-end-provider-#
 *
 *   #---# local
 *   #DAVAI_PROVIDER=openai
 *   #DAVAI_BASE_URL=http://127.0.0.1:8080/v1
 *
 * A block runs to the next sentinel, to `#-end-provider-#` (or `#---# end`), or to the
 * end of the file. Anything before the first sentinel is the preamble and is never
 * touched: it holds what applies whichever provider is live. Blocks come after it, so a
 * block's assignment beats the preamble's by dotenv's own last-wins rule — preamble as
 * defaults, block as overrides, with no new precedence rule to learn.
 *
 * Two conventions earn their keep:
 *   - `##` marks a line davai will never uncomment. A single `#` before an assignment
 *     means "disabled setting"; `##` means prose. Without the distinction, enabling a
 *     block would resurrect the comment explaining why a value was abandoned.
 *   - Within one block the *last* assignment of a name is the live one and earlier ones
 *     stay commented, because that is the one dotenv would have used anyway. Uncommenting
 *     all of them would make the visible first line not the value in effect.
 *
 * Pure text in, pure text out. No filesystem here: the atomic write stays in
 * config/envfile.js and all of this is testable without a temp directory.
 */
import { formatAssignment, toLines, joinLines } from './envfile.js';

/**
 * `#---# NAME`, capturing indent, name and whatever else is on the line.
 *
 * The trailing remark is the point: `#---# mistral sucks` is a header an operator will
 * write, and requiring a bare name meant it was not a sentinel at all — the block below
 * it was silently absorbed into the previous one, which then reported every setting in
 * both as a duplicate. A header is a comment; it may say something.
 */
const SENTINEL = /^([ \t]*)#-{3}#[ \t]*(\S+)[ \t]*(.*?)[ \t]*$/;
/** The explicit close. A block does not need one; the next sentinel or EOF will do. */
const END_TAG = /^[ \t]*#-end-provider-#[ \t]*$/i;
/** Prose. Never uncommented, never counted as a setting. */
const IMMUNE = /^[ \t]*##/;
const LIVE = /^([ \t]*)((?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/;
const OFF = /^([ \t]*)#[ \t]?((?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/;

export const END_MARKER = '#-end-provider-#';

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VAR_OK = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The header line that opens a block. */
export function sentinelFor(name) {
  return `#---# ${name}`;
}

/**
 * A block name has to survive being written into a one-line comment and read back, so
 * it cannot contain whitespace. Checked on the way in rather than producing a file that
 * parses back as something else.
 */
export function validateBlockName(name) {
  const n = String(name ?? '').trim();
  if (!NAME_OK.test(n)) {
    throw new Error(
      `"${name}" is not a usable block name — letters, digits, dot, dash and underscore, ` +
        `no spaces (the header is a single "#---# NAME" line).`,
    );
  }
  if (n.toLowerCase() === 'end') {
    throw new Error('"end" is reserved: "#---# end" closes a block.');
  }
  return n;
}

function classify(line) {
  if (IMMUNE.test(line)) return null;
  const live = LIVE.exec(line);
  if (live) {
    return { indent: live[1], prefix: live[2], name: live[3], value: live[4].trim(), enabled: true };
  }
  const off = OFF.exec(line);
  if (off) {
    return { indent: off[1], prefix: off[2], name: off[3], value: off[4].trim(), enabled: false };
  }
  return null;
}

/** Comment a line out, keeping its indentation so the block stays readable. */
function comment(line) {
  const m = /^([ \t]*)(.*)$/.exec(line);
  return `${m[1]}#${m[2]}`;
}

/** The inverse. A line that is not commented comes back unchanged. */
function uncomment(line) {
  const m = /^([ \t]*)#[ \t]?(.*)$/.exec(line);
  return m ? `${m[1]}${m[2]}` : line;
}

/**
 * Only one assignment of a name counts; mark the rest, so enabling can skip them.
 *
 * "The last one" is the rule, because that is the one dotenv would have used — but only
 * among the assignments dotenv can see. A live assignment therefore beats a commented
 * one wherever it sits, and the fallback for a group that is entirely commented — an
 * inert block, or a list of alternatives the operator keeps around — is the last of
 * them. Without the first half, a hand-edited block with its live line above a parked
 * duplicate reported the parked one as effective and the block itself as disabled.
 */
function markShadowed(vars) {
  const chosen = new Map();
  vars.forEach((v, i) => {
    const prev = chosen.get(v.name);
    if (prev === undefined || v.enabled || !vars[prev].enabled) chosen.set(v.name, i);
  });
  vars.forEach((v, i) => {
    v.shadowed = chosen.get(v.name) !== i;
  });
}

/**
 * Every assignment of `name` in one block, or [] when there is only one.
 *
 * A block that collects alternatives — four OpenRouter models, each under the note
 * saying why — is a normal block, not a broken one. Reporting the group lets a view
 * offer the choice instead of hiding all but one behind the word "shadowed".
 */
function choicesFor(vars, name) {
  const group = vars.filter((v) => v.name === name);
  if (group.length < 2) return [];
  return group.map((v) => ({
    value: v.value,
    line: v.line + 1,
    enabled: v.enabled,
    chosen: !v.shadowed,
  }));
}

/**
 * Split .env text into its preamble and its provider blocks.
 *
 * Returns line indices rather than rebuilt text, so every edit below is a targeted
 * substitution into the original array and lines nobody asked about cannot be reflowed.
 *
 * @param {string} text
 * @returns {{lines: string[], blocks: object[], preamble: object[]}}
 */
export function parseBlocks(text) {
  const lines = toLines(text);
  /** @type {object[]} */
  const blocks = [];
  /** @type {object[]} */
  const preamble = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sentinel = SENTINEL.exec(line);
    const closes = END_TAG.test(line) || (sentinel && sentinel[2].toLowerCase() === 'end');
    if (closes) {
      if (current) {
        current.end = i + 1;
        current.closed = true;
        current = null;
      }
      continue;
    }
    if (sentinel) {
      if (current) current.end = i;
      current = {
        name: sentinel[2],
        note: sentinel[3] || '',
        indent: sentinel[1],
        header: i,
        end: lines.length,
        closed: false,
        vars: [],
      };
      blocks.push(current);
      continue;
    }
    const v = classify(line);
    if (!v) continue;
    (current ? current.vars : preamble).push({ ...v, line: i });
  }

  for (const b of blocks) {
    markShadowed(b.vars);
    b.enabled = b.vars.some((v) => v.enabled && !v.shadowed);
  }
  markShadowed(preamble);
  return { lines, blocks, preamble };
}

/**
 * What a view needs to render the file: every block, whether it is live, and which
 * variables it sets.
 *
 * Values come back raw. Masking is the caller's job, and deliberately so — this is the
 * layer that must not decide what a secret looks like, and session/keys.js already owns
 * the one description of a key that may leave the process.
 *
 * @param {string} text
 * @returns {{blocks: Array<{name: string, note: string, enabled: boolean, line: number, closed: boolean,
 *   vars: Array<{name: string, value: string, enabled: boolean}>, shadowed: string[]}>,
 *   active: string[], preamble: string[]}}
 */
export function blockState(text) {
  const { blocks, preamble } = parseBlocks(text);
  return {
    blocks: blocks.map((b) => ({
      name: b.name,
      note: b.note,
      enabled: b.enabled,
      line: b.header + 1,
      closed: b.closed,
      vars: b.vars
        .filter((v) => !v.shadowed)
        .map((v) => ({
          name: v.name,
          value: v.value,
          enabled: v.enabled,
          line: v.line + 1,
          choices: choicesFor(b.vars, v.name),
        })),
      shadowed: b.vars.filter((v) => v.shadowed).map((v) => v.name),
    })),
    active: blocks.filter((b) => b.enabled).map((b) => b.name),
    preamble: preamble.filter((v) => v.enabled && !v.shadowed).map((v) => v.name),
  };
}

/** The effective assignments of one block, whether or not it is live. */
export function blockValues(text, name) {
  const { blocks } = parseBlocks(text);
  const out = {};
  for (const b of blocks) {
    if (b.name !== name) continue;
    for (const v of b.vars) if (!v.shadowed) out[v.name] = v.value;
  }
  return out;
}

/**
 * Make one block live and every other block inert, by commenting and uncommenting only.
 *
 * `name` of null disables all of them, which is how you fall back to the preamble alone.
 * A block that is already in the wanted state contributes no edit, so a no-op switch
 * leaves the file byte for byte identical and editEnvFile declines to write.
 *
 * @param {string} text
 * @param {string|null} name
 * @returns {{text: string, block: string|null, enabled: string[], disabled: string[]}}
 */
export function enableBlock(text, name) {
  const { lines, blocks } = parseBlocks(text);
  const want = name == null ? null : validateBlockName(name);
  if (want !== null && !blocks.some((b) => b.name === want)) {
    const have = blocks.map((b) => b.name).join(', ') || '(none)';
    throw new Error(`no provider block "${want}" in this file — have: ${have}`);
  }

  const out = lines.slice();
  const enabled = [];
  const disabled = [];
  for (const b of blocks) {
    const on = want !== null && b.name === want;
    for (const v of b.vars) {
      // A shadowed duplicate stays commented even in the block being enabled: the file
      // must not come back with two live assignments of the same name.
      const live = on && !v.shadowed;
      if (live && !v.enabled) {
        out[v.line] = uncomment(out[v.line]);
        enabled.push(v.name);
      } else if (!live && v.enabled) {
        out[v.line] = comment(out[v.line]);
        disabled.push(v.name);
      }
    }
  }
  return { text: joinLines(out), block: want, enabled, disabled };
}

/** Strip one layer of matching quotes, so a value matches as it reads on screen. */
function unquote(value) {
  const s = String(value ?? '').trim();
  const m = /^(['"])(.*)\1$/.exec(s);
  return m ? m[2] : s;
}

/**
 * Choose which of several assignments of one name in a block is the effective one.
 *
 * The pane used to render a block holding four candidate models as "shadowed:
 * DAVAI_MODEL, DAVAI_MODEL, DAVAI_MODEL" — the candidates invisible and unreachable
 * without an editor. This is the pick: one-hot within the group, by commenting and
 * uncommenting, like every other edit here.
 *
 * The chosen line is also moved to the end of its group, which is what makes the choice
 * survive a switch away and back. In an inert block every assignment is a comment, so
 * there is no live line to point at and "the last of them" is the only marker a plain
 * .env already has. The prose directly above the line travels with it, or the note
 * explaining one model ends up over another.
 *
 * @param {string} text
 * @param {string} blockName
 * @param {string} varName
 * @param {{line?: number, value?: string}} want  by 1-based line, or by value
 * @returns {{text: string, block: string, name: string, value: string, enabled: boolean}}
 */
export function selectBlockVar(text, blockName, varName, want = {}) {
  const block = validateBlockName(blockName);
  const { lines, blocks } = parseBlocks(text);
  const matches = blocks.filter((b) => b.name === block);
  if (!matches.length) {
    const have = blocks.map((b) => b.name).join(', ') || '(none)';
    throw new Error(`no provider block "${block}" in this file — have: ${have}`);
  }
  const target = matches[matches.length - 1];
  const group = target.vars.filter((v) => v.name === varName);
  if (!group.length) throw new Error(`block "${block}" does not set ${varName}`);

  const pick =
    want.line != null
      ? group.find((v) => v.line === Number(want.line) - 1)
      : group.find((v) => unquote(v.value) === unquote(want.value));
  if (!pick) {
    const have = group.map((v) => unquote(v.value)).join(', ');
    const asked = want.line != null ? `on line ${want.line}` : `"${unquote(want.value)}"`;
    throw new Error(`${varName} in block "${block}" has no assignment ${asked} — have: ${have}`);
  }

  const out = lines.slice();
  // Decided before the edit: a pick never makes an inert block live by itself. That is
  // switchProfile's job, and doing it here would leave a block half-enabled.
  const live = target.enabled;
  for (const v of group) {
    if (v !== pick && v.enabled) out[v.line] = comment(out[v.line]);
  }
  if (live && !pick.enabled) out[pick.line] = uncomment(out[pick.line]);
  if (!live && pick.enabled) out[pick.line] = comment(out[pick.line]);

  const lastLine = group[group.length - 1].line;
  if (pick.line < lastLine) {
    // The run of comment lines immediately above that are not assignments: that is the
    // note for this candidate. Stop at a blank line, at another assignment, or at the
    // block header — those belong to someone else.
    let from = pick.line;
    while (from - 1 > target.header) {
      const above = out[from - 1];
      if (!/^[ \t]*#/.test(above) || classify(above)) break;
      from--;
    }
    const moved = out.splice(from, pick.line - from + 1);
    out.splice(lastLine - moved.length + 1, 0, ...moved);
  }

  return {
    text: joinLines(out),
    block,
    name: varName,
    value: unquote(pick.value),
    enabled: live,
  };
}

function render(assignment, live) {
  return live ? assignment : `#${assignment}`;
}

/**
 * Set one variable inside one block, creating the block if it is not there.
 *
 * The assignment is written live or commented to match the block it lands in, so saving
 * a key for a provider you are not currently using parks it rather than quietly
 * redirecting the session. `live` overrides that; a block created from nothing starts
 * inert unless you say otherwise.
 *
 * Without this, persisting a key through setEnvVars would append a bare assignment after
 * the last block — where it outranks every block in the file and makes the enable/disable
 * machinery look broken.
 *
 * @param {string} text
 * @param {string} blockName
 * @param {string} name
 * @param {string} value
 * @param {{live?: boolean}} [opts]
 * @returns {{text: string, block: string, created: boolean, enabled: boolean}}
 */
export function setBlockVar(text, blockName, name, value, opts = {}) {
  const block = validateBlockName(blockName);
  const varName = String(name ?? '');
  if (!VAR_OK.test(varName)) {
    throw new Error(`"${name}" is not a valid environment variable name`);
  }

  const { lines, blocks } = parseBlocks(text);
  const out = lines.slice();
  const matches = blocks.filter((b) => b.name === block);

  if (!matches.length) {
    const live = opts.live === true;
    const added = [];
    if (out.length && out[out.length - 1].trim() !== '') added.push('');
    added.push(sentinelFor(block));
    added.push(render(formatAssignment(varName, value), live));
    added.push(END_MARKER);
    return { text: joinLines([...out, ...added]), block, created: true, enabled: live };
  }

  // Several blocks may share a name. The last one is the one dotenv would have used.
  const target = matches[matches.length - 1];
  const live = opts.live === undefined ? target.enabled : Boolean(opts.live);
  const hits = target.vars.filter((v) => v.name === varName);

  if (hits.length) {
    for (const v of hits.slice(0, -1)) if (v.enabled) out[v.line] = comment(out[v.line]);
    const last = hits[hits.length - 1];
    out[last.line] = `${last.indent}${render(formatAssignment(varName, value, last.prefix), live)}`;
  } else {
    // Before the closing tag when there is one, so the block does not grow past its end.
    const at = target.closed ? target.end - 1 : target.end;
    out.splice(at, 0, `${target.indent}${render(formatAssignment(varName, value), live)}`);
  }
  return { text: joinLines(out), block, created: false, enabled: live };
}