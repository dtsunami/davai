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
- A view hook you omit defaults to a no-op. That is deliberate but sharp: a view that
  forgets `setPane` gets silence rather than an error. `test/dispatch.test.js` pins it.

## Testing

`npm test` — vitest. The ops engine, sandbox and parser are tested against temp
directories with no model calls; UI tests render Ink into a fake stdout. The server
tests bind an ephemeral port and speak real HTTP and SSE against a fake agent.

`test/events.test.js` greps the front ends for their subscriptions, so an event that is
emitted and never consumed fails the build. If you change how listeners are registered,
teach `consumedIn()` the new shape.
