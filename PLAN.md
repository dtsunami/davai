# davai — Implementation Plan

Target: a JavaScript CLI REPL/TUI agentic coding assistant, loosely based on the legacy Python `da_code`
REPL, satisfying the 15 requirements in [repl_agent.md](repl_agent.md).

Architecture decisions taken up front:

| Concern | Decision |
|---|---|
| Agent harness | Hand-rolled. No LangChain / agno / Agent SDK. |
| TUI | **Ink** (React for CLI) + `ink-text-input`. "No frameworks" applies to the agent harness, not the renderer. |
| Provider clients | **Official SDKs**: `@anthropic-ai/sdk`, `openai` (also serves Grok via `baseURL`), `@google/genai`. |
| Undo model | **Journal + content snapshots** under `$DAVAI_HOME/sessions/<id>/`. No git dependency. |
| Tool interface | None. All model-driven actions arrive as `da_ops` fenced blocks (req 8). |

---

## Phase 0 — Toolchain and scaffold

1. ~~Install Node.js~~ **Done** — Node **v24.21.0** / npm **11.19.0** at `C:\Program Files\nodejs`.
   Caveat: shells and IDE windows opened before the install carry a stale `PATH` and won't resolve `node`.
   Restart them.
2. `npm init`, ESM (`"type": "module"`), `bin: { davai: "./bin/davai.js" }`, `npm link` for local dev.
3. Dependencies — deliberately small:
   - `ink`, `react`, `ink-text-input`, `ink-spinner` (UI)
   - `@anthropic-ai/sdk`, `openai`, `@google/genai` (providers)
   - `dotenv`, `picomatch` (`.daignore` and the `glob` op), `cli-highlight` (code blocks)
   - dev: `vitest`, `eslint`, `prettier`
4. JS with JSDoc types + `checkJs` via `jsconfig.json` — type safety without a build step, so the REPL
   starts instantly. If you'd rather have TypeScript, decide now; retrofitting later is churn.

**Exit criteria:** `davai --version` runs.

---

## Repository layout

```
davai/
  bin/davai.js                  # shebang, arg parse, bootstrap
  src/
    config/
      env.js                    # DAVAI_HOME resolution, .env load, validation
      models.js                 # model registry: ids, ctx window, price, vision, effort support
      settings.js               # runtime-mutable settings, persisted to $DAVAI_HOME/settings.json
    providers/
      index.js                  # name -> adapter factory
      base.js                   # contract: send({system, messages, signal}) -> AsyncIterable<Event>
      anthropic.js openai.js grok.js gemini.js
      normalize.js              # content parts (text/image) + usage normalization
    agent/
      loop.js                   # the harness: turn -> parse -> execute -> feed back -> repeat
      prompt.js                 # system prompt + da_ops protocol spec
      grounding.js              # first-prompt project grounding (req 4)
      parser.js                 # fenced-block scanner -> da_ops | artifacts
      ops/
        schema.js               # per-op shape validation
        planner.js              # two-phase: validate whole batch before touching disk
        executor.js             # apply, rollback on any failure
        read.js write.js replace.js list.js grep.js glob.js shell.js delete.js move.js
      journal.js                # JSONL journal + snapshots + batch rollback
      sandbox.js                # write jail (cwd subtree) + read allowlist (DAVAI_RO_DIRS)
      daignore.js
    context/
      ledger.js                 # typed, individually addressable context segments
      tokens.js                 # counting + post-call reconciliation from usage
      compact.js                # auto-compact policy
      artifacts.js pastes.js shellctx.js
    session/
      log.js resume.js          # $DAVAI_HOME/sessions/<id>/
    ui/
      App.jsx Transcript.jsx Composer.jsx StatusBar.jsx
      ContextPane.jsx ModelPane.jsx ArtifactPane.jsx ApprovalPane.jsx
      theme.js markdown.js
    headless.js                 # --print / --json mode: same loop, no Ink
  test/
```

Everything under `src/agent/`, `src/context/` and `src/providers/` is Ink-free and unit-testable. The UI is
a view over state the harness owns — not the other way round. That split is what makes `--print` mode free.

---

## Phase 1 — Config + provider layer

