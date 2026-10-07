/**
 * sudo without a terminal.
 *
 * Shell ops run in a new session with no tty (see ops/shell.js), so sudo cannot ask
 * for a password itself. Instead the operator types it into the approval pane, it is
 * checked with a throwaway `sudo -A true`, and it is handed to sudo through
 * SUDO_ASKPASS for the commands that need it:
 *
 *   - a private 0700 temp dir holds a Unix socket and a tiny helper script;
 *   - the command runs behind SUDO_FN, so a direct `sudo` call asks the helper
 *     instead of /dev/tty;
 *   - the helper sends sudo's PID and prints whatever the socket answers.
 *
 * Each sudo process gets one answer. A second request from the same PID means the
 * password was rejected, so it is refused and sudo fails at once instead of looping.
 *
 * The secret never goes on disk, into the command's environment, the session log or
 * the model's context. What the model does get is telemetry (the channel trace and
 * the notes built from it in shell.js), so it can tell a wrong password from a missing
 * one from an indirect sudo call.
 *
 * The temp dir is davai's own plumbing, not an op path, so it does not go through the
 * Sandbox. Ink-free. POSIX only: on win32 needsSudo() is always false.
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WIN = process.platform === 'win32';

/** sudo's own compiled-in timestamp_timeout. Every use slides the expiry, as sudo does. */
export const SUDO_TTL_MS = 15 * 60_000;

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Prefixed to a command that has a password available. -S reads stdin, which the
 * command does not have, so it is left alone; everything else gets -A. `command sudo`
 * skips the function, so this does not recurse.
 */
export const SUDO_FN =
  'sudo() { case "$1" in -S|--stdin|-*S) command sudo "$@" ;; *) command sudo -A "$@" ;; esac; }\n';

/** `sudo` as a command word, capturing its first argument. */
const SUDO_CALL = /(?:^|[\s;&|(`])sudo(?=\s|$)\s*(\S*)/g;
/** A sudo call that will never prompt, so needs no password from us. */
const NON_INTERACTIVE = /^(?:-[a-zA-Z]*[nS]|--non-interactive|--stdin)$/;

/**
 * Does the command call sudo directly, in a form that may prompt? Lexical: a mention
 * of sudo inside a string also counts, which costs one `sudo -n true` probe and
 * nothing else. Indirect calls (a script, /usr/bin/sudo, xargs) are not seen here and
 * would bypass SUDO_FN anyway; shell.js says so in the result when that happens.
 */
export function needsSudo(cmd) {
  if (WIN || !cmd) return false;
  for (const m of String(cmd).matchAll(SUDO_CALL)) {
    if (!NON_INTERACTIVE.test(m[1] || '')) return true;
  }
  return false;
}

/** A first argument that turns off sudo's prompt: -n alone or bundled (-nl), or the long form. */
const NO_PROMPT_FLAG = /^(?:-[a-zA-Z]*n[a-zA-Z]*|--non-interactive)$/;

/**
 * Does the command call sudo with -n? Lexical, like needsSudo. shell.js uses it to
 * tell the model, when -n was refused for want of a password, that a plain sudo call
 * would have reached the operator's password prompt instead.
 */
export function callsSudoNonInteractive(cmd) {
  if (WIN || !cmd) return false;
  for (const m of String(cmd).matchAll(SUDO_CALL)) {
    if (NO_PROMPT_FLAG.test(m[1] || '')) return true;
  }
  return false;
}

/**
 * Open a one-shot password channel. Answers each sudo PID once, then refuses.
 * @param {string|null} secret
 */
export async function openChannel(secret) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-askpass-'));
  fs.chmodSync(dir, 0o700);
  const sock = path.join(dir, 's');
  const helper = path.join(dir, 'askpass.cjs');
  fs.writeFileSync(helper, helperSource(sock), { mode: 0o700 });

  const trace = { asked: 0, answered: 0, refused: 0 };
  const seen = new Set();

  const server = net.createServer((conn) => {
    conn.setEncoding('utf8');
    let buf = '';
    let done = false;
    conn.on('error', () => {});
    conn.on('data', (d) => {
      if (done) return;
      buf += d;
      if (buf.length > 4096) return conn.destroy();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      done = true;
      let req = {};
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        /* treated as an unknown caller */
      }
      trace.asked++;
      const pid = String(req.pid ?? '');
      if (secret == null || !pid || seen.has(pid)) {
        trace.refused++;
        conn.end('{"ok":false}\n');
        return;
      }
      seen.add(pid);
      trace.answered++;
      conn.end(JSON.stringify({ ok: true, secret }) + '\n');
    });
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, resolve);
    });
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  server.unref();

  return {
    env: { SUDO_ASKPASS: helper },
    trace,
    close() {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The helper sudo runs. process.ppid is the sudo process that is asking. */
function helperSource(sock) {
  return `#!${process.execPath}
// davai askpass helper: forwards sudo's prompt to the davai session running this command.
const net = require('net');
const fail = () => process.exit(1);
setTimeout(fail, 30000).unref();
let buf = '';
const c = net.connect(${JSON.stringify(sock)}, () => {
  c.write(JSON.stringify({ pid: process.ppid, prompt: process.argv[2] || '' }) + '\\n');
});
c.setEncoding('utf8');
c.on('data', (d) => { buf += d; });
c.on('end', () => {
  try {
    const r = JSON.parse(buf);
    if (r.ok) { process.stdout.write(r.secret + '\\n'); return; }
  } catch {}
  fail();
});
c.on('error', fail);
`;
}

/**
 * Run a sudo probe the way a shell op runs: through sh, in a new session, no stdin.
 * Going through sh matters. With no tty, sudo keys its credential cache on the parent
 * PID, so a probe spawned straight from davai would leave a timestamp that later
 * `sudo -n` probes see but no shell op (whose parent is a fresh sh) ever could.
 */
function probe(script, env, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stderr = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn('/bin/sh', ['-c', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
      env,
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ code: -1, stderr: `timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => finish({ code: -1, stderr: err.message }));
    child.on('close', (code) => finish({ code: code ?? -1, stderr: stderr.trim() }));
  });
}

