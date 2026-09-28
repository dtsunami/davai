import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { readStdin } from '../src/headless.js';

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');

/** Stand in for process.stdin. `isTTY` decides which branch readStdin takes. */
function fakeStdin({ isTTY = false } = {}) {
  const s = new PassThrough();
  s.isTTY = isTTY;
  Object.defineProperty(process, 'stdin', { value: s, configurable: true });
  return s;
}

afterEach(() => {
  Object.defineProperty(process, 'stdin', realStdin);
});

const after = (ms, fn) => setTimeout(fn, ms);

describe('readStdin', () => {
  it('skips a TTY outright', async () => {
    fakeStdin({ isTTY: true });
    expect(await readStdin()).toBe('');
  });

  it('reads a piped request and trims it', async () => {
    const s = fakeStdin();
    s.write('  check git status\n');
    s.end();
    expect(await readStdin()).toBe('check git status');
  });

  it('waits for real EOF once bytes have started', async () => {
    const s = fakeStdin();
    s.write('first chunk ');
    after(40, () => s.write('second chunk'));
    after(80, () => s.end());
    expect(await readStdin({ idleMs: 20 })).toBe('first chunk second chunk');
  });

  it('gives up quickly on a silent pipe when a prompt was already supplied', async () => {
    fakeStdin(); // never writes, never ends
    const started = Date.now();
    expect(await readStdin({ idleMs: 30 })).toBe('');
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('waits for a slow producer when stdin is the only input', async () => {
    // The bug: the grace period covered only the wait for the first byte, so a producer
    // that took longer than it to start was read as empty and the request was lost.
    const s = fakeStdin();
    after(60, () => {
      s.write('summarize this');
      s.end();
    });
    expect(await readStdin({ idleMs: 10, required: true })).toBe('summarize this');
  });

  it('would have dropped that input without the required flag', async () => {
    const s = fakeStdin();
    after(60, () => {
      s.write('summarize this');
      s.end();
    });
    expect(await readStdin({ idleMs: 10 })).toBe('');
  });

  it('still bounds the wait so a dead pipe cannot hang forever', async () => {
    fakeStdin(); // never writes, never ends
    const started = Date.now();
    expect(await readStdin({ required: true, maxWaitMs: 40 })).toBe('');
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('resolves with whatever arrived when the stream errors', async () => {
    const s = fakeStdin();
    s.write('partial');
    after(20, () => s.emit('error', new Error('broken pipe')));
    expect(await readStdin({ idleMs: 200, required: true })).toBe('partial');
  });
});
