# davai

An agentic CLI REPL for engineering work. Multi-provider, no agent framework, and
no tool-calling API — every action the model takes is a `da_ops` block that davai
validates as an atomic, reversible batch.

```
❯ slugify is incomplete — it should collapse non-alphanumeric runs into hyphens.
  Fix it, add tests, and run them.

  · read: slug.js
  · replace: slug.js
  · write: test.js
  · shell: node --test

  ▲ shell command needs approval
  $ node --test
    y run · n deny · e edit first · this cannot be undone

  ✓ slug.js edited (+4 lines)
  ✓ test.js created (22 lines)
  ✓ $ node --test (exit 0, 412ms)

All 7 tests pass. slug.js now lowercases, collapses each run of non-[a-z0-9]
characters into a single hyphen, then strips leading and trailing hyphens.

demo · claude-opus-5-5/high · ████░░░░░░ 4% 41.2k/1.0M · 3t 5ops · $0.14
```

## Install

Needs Node 22+.

```bash
npm install
npm link          # puts `davai` on your PATH
cp .env.example ~/.davai/.env
$EDITOR ~/.davai/.env   # add your API key
```

## Use

```bash
davai                              # interactive REPL in the current directory
davai "fix the type errors"        # one-shot, then exit
echo "check git status" | davai    # read the request from stdin
davai --print "add a test"         # plain text out, no TUI
davai --json "add a test"          # newline-delimited JSON events
davai --models                     # what the provider actually serves
davai --sessions                   # recent sessions
davai --yolo "run the test suite"  # shell commands without the approval prompt
davai --resume                     # reopen the most recent session
davai --resume 9ffcf35f            # reopen one by id, or any unique prefix
davai --config                     # resolved configuration
```

### In the REPL

| | |
|---|---|
| `sh <cmd>` | run a command; its output is added to context |
| `/model` | model, provider and effort — applied live |
| `/context` · `ctrl+g` | context breakdown, drop or pin segments |
| `/artifacts` · `ctrl+a` | code blocks the model emitted; copy or save |
| `/image [path]` | attach an image (no path = clipboard, Windows) |
| `/compact` | compact context now |
| `/clear` | drop the conversation, keep the grounding |
| `/yolo` | auto-approve shell commands for this session |
| `esc` | cancel the running turn |
| `ctrl+s` | shell mode |
| `tab` | complete `@paths` and `/commands` |
| `shift+enter` | newline instead of submit |

Multi-line pastes become `[[paste#N: 42 lines]]` in the input and expand on submit,
each as its own context segment you can drop individually.

## How it works

### No tool-calling

The model has no tool API. It emits a `da_ops` block; davai parses, validates and
applies it. The envelope is JSON, but multi-line content lives in out-of-band payload
blocks so code keeps its exact whitespace and needs no escaping:

````
```da_ops
{"ops": [
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
```
````

Nine ops: `read`, `list`, `grep`, `glob`, `write`, `replace`, `delete`, `move`,
`shell`.

### Atomic batches

Every batch runs in two phases. **Plan** validates all of it — paths, existence,
whether `old` matches exactly once, whether two ops conflict — and touches nothing.
If anything fails, nothing is applied and the model is told which op and why.
**Apply** then snapshots each file, journals the intent, and writes through a temp
file plus rename. A failure mid-apply replays the journal backwards.

`shell` is the exception. It cannot be undone, so it is segregated: file ops commit
first, then each shell command stops for human approval, one at a time. A denied or
failed command kills the rest of the batch.

#### yolo mode

Approval is a hook, not a hard-coded prompt, so the front end decides the policy:

```bash
davai --yolo                  # this run, REPL or headless
DAVAI_YOLO=true               # every run, in $DAVAI_HOME/.env
/yolo                         # toggle inside a running session
```

Only the prompt goes away. The write jail, the read allowlist, `.daignore` and the
shell timeout all still apply, and every auto-approved command is printed to the
transcript and logged. The status bar shows a red `yolo` the whole time it is on.

It is deliberately never written to `settings.json` and never restored by `--resume`:
it lasts for one run or one toggle, so it cannot silently outlive the task it was
turned on for. In headless mode `--yes` and `--yolo` mean the same thing.

### Boundaries

