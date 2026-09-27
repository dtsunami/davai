/**
 * The shell op. Not reversible, so it never joins the rollback set and always goes
 * through the approval hook (req 8). Whether that hook asks a human or answers on
 * policy is the front end's business: the REPL prompts unless yolo is on, headless
 * allows with --yes/--yolo and otherwise denies.
 */
import { spawn } from 'node:child_process';

const MAX_OUTPUT = 100_000;

const WIN = process.platform === 'win32';

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
        })
      : spawn('/bin/sh', ['-c', op.cmd], { cwd });

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

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, ctx.shellTimeout);

    const onAbort = () => {
      killed = true;
      child.kill('SIGKILL');
    };
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
        ...(killed
          ? { note: `killed after ${Math.round(ctx.shellTimeout / 1000)}s (timeout or cancel)` }
          : {}),
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
