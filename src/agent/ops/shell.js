/**
 * The shell op. Not reversible, so it never joins the rollback set and always goes
 * through the approval hook (req 8). Whether that hook asks a human or answers on
 * policy is the front end's business: the REPL prompts unless yolo is on, headless
 * allows with --yes/--yolo and otherwise denies.
 */
import { spawn } from 'node:child_process';
import { openChannel, SUDO_FN } from '../askpass.js';

const MAX_OUTPUT = 100_000;

const WIN = process.platform === 'win32';

/** What an interactive prompt prints when it finds no terminal to ask on. */
const SUDO_NO_TTY =
  /sudo: (?:a terminal is required|a password is required|no tty present|no password was provided|\d+ incorrect password attempts?)/i;
const NEEDS_TTY = new RegExp(
  `${SUDO_NO_TTY.source}|terminal prompts disabled|could not read (?:Username|Password)`,
  'i',
);

function noteFor(killed, code, stderr, timeout, sudoReady = false) {
  const notes = [];
  if (killed) notes.push(`killed after ${Math.round(timeout / 1000)}s (timeout or cancel)`);
  // With a password on hand, sudo's failures are explained by sudoNote instead.
  if (code !== 0 && NEEDS_TTY.test(stderr) && !(sudoReady && SUDO_NO_TTY.test(stderr))) {
    notes.push(
      'the command wanted an interactive prompt (password or credentials) and had no ' +
        'terminal, and no password was supplied for it. davai can supply a sudo password ' +
        'only to direct `sudo` calls in a command the operator approves in the REPL; ' +
        'otherwise ask the operator to run it in their own terminal, or use a ' +
        'non-interactive form (sudo -n, a credential helper)',
    );
  }
  return notes.length ? { note: notes.join('; ') } : {};
}

function appendNote(out, note) {
  if (!note) return out;
  return { ...out, note: out.note ? `${out.note}; ${note}` : note };
}

/** Telemetry for a command that ran with a sudo password available. */
function sudoNote(trace, out) {
  if (trace.refused) {
    return (
      'sudo rejected the password davai supplied (it asked again in the same process); ' +
      'the cached password was dropped and the operator will be prompted on the next sudo command'
    );
  }
  if (out.exitCode !== 0 && !trace.asked && SUDO_NO_TTY.test(out.stderr)) {
    return (
      'sudo wanted a password but never asked davai for it: it was run indirectly (a ' +
      'script, /usr/bin/sudo, xargs, env, sh -c), which bypasses the askpass hook. Call ' +
      'sudo directly in the command, or ask the operator to run it in their own terminal'
    );
  }
  return '';
}

/**
 * Run a shell op. With `secret`, direct `sudo` calls in the command get the password
 * through the askpass channel (see ../askpass.js) instead of failing for want of a
 * tty. The result carries a `sudo` trace and a note when anything went wrong, so the
 * model can tell a wrong password from an indirect sudo call from no sudo at all.
 *
 * @param {{cmd: string, cwd?: string}} op
 * @param {{sandbox: any, shellTimeout: number, signal?: AbortSignal}} ctx
 * @param {{secret?: string|null}} [opts]
 */
export async function runShell(op, ctx, { secret } = {}) {
  if (secret == null || WIN) return spawnShell(op, ctx);

  let channel;
  try {
    channel = await openChannel(secret);
  } catch (err) {
    const out = await spawnShell(op, ctx);
    return appendNote(
      out,
      `davai could not set up sudo password delivery (${err.message}), so the command ran without it`,
    );
  }
  try {
    const out = await spawnShell(op, ctx, {
      prefix: SUDO_FN,
      env: channel.env,
      sudoReady: true,
    });
    const sudo = { ...channel.trace };
    return appendNote({ ...out, sudo }, sudoNote(sudo, out));
  } finally {
    channel.close();
  }
}

/**
 * @param {{cmd: string, cwd?: string}} op
 * @param {{sandbox: any, shellTimeout: number, signal?: AbortSignal}} ctx
 * @param {{prefix?: string, env?: Record<string, string>, sudoReady?: boolean}} [extra]
 */
function spawnShell(op, ctx, extra = {}) {
  const cwd = op.cwd ? ctx.sandbox.resolveForWrite(op.cwd) : ctx.sandbox.writeRoot;

  return new Promise((resolve) => {
    const started = Date.now();
    const child = WIN
      ? spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', op.cmd], {
          cwd,
          windowsVerbatimArguments: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : // No stdin and no controlling terminal. sudo, ssh and git open /dev/tty directly
        // to ask for a password: the prompt was drawn underneath Ink, raced Ink's
        // raw-mode reader for keystrokes, and the run sat there until the timeout. In a
        // new session (detached = setsid) there is no tty to find, so they fail at once
        // with a message the model can act on. A piped stdin that is never closed also
        // hung anything that reads it, like a bare `cat`.
        spawn('/bin/sh', ['-c', (extra.prefix || '') + op.cmd], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          env: { ...process.env, ...extra.env, GIT_TERMINAL_PROMPT: '0' },
        });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let truncated = false;

    const cap = (buf, chunk) => {
      if (buf.length >= MAX_OUTPUT) {
        truncated = true;
        return buf;
      }
      return buf + chunk;
    };

    child.stdout.on('data', (d) => {
      stdout = cap(stdout, d.toString());
    });
    child.stderr.on('data', (d) => {
      stderr = cap(stderr, d.toString());
    });

    const kill = () => {
      killed = true;
      try {
        // detached made the shell a process-group leader, so take its children with it:
        // killing only sh left e.g. a test runner holding the pipes open, and `close`
        // did not fire until it exited on its own.
        if (WIN) child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const timer = setTimeout(kill, ctx.shellTimeout);
    const onAbort = kill;
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve({
        cmd: op.cmd,
        cwd: ctx.sandbox.rel(cwd),
        exitCode: code,
        durationMs: Date.now() - started,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        ...noteFor(killed, code, stderr, ctx.shellTimeout, extra.sudoReady),
        ...(truncated ? { outputTruncated: true } : {}),
      });
    };

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        cmd: op.cmd,
        cwd: ctx.sandbox.rel(cwd),
        exitCode: -1,
        error: err.message,
        stdout,
        stderr,
      });
    });
    child.on('close', finish);
  });
}
