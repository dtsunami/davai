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

describe('shell cancellation and process-tree kill (all platforms)', () => {
  /**
   * Write a script that spawns a grandchild Node process inheriting stdout/stderr pipes
   * and hanging for 60s — reproducing `cmd.exe -> pytest.exe -> python.exe` on Windows.
   */
  function writeTreeHangScript() {
    const childScript = path.join(base, 'grandchild.mjs');
    const parentScript = path.join(base, 'parent.mjs');
    fs.writeFileSync(
      childScript,
      [
        'process.stdout.write(`GRANDCHILD_PID=${process.pid}\\n`);',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    fs.writeFileSync(
      parentScript,
      [
        'import { spawn } from "node:child_process";',
        `const c = spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: "inherit" });`,
        'c.on("exit", (code) => process.exit(code ?? 0));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    return 'node parent.mjs';
  }

  function isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('kills the full descendant tree and resolves promptly on AbortSignal cancel', async () => {
    const cmd = writeTreeHangScript();
    const ctl = new AbortController();

    setTimeout(() => ctl.abort(), 350);
    const r = await runShell({ cmd }, { ...ctx, shellTimeout: 60_000, signal: ctl.signal });

    expect(r.cancelled).toBe(true);
    expect(r.note).toMatch(/cancelled by operator/);
    expect(r.stdout).toMatch(/GRANDCHILD_PID=\d+/);
    expect(r.durationMs).toBeLessThan(5000);

    const m = /GRANDCHILD_PID=(\d+)/.exec(r.stdout);
    const grandchildPid = Number(m[1]);
    // Give OS process teardown a brief moment to finalize handle table cleanup.
    const deadline = Date.now() + 2000;
    while (isAlive(grandchildPid) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(isAlive(grandchildPid)).toBe(false);
  });

  it('kills the full descendant tree on shellTimeout too', async () => {
    const cmd = writeTreeHangScript();
    const r = await runShell({ cmd }, { ...ctx, shellTimeout: 350 });

    expect(r.cancelled).toBeUndefined();
    expect(r.note).toMatch(/killed.*timeout/);
    expect(r.durationMs).toBeLessThan(5000);
  });

  it('returns cancelled immediately without spawning when signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const marker = path.join(base, 'never-created.txt');
    const r = await runShell(
      { cmd: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"` },
      { ...ctx, signal: ctl.signal },
    );
    expect(r.cancelled).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});