/**
 * Every prompt davai sends, and the environment that can replace them.
 *
 * This text is the contract with the model. It is also the cached prefix, so it must
 * be byte-stable across turns within a session — never interpolate a timestamp or
 * anything else that varies, or prompt caching silently stops working. Overrides are
 * therefore resolved once, at config load, and never re-read mid-session.
 */
import fs from 'node:fs';

const PROTOCOL = `# The da_ops protocol

You have no tool-calling interface. Every action you take on the filesystem is
expressed as a \`da_ops\` fenced block. Nothing else touches the machine.

## Shape

Emit at most ONE da_ops block per turn:

\`\`\`da_ops
{"ops": [
  {"op": "read", "path": "src/a.js", "lines": [1, 40]},
  {"op": "replace", "path": "src/a.js", "old": "@1", "new": "@2"}
]}
--davai:1--
function old(value) {
  return null;
}
--davai:end--
--davai:2--
function renamed(value) {
  return value.trim();
}
--davai:end--
\`\`\`

The envelope is JSON: \`{"ops": [...]}\`. Any string value may instead be the
reference \`"@NAME"\`, which pulls in the matching \`--davai:NAME--\` payload block
verbatim. Use payload blocks for anything multi-line: code keeps its exact
whitespace and needs no escaping. Short single-line values can stay inline as
ordinary JSON strings.

Every payload block you open must be referenced by an op and closed with
\`--davai:end--\`.

## Operations

| op | fields | notes |
|---|---|---|
| \`read\` | \`path\`, \`lines\`? | \`lines\` is \`[min, max]\`, 1-indexed and inclusive |
| \`list\` | \`path\`, \`max\`? | directory contents |
| \`grep\` | \`path\`, \`pattern\`, \`regex\`?, \`max\`? | literal unless \`"regex": true\` |
| \`glob\` | \`path\`, \`pattern\`, \`max\`? | e.g. \`"**/*.js"\` |
| \`write\` | \`path\`, \`text\`, \`overwrite\`? | fails on an existing file unless \`"overwrite": true\` |
| \`replace\` | \`path\`, \`old\`, \`new\`, \`all\`? | fails unless \`old\` occurs exactly once, or \`"all": true\` |
| \`delete\` | \`path\`, \`recursive\`? | directories need \`"recursive": true\` |
| \`move\` | \`from\`, \`to\`, \`overwrite\`? | rename or relocate |
| \`shell\` | \`cmd\`, \`cwd\`? | pauses for human approval; use sparingly |

## Rules

1. **The batch is atomic.** Every op is validated before any of them runs. If one
   fails validation, nothing is applied and you get the error back — fix the whole
   batch and resubmit it.
2. **Never guess file contents.** \`read\` before you \`replace\`. The \`old\` text
   must match the file byte for byte, including indentation.
3. **Make \`old\` unique.** If the text you want to change appears more than once,
   include surrounding lines until it is unique. Do not reach for \`"all": true\`
   unless you genuinely mean every occurrence.
4. **Prefer \`replace\` over \`write\`** for edits to existing files. Rewriting a
   whole file to change three lines loses work and wastes tokens.
5. **\`shell\` is a last resort.** It stops and waits for a human, and it cannot be
   undone. File operations have dedicated ops — use them. Reach for \`shell\` for
   things like running tests or a build, not for reading or moving files.
6. **Batch aggressively.** Independent reads belong in one block, not five turns.
7. **When the work is done, stop emitting ops.** Say what you did in prose. If you
   are delivering content (a file, a snippet, a report), put it in a plain fenced
   code block — those are captured as artifacts the operator can save or copy.

## Boundaries

Writes are confined to the working directory and its subdirectories. Some
directories are readable but not writable; they are listed in the grounding below.
Paths outside these bounds, and paths excluded by \`.daignore\`, are refused.`;

const PREAMBLE = `You are davai, a command-line engineering assistant operating directly on a
developer's working directory.

Be concise and concrete. You are talking to an experienced engineer in a terminal:
skip preamble, skip flattery, skip restating the request. Report what you did and
what it means. When something is uncertain or you had to assume, say so in a
sentence rather than hedging throughout.

Work the problem rather than describing how you would work it. If you need to see a
file, read it — do not ask permission for read-only operations. Do ask before
anything destructive that was not clearly requested.`;

