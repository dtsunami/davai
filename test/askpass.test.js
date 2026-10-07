import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runShell } from '../src/agent/ops/shell.js';
import { executeBatch, formatResults } from '../src/agent/ops/executor.js';
import { Journal } from '../src/agent/journal.js';
import { SudoAuth, needsSudo } from '../src/agent/askpass.js';
import { Sandbox } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';

/**
 * A stand-in for sudo: password "hunter2", askpass only, three tries like the real
 * one, and no privilege. Put first on PATH so no test ever touches real sudo.
 */
const FAKE_SUDO = `#!/bin/sh
mode=
while [ $# -gt 0 ]; do
  case "$1" in
    -n) mode=n; shift ;;
    -A) mode=A; shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
if [ "$mode" = n ]; then echo "sudo: a password is required" >&2; exit 1; fi
if [ "$mode" != A ]; then
  echo "sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper" >&2
  exit 1
fi
tries=0
while [ $tries -lt 3 ]; do
  pw=$("$SUDO_ASKPASS" "[sudo] password for test: ") || { echo "sudo: no password was provided" >&2; exit 1; }
  if [ "$pw" = hunter2 ]; then exec "$@"; fi
  tries=$((tries + 1))
  echo "Sorry, try again." >&2
done
echo "sudo: 3 incorrect password attempts" >&2
exit 1
`;

let dir;
let ctx;
let oldPath;