/**
 * The session's sudo state: an in-memory password with a sliding expiry, and the
 * probes that decide whether a command needs one.
 */
export class SudoAuth {
  #secret = null;
  #expires = 0;

  /** @param {{ttlMs?: number, now?: () => number, env?: NodeJS.ProcessEnv}} [opts] */
  constructor({ ttlMs = SUDO_TTL_MS, now = Date.now, env = process.env } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.env = env;
  }

  /** The cached password, or null once it has expired. */
  cached() {
    if (this.#secret != null && this.now() < this.#expires) return this.#secret;
    this.forget();
    return null;
  }

  /** Cache a verified password. A TTL of 0 disables caching. */
  remember(secret) {
    if (!this.ttlMs) return;
    this.#secret = secret;
    this.#expires = this.now() + this.ttlMs;
  }

  forget() {
    this.#secret = null;
    this.#expires = 0;
  }

  /** The cached password for a command about to run, sliding the expiry. */
  take() {
    const s = this.cached();
    if (s != null) this.remember(s);
    return s;
  }

  /**
   * What a command needs before it runs.
   * @returns {Promise<{state: 'none'|'cached'|'nopasswd'|'password'|'unavailable', detail?: string}>}
   */
  async status(cmd) {
    if (!needsSudo(cmd)) return { state: 'none' };
    if (this.cached() != null) return { state: 'cached' };
    const r = await probe('sudo -n true', this.env);
    if (r.code === 0) return { state: 'nopasswd' };
    if (r.code === 127) {
      return { state: 'unavailable', detail: 'sudo is not installed or not on PATH' };
    }
    if (/not in the sudoers|not allowed|may not run sudo/i.test(r.stderr)) {
      return { state: 'unavailable', detail: r.stderr };
    }
    return { state: 'password' };
  }

  /**
   * Check a password with a throwaway `sudo -A true`. Nothing the operator asked for
   * runs, so a wrong password costs nothing.
   * @returns {Promise<{ok: boolean, wrong?: boolean, detail?: string}>}
   */
  async verify(secret) {
    let channel;
    try {
      channel = await openChannel(secret);
    } catch (err) {
      return { ok: false, detail: `could not set up password delivery: ${err.message}` };
    }
    try {
      const r = await probe('sudo -A true', { ...this.env, ...channel.env });
      if (r.code === 0) {
        this.remember(secret);
        return { ok: true };
      }
      const wrong = channel.trace.refused > 0;
      return {
        ok: false,
        wrong,
        detail: wrong ? 'incorrect password' : r.stderr || `sudo exited ${r.code}`,
      };
    } finally {
      channel.close();
    }
  }
}