**Config (req 2).** `DAVAI_HOME` defaults to `~/.davai`. Load `$DAVAI_HOME/.env` (not cwd — this is
per-operator config, not per-project), then overlay real environment variables. Validate and fail loud,
naming the missing key. Recognized keys:

```
DAVAI_HOME              # bootstrap only, read from the real environment
DAVAI_PROVIDER          # anthropic | openai | gemini | grok
DAVAI_MODEL             # overrides the provider default
DAVAI_RO_DIRS           # pathlike: ';' on win32, ':' elsewhere (req 5)
DAVAI_EFFORT            # low|medium|high|xhigh|max  (mapped per provider)
DAVAI_MAX_TOKENS  DAVAI_TEMPERATURE  DAVAI_SHELL_TIMEOUT
DAVAI_CONTEXT_LIMIT     # override the registry's window
DAVAI_COMPACT_AT        # fraction, default 0.75
ANTHROPIC_API_KEY  OPENAI_API_KEY  GEMINI_API_KEY  XAI_API_KEY
HTTP_PROXY HTTPS_PROXY NO_PROXY      # the legacy .env shows a corporate proxy — must keep working
```

**Model registry (`config/models.js`)** — one table drives the `/model` pane, the context bar, cost display
and vision gating. Seed values:

| Provider | Model | Notes |
|---|---|---|
| anthropic | `claude-opus-5` (default) | 1M ctx, vision, `thinking: {type:"adaptive"}`, `output_config.effort` |
| anthropic | `claude-sonnet-5`, `claude-haiku-4-5` | alternates; Haiku is the compaction/summarizer model |
| openai | current GPT frontier model | fill in at implementation time from `/v1/models` |
| gemini | current Gemini Pro / Flash | same |
| grok | current Grok | OpenAI-compatible: `openai` SDK with `baseURL: "https://api.x.ai/v1"` |

Only the Anthropic rows are pinned here because those are the ones I verified. **Query each other
provider's models endpoint when you write its adapter rather than hardcoding IDs from memory** — that is
where this kind of table rots first.

**Provider contract (`providers/base.js`).** One function, one normalized event stream:

```js
// send({ system, messages, images, signal }) -> AsyncIterable<
//   { t:'text',     delta }                        // assistant prose, streamed
//   { t:'thinking', delta }                        // if the model exposes it
//   { t:'usage',    in, out, cacheRead, cacheWrite }
//   { t:'stop',     reason }                       // end_turn | max_tokens | refusal | cancelled
// >
```

Because `da_ops` replaces tool-calling entirely (req 8), each adapter needs only streaming text, image
parts, usage and cancellation. That is a small surface — roughly 80–120 lines per provider.

Adapter specifics worth knowing before you write them:

- **Anthropic** — `client.messages.stream(...)`. Default `claude-opus-5`. Use
  `thinking: {type: "adaptive"}`; `budget_tokens` is **rejected with a 400** on current models. Effort goes
  in `output_config: {effort}`, not top-level. Reasoning streams empty unless you set
  `thinking.display: "summarized"`. Handle `stop_reason: "refusal"` — it arrives as HTTP 200, so check it
  before reading content. Put the stable prefix (system + protocol + grounding) first and mark it
  `cache_control: {type: "ephemeral"}`: a REPL resends history every turn, so caching that prefix is the
  single largest cost lever available.
- **OpenAI / Grok** — one adapter, `baseURL` swap. Watch for reasoning-model parameter differences.
- **Gemini** — different content shape (`parts`, `inlineData` for images). Keep that translation in
  `normalize.js` rather than scattering it through the adapter.
- Set `maxRetries` and a generous timeout on each client; let the SDKs own backoff.

**Exit criteria:** `davai --print "say hi"` streams a reply from any of the four providers.

---

## Phase 2 — The `da_ops` engine (req 8)

The heart of the design, and worth building and testing *before* any UI exists.

### 2a. Protocol — three spec gaps to close first

The block in `repl_agent.md` is illustrative, not parseable. Three fixes:

1. **`{ [ ... ] }` is not valid JSON.** Use `{"ops": [ ... ]}`.
2. **`"""triple quoted"""` is Python, not JSON.** Multi-line code inside a JSON string means every newline
   and quote must be escaped — token-expensive, unreadable in the transcript, and the single thing models
   get wrong most often. Recommendation: keep a JSON envelope, move payloads out of band:

````
```da_ops
{"ops": [
  {"op": "replace", "path": "src/a.js", "old": "@1", "new": "@2"},
  {"op": "write",   "path": "src/b.js", "text": "@3"}
]}
--davai:1--
def old_func(value):
    return None
--davai:end--
--davai:2--
def new_func(value: str):
    return "new_func worked"
--davai:end--
--davai:3--
console.log("verbatim, nothing escaped");
--davai:end--
```
````

   Payloads are verbatim — no escaping, exact whitespace, diff-legible in the transcript. The envelope
   stays strictly machine-checkable. Short single-line values may still be written inline as ordinary JSON
   strings, so the simple cases stay simple. The parser should also accept plain JSON with escaped newlines
   as a fallback, so a model that ignores the convention still works.
3. **`replace` needs stated semantics.** Fail the op when `old` matches **zero or more than one** time; that
   ambiguity is where silent corruption comes from. Add explicit `{"all": true}` to opt into multi-replace.

Further spec decisions to make (my defaults in bold):

- `write` to an existing path: **require `"overwrite": true`**, otherwise fail. Prevents accidental clobber.
- `read` `lines: [min, max]`: **1-indexed, inclusive**. State it in the system prompt.
- `grep` / `glob` use `"text"` for the pattern; **rename to `"pattern"`**, accepting `"text"` as an alias.
  Add `{"regex": true}` to `grep`; default literal.

### 2b. Op reference

Nine ops. `delete` and `move` are added to the set in `repl_agent.md` — without them the model routes
routine file work through `shell`, which pauses for human approval every time, for operations that are
perfectly reversible via the journal.

| Op | Shape | Side effect | Reversible |
|---|---|---|---|
| `read` | `{"op":"read","path":P,"lines":[min,max]?}` | none | n/a |
| `list` | `{"op":"list","path":P,"max":N?}` | none | n/a |
| `grep` | `{"op":"grep","path":P,"pattern":S,"regex":false,"max":N?}` | none | n/a |
| `glob` | `{"op":"glob","path":P,"pattern":S,"max":N?}` | none | n/a |
| `write` | `{"op":"write","path":P,"text":S,"overwrite":false}` | creates/replaces | snapshot |
| `replace` | `{"op":"replace","path":P,"old":S,"new":S,"all":false}` | edits | snapshot |
| `delete` | `{"op":"delete","path":P,"recursive":false}` | unlinks | snapshot |
| `move` | `{"op":"move","from":P,"to":P,"overwrite":false}` | renames | inverse rename |
| `shell` | `{"op":"shell","cmd":S,"cwd":P?}` | arbitrary | **no** — needs approval |

`delete` — snapshot bytes before unlinking, then restore on rollback. Files only unless
`"recursive": true`, which snapshots the whole subtree; cap that by total size and refuse past the cap
rather than filling the session directory. Refuse on anything the write jail or `.daignore` excludes.

`move` — both `from` and `to` must sit inside the write jail. Rollback is the inverse rename, so the
journal records both paths. If `to` exists, require `"overwrite": true` and snapshot the file being
replaced. Cross-device renames fall back to copy-then-unlink; the journal must record which path was
taken, or rollback restores the wrong side.

### 2c. Sandbox (req 5) — `agent/sandbox.js`