describe.skipIf(process.platform === 'win32')('sudo via askpass', () => {
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'davai-sudo-')));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'sudo'), FAKE_SUDO, { mode: 0o755 });
    oldPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    ctx = {
      sandbox: new Sandbox({ cwd: dir, roDirs: [], ignore: DaIgnore.fromDir(dir) }),
      shellTimeout: 10_000,
    };
  });

  afterEach(() => {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('spots direct sudo calls that may prompt', () => {
    expect(needsSudo('sudo apt update')).toBe(true);
    expect(needsSudo('make && sudo make install')).toBe(true);
    expect(needsSudo('ls; sudo -u root id')).toBe(true);
    expect(needsSudo('echo nosudo')).toBe(false);
    expect(needsSudo('sudo -n true')).toBe(false);
    expect(needsSudo('ls -la')).toBe(false);
  });

  it('asks for a password only when sudo -n fails', async () => {
    const auth = new SudoAuth();
    expect((await auth.status('ls')).state).toBe('none');
    expect((await auth.status('sudo true')).state).toBe('password');
  });

  it('verifies with a throwaway probe and caches only a correct password', async () => {
    const auth = new SudoAuth();
    const bad = await auth.verify('wrong');
    expect(bad).toMatchObject({ ok: false, wrong: true });
    expect(auth.cached()).toBeNull();

    expect((await auth.verify('hunter2')).ok).toBe(true);
    expect((await auth.status('sudo true')).state).toBe('cached');
  });

  it('expires the cache like sudo does, and TTL 0 disables it', () => {
    let t = 0;
    const auth = new SudoAuth({ ttlMs: 1000, now: () => t });
    auth.remember('x');
    t = 900;
    expect(auth.take()).toBe('x'); // slides the expiry to 1900
    t = 1800;
    expect(auth.cached()).toBe('x');
    t = 2000;
    expect(auth.cached()).toBeNull();

    const off = new SudoAuth({ ttlMs: 0 });
    off.remember('x');
    expect(off.cached()).toBeNull();
  });

  it('runs a direct sudo call with the password', async () => {
    const r = await runShell({ cmd: 'sudo echo ok' }, ctx, { secret: 'hunter2' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('ok');
    expect(r.sudo).toMatchObject({ answered: 1, refused: 0 });
    expect(r.note).toBeUndefined();
  });

  it('refuses a second ask from the same sudo and tells the model', async () => {
    const r = await runShell({ cmd: 'sudo true' }, ctx, { secret: 'wrong' });
    expect(r.exitCode).not.toBe(0);
    expect(r.sudo.refused).toBe(1);
    expect(r.note).toMatch(/rejected the password/);
  });

  it('tells the model when sudo was called indirectly', async () => {
    const r = await runShell({ cmd: "sh -c 'sudo true'" }, ctx, { secret: 'hunter2' });
    expect(r.exitCode).not.toBe(0);
    expect(r.sudo.asked).toBe(0);
    expect(r.note).toMatch(/indirectly/);
  });

  it('keeps the password out of the environment and the output', async () => {
    const r = await runShell({ cmd: 'sudo env' }, ctx, { secret: 'hunter2' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/SUDO_ASKPASS=/);
    expect(r.stdout).not.toMatch(/hunter2/);
  });

  /** A batch context whose approvals answer from a script, recording what was asked. */
  function gated(answer) {
    const asks = [];
    return {
      asks,
      ctx: {
        ...ctx,
        journal: new Journal({ dir: path.join(dir, '.journal') }),
        sudo: new SudoAuth(),
        approve: async (op, i, extra) => {
          asks.push(extra?.sudo ?? null);
          return answer(asks.length);
        },
      },
    };
  }

  it('asks for the password in the approval and runs once it checks out', async () => {
    const { asks, ctx: c } = gated(() => ({ allow: true, secret: 'hunter2' }));
    const out = await executeBatch([{ op: 'shell', cmd: 'sudo echo hi' }], c);
    expect(out.status).toBe('ok');
    expect(asks).toEqual([{ state: 'password' }]);
    expect(out.results[0].result.stdout.trim()).toBe('hi');
    expect(out.results[0].result.auth).toMatch(/checked and supplied/);
    expect(formatResults(out)).not.toMatch(/hunter2/);
  });

  it('re-asks after a wrong password, then reuses the cache without asking', async () => {
    const answers = ['wrong', 'hunter2'];
    const { asks, ctx: c } = gated(() => ({ allow: true, secret: answers.shift() }));

    const first = await executeBatch([{ op: 'shell', cmd: 'sudo true' }], c);
    expect(first.status).toBe('ok');
    expect(asks[1]).toMatchObject({ state: 'password', retry: expect.stringMatching(/incorrect/) });

    const second = await executeBatch([{ op: 'shell', cmd: 'sudo true' }], c);
    expect(second.status).toBe('ok');
    expect(asks[2]).toBeNull();
    expect(second.results[0].result.auth).toMatch(/cached/);
  });

  it('stops after three wrong passwords without running the command', async () => {
    const { asks, ctx: c } = gated(() => ({ allow: true, secret: 'nope' }));
    const out = await executeBatch([{ op: 'shell', cmd: 'sudo touch ran' }], c);
    expect(out.status).toBe('apply-failed');
    expect(asks).toHaveLength(3);
    expect(out.errors[0].message).toMatch(/incorrect sudo password 3 times/);
    expect(fs.existsSync(path.join(dir, 'ran'))).toBe(false);
  });

  it('tells the model when an approval came back with no password', async () => {
    const { ctx: c } = gated(() => ({ allow: true }));
    const out = await executeBatch(
      [
        { op: 'write', path: 'kept.txt', text: 'x\n' },
        { op: 'shell', cmd: 'sudo true' },
      ],
      c,
    );
    expect(out.status).toBe('apply-failed');
    const text = formatResults(out);
    expect(text).toMatch(/none was supplied/);
    expect(text).toMatch(/file changes earlier in the batch were kept/);
    expect(fs.existsSync(path.join(dir, 'kept.txt'))).toBe(true);
  });

  /** Deps for handleCommand, with a scripted password prompt. */
  function operatorDeps(answer) {
    const asked = [];
    const added = [];
    const pushed = [];
    const deps = {
      session: {
        cfg: { shellTimeout: 10_000 },
        sandbox: ctx.sandbox,
        ledger: { add: (s) => added.push(s) },
        log: { event: () => {} },
        agent: { sudo: new SudoAuth() },
      },
      push: (e) => pushed.push(e),
      setPane: () => {},
      exit: () => {},
      refresh: () => {},
      requestSecret: async (op, extra) => {
        asked.push(extra.sudo);
        return answer(asked.length);
      },
    };
    return { deps, asked, added, pushed };
  }

  it('lets the operator sh run sudo, asking only for the password', async () => {
    const { handleCommand } = await import('../src/ui/commands.js');
    const { deps, asked, added } = operatorDeps(() => ({ allow: true, secret: 'hunter2' }));

    await handleCommand('sh sudo echo ok', deps);
    expect(asked).toEqual([{ state: 'password' }]);
    expect(added[0].text).toMatch(/exit 0/);
    expect(added[0].text).toMatch(/\nok/);
    expect(added[0].text).toMatch(/password checked and supplied/);
    expect(added[0].text).not.toMatch(/hunter2/);

    await handleCommand('sh sudo true', deps);
    expect(asked).toHaveLength(1); // cached, no second prompt
    expect(added[1].text).toMatch(/cached password supplied/);
  });

  it('runs a plain operator sh without any prompt', async () => {
    const { handleCommand } = await import('../src/ui/commands.js');
    const { deps, asked, added } = operatorDeps(() => ({ allow: true }));
    await handleCommand('sh echo plain', deps);
    expect(asked).toHaveLength(0);
    expect(added[0].text).toMatch(/exit 0/);
  });

  it('does not run an operator sh when the password prompt is cancelled', async () => {
    const { handleCommand } = await import('../src/ui/commands.js');
    const { deps, added, pushed } = operatorDeps(() => ({
      allow: false,
      reason: 'operator did not give the sudo password',
    }));
    await handleCommand('sh sudo touch ran', deps);
    expect(fs.existsSync(path.join(dir, 'ran'))).toBe(false);
    expect(added[0].text).toMatch(/was not run/);
    expect(pushed.some((p) => /not run/.test(p.message || ''))).toBe(true);
  });

  it('reports the operator declining to give a password as a denial', async () => {
    const { ctx: c } = gated(() => ({ allow: false, reason: 'operator did not give the sudo password' }));
    const out = await executeBatch([{ op: 'shell', cmd: 'sudo true' }], c);
    expect(out.status).toBe('denied');
    expect(formatResults(out)).toMatch(/did not give the sudo password/);
  });
});