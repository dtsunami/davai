/**
 * REPL-level commands. These run locally and never reach the model, except that
 * several of them deliberately add their output to context.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROMPTS, PROMPT_SPECS, promptDirs } from '../agent/prompt.js';import { runShell } from '../agent/ops/shell.js';
import { gateShell } from '../agent/ops/executor.js';
import { loadImage, clipboardImage } from '../context/images.js';
import { listSessions } from '../session/log.js';
import { compact } from '../context/compact.js';
import { formatTokens, glyphs } from './theme.js';

const HELP = `Commands
  sh <cmd>            run a shell command; output is added to context (sudo asks for a password)
  /model              model and settings pane
  /context            context breakdown (also ctrl+g)
  /artifacts          artifacts from this session (also ctrl+a)
  /image [path]       attach an image (no path = clipboard, Windows)
  /compact            compact the context now
  /sessions           recent sessions
  /config             resolved configuration
  /prompts [export]   where each prompt comes from; export writes them to ./.prompts
  /clear              drop conversation context, keep grounding
  /yolo [on|off]      auto-approve shell commands for this session
  /events             harness events emitted vs retired this session
  /history [n]        recent prompts, across sessions (default 15)
  /replay <n>         run a prompt from /history again
  /help               this text
  /exit               quit

Keys
  esc                 cancel the running turn, or close a pane
  ctrl+g              context pane
  ctrl+a              artifacts pane
  ctrl+s              toggle shell mode
  ctrl+u              clear the input line
  tab                 complete @paths and /commands
  shift+enter         newline instead of submit
  ctrl+c twice        quit

Input
  @path/to/file       tab-completes against the working directory
  multi-line paste    stored as [[paste#N]], expanded on submit`;

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}${glyphs.ellipsis}` : text;
}

/** Only the overridden prompts are worth naming; the defaults are the norm. */
function describePrompts(cfg) {
  const overridden = Object.entries(cfg.promptSources || {}).filter(
    ([, source]) => source !== 'default',
  );
  if (!overridden.length) return 'all default';
  return overridden.map(([key, source]) => `${key} ${glyphs.arrow} ${source}`).join(', ');
}

/**
 * @returns {Promise<{handled: boolean, input?: string}>}
 */