- **Write root** = `process.cwd()` subtree, no exceptions.
- **Read allowlist** = write root + every entry of `DAVAI_RO_DIRS`.
- Resolve with `fs.realpath` *before* the containment check, so symlinks, junctions and `..` cannot escape.
  On win32, compare case-insensitively and normalize `\\?\` prefixes and drive letters.
- Enforce at one boundary: a single `resolveForRead(p)` / `resolveForWrite(p)` pair that every op calls.
  Never let an op do its own path math.
- `.daignore` (reuse the legacy file's patterns) filters `list`, `grep` and `glob` results, and blocks `read`.
- `shell` runs with cwd = write root but is **not** containable — which is exactly why it needs approval.

Write the adversarial tests here first: `../`, absolute paths, symlink-to-parent, NTFS junction, UNC path,
`C:/Windows/System32/...`, and a `.daignore`d `.env`.

### 2d. Atomic and reversible batch execution

Two phases, never interleaved.

**Plan** (`ops/planner.js`) — no disk writes. Validate every op: schema, path containment, target exists or
doesn't as required, `old` matches exactly once, every payload sigil resolves, no two ops write the same
file in conflicting ways. Any failure means **nothing is applied**, and a structured `da_results` block goes
back to the model naming the failing op index and the reason — req 8's "the batch is killed and llm is
prompted to resubmit".

**Apply** (`ops/executor.js`) — in submitted order, per mutating op:

1. Snapshot current bytes to `sessions/<id>/snaps/<seq>-<basename>`.
2. Append the journal entry (pre-snapshot path, post-content hash) and fsync it.
3. Write to a temp file in the same directory, fsync, then `rename` over the target — atomic on NTFS and
   POSIX alike.

Any throw mid-apply replays the journal backwards, restoring snapshots, then reports. Rollback is scoped to
the batch — there is deliberately no operator-facing session-wide revert (see Phase 6).

**Shell is segregated.** It is not reversible, so it never joins the rollback set. A batch containing shell
ops applies its file ops atomically first, then queues each shell op for approval one at a time — approve,
deny, or edit-then-run. A denied or failed shell op kills the remainder of the batch.

**Read-type ops** (`read`, `list`, `grep`, `glob`) have no side effects; their output is collected into the
`da_results` block and becomes an individually addressable context segment (Phase 5).

**Exit criteria:** a `vitest` suite covering each op, the jail, batch rollback and shell segregation — all
against a temp directory, no model calls.

---

## Phase 3 — The agent loop

`agent/loop.js`, roughly:

```
build first prompt = system + protocol spec + project grounding   (req 4)
loop:
  stream assistant turn from provider
  scan output for fenced blocks (parser.js):
     da_ops block   -> plan, execute, emit da_results, continue loop
     other fenced   -> register as artifact (req 7)
     none           -> turn is complete, hand control back to the operator
  if the model produced neither ops nor a conclusion, nudge once
