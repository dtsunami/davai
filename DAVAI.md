# davai

An agentic CLI REPL. See README.md for the full design.

## Conventions

- ESM only (`"type": "module"`), JSDoc types, no build step.
- `src/agent/`, `src/context/` and `src/providers/` must stay Ink-free — the UI is a
  view over state the harness owns, never the other way round.
- Every filesystem path goes through `Sandbox.resolveForRead` / `resolveForWrite`.
  No op does its own path math.
- Mutating ops snapshot to the journal before they write, so a batch can roll back.
- `src/server/` and `src/session/` are Ink-free too. A view — Ink or browser — drives the
  session through `session/dispatch.js` and observes it through `session/bus.js`. Neither
  view owns state; both are subscribers, and the harness is the single writer.

## The web sidecar

`davai --web [--port N] [--host ADDR]` serves the running session over HTTP alongside the
REPL. The REPL remains the better driver; the browser adds plots, a scrollable transcript
and remote access.

- SSE downstream (`GET /api/events`), POST upstream. The stream is append-only, so
  `Last-Event-ID` gives reconnect-and-replay for nothing — which is what makes it usable
  from a phone on a bad connection.
- One dispatcher, two renderers. Slash commands, steering, pastes and image refs are
  shared; `/api/commands` serves the REPL's own table so completion cannot drift.
- Loopback by default, bearer token on every request. Remote access is a tunnel's job
  (`ssh -L`, Tailscale). Binding off-loopback with `--yolo` is refused: yolo makes the
  approval pane a no-op, so the combination is an unauthenticated remote shell.
- Configurable from `.env` as `DAVAI_WEB`, `DAVAI_WEB_PORT`, `DAVAI_WEB_HOST` and
  `DAVAI_WEB_TOKEN`; `--web` / `--web-host` override them. A fixed token is opt-in
  because the safe default is a fresh one per run.
- Approvals are brokered by the bus, so the REPL and any number of browsers race for the
  same request and the first answer wins. A late answer reports `stale`, not an error.
  The loser has to be *told*: the bus stamps `id` onto the request object itself and
  publishes `approval-resolved`, and App.jsx clears its pane on that. Winning the race
  silently is not enough — the REPL's pane is modal, `useInput` returns early while it is
  open and the Composer is unmounted, so an approval answered in a browser left the
  terminal frozen on a question that had already been decided, with no key able to
  dismiss it. The TUI marks its own answers `answeredLocally` first, because the bus
  publishes the event synchronously from inside `respond` and the decision would
  otherwise be recorded twice.
- The browser timeline is built from `transcript` alone. Every REPL push is mirrored through
  the bus, so handling the agent's own `ops-parsed` / `warning` / `turn-end` as entries too
  printed everything twice; those events now drive live state only. `test/webclient.test.js`
  pins the entry types and the event subscriptions against App.jsx and `EVENTS`.
- Entries the REPL's own dispatcher never sees are tagged `origin: 'web'`, and App.jsx
  re-pushes those locally. Without it a prompt typed in a browser produced an answer in the
  terminal with no visible question.
- Models and artifacts are the same machinery in both views. `session/models.js` owns the
  catalog merge and the switch; `ModelPane.jsx`, `/model` and `POST /api/model` all call
  `applyModelChange`, which goes through `loadConfig` so a switch is validated by the same
  path as startup. Poking `cfg.provider` directly is how `/model` and the pane drifted —
  one moved the provider, the other did not.
- Browsing a provider is not switching to it. Both panes keep a `browsing` provider
  separate from the live one, and the switch commits only when a model is chosen.
