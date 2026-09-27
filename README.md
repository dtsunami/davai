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

## Development

```bash
npm test          # 96 tests: ops engine, sandbox, parser, context, UI
npm run test:watch
```

The agent, context and provider layers are Ink-free and testable without a terminal;
the UI is a view over state the harness owns. `--print` and `--json` run the same
loop with no React loaded at all.