```

**Grounding (req 4)** — `agent/grounding.js` builds the first-prompt payload from: cwd, OS and shell, git
branch plus dirty count when in a repo, a `.daignore`-filtered directory listing with activity-ranked
subdirectory previews (port the legacy `DirectoryContext` — one of the better parts of `da_code`),
`AGENTS.md` / `DAVAI.md` when present, the detected package manager and test command, and the
`DAVAI_RO_DIRS` list so the model knows what it may read.

**System prompt (`agent/prompt.js`)** — the protocol spec is the highest-leverage text in the product. It
must state: emit exactly one `da_ops` block per turn; ops are validated as a batch and applied
all-or-nothing; never guess file contents, `read` first; `shell` is a last resort that pauses for a human;
and when the work is done, say so in prose with deliverables in a plain fenced block. Include one worked
example.

**Malformed ops** — tolerant parse, then a repair turn quoting the parse error, bounded at two retries
before surfacing to the operator. Track the malformed-block rate per model; it is the metric that tells you
whether the protocol design is working.

**Cancellation** — one `AbortController` per turn, `Esc` aborts. Partial text stays in the transcript,
marked cancelled. A batch mid-apply is *not* abortable; it rolls back or completes.

**Exit criteria:** headless `davai --print "add a hello() to foo.js and run the tests"` completes a real
multi-op session, and rolls back correctly when an op is bad.

---

## Phase 4 — Ink TUI (req 1)

```
+- Transcript (Ink <Static>) ---------------------------------+
|  committed turns, rendered markdown, op summaries, diffs    |
+- Live region ----------------------------------------------+
|  streaming assistant text / spinner / op progress           |
+- Composer -------------------------------------------------+
|  > multiline input, history, @path and !nudge completion    |
+- StatusBar ------------------------------------------------+
|  cwd . provider/model . ctx [####....] 62% . $0.14 . ops 7  |
+------------------------------------------------------------+
```

- Put every committed turn in `<Static>` so Ink never re-renders scrollback. Only the live region, composer
  and status bar reconcile. This is the difference between a responsive REPL and a janky one.
- Windows console: enable VT processing and UTF-8 (`chcp 65001`) at startup, and pick box-drawing glyphs
  that survive the default font. Gate emoji behind a capability check.
- Keys: `Esc` cancel turn, `Ctrl+G` context pane, `Ctrl+A` artifacts, `Ctrl+S` shell-mode toggle,
  `Tab` completion, `Ctrl+C` twice to exit.
- Throttle streaming deltas into a buffer at roughly 30fps; never re-render per token.

**Exit criteria:** an interactive session feels immediate under a fast stream, and resizing reflows cleanly.

---

## Phase 5 — Context management (req 12)

`context/ledger.js` is the spine. Context is never an opaque message array; it is a list of typed segments:

```js
{ id, type, label, tokens, pinned, createdAt, payload }
// type: 'system' | 'protocol' | 'grounding' | 'user' | 'assistant'
//     | 'op-result' | 'shell' | 'paste' | 'artifact' | 'summary'
```

Everything that can enter context does so as a segment with an id — which turns req 12's "granular
management and display" into a table render rather than a feature.

**Display (`ui/ContextPane.jsx`)** — port the legacy Pareto breakdown: segments sorted by token count, a
mini bar per row, percentage of window, colour-graded. Per-row actions: view, pin, drop, summarize.
`Ctrl+G` opens it; the status bar carries the total.

**Counting (`context/tokens.js`)** — estimate with a cheap heuristic for the live bar, then reconcile
against the authoritative `usage` on each response. For Anthropic, `messages.count_tokens` gives exact
pre-flight numbers when it matters. Do not use `tiktoken` for non-OpenAI models.

**Auto-compact (`context/compact.js`)** — fires at `DAVAI_COMPACT_AT` (default 0.75) of the window, in
this order:

1. Evict unpinned `op-result` segments oldest-first. They are re-derivable by re-reading the file, and they
   are almost always the largest consumers.
2. Summarize `shell` and `paste` segments to a few lines, keeping the id so the full text stays in the log.
3. Summarize the oldest user/assistant pairs with Haiku into one `summary` segment.
4. Never touch `system`, `protocol`, `grounding`, or the last three turns.

Two things to get right. Compaction must be **append-only with respect to the cached prefix** — rewriting
the head of the message list destroys prompt caching and costs more than it saves. And every compaction
event is logged to the session, so the operator can see what disappeared and why.

Server-side compaction exists on Anthropic (beta `compact-2026-01-12`) and is worth considering later as an
Anthropic-only accelerator, but the harness needs its own for provider parity.

---

## Phase 6 — Operator surface

**Artifacts (req 7)** — `context/artifacts.js`. Every non-`da_ops` fenced block gets
`{n, lang, lines, text}`. `Ctrl+A` lists them; actions are copy-to-clipboard and save-to-file. Clipboard
with no dependency: `clip.exe` on win32, `pbcopy` on darwin, `wl-copy` / `xclip` on linux. Saving routes
through the write jail and the journal like any other write.

**Pastes (req 14)** — enable bracketed paste. Single-line pastes insert literally. Multi-line pastes are
stored and replaced in the buffer with `[[paste#N: 42 lines]]`; on submit each placeholder expands into its
own `paste` context segment, individually droppable in the context pane. `[[paste#N]]` can be re-referenced
in later prompts.

**`sh` command (req 13)** — `sh <cmd>` at the prompt is operator-initiated, so it runs immediately with no
approval. Output is displayed and added as a `shell` segment with its own token count and a truncation cap.
`Ctrl+S` toggles persistent shell mode with its own history ring.

**`/model` (req 15)** — a pane over the model registry: provider, model, context window, price per MTok,
vision support. Shows current settings and edits model, effort, temperature, max tokens and thinking
display. Writes back to `$DAVAI_HOME/settings.json` and rebuilds the provider client in place — no restart.

**Sessions (req 6)** — `$DAVAI_HOME/sessions/<iso-ts>-<id>/`:

```
meta.json         provider, model, cwd, argv, start/end, token and cost totals
transcript.jsonl  one JSON object per event: user, assistant, ops, results, approvals, usage, compaction
journal.jsonl     the undo log
snaps/            pre-change file snapshots
```

Redact API keys on the way in. `davai --resume <id>` rebuilds the ledger from the transcript;
`davai --sessions` lists them. Prune by age and total size at startup.

**No restore picker.** The legacy `da_code` revision-picker UI is deliberately dropped. Reversibility stays
where req 8 puts it — at the batch boundary, automatic, invisible. The journal and snapshots still exist
and still roll back a failed batch; what's gone is the operator-facing "browse revisions and revert"
surface. Users who want history beyond the current batch use git, which does it better. Keep `snaps/` on
disk anyway: it costs nothing, and manual recovery from a session directory is always possible.

---

## Phase 7 — Vision (req 9)

Sources: `@path/to/img.png` in a prompt, a clipboard image paste (`Get-Clipboard -Format Image` on
Windows), and a dragged path. Gate on the registry's `vision` flag and say so plainly when the active model
can't. Downscale and re-encode to stay under per-provider size limits; each adapter emits its own shape
(Anthropic `{type:"image", source:{type:"base64",...}}`, Gemini `inlineData`, OpenAI `image_url`). Images
become `paste`-class context segments so they appear in the context pane with a real token cost — images
are expensive and otherwise invisible.

---

## Phase 8 — Hardening

- **Tests**: ops engine; sandbox (adversarial paths); journal rollback; parser, including a corpus of
  malformed `da_ops`; ledger and compaction policy; provider adapters against recorded fixtures.
- **Headless mode**: `--print` and `--json` run the same loop with no Ink, which is what makes the loop
  CI-testable and pipeable (`echo "fix the types" | davai`).
- **Docs**: `README.md`, `.env.example`, a `DAVAI.md` grounding template, a `.daignore` template, and a
  `da_ops` protocol reference — the last doubling as the system prompt's source of truth.
- **Telemetry**: per-turn cost and latency in the session log; cumulative cost in the status bar.

---

## Suggested order of work

| # | Deliverable | Depends on |
|---|---|---|
| 1 | Toolchain, scaffold, `--version` | — |
| 2 | Config + model registry | 1 |
| 3 | One provider adapter end-to-end (Anthropic), `--print` | 2 |
| 4 | Sandbox + journal + ops engine, fully unit-tested | 1 |
| 5 | Parser + agent loop, headless multi-op session | 3, 4 |
| 6 | Remaining three adapters | 3 |
| 7 | Ink TUI over the existing loop | 5 |
| 8 | Context ledger + pane + auto-compact | 5, 7 |
| 9 | Artifacts, pastes, `sh`, `/model`, sessions | 7, 8 |
| 10 | Vision | 6, 8 |
| 11 | Hardening, docs | all |

Items 4 and 3/6 are independent — the ops engine needs no model, and the adapters need no filesystem.

---

## Risks

| Risk | Mitigation |
|---|---|
| Node not installed | Phase 0, step 1. Blocks everything. |
| Models emit malformed `da_ops` | Out-of-band payload blocks (no escaping), tolerant parser, bounded repair turns, per-model malformed-rate metric. |
| Ink re-render cost on long transcripts | `<Static>` for committed turns; throttled delta buffer for the live region. |
| Sandbox escape on Windows | `realpath` before containment, case-insensitive compare, junction/UNC/`\\?\` tests written first. |
| No native tool-calling, so the model chats instead of acting | Strong protocol spec with a worked example, plus a "no ops and no conclusion" nudge. |
| Provider drift (models, params) | Single registry table; query each provider's models endpoint rather than hardcoding; adapters isolated to ~100 lines each. |
| Context cost | Cache the stable prefix; keep compaction append-only; evict op-results first. |

---

## Note on the Anthropic adapter

Anthropic is one of four backends here. The verified Anthropic details above — adaptive thinking,
`output_config.effort`, no `budget_tokens`, the refusal stop reason, prefix caching — apply to
`providers/anthropic.js` only. The other three adapters follow their own SDKs' conventions, and
`providers/normalize.js` is where the differences get flattened.
