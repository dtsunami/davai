/**
 * The shell op. Not reversible, so it never joins the rollback set and always goes
 * through the approval hook (req 8). Whether that hook asks a human or answers on
 * policy is the front end's business: the REPL prompts unless yolo is on, headless
 * allows with --yes/--yolo and otherwise denies.
 */
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 100_000;

const WIN = process.platform === 'win32';

/** What an interactive prompt prints when it finds no terminal to ask on. */
const NEEDS_TTY =
  /sudo: (?:a terminal is required|a password is required|no tty present)|terminal prompts disabled|could not read (?:Username|Password)/i;

function noteFor(killed, code, stderr, timeout) {
  const notes = [];
  if (killed) notes.push(`killed after ${Math.round(timeout / 1000)}s (timeout or cancel)`);
  if (code !== 0 && NEEDS_TTY.test(stderr)) {
    notes.push(
      'the command wanted an interactive prompt (password or credentials), which davai ' +
        'cannot answer. Ask the operator to run it in their own terminal, or use a ' +
        'non-interactive form (sudo -n, a credential helper)',
    );
  }
  return notes.length ? { note: notes.join('; ') } : {};
}

/**
 * @param {{cmd: string, cwd?: string}} op
 * @param {{sandbox: any, shellTimeout: number, signal?: AbortSignal}} ctx
 */
export function runShell(op, ctx) {
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
        spawn('/bin/sh', ['-c', op.cmd], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
        ...noteFor(killed, code, stderr, ctx.shellTimeout),
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
