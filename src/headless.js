/**
 * Headless mode: --print and --json. Same loop, no Ink.
 *
 * This is what makes the harness CI-testable and pipeable:
 *   echo "fix the types" | davai --print
 */
import { createSession } from './session/bootstrap.js';

/**
 * @param {string} input
 * @param {{json?: boolean, yes?: boolean, cwd?: string, overrides?: object}} opts
 * @returns {Promise<number>} exit code
 */
export async function runHeadless(input, opts = {}) {
  const session = await createSession({
    cwd: opts.cwd,
    overrides: opts.overrides,
    resume: opts.resume,
  });
  const { agent, log } = session;

  const emit = (obj) => {
    if (opts.json) process.stdout.write(JSON.stringify(obj) + '\n');
  };

  if (session.resumed) {
    const r = session.resumed;
    emit({ type: 'resume', ...r });
    if (!opts.json) {
      process.stderr.write(
        `  resumed ${r.id}: ${r.turns} turn(s), ${r.segments} segment(s)` +
          (r.omitted ? `, ${r.omitted} omitted` : '') +
          '\n',
      );
    }
  }

  // Startup notices: a project setting that was ignored, a limit that was clamped.
  for (const message of [...session.cfg.warnings, ...session.limitNotices]) {
    emit({ type: 'warning', message });
    if (!opts.json) process.stderr.write(`  ! ${message}\n`);
  }

  // A one-shot request is still a prompt worth replaying later.
  session.history?.add(input);

  let failed = false;

  if (!opts.json) {
    // Stream prose, but swallow da_ops blocks — piping the protocol into stdout is
    // noise. The ops themselves are reported separately, on stderr.
    const filter = createOpsFilter((s) => process.stdout.write(s));
    agent.on('text', filter.write);
    agent.on('turn-end', () => {
      filter.reset();
      process.stdout.write('\n');
    });
  }

  agent.on('ops-parsed', (ops) => {
    emit({ type: 'ops', ops });
    if (!opts.json) {
      for (const op of ops) process.stderr.write(`  · ${describeOp(op)}\n`);
    }
  });

  agent.on('ops-result', ({ outcome }) => {
    emit({ type: 'ops-result', status: outcome.status, errors: outcome.errors });
    if (!opts.json && outcome.status !== 'ok') {
      for (const e of outcome.errors) {
        process.stderr.write(`  ! [${e.index}] ${e.op}: ${e.message}\n`);
      }
    }
  });

  agent.on('artifact', (a) => emit({ type: 'artifact', n: a.n, lang: a.lang, lines: a.lines }));

  // Structured consumers can follow the reasoning; plain --print keeps stdout to the
  // answer, which is what a pipe is for.
  agent.on('thinking', (delta) => emit({ type: 'thinking', delta }));

  agent.on('retry', ({ attempt, of, waitMs, message }) => {
    emit({ type: 'retry', attempt, of, waitMs, message });
    if (!opts.json) {
      process.stderr.write(
        `  ! ${message} — retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${of})\n`,
      );
    }
  });

  agent.on('nudge', ({ attempt }) => {
    emit({ type: 'nudge', attempt });
    if (!opts.json) process.stderr.write(`  · no ops in that turn — asking it to continue\n`);
  });

  agent.on('usage', (u) => emit({ type: 'usage', ...u }));

  agent.on('compact-done', (r) => {
    emit({ type: 'compact', ...r });
    if (!opts.json) process.stderr.write(`  · auto-compacted, freed ~${r.freed} tokens\n`);
  });

  agent.on('warning', (w) => {
    emit({ type: 'warning', ...w });
    if (!opts.json) process.stderr.write(`  ! ${w.message}\n`);
  });

  agent.on('error', (e) => {
    failed = true;
    emit({ type: 'error', ...e });
    if (!opts.json) process.stderr.write(`\nerror: ${e.message}\n`);
  });

  // Shell approval in headless mode is policy, not a prompt: --yes/--yolo allows,
  // otherwise deny, because there is no human to ask.
  const autoApprove = opts.yes || session.cfg.yolo;
  agent.on('approval-request', ({ op, respond }) => {
    if (autoApprove) {
      emit({ type: 'shell-approved', cmd: op.cmd });
      if (!opts.json) process.stderr.write(`  $ ${op.cmd}\n`);
      respond({ allow: true });
    } else {
      emit({ type: 'shell-denied', cmd: op.cmd });
      if (!opts.json) {
        process.stderr.write(
          `  ! shell denied (no TTY to approve): ${op.cmd}\n` +
            `    re-run with --yes to allow shell commands\n`,
        );
      }
      respond({ allow: false, reason: 'headless mode without --yes' });
    }
  });

  try {
    await agent.run(input);
  } finally {
    const pending = agent.pendingEvents();
  if (pending.length) {
    emit({ type: 'pending-events', events: pending });
    if (!opts.json) {
      const list = pending.map((p) => `${p.name} ×${p.count}`).join(', ');
      process.stderr.write(`  ! emitted with no listener: ${list}\n`);
    }
  }

  log.close(failed ? 'error' : 'done');
  }

  emit({ type: 'done', stats: agent.stats, session: log.id });
  if (!opts.json) {
    const cost = agent.stats.costUnknown
      ? 'cost n/a'
      : `${agent.stats.costEstimated ? '~' : ''}$${agent.stats.cost.toFixed(4)}`;
    process.stderr.write(
      `\n[${agent.stats.turns} turns · ${agent.stats.ops} ops · ${cost} · session ${log.id}]\n`,
    );
  }
  return failed ? 1 : 0;
}