- The browser can do two things the terminal cannot: download an artifact (the REPL's
  clipboard copy runs on davai's machine, which is the wrong one from a phone) and sort
  300 OpenRouter models by price. Artifact bodies are fetched per-item, never in the list.
- A view hook you omit defaults to a no-op. That is deliberate but sharp: a view that
  forgets `setPane` gets silence rather than an error. `test/dispatch.test.js` pins it.
- The browser hides things with the `hidden` property, and `[hidden] { display: none }`
  from the UA stylesheet loses to any author rule that sets display. app.css sets display
  on `#app`, `.gate`, `.view.chat` and `.approval`, so the approval overlay sat over the
  chat from page load with no request behind it and buttons that read a null
  `pendingApproval` — the symptom was an overlay that would not dismiss. app.css now
  carries `[hidden] { display: none !important }` and `test/webclient.test.js` pins it.
- One approval overlay, many possible requests. `showApproval` queues rather than
  overwrites: a replayed or concurrent request that clobbers the visible one is never
  answered, and the agent blocks on a `respond` nobody will call.
- Slash completion is derived from `commandList()`, not kept beside it. The hand-written
  copy in `complete.js` is why `/stream` and `/prompts` reached the help text, the
  dispatcher and the browser but could not be tab-completed in the REPL.

## Video input

Gemini is the only provider davai can send video to, so `src/context/video.js` sits
beside `images.js` rather than inside it, and `cfg.model.video` is a separate capability
from `cfg.model.vision`.

- **Video rides `inlineData`, exactly like an image.** That is why `gemini.js` has no
  video branch — the part type widened and the wire shape did not. The other three
  adapters `throw videoUnsupported()` instead. Dropping the part and sending the prompt
  anyway would produce a model answering confidently about footage it never received,
  which is indistinguishable from a hallucination in the transcript.
- **`video` is not implied by `vision`.** A vision-capable model that cannot take video
  is the common case, not the exception, so reusing the vision flag would have offered
  video on every GPT and Claude model and failed at the adapter. The flag is seeded for
  Gemini models, derived from the family in `refineModel` (the models endpoint reports no
  input modalities), and forced `false` for OpenRouter — it lists a `video` input
  modality, but routing through it still sends a Chat-Completions body with nowhere to
  put the data.
- **Video is billed by duration, images by pixels.** `estimateVideo` infers seconds from
  file size against an assumed bitrate, which is the weakest number in `tokens.js` and is
  written to be visibly so. It is there because the alternative is pricing video at zero
  in the context pane, and video is the one attachment that can spend a six-figure token
  budget from a 10MB file. The ledger takes the loader's figure rather than re-deriving
  it from the base64 length, which would bill a 40k-token clip like a 1600-token image.
  Calibration against reported usage corrects it after the first turn.
- **The cap is the request's, not the file's.** Inline data limits the whole request to
  20MB, so a file is checked at 18MB — a video that only just fits alone would otherwise
  push the request over as soon as there was a conversation attached to it. Larger files
  are the Files API's job, which is a separate upload-and-poll flow davai does not
  implement; the error says so rather than letting the upload fail.
- `extractVideoRefs` runs after `extractImageRefs` and the agent runs on the text both
  have substituted. Running it on the pre-video string dropped `[video: clip.mp4]` and
  sent a bare `@clip.mp4` the model could not resolve; `test/dispatch.test.js` pins it.
- **A YouTube video is referenced, not uploaded.** `fileData.fileUri` rather than
  `inlineData.data` — Gemini's backend fetches it, so it is the one part davai sends
  without holding its bytes, and every byte-derived rule above is inapplicable to it. The
  mime type is omitted deliberately: asserting `video/mp4` for a stream we have never
  seen is a claim we cannot support. A ledger part carries `data` or `uri`, never both,
  and the adapters refuse on the part *type* — an adapter checking for `data` would wave
  a by-reference video through and send a part with neither text nor image in it.
- **The `@` is required for a URL too.** A link pasted into a sentence almost always
  means "let us discuss this", not "watch this and bill me for an hour of footage". An
  attachment costing tens of thousands of tokens must not be triggerable by accident, so
  a URL opts in exactly as a path does.
- **A YouTube duration is unknowable from here**, so `/youtube <url> [minutes]` takes one
  and the notice says whether it used the operator's figure or assumed ten. Nothing about
  the request changes either way — it only moves the context estimate, which is otherwise
  wrong by whatever the real runtime is.

## Perf plots

The same measurements in three resolutions: a hand-drawn canvas sparkline in the header,
a hover overlay, and the full pane. uPlot is served from `node_modules` as a global
script tag, so there is still no build step; if it is missing the panels stay empty
rather than the page dying.

- **Raw buckets travel with their `scale`.** A turn's buckets are the harness's
  character-derived estimate, rescaled at turn end against the provider's reported
  `usage.out`. `/api/perf` sends `tokens` already reconciled, so a bucket curve drawn
  without `scale` disagrees with both the token count printed beside it and the
  terminal's plot of the same turn.
- **Effort is corrected at turn end, not captured at turn start.** An empty max_tokens
  turn is retried a notch lower, so the level a turn *ran* at is only known when it
  finishes. `turn-end` carries it and `applyTiming` applies it; otherwise the tooltip and
  the session log disagree about one turn.
- **The accumulator extrapolates, but only a little.** `renderSessionAccumulator` adds
  the time since the last sample to the live bucket so the clock ticks between polls.
  Uncapped, that let a stale sample invent history — hovering the chip after ten idle
  minutes charged all ten to `modelMs` if a turn happened to be running. It is clamped,
  and `openPop` refetches rather than drawing from whatever was last fetched.
- **Phases are a bounded ring whose totals stay exact.** A long session accumulates
  thousands; no view can draw them and re-sending them every poll grows the payload
  without bound. Evicted phases are banked into `evictedTotals`, so trimming the strip
  never shortens the session. The server caps what it sends separately and reports
  `phasesTotal`.
- **Charts are reconciled, not rebuilt.** `upsertChart` keyed by slot, `setData` for new
  numbers, `setSize` for a reflow. Destroying four canvases per poll was slow and threw
  away the cursor and legend, so a tooltip being read vanished every two seconds. Only
  the turn-detail plot has a per-turn key, because uPlot fixes a title at construction.
- **Streaming text paints per frame, not per token.** `setLive` / `setThinking` buffer
  onto an animation frame; `flushPaint` forces it wherever ordering matters
  (`commitThinking`, `turn-end`), since a pending frame would otherwise redraw notes that
  have already been committed to the transcript. Same reasoning as `FRAME_MS` in App.jsx.

## Prompts, agents files and the cached prefix

The system prompt is `preamble + protocol + grounding`, resolved once at bootstrap and
byte-stable for the session — it is the provider's cache prefix, so anything that varies
per turn silently stops caching from working.

- **An agents file is additive; a prompt override replaces.** `AGENTS.md` adds the
  operator's standing instructions to grounding. A file in `~/.davai/prompts` or
  `./.prompts` replaces davai's own contract text. They are reported separately by
  `/api/prompts` for that reason: lumping them together implies an AGENTS.md could
  override the protocol, which it cannot.
- **Agents files multiplex, home then project.** `$DAVAI_HOME/AGENTS.md` and the first of
  `AGENTS.md`/`DAVAI.md`/`CLAUDE.md` in the cwd are *both* read. First-matching meant a
  repo with its own file silently suppressed the conventions that applied everywhere.
  `DAVAI_AGENTS_MD` is a path list and *replaces* the search, like `DAVAI_RO_DIRS`.
- **The agents file is the only part of the prompt worth bounding.** Measured on this
  repo: preamble 147 tokens, protocol 1040, listing+git ~1000, AGENTS.md 3346 — 88% of
  grounding. `DAVAI_AGENTS_BUDGET` (default 6000 tokens, clamped to 8% of the window)
  bounds it, and the clip cuts at a markdown heading rather than mid-sentence, because a
  mid-sentence cut reads as a complete document. That is how the old hard-coded
  `slice(0, 8000)` hid itself while discarding 42% of this file.
- **A truncation names the path.** The file is on disk and `read` is the first op in the
  protocol, so a clip that says "continues for N more characters at /path" costs one
  round trip while a silent one costs instructions nobody knows are missing. Same reason
  a summary would be worse than a clip: lossy *and* unverifiable.
- **Overrides record where they were forked from.** A fork of `protocol.md` describes the
  protocol as it was; add an op and the copy is wrong with nothing to notice. Hence
  `.davai-prompts.json` beside the files, holding the built-in's hash at fork time.
  A *stale* fork (recorded hash ≠ today's) is positive evidence of drift and refuses to
  start — a warning would scroll past, and silent prompt rot is undetectable from the
  transcript. An *unstamped* fork is merely unknown, and only warns; blocking there would
  wall off everyone who forked before the manifest existed. `--accept-prompts` overrides
  once, `/prompts accept` re-baselines. The manifest is a sidecar file and not front
  matter because prompt files are read verbatim — a header would be sent to the model.
- **Save, stage and apply are three things.** Save writes a file and is safe mid-turn;
  the running session does not read it. Apply rebuilds `ledger.system`, so it is queued
  and drained at a step boundary beside `#applySteers` — the one moment with nothing in
  flight and the next request not yet built. It also busts the prompt cache, so the next
  turn pays full input price; that is stated in the UI rather than hidden behind a single
  save button. A broken override is rejected at `stageApply`, not at the boundary,
  because an error at the button is actionable and one three minutes later is not.

## Configuration precedence

Lowest to highest: `settings.json` → `$DAVAI_HOME/.env` → `./.env` → the real
environment → CLI flags. A live switch (`/model`, the pane, `POST /api/model`) enters as
an override, so it wins for the session it was made in.

- `settings.json` is a *remembered default*, not an overlay. It used to sit at the top,
  so a model chosen once in the pane shadowed `DAVAI_MODEL` on every later run with
  nothing on screen to say why the `.env` had stopped mattering. The file an operator
  writes by hand wins; the file davai writes as a side effect of a keypress does not.
- Nothing is persisted unless asked: `/model --save`, `s` in the pane, the browser's
  *remember* checkbox. `applyModelChange(session, want, { persist })` is the one path,
  and when it saves under a `.env` that will outrank it, it says so rather than
  reporting success.
- `loadConfig` takes `defaults` (bottom) and `overrides` (top). Anything that should
  lose to a hand-written `.env` belongs in the first. `cfg.varOrigins` records which
  layer supplied each variable.

## Provider blocks in a .env

Several endpoint-and-key sets in one file, one live at a time. `/env` lists them, `/env
<name>` switches, the pane and the browser's *.env* panel do the same thing with a
keypress. `config/profiles.js` is the text layer, `session/profiles.js` the session one —
the same split as `session/keys.js` and `KeyPane.jsx`.

```
#---# mistral
DAVAI_PROVIDER=openai
DAVAI_BASE_URL=https://api.mistral.ai/v1
DAVAI_OPENAI_API_KEY=sk-...
#-end-provider-#
```

- A block ends at the next `#---#`, at `#-end-provider-#`, or at end of file. Everything
  above the first sentinel is the preamble and applies whichever block is live; blocks
  come after it, so a block's assignment beats the preamble's by dotenv's own last-wins
  rule rather than by a new precedence rule.
- **Inactive blocks are ordinary comments.** This is the whole design. A block-aware
  reader would mean a `.env` that dotenv, `set -a; . ./.env`, Docker and every other tool
  parse differently from davai — a sentinel that looks like it gates something but does
  not, with the last duplicate quietly in effect. Switching only comments and uncomments,
  so nothing is ever deleted and switching back restores the file byte for byte.
  `test/profiles.test.js` pins the round-trip and the no-line-lost property.
- `##` marks prose davai will never uncomment; a single `#` before an assignment means a
  disabled setting. Without the distinction, enabling a block would resurrect the comment
  explaining why a value was abandoned.
- Within a block only the *last* assignment of a name is uncommented, because that is the
  one dotenv would have used. Enabling all of them would make the visible first line not
  the value in effect.
- The switch writes the file, then rebuilds the config through `loadConfig` exactly as
  startup does, and rolls the file back if that throws. A bad block leaves neither the
  file nor the session half-switched. Poking `cfg.baseURL` by hand instead is the
  `/model`-vs-pane drift again, and a base URL is worse to get wrong than a model: it
  decides which server receives the key.
- Saving a key for a provider you are not running goes through `setProfileVar`, which
  writes *inside* the block, commented to match. `setEnvVars` appends at top level, where
  the assignment outranks every block — correct when there are no blocks, wrong the
  moment there are.
- Secrets are masked in `session/profiles.js`, not at the view: `profileState` is what
  crosses to the bus and the browser, and `blockState` returns raw values by design.
- **The text layer works in LF; the file keeps its own line ending.** Every regex in
  `config/profiles.js` is anchored with `$`, and `.` does not match `\r`, so a CRLF
  `.env` matched no sentinel and no assignment at all — a Windows operator's blocks were
  not mis-parsed, they were invisible, and the pane said "no `#---#` blocks in this
  .env" about a file with nine of them. `toLines` strips the `\r` and `editEnvFile`
  restores the file's ending through `toEol`, which is idempotent because
  `switchProfile`'s rollback hands back text it read from disk unchanged and a naive
  `\n` → `\r\n` on that would write `\r\r\n`. Normalizing without restoring would have
  been worse than the bug: every switch would rewrite all 107 lines of a CRLF file and
  break the byte-for-byte round trip the whole design rests on.

## Providers and keys

`/keys` lists every provider, whether it has a key, and which variable supplied it.
`session/keys.js` owns it; `KeyPane.jsx`, `/keys` and `/api/keys` are three views over
`keyState` / `setProviderKey` / `clearProviderKey`, the same split as `session/models.js`.

- Keys are read from `DAVAI_<PROVIDER>_API_KEY` first, then the bare conventional names
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`…). The bare names are shared
  with every other tool on the machine — the OpenAI SDK reads `OPENAI_API_KEY` itself —
  so "the key davai sends" was not separable from "the key my shell exports". The
  prefixed name is what davai writes and what overrides that.
- The surface selector is `DAVAI_OPENAI_SURFACE`; `DAVAI_OPENAI_API` still works. One
  suffix apart from `DAVAI_OPENAI_API_KEY` was a typo waiting to happen.
- A key is session-scoped unless saved. Saving writes `$DAVAI_HOME/.env` through
  `config/envfile.js`, which edits a file rather than reserializing one: comments and
  ordering survive, the write is atomic, and the mode is 0600. Never the project `.env`
  — a key in a repo's `.env` is a key in a commit.
- A key is verified before it is stored with one `models.list` call, bounded by
  `VERIFY_TIMEOUT_MS`. The SDKs retry with backoff and some have no default timeout, so
  an unreachable host hung the pane with its input disabled and the whole REPL looked
  dead. A timeout counts as unverified, not rejected — being offline must not make davai
  refuse a valid key. Esc abandons the probe, and the pane verifies before it applies so
  abandoning really does leave nothing set.
- A secret never reaches the bus. `/api/keys` broadcasts `maskKey`'s description only;
  the value would otherwise sit in the SSE backlog and replay to every attached browser.

## Brakes on a running turn

Every other limit in `agent/loop.js` — `MAX_EMPTY`, `MAX_REPAIRS`, `MAX_NUDGES`,
`MAX_STEPS`, `#overBudget` — is tested at a step boundary, which is the right place for
all of them: the request in flight is already paid for. The exception is a generation
that has collapsed, where the remaining budget buys nothing but garbage.

- **A repeating cycle stops the turn.** `detectRepetition` examines the tail of the text
  channel every `REPEAT_CHECK_EVERY` characters: find the previous occurrence of the last
  64 characters, take the gap as the only candidate period, and confirm the whole window
  really is that unit repeated. One `lastIndexOf` and one slice compare per call, because
  it runs mid-stream. Exact periodicity is required on purpose — approximate matching
  would also fire on a long generated table, and a false positive kills a turn.
- **Text only, not thinking.** A model re-deriving the same fact loops in its reasoning
  routinely and still writes a good answer; that case is already handled by the effort
  demotion in `#streamTurn`. `test/empty-turn.test.js` streams 50k identical characters
  of thinking and must still reach the blowout path.
- **The guard aborts through `cancel()`** so the existing teardown applies unchanged: the
  partial text goes to `assistant-partial`, the stream record closes as `cancelled`, and
  the ledger never sees the garbage. `agent.degenerate` is how `run()` tells it from an
  operator's esc, and it reports an `error` rather than `cancelled` — a cancellation the
  operator did not ask for reads as davai losing the turn.
- **A cancelled turn is still billed.** `#streamOnce` carries `usage` out of the abort
  path and `#streamTurn` accounts it before returning. Without that, killing a runaway
  after a minute of output reported `$0.0000`. Best-effort by nature: a provider that
  only sends usage at the end of a stream sends none at all on a mid-stream abort.

## A model that leaks its own parser

Some models emit the scaffolding of their serving stack into the text channel.
Reflection's Beam (via OpenRouter/SGLang) closes a batch with a bare
`</rfl:parameter>` — the `rfl:` prefix is Reflection's own pseudo-XML, and the leak
takes the closing fence with it.

- **An unclosed fence is evidence of truncation, not proof of it.** `extract` now parses
  first and judges afterwards: if the envelope is complete, the batch runs and the turn
  reports `recovered: 'no closing fence'`; only a body that also fails to parse is called
  cut off. Before, three `read` ops that were perfectly good JSON cost three repair
  rounds and ended the request — at `max` effort on a 1M-context model, several dollars
  to accomplish nothing.
- **The tolerant pass drops a lone pseudo-XML tag**, and only the tolerant pass. Valid
  JSON never reaches it, so nothing legitimate is rewritten; a tag alone on a line can
  never be part of an envelope, and a payload block's contents are already split out
  before `parseEnvelope` sees anything, so a `</div>` inside a file being written is
  untouched.
- **The recovery is announced.** A `warning` on the turn, `parse-recovered` in the
  session log. Silently papering over a provider's malformed output is how you stop
  noticing that a model has stopped speaking the protocol.

## Testing

`npm test` — vitest. The ops engine, sandbox and parser are tested against temp
directories with no model calls; UI tests render Ink into a fake stdout. The server
tests bind an ephemeral port and speak real HTTP and SSE against a fake agent.

### File modes, and the one bit Windows has

Windows exposes a single permission bit through the POSIX layer: the read-only flag.
`chmod 0o755` reads back `0o666`, `chmod 0o700` reads back `0o666`, and only `0o444`
survives the round trip. Four tests asserting `mode & 0o777 === 0o755` were therefore
testing libuv's emulation rather than davai's behaviour, and failed on Windows for a
reason that had nothing to do with the code under test.

- **The promise is relative, not absolute.** Not "the file is 0755 afterwards" but
  "whatever the filesystem recorded before the op, it records after it".
  `test/helpers/modes.js` asserts that by reading the mode back after `chmod` instead of
  assuming the requested one took, so the same test is meaningful on both platforms —
  the executable bit on Linux, the read-only flag on Windows.
- **`describe.skipIf(win32)` would have been the wrong fix.** Skipping is right for the
  genuinely POSIX-only distinctions (`0o755`, `0o700`), and those are marked
  `it.runIf(POSIX_MODES)`. But the read-only cases run everywhere, and they had to,
  because chasing these assertions turned up two real Windows bugs the old tests could
  never have caught: Windows refuses to **rename over** a read-only file (POSIX governs
  that by the *directory's* write bit, so `write --overwrite`, `replace` and
  `move --overwrite` all died with EPERM at apply time) and refuses to **copy onto**
  one (so rollback threw and left the batch half-applied — precisely the failure
  rollback exists to prevent). `renameOver` and `restoreFile` in `journal.js` unlock,
  retry and restore the flag; both were verified to fail the new tests when reverted.
- **`atomicWrite` restates the mode after the rename**, because `openSync` applies the
  umask to its mode argument — a 0644 file preserved under a 0o077 umask came back 0600.
- **`snapshotTree` chmods each copied file.** `copyFileSync` does not carry the mode, and
  rollback restores from those copies, so a deleted-and-restored `bin/` came back 0644
  and no longer ran. `snapshot` already did this; the tree path did not.

`test/events.test.js` greps the front ends for their subscriptions, so an event that is
emitted and never consumed fails the build. If you change how listeners are registered,
teach `consumedIn()` the new shape.

`test/webclient.test.js` reads the browser client as text, since it has no module boundary
to import: event subscriptions, entry types, pane-to-tab mapping, `$('...')` ids and the
`[hidden]` rule are all checked against `index.html` and `app.css`. Every one of those
fails silently in a browser, which is why they are pinned here rather than left to a
manual look.
