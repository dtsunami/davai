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
| `/events` | harness events emitted vs retired this session |
| `/history [n]` | recent prompts, across sessions |
| `/replay <n>` | run a prompt from `/history` again |
| type while it works | steer the run — applied at the next turn, not a new request |
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

### Steering

The composer stays live while a run is in flight. Anything you type is queued as a
*steer* and folded into context at the next step boundary, labelled so the model treats
it as superseding the earlier instruction rather than as a follow-up request. A steer
that lands while the model is wrapping up keeps the loop going instead of being answered
on your next prompt.

It deliberately does not interrupt the request in flight: aborting mid-stream throws away
tokens already paid for, and the model cannot act on a correction until it is between
turns anyway. Use `esc` when you want it to stop now. Slash commands still run
immediately while busy — `/context` mid-run is the point of them.

The spinner carries a meter while it works:

```
⠋ thinking… 12.4s · 1.8k chars · 640 thought · 2 ops (esc to cancel, type to steer)
```

Elapsed API time, characters streamed, reasoning characters counted separately (they are
billed and streamed but never appear in the answer), and ops run — all for the request in
flight, not the session.

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

Prompts themselves are kept separately, in `$DAVAI_HOME/history.jsonl`: the up arrow
reaches across sessions, `/history` lists them with a number, and `/replay <n>` runs
one again (`-1` being the most recent). Only prompts are recorded — slash commands and
`sh` lines operate the tool rather than asking it anything. The file is capped at 500
entries and safe to delete.

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
| openai | `OPENAI_API_KEY` | Responses API, reasoning summaries, effort, cached input |
| gemini | `GEMINI_API_KEY` | thought summaries, cached input |
| grok | `XAI_API_KEY` | Chat Completions; no reasoning summaries on grok-4 |

davai ships a small table of model metadata for pricing and defaults, but it is a
seed, not an authority — a hardcoded model list is wrong the moment a provider ships
something new. An unrecognized model id is assumed real and its limits are fetched
from the provider. `davai --models` lists what is actually available.

### Reasoning

`DAVAI_THINKING=true` shows the model's reasoning in a panel above the answer while it
streams. The models reason either way; the flag only decides whether you get to watch.
What each provider can actually send back differs:

- **Anthropic** streams summarized thinking, requested via `thinking.display`.
- **OpenAI** streams reasoning summaries, which only the Responses API can return —
  so that is the default adapter. `DAVAI_OPENAI_API=chat` falls back to Chat
  Completions and loses them. Your organisation may need to be verified with OpenAI
  before summaries arrive at all; nothing breaks if they don't.
- **Gemini** returns thought parts only when asked (`thinkingConfig.includeThoughts`),
  though it bills `thoughtsTokenCount` regardless.
- **Grok** exposes nothing on grok-4. `reasoning_content` is handled for xAI's smaller
  reasoning models, but there is no equivalent of a summary stream. If you want visible
  rationale there, ask for it in the preamble — see [Prompts](#prompts).

Thoughts are shown, never stored: they are not written to the session transcript and
not restored by `--resume`.

## Project instructions

Drop a `DAVAI.md` (or `AGENTS.md`, or `CLAUDE.md`) in the working directory and it is
included in the grounding, alongside the directory listing, git state and detected
build tooling.

## Prompts

There are six, and each is a markdown file you can replace:

| prompt | file | what it is |
|---|---|---|
| preamble | `preamble.md` | who the assistant is and how it writes |
| protocol | `protocol.md` | the whole `da_ops` specification |
| ops result | `ops_result.md` | wraps each `da_results` block — needs `{results}` |
| nudge | `nudge.md` | sent when a turn produced no ops and no conclusion |
| steer | `steer.md` | wraps a mid-run correction — needs `{text}` |
| repair | `repair.md` | sent when a block did not parse — needs `{error}` |

Each prompt resolves on its own, and the highest layer that has the file wins:

1. built-in, in [src/agent/prompt.js](src/agent/prompt.js)
2. `$DAVAI_HOME/prompts/<file>`: your defaults, for every project
3. `./.prompts/<file>`: this project only

Files are read verbatim, so quotes, backslashes and backticks need no escaping. `/prompts`
shows which layer each prompt comes from. `/prompts export` writes the resolved prompts to
`./.prompts/` as a starting point, and refuses to overwrite existing files without
`--force`. The grounding (directory listing, git state, `DAVAI.md`) is generated each
launch and is not a prompt file.

The old `DAVAI_PROMPT_*` variables are no longer read; davai warns at startup if one is
still set.

A project's `./.prompts` is loaded without asking, and a cloned repo can ship one. Read it
before running davai in an unfamiliar repo, especially with `--yolo`.

Overrides are validated at startup, not on first use: one that is empty, unreadable, or
drops its `{placeholder}` stops the session with an explanation.
That last check matters — a `{results}`-less template would send the model a friendly
sentence and none of the output it asked for.

The system prompt is the cached prefix, so prompts are resolved once at startup and
never re-read mid-session; editing a prompt file takes effect on the next run.

Two cautions. Replacing `protocol.md` replaces the contract [the parser](src/agent/parser.js)
implements, so the model can quite easily stop emitting anything davai can execute —
start from the default text. And the ops-result prompt rides along with every batch
rather than being cached, so a paragraph there is a paragraph multiplied by every batch
in the session; set it to bare `{results}` for the block alone.

## Development

```bash
npm test          # 248 tests: ops engine, sandbox, parser, prompts, providers, errors, events, loop, stdin, context, resume, history, UI
npm run test:watch
npm run lint      # eslint, flat config in eslint.config.js
```

The agent, context and provider layers are Ink-free and testable without a terminal;
the UI is a view over state the harness owns. `--print` and `--json` run the same
loop with no React loaded at all.

### Pending emits

An `EventEmitter` never complains about an emit with no listener, and that is how `nudge`,
`thinking` and `retry` all shipped wired at one end only: emitted, documented, consumed by
nobody, silent. Three things now stand in the way.

`EVENTS` in [loop.js](src/agent/loop.js) is the declared list, in code rather than a
comment. [test/events.test.js](test/events.test.js) holds it against both front ends: every
emitted event must be declared, must have a TUI listener, and must be handled in headless
mode or carry a written reason for being ignored. It also fails on a listener for an event
nothing emits, so a rename cannot leave a dead handler behind. That check is static, so it
catches a cold path — a reasoning summary or a 503 retry — without needing one to happen.

At runtime the agent counts every emission and whether anything was listening. `/events`
shows the table, the session exit line names anything that went nowhere, and the first
occurrence of each is written to the transcript as `unretired-emit`. `DAVAI_STRICT_EVENTS=true`
turns it into a thrown error instead, for when you are working on the harness itself.

Neither catches the related shape — a computed field nothing reads, as `ProviderError.retryable`
was for a while. `no-unused-vars` runs with `args: 'after-used'`, which covers the parameter
version of that mistake, but a dead property still needs a reader.
