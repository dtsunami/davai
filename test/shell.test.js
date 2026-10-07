import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runShell } from '../src/agent/ops/shell.js';
import { Sandbox } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';

let base;
let ctx;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'davai-shell-')));
  ctx = {
    sandbox: new Sandbox({ cwd: base, roDirs: [], ignore: DaIgnore.fromDir(base) }),
    shellTimeout: 5000,
  };
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('shell op isolation', () => {
  it('does not hang on a command that reads stdin', async () => {
    const r = await runShell({ cmd: 'cat' }, ctx);
    expect(r.exitCode).toBe(0);
    expect(r.note).toBeUndefined();
    expect(r.durationMs).toBeLessThan(4000);
  });

  it('runs without a controlling terminal', async () => {
    const r = await runShell(
      { cmd: 'if (: < /dev/tty) 2>/dev/null; then echo tty; else echo none; fi' },
      ctx,
    );
    expect(r.stdout.trim()).toBe('none');
  });

  it('explains a password prompt it cannot answer', async () => {
    const r = await runShell(
      {
        cmd: 'echo "sudo: a terminal is required to read the password; either use the -S option" >&2; exit 1',
      },
      ctx,
    );
    expect(r.exitCode).toBe(1);
    expect(r.note).toMatch(/interactive prompt/);
  });

  it('does not add the note to a successful command', async () => {
    const r = await runShell({ cmd: 'echo "no tty present" >&2' }, ctx);
    expect(r.note).toBeUndefined();
  });

  it('kills the whole process group on timeout', async () => {
    // Before, only sh died; the backgrounded sleep kept the pipes open for 30s.
    const r = await runShell({ cmd: 'sleep 30 & sleep 30; wait' }, { ...ctx, shellTimeout: 300 });
    expect(r.note).toMatch(/killed/);
    expect(r.durationMs).toBeLessThan(4000);
  });
});