/**
 * Line-buffered filter that drops ```da_ops fences from a token stream while
 * letting everything else through as it arrives.
 */
export function createOpsFilter(out) {
  let pending = '';
  let inOps = false;

  const handleLine = (line) => {
    if (!inOps) {
      if (/^\s*```\s*da_ops\s*$/i.test(line)) {
        inOps = true;
        return;
      }
      out(line + '\n');
    } else if (/^\s*```\s*$/.test(line)) {
      inOps = false;
    }
  };

  return {
    write(delta) {
      pending += delta;
      let nl;
      while ((nl = pending.indexOf('\n')) !== -1) {
        handleLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    },
    reset() {
      if (pending && !inOps) out(pending);
      pending = '';
      inOps = false;
    },
  };
}

function describeOp(op) {
  switch (op.op) {
    case 'shell':
      return `shell: ${op.cmd}`;
    case 'move':
      return `move: ${op.from} -> ${op.to}`;
    case 'grep':
    case 'glob':
      return `${op.op}: ${op.pattern} in ${op.path}`;
    default:
      return `${op.op}: ${op.path}`;
  }
}

/**
 * Read piped stdin, if any.
 *
 * Two traps. A TTY never ends, so we skip it outright. And a pipe held open by a parent
 * that never writes (how most non-interactive shells invoke a child) also never ends, so
 * something has to stop us waiting forever.
 *
 * The grace period only covers the wait for the *first* byte, and that is the trap in the
 * trap: `slow-command | davai` emits nothing for longer than the window, so davai read
 * empty and exited with "nothing to do" while the producer was still starting up. So the
 * grace period applies only when a prompt was already supplied on the command line and
 * stdin is optional extra. When stdin is the only possible source of input, we wait for
 * the producer — bounded, so a dead pipe cannot hang a machine, but long enough that a
 * slow one is never cut off. A hang you can ctrl+C beats input silently dropped.
 *
 * One narrow case is left: `slow-command | davai "a prompt"`, where both sources are used
 * and the pipe is slower than the grace period, still loses the piped half. It cannot be
 * fixed by waiting, because a prompt in argv is also what makes a never-writing inherited
 * pipe survivable — and that is the far more common shape.
 */
export function readStdin({ idleMs = 250, required = false, maxWaitMs = 5 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY) return resolve('');

    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeAllListeners('data');
      stdin.removeAllListeners('end');
      stdin.removeAllListeners('error');
      stdin.pause();
      resolve(data.trim());
    };

    // Armed only until the first byte; after that we wait for a genuine end.
    const timer = setTimeout(done, required ? maxWaitMs : idleMs);

    stdin.setEncoding('utf8');
    stdin.on('data', (c) => {
      clearTimeout(timer);
      data += c;
    });
    stdin.on('end', done);
    stdin.on('error', done);
  });
}
