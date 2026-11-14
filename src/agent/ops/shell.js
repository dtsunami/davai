/**
 * The shell op. Not reversible, so it never joins the rollback set and always goes
 * through the approval hook (req 8). Whether that hook asks a human or answers on
 * policy is the front end's business: the REPL prompts unless yolo is on, headless
 * allows with --yes/--yolo and otherwise denies.
 */
import { spawn } from 'node:child_process';
import { openChannel, SUDO_FN, callsSudoNonInteractive } from '../askpass.js';

const MAX_OUTPUT = 100_000;
/**
 * How long after killing the process tree we wait for pipes to hit EOF on their own.
 * If an orphaned descendant escaped the group/tree and still holds stdout or stderr open,
 * we destroy the pipes and settle anyway so a cancelled or timed-out command never hangs.
 */
const KILL_GRACE_MS = 1500;

const WIN = process.platform === 'win32';

/** What an interactive prompt prints when it finds no terminal to ask on. */
const SUDO_NO_TTY =
  /sudo: (?:a terminal is required|a password is required|no tty present|no password was provided|\d+ incorrect password attempts?)/i;
const NEEDS_TTY = new RegExp(
  `${SUDO_NO_TTY.source}|terminal prompts disabled|could not read (?:Username|Password)`,
  'i',
);

/** What `sudo -n` prints when it would have needed a password. */
const SUDO_N_REFUSED = /sudo: a password is required/i;

/**
 * @param {{cmd: string, killed: boolean, killReason?: 'timeout'|'cancel'|null,
 *   durationMs: number, code: number|null, stdout: string, stderr: string,
 *   timeout: number, sudoReady?: boolean}} r
 */
function noteFor({
  cmd,
  killed,
  killReason = null,
  durationMs,
  code,
  stdout,
  stderr,
  timeout,
  sudoReady = false,
}) {
  const notes = [];
  if (killed) {
    notes.push(
      killReason === 'cancel'
        ? `killed after ${Math.round(durationMs / 1000)}s (cancelled by operator)`
        : `killed after ${Math.round(timeout / 1000)}s (timeout)`,
    );
  }
  // Both streams, any exit code: `sudo -n -l 2>&1 | head` exits 0 with the refusal in
  // stdout, and that is the case that once led the model to declare sudo impossible.
  if (callsSudoNonInteractive(cmd) && SUDO_N_REFUSED.test(`${stdout}\n${stderr}`)) {
    notes.push(
      'sudo -n was refused because this sudo needs a password. That is not a dead end: ' +
        'rerun it as a plain `sudo ...` call without -n, and in the REPL davai asks the ' +
        'operator for the password in the approval pane and supplies it. Do not tell the ' +
        'operator sudo is unavailable or that you cannot enter a password',
    );
  } else if (code !== 0 && NEEDS_TTY.test(stderr) && !(sudoReady && SUDO_NO_TTY.test(stderr))) {
    // With a password on hand, sudo's failures are explained by sudoNote instead.
    notes.push(
      'the command wanted an interactive prompt (password or credentials) and had no ' +
        'terminal, and no password was supplied for it. davai can supply a sudo password ' +
        'only to direct `sudo` calls in a command the operator approves in the REPL; ' +
        'otherwise ask the operator to run it in their own terminal or, for git and ssh, ' +
        'use a credential helper or key',
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
function killTree(child) {
  if (WIN) {
    if (child.pid) {
      try {
        // child.kill() on Windows terminates only cmd.exe, leaving descendants (e.g. a
        // hung test runner) alive and holding the inherited stdout/stderr pipes open so
        // `close` never fires. taskkill /T /F terminates the whole process tree.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('error', () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already exited */
          }
        });
        killer.unref();
        return;
      } catch {
        /* fall through to direct kill */
      }
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
    return;
  }

  try {
    // detached made the shell a process-group leader, so take its children with it:
    // killing only sh left e.g. a test runner holding the pipes open, and `close`
    // did not fire until it exited on its own.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }
}

function spawnShell(op, ctx, extra = {}) {
  const cwd = op.cwd ? ctx.sandbox.resolveForWrite(op.cwd) : ctx.sandbox.writeRoot;

  if (ctx.signal?.aborted) {
    return Promise.resolve({
      cmd: op.cmd,
      cwd: ctx.sandbox.rel(cwd),
      exitCode: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      cancelled: true,
      note: 'killed after 0s (cancelled by operator)',
    });
  }

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
    /** @type {'timeout'|'cancel'|null} */
    let killReason = null;
    let truncated = false;
    let settled = false;
    let graceTimer = null;

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

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      ctx.signal?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - started;
      resolve({
        cmd: op.cmd,
        cwd: ctx.sandbox.rel(cwd),
        exitCode: code,
        durationMs,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        ...(killReason === 'cancel' ? { cancelled: true } : {}),
        ...noteFor({
          cmd: op.cmd,
          killed,
          killReason,
          durationMs,
          code,
          stdout,
          stderr,
          timeout: ctx.shellTimeout,
          sudoReady: extra.sudoReady,
        }),
        ...(truncated ? { outputTruncated: true } : {}),
      });
    };

    const kill = (reason) => {
      if (!killed) {
        killed = true;
        killReason = reason;
      }
      killTree(child);
      if (!graceTimer && !settled) {
        graceTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref?.();
          finish(child.exitCode);
        }, KILL_GRACE_MS);
      }
    };

    const timer = setTimeout(() => kill('timeout'), ctx.shellTimeout);
    const onAbort = () => kill('cancel');
    if (ctx.signal?.aborted) onAbort();
    else ctx.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      ctx.signal?.removeEventListener('abort', onAbort);
      resolve({
        cmd: op.cmd,
        cwd: ctx.sandbox.rel(cwd),
        exitCode: -1,
        durationMs: Date.now() - started,
        error: err.message,
        stdout,
        stderr,
      });
    });
    child.on('close', finish);
  });
}