Writes are confined to the working directory subtree. Reads additionally cover
`DAVAI_RO_DIRS`. Containment is checked against the resolved realpath, so symlinks,
NTFS junctions and `..` cannot escape. `.daignore` filters everything further.

### Context

Context is a list of typed, individually addressable segments rather than an opaque
message array, which is what makes `ctrl+g` a table render rather than a feature.
Auto-compaction at 75% evicts file-read results first (they are the biggest consumers
and re-derivable), then truncates shell output and pastes, then summarizes the oldest
turns with a cheap model. The system prompt and grounding are never rewritten — doing
so would invalidate the prompt cache and cost more than the compaction saves.

### Sessions

Everything lands in `$DAVAI_HOME/sessions/<timestamp>-<id>/`:

```
meta.json         provider, model, cwd, token and cost totals
transcript.jsonl  every event: turns, ops, results, approvals, usage, compaction
journal.jsonl     the undo log
snaps/            pre-change file snapshots
```

API keys are redacted on the way in. Sessions are pruned by age and count at startup.

`davai --resume [id]` rebuilds the ledger from a transcript — the events already on disk
*are* the resume format, so there is no second thing to keep in sync. With no id it takes
the most recent session; an id may be any unique prefix. Resume defaults to the working
directory the session ran in, since grounding and the sandbox have to describe the tree
the transcript talks about, and it starts a *new* session directory, so an undo log never
spans two processes.

Pastes, images and operator shell output are not in the transcript and so do not come
back. Compaction is re-derived rather than replayed: a replay is capped at half the
context window, and anything over the threshold is compacted on the next turn by the
normal policy.

## Providers

| Provider | Key | Notes |
|---|---|---|
| anthropic | `ANTHROPIC_API_KEY` | adaptive thinking, effort, prefix caching, exact token counts |
| openai | `OPENAI_API_KEY` | |
| gemini | `GEMINI_API_KEY` | |
| grok | `XAI_API_KEY` | OpenAI-compatible |

davai ships a small table of model metadata for pricing and defaults, but it is a
seed, not an authority — a hardcoded model list is wrong the moment a provider ships
something new. An unrecognized model id is assumed real and its limits are fetched
from the provider. `davai --models` lists what is actually available.

## Project instructions

Drop a `DAVAI.md` (or `AGENTS.md`, or `CLAUDE.md`) in the working directory and it is
included in the grounding, alongside the directory listing, git state and detected
build tooling.

## Prompts

There are five, and every one is replaceable from the environment:

| prompt | variable | what it is |
|---|---|---|
| preamble | `DAVAI_PROMPT_PREAMBLE` | who the assistant is and how it writes |
| protocol | `DAVAI_PROMPT_PROTOCOL` | the whole `da_ops` specification |
| ops result | `DAVAI_PROMPT_OPS_RESULT` | wraps each `da_results` block — needs `{results}` |
| nudge | `DAVAI_PROMPT_NUDGE` | sent when a turn produced no ops and no conclusion |
| repair | `DAVAI_PROMPT_REPAIR` | sent when a block did not parse — needs `{error}` |

Each also takes a `_FILE` variant holding a path, which is the practical choice for
anything multi-line. Inline wins when both are set, matching the rest of davai's
precedence. `davai --config` reports where each prompt came from.

Overrides are validated at startup, not on first use: one that is empty, points at an
unreadable file, or drops its `{placeholder}` stops the session with an explanation.
That last check matters — a `{results}`-less template would send the model a friendly
sentence and none of the output it asked for.

The system prompt is the cached prefix, so prompts are resolved once at startup and
never re-read mid-session; editing a prompt file takes effect on the next run.

Two cautions. Replacing `DAVAI_PROMPT_PROTOCOL` replaces the contract [the parser](src/agent/parser.js)
implements, so the model can quite easily stop emitting anything davai can execute —
start from the default text. And the ops-result prompt rides along with every batch
rather than being cached, so a paragraph there is a paragraph multiplied by every batch
in the session; set it to bare `{results}` for the block alone.

## Development

```bash
npm test          # 140 tests: ops engine, sandbox, parser, prompts, loop, context, resume, UI
npm run test:watch
npm run lint      # eslint, flat config in eslint.config.js
```

The agent, context and provider layers are Ink-free and testable without a terminal;
the UI is a view over state the harness owns. `--print` and `--json` run the same
loop with no React loaded at all.
