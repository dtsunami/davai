/**
 * REPL-level commands. These run locally and never reach the model, except that
 * several of them deliberately add their output to context.
 */
import os from 'node:os';
import { runShell } from '../agent/ops/shell.js';
import { loadImage, clipboardImage } from '../context/images.js';
import { listSessions } from '../session/log.js';
import { compact } from '../context/compact.js';
import { formatTokens, glyphs } from './theme.js';

const HELP = `Commands
  sh <cmd>            run a shell command; output is added to context
  /model              model and settings pane
  /context            context breakdown (also ctrl+g)
  /artifacts          artifacts from this session (also ctrl+a)
  /image [path]       attach an image (no path = clipboard, Windows)
  /compact            compact the context now
  /sessions           recent sessions
  /config             resolved configuration
  /clear              drop conversation context, keep grounding
  /yolo [on|off]      auto-approve shell commands for this session
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

/**
 * @returns {Promise<{handled: boolean, input?: string}>}
 */
export async function handleCommand(text, deps) {
  const { session, push, setPane, exit, refresh } = deps;
  const { cfg, ledger, sandbox, log, agent } = session;

  // --- sh <cmd> (req 13) ---
  if (text === 'sh' || text.startsWith('sh ')) {
    const cmd = text.slice(2).trim();
    if (!cmd) {
      push({ type: 'info', text: 'usage: sh <command>' });
      return { handled: true };
    }
    push({ type: 'user', text });
    const out = await runShell({ cmd }, { sandbox, shellTimeout: cfg.shellTimeout });
    const body = [out.stdout, out.stderr && `stderr:\n${out.stderr}`].filter(Boolean).join('\n');
    push({
      type: 'info',
      text: body || '(no output)',
      color: out.exitCode === 0 ? undefined : 'red',
    });
    push({
      type: 'notice',
      message: `exit ${out.exitCode} · ${out.durationMs}ms · added to context`,
    });

    ledger.add({
      type: 'shell',
      label: `sh ${cmd}`,
      role: 'user',
      text: `The operator ran a shell command:\n$ ${cmd}\nexit ${out.exitCode}\n${body || '(no output)'}`,
    });
    log.event('operator-shell', { cmd, exitCode: out.exitCode });
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
        const cost = t.costUnknown ? 'n/a' : `$${(t.cost || 0).toFixed(4)}`;
        return `  ${s.id}  ${s.startedAt.slice(0, 19)}  ${s.model}  ${t.turns || 0}t ${t.ops || 0}ops  ${cost}`;
      });
      push({ type: 'info', text: ['Recent sessions', ...lines].join('\n') });
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
