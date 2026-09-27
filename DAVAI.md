# davai

An agentic CLI REPL. See README.md for the full design.

## Conventions

- ESM only (`"type": "module"`), JSDoc types, no build step.
- `src/agent/`, `src/context/` and `src/providers/` must stay Ink-free — the UI is a
  view over state the harness owns, never the other way round.
- Every filesystem path goes through `Sandbox.resolveForRead` / `resolveForWrite`.
  No op does its own path math.
- Mutating ops snapshot to the journal before they write, so a batch can roll back.

## Testing

`npm test` — vitest. The ops engine, sandbox and parser are tested against temp
directories with no model calls; UI tests render Ink into a fake stdout.