export async function handleCommand(text, deps) {
  const { session, push, setPane, exit, refresh } = deps;
  const { cfg, ledger, sandbox, log, agent, history } = session;

  // --- sh <cmd> (req 13) ---
  if (text === 'sh' || text.startsWith('sh ')) {
    const cmd = text.slice(2).trim();
    if (!cmd) {
      push({ type: 'info', text: 'usage: sh <command>' });
      return { handled: true };
    }
    push({ type: 'user', text });

    // Operator-initiated, so there is no approval question. sudo may still need a
    // password: gateShell asks for it through the approval pane (requestSecret) and
    // checks it before anything runs, sharing the agent's in-memory cache.
    const gate = await gateShell({ op: 'shell', cmd }, 0, {
      sudo: agent?.sudo,
      approve: (op, index, extra) =>
        extra?.sudo && deps.requestSecret
          ? deps.requestSecret(op, extra)
          : Promise.resolve({ allow: true }),
    });

    if (!gate.allow) {
      const why = gate.message || gate.reason || 'not run';
      push({ type: 'warning', message: `not run: ${why}` });
      // In context too, so the model never assumes the command ran if asked about it.
      ledger.add({
        type: 'shell',
        label: `sh ${cmd} (not run)`,
        role: 'user',
        text: `The operator tried to run a shell command, but it was not run:\n$ ${cmd}\n${why}`,
      });
      log.event('operator-shell', { cmd, notRun: why });
      refresh();
      return { handled: true };
    }

    const out = await runShell(
      gate.op,
      { sandbox, shellTimeout: cfg.shellTimeout },
      { secret: gate.secret },
    );
    // sudo asked twice in one process: the cached password is stale.
    if (out.sudo?.refused) agent?.sudo?.forget();

    const body = [out.stdout, out.stderr && `stderr:\n${out.stderr}`].filter(Boolean).join('\n');
    const notes = [gate.auth, out.note].filter(Boolean);
    push({
      type: 'info',
      text: body || '(no output)',
      color: out.exitCode === 0 ? undefined : 'red',
    });
    for (const n of notes) push({ type: out.exitCode === 0 ? 'notice' : 'warning', message: n });
    push({
      type: 'notice',
      message: `exit ${out.exitCode} · ${out.durationMs}ms · added to context`,
    });

    ledger.add({
      type: 'shell',
      label: `sh ${cmd}`,
      role: 'user',
      text:
        `The operator ran a shell command:\n$ ${cmd}\nexit ${out.exitCode}\n` +
        notes.map((n) => `[${n}]\n`).join('') +
        (body || '(no output)'),
    });
    log.event('operator-shell', {
      cmd,
      exitCode: out.exitCode,
      ...(gate.auth ? { auth: gate.auth } : {}),
    });
    refresh();
    return { handled: true };
  }

  if (!text.startsWith('/')) return { handled: false };

  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ');

  switch (cmd) {
    case 'help':
    case '?':
      push({ type: 'info', text: HELP });
      return { handled: true };

    case 'exit':
    case 'quit':
    case 'q':
      exit();
      return { handled: true };

    case 'model':
      setPane('model');
      return { handled: true };

    case 'context':
      setPane('context');
      return { handled: true };

    case 'artifacts':
      setPane('artifacts');
      return { handled: true };

    case 'compact': {
      push({ type: 'notice', message: 'compacting…' });
      const result = await compact(ledger, {
        cfg,
        makeProvider: agent.makeProvider,
        onEvent: (e) => push({ type: 'warning', message: e.message }),
      });
      push({ type: 'compact', ...result });
      refresh();
      return { handled: true };
    }

    case 'events': {
      const rows = agent.eventSummary();
      const total = rows.reduce((n, r) => n + r.emitted, 0);
      const unretired = rows.filter((r) => r.unretired > 0);
      const undeclared = rows.filter((r) => !r.declared);
      const silent = rows.filter((r) => r.declared && r.emitted === 0);

      const lines = rows
        .filter((r) => r.emitted > 0)
        .map((r) => {
          const flag = r.unretired
            ? `  ${glyphs.warn} ${r.unretired} unretired`
            : !r.declared
              ? `  ${glyphs.warn} not in EVENTS`
              : '';
          return `  ${r.name.padEnd(18)}${String(r.emitted).padStart(6)}${flag}`;
        });

      if (silent.length) {
        lines.push('', `  never fired: ${silent.map((r) => r.name).join(', ')}`);
      }
      if (unretired.length || undeclared.length) {
        lines.push(
          '',
          `  ${glyphs.warn} ${unretired.length + undeclared.length} event type(s) went nowhere — ` +
            `emitted with no listener, which fails silently`,
        );
      } else if (total) {
        lines.push('', `  every one of ${total} events had a listener`);
      }

      push({ type: 'info', text: [`Events (emitted ${glyphs.arrow} retired)`, ...lines].join('\n') });
      return { handled: true };
    }

    case 'history': {
      if (!history?.length) {
        push({ type: 'info', text: 'no prompt history yet' });
        return { handled: true };
      }
      const n = Number.parseInt(arg, 10);
      const rows = history.recent(Number.isFinite(n) && n > 0 ? n : 15);
      const lines = rows.map((row) => {
        const first = row.text.split('\n')[0];
        const extra = row.text.includes('\n') ? ` ${glyphs.ellipsis}` : '';
        // Only worth naming the directory when it is not this one.
        const where = row.cwd && row.cwd !== cfg.cwd ? `  (${row.cwd})` : '';
        return `  ${String(row.n).padStart(3)}  ${truncate(first, 88)}${extra}${where}`;
      });
      push({
        type: 'info',
        text: [`Prompt history (${history.length} total) — /replay <n>`, ...lines].join('\n'),
      });
      return { handled: true };
    }

    case 'replay': {
      const n = Number.parseInt(arg, 10);
      if (!Number.isFinite(n) || n === 0) {
        push({ type: 'warning', message: '/replay takes a number from /history (or -1 for the last)' });
        return { handled: true };
      }
      const prompt = history?.at(n);
      if (prompt == null) {
        push({ type: 'warning', message: `no prompt ${n} in history (${history?.length || 0} recorded)` });
        return { handled: true };
      }
      push({ type: 'notice', message: `replaying ${n}: ${truncate(prompt.split('\n')[0], 72)}` });
      // Not handled: the caller submits this as though it had just been typed.
      return { handled: false, input: prompt };
    }

    case 'yolo': {
      const want = arg ? /^(on|1|true|yes)$/i.test(arg) : !cfg.yolo;
      if (arg && !/^(on|off|1|0|true|false|yes|no)$/i.test(arg)) {
        push({ type: 'warning', message: `/yolo takes on or off (got "${arg}")` });
        return { handled: true };
      }
      cfg.yolo = want;
      log.event('yolo', { enabled: want });
      push(
        want
          ? {
              type: 'warning',
              message:
                'yolo on — shell commands run without asking. The write jail and ' +
                'read allowlist still apply; only the prompt is gone.',
            }
          : { type: 'notice', message: 'yolo off — shell commands need approval again' },
      );
      refresh();
      return { handled: true };
    }

    case 'clear': {
      const before = ledger.tokens;
      ledger.segments = ledger.segments.filter((s) => s.type === 'grounding');
      push({
        type: 'notice',
        message: `context cleared (${formatTokens(before - ledger.tokens)} tokens freed); grounding kept`,
      });
      refresh();
      return { handled: true };
    }

    case 'image': {
      if (!cfg.model.vision) {
        push({ type: 'warning', message: `${cfg.model.id} has no vision support` });
        return { handled: true };
      }
      try {
        const img =
          !arg || arg === 'clipboard'
            ? clipboardImage(os.tmpdir())
            : loadImage(arg, sandbox);
        if (!img) {
          push({
            type: 'warning',
            message:
              process.platform === 'win32'
                ? 'no image on the clipboard'
                : 'clipboard images are only wired up on Windows — pass a path instead',
          });
          return { handled: true };
        }
        ledger.add({
          type: 'paste',
          label: `image ${img.name} (${Math.round(img.bytes / 1024)}kB)`,
          role: 'user',
          image: img,
        });
        push({ type: 'notice', message: `attached ${img.name} (~${img.tokens} tokens)` });
        refresh();
      } catch (err) {
        push({ type: 'error', message: err.message });
      }
      return { handled: true };
    }

    case 'sessions': {
      const rows = listSessions(cfg.home, 15);
      if (!rows.length) {
        push({ type: 'info', text: 'no sessions yet' });
        return { handled: true };
      }
      const lines = rows.map((s) => {
        const t = s.totals || {};
        const cost = t.costUnknown ? 'n/a' : `${t.costEstimated ? '~' : ''}$${(t.cost || 0).toFixed(4)}`;
        return `  ${s.id}  ${s.startedAt.slice(0, 19)}  ${s.model}  ${t.turns || 0}t ${t.ops || 0}ops  ${cost}`;
      });
      push({ type: 'info', text: ['Recent sessions', ...lines].join('\n') });
      return { handled: true };
    }

    case 'prompts': {
      const dirs = cfg.promptDirs || promptDirs(cfg.home, cfg.cwd);
      const [sub, ...flags] = rest.filter(Boolean);

      if (!sub) {
        const lines = PROMPT_SPECS.map((s) => {
          const layer = cfg.promptLayers?.[s.key] || 'default';
          const where = layer === 'default' ? 'built-in' : cfg.promptSources?.[s.key];
          return `  ${s.key.padEnd(10)} ${layer.padEnd(8)} ${where}`;
        });
        push({
          type: 'info',
          text: [
            `Prompts (highest wins: built-in ${glyphs.arrow} home ${glyphs.arrow} project)`,
            ...lines,
            '',
            `  home     ${dirs.home}`,
            `  project  ${dirs.project}`,
            '',
            '  /prompts export [--force] writes the resolved prompts to ./.prompts; edits apply on relaunch',
          ].join('\n'),
        });
        return { handled: true };
      }

      if (sub !== 'export' || flags.some((f) => f !== '--force')) {
        push({ type: 'warning', message: 'usage: /prompts  or  /prompts export [--force]' });
        return { handled: true };
      }
      const force = flags.includes('--force');

      let targets;
      try {
        targets = PROMPT_SPECS.map((spec) => ({
          spec,
          abs: sandbox.resolveForWrite(path.join(dirs.project, spec.file)),
        }));
      } catch (err) {
        push({ type: 'warning', message: `not exported: ${err.message}` });
        return { handled: true };
      }

      // Check every file before writing any, so a refusal leaves nothing half-exported.
      const existing = targets.filter((t) => fs.existsSync(t.abs));
      if (existing.length && !force) {
        push({
          type: 'warning',
          message:
            `not exported: ${existing.map((t) => sandbox.rel(t.abs)).join(', ')} ` +
            `already exist${existing.length === 1 ? 's' : ''} — /prompts export --force to overwrite`,
        });
        return { handled: true };
      }

      const values = cfg.prompts || DEFAULT_PROMPTS;
      try {
        fs.mkdirSync(path.dirname(targets[0].abs), { recursive: true });
        for (const t of targets) fs.writeFileSync(t.abs, values[t.spec.key]);
      } catch (err) {
        push({ type: 'warning', message: `export failed: ${err.message}` });
        return { handled: true };
      }
      log.event('prompts-export', { dir: dirs.project, force, files: targets.length });
      push({
        type: 'notice',
        message:
          `exported ${targets.length} prompts to ${sandbox.rel(path.dirname(targets[0].abs))}/ — ` +
          `edits apply on relaunch, and these now shadow $DAVAI_HOME/prompts for this project`,
      });
      return { handled: true };
    }

    case 'config': {
      const lines = [
        'Configuration',
        `  provider       ${cfg.provider}`,
        `  model          ${cfg.model.id}${cfg.model.unverified ? ' (unverified — not in the local registry)' : ''}`,
        `  context limit  ${formatTokens(cfg.contextLimit)}`,
        `  max output     ${formatTokens(cfg.maxTokens)}`,
        `  effort         ${cfg.effort}`,
        `  compact at     ${Math.round(cfg.compactAt * 100)}%`,
        `  shell timeout  ${cfg.shellTimeout / 1000}s`,
        `  yolo           ${cfg.yolo ? 'on — shell auto-approved' : 'off'}`,
        `  prompts        ${describePrompts(cfg)}`,
        `  DAVAI_HOME     ${cfg.home}`,
        `  working dir    ${cfg.cwd}`,
        `  read-only dirs ${cfg.roDirs.length ? cfg.roDirs.join(', ') : '(none)'}`,
        `  .env loaded    ${cfg.envFiles.length ? cfg.envFiles.join(', ') : '(none)'}`,
        `  session        ${log.id} ${glyphs.arrow} ${log.dir}`,
      ];
      push({ type: 'info', text: lines.join('\n') });
      return { handled: true };
    }

    default:
      push({
        type: 'warning',
        message: `unknown command /${cmd} — try /help`,
      });
      return { handled: true };
  }
}
