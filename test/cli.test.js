import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError } from '../bin/davai.js';

/**
 * The flag surface is the part of davai a human touches first, and it had no tests
 * through two renames (--web <port> → --port, --web-host → --host). These pin the
 * conventional spellings and, as much as anything, the migration errors: a flag that
 * silently changed meaning is worse than one that is gone.
 */
describe('web flags', () => {
  it('--web alone asks for the server and leaves the rest to config', () => {
    const a = parseArgs(['--web']);
    expect(a.web).toBe(true);
    expect(a.port).toBeUndefined();
    expect(a.host).toBeUndefined();
  });

  it('takes --port and --host the way every other server tool does', () => {
    const a = parseArgs(['--web', '--port', '9000', '--host', '0.0.0.0']);
    expect(a).toMatchObject({ web: true, port: 9000, host: '0.0.0.0' });
  });

  it('accepts port 0, which asks the OS for a free one', () => {
    expect(parseArgs(['--port', '0']).port).toBe(0);
  });

  it('order does not matter', () => {
    expect(parseArgs(['--port', '9000', '--web']).port).toBe(9000);
  });

  it('rejects a port that is not one, naming the value', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/between 0 and 65535 \(got "abc"\)/);
    expect(() => parseArgs(['--port', '70000'])).toThrow(UsageError);
    expect(() => parseArgs(['--port'])).toThrow(UsageError);
  });
});

describe('migration from the invented spellings', () => {
  it('names the replacement for --web <port> rather than eating the number', () => {
    // The dangerous case: without this, 9000 falls through to out.words and becomes
    // part of the prompt, so the model is asked to do something beginning "9000".
    const err = (() => { try { parseArgs(['--web', '9000']); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toContain('--web --port 9000');
  });

  it('points --web-host at --host', () => {
    expect(() => parseArgs(['--web-host', '0.0.0.0'])).toThrow(/--web-host is now --host/);
  });
});

describe('the rest of the surface', () => {
  it('still parses the flags that were there before', () => {
    const a = parseArgs(['-m', 'claude-opus-5', '--provider', 'anthropic', '--effort', 'low']);
    expect(a.overrides).toEqual({
      DAVAI_MODEL: 'claude-opus-5',
      DAVAI_PROVIDER: 'anthropic',
      DAVAI_EFFORT: 'low',
    });
  });

  it('--yolo implies --yes, since the intent is the same in both modes', () => {
    const a = parseArgs(['--yolo']);
    expect(a.yes).toBe(true);
    expect(a.overrides.DAVAI_YOLO).toBe('true');
  });

  it('collects bare words into the prompt', () => {
    expect(parseArgs(['fix', 'the', 'bug']).input).toBe('fix the bug');
  });

  it('keeps a prompt that merely looks like a flag value out of the flags', () => {
    expect(parseArgs(['--web', 'why', 'is', 'it', 'slow']).input).toBe('why is it slow');
  });

  it('--resume takes an optional id', () => {
    expect(parseArgs(['--resume']).resume).toBe(true);
    expect(parseArgs(['--resume', 'abc123']).resume).toBe('abc123');
    // A flag after --resume is not an id.
    expect(parseArgs(['--resume', '--web']).resume).toBe(true);
  });

  it('rejects an unknown option with the help text', () => {
    const err = (() => { try { parseArgs(['--nonsense']); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toContain('unknown option: --nonsense');
    expect(err.message).toContain('USAGE');
  });
});