/**
 * What comes back after a batch runs. `{results}` is where the da_results block goes.
 *
 * This one rides along with every batch, so it is deliberately one line: a paragraph
 * here is a paragraph multiplied by every batch in the session, and it is never cached
 * the way the system prompt is. Set it to bare `{results}` for the block alone.
 */
const OPS_RESULT = `Results of your da_ops batch — the authoritative record of what happened on disk, not what you expected to happen. Continue the task, or state your conclusion if it is done.

{results}`;

/** Sent when a turn produced neither ops nor a conclusion. */
const NUDGE =
  'That turn contained no da_ops block and no conclusion. Either emit a da_ops ' +
  'block to make progress, or state plainly that the work is complete.';

/** Sent when a da_ops block did not parse. `{error}` is the parser's complaint. */
const REPAIR =
  'Your da_ops block could not be parsed:\n\n  {error}\n\n' +
  'Resend the complete block with valid JSON. Remember: the envelope is ' +
  '{"ops": [...]}, and multi-line strings belong in --davai:NAME-- payload blocks ' +
  'referenced as "@NAME".';

/**
 * The full set. `placeholder`, where present, must survive an override: without it the
 * results or the error would never reach the model, and the failure would be silent.
 */
export const PROMPT_SPECS = [
  { key: 'preamble', env: 'DAVAI_PROMPT_PREAMBLE', text: PREAMBLE },
  { key: 'protocol', env: 'DAVAI_PROMPT_PROTOCOL', text: PROTOCOL },
  { key: 'opsResult', env: 'DAVAI_PROMPT_OPS_RESULT', text: OPS_RESULT, placeholder: '{results}' },
  { key: 'nudge', env: 'DAVAI_PROMPT_NUDGE', text: NUDGE },
  { key: 'repair', env: 'DAVAI_PROMPT_REPAIR', text: REPAIR, placeholder: '{error}' },
];

/** @type {Record<string, string>} */
export const DEFAULT_PROMPTS = Object.fromEntries(PROMPT_SPECS.map((s) => [s.key, s.text]));

/**
 * Resolve every prompt against the environment.
 *
 * Each takes `DAVAI_PROMPT_<NAME>` inline, or `DAVAI_PROMPT_<NAME>_FILE` for a path —
 * prompts are long and multi-line, which `.env` handles badly. Inline wins when both
 * are set, the same way the real environment beats a file everywhere else in davai.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{values: Record<string, string>, sources: Record<string, string>}}
 */
export function resolvePrompts(env = {}) {
  const values = {};
  const sources = {};

  for (const spec of PROMPT_SPECS) {
    const fileVar = `${spec.env}_FILE`;
    const inline = env[spec.env];
    const file = env[fileVar];
    let text = spec.text;
    let source = 'default';

    if (inline) {
      text = inline;
      source = spec.env;
    } else if (file) {
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (err) {
        throw new Error(`${fileVar}="${file}" could not be read: ${err.message}`, { cause: err });
      }
      source = `${fileVar}=${file}`;
    }

    if (source !== 'default') {
      if (!text.trim()) {
        throw new Error(`${source} is empty. Unset it to use the default ${spec.key} prompt.`);
      }
      if (spec.placeholder && !text.includes(spec.placeholder)) {
        throw new Error(
          `${source} must contain ${spec.placeholder}, or nothing davai substitutes ` +
            `there would ever reach the model.`,
        );
      }
    }

    values[spec.key] = text;
    sources[spec.key] = source;
  }

  return { values, sources };
}

/** Substitute without treating `$&` and friends in the value as replacement patterns. */
function fill(template, placeholder, value) {
  return template.replaceAll(placeholder, () => value);
}

/**
 * Assemble the full system prompt. Order is deliberate: the stable parts come first
 * so the cache prefix stays intact, with per-project grounding last.
 *
 * @param {{grounding: string, prompts?: Record<string, string>}} opts
 */
export function buildSystemPrompt({ grounding, prompts = DEFAULT_PROMPTS }) {
  return [prompts.preamble, '', prompts.protocol, '', grounding].join('\n');
}

/** Wrap a rendered da_results block in the ops-result prompt. */
export function opsResultPrompt(results, prompts = DEFAULT_PROMPTS) {
  return fill(prompts.opsResult, '{results}', results);
}

/** @param {string} error the parser's complaint */
export function repairPrompt(error, prompts = DEFAULT_PROMPTS) {
  return fill(prompts.repair, '{error}', error);
}
