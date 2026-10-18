import { describe, it, expect } from 'vitest';
import { completeInput } from '../src/ui/complete.js';
import { commandList } from '../src/ui/commands.js';

/**
 * The completion table used to be a second hand-written list of commands, and it drifted:
 * /stream and /prompts were in the help text, in the dispatcher and in the browser's
 * completion, but could not be tab-completed in the REPL that owns them. It is derived
 * now, and this pins the derivation.
 */
const session = { sandbox: {} };

describe('slash command completion', () => {
  it('completes every command the help table lists', () => {
    for (const c of commandList()) {
      if (!c.name.startsWith('/')) continue;
      const r = completeInput(c.name, c.name.length, session);
      expect(r, `${c.name} does not complete at all`).not.toBeNull();
      expect(r.value.trim(), `${c.name} completes to something else`).toBe(c.name);
    }
  });

  it('completes a unique prefix to the whole command', () => {
    expect(completeInput('/str', 4, session).value).toBe('/stream ');
    expect(completeInput('/prom', 5, session).value).toBe('/prompts ');
  });

  it('stops at the common prefix and lists the candidates', () => {
    const r = completeInput('/c', 2, session);
    expect(r.value.trim()).toBe('/c');
    for (const name of ['/clear', '/compact', '/config', '/context']) {
      expect(r.hint).toContain(name);
    }
  });

  it('completes the aliases the switch accepts but help does not list', () => {
    expect(completeInput('/perf', 5, session).value).toBe('/perf ');
  });

  it('returns null for something that is not a command', () => {
    expect(completeInput('/nope', 5, session)).toBeNull();
  });
});