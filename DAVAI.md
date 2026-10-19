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

## Testing

`npm test` — vitest. The ops engine, sandbox and parser are tested against temp
directories with no model calls; UI tests render Ink into a fake stdout. The server
tests bind an ephemeral port and speak real HTTP and SSE against a fake agent.

`test/events.test.js` greps the front ends for their subscriptions, so an event that is
emitted and never consumed fails the build. If you change how listeners are registered,
teach `consumedIn()` the new shape.

`test/webclient.test.js` reads the browser client as text, since it has no module boundary
to import: event subscriptions, entry types, pane-to-tab mapping, `$('...')` ids and the
`[hidden]` rule are all checked against `index.html` and `app.css`. Every one of those
fails silently in a browser, which is why they are pinned here rather than left to a
manual look.
