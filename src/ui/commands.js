/**
 * REPL-level commands. These run locally and never reach the model, except that
 * several of them deliberately add their output to context.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROMPTS, PROMPT_SPECS, promptDirs } from '../agent/prompt.js';
import { checkForks, stampFork, snapshot, hashText } from '../agent/promptfork.js';
import { runShell } from '../agent/ops/shell.js';
import { gateShell } from '../agent/ops/executor.js';
import { loadImage, clipboardImage } from '../context/images.js';
import { listSessions } from '../session/log.js';
import { readStream } from '../session/stream.js';
import { runCompact } from '../context/manage.js';
import { formatTokens, glyphs } from './theme.js';

const HELP = `Commands
  sh <cmd>            run a shell command; output is added to context (sudo asks for a password)
  /model [id|query]   model and settings pane (--save to remember it for next time)
  /tps                token/s and time-to-first-token, per turn and per model (also ctrl+t)
  /context            context breakdown (also ctrl+g)
  /artifacts          artifacts from this session (also ctrl+a)
  /image [path]       attach an image (no path = clipboard, Windows)
  /compact            compact the context now
  /sessions           recent sessions
  /stream [n]         streamed reasoning + text for a turn, read back from disk
  /keys [provider]    enable a provider: see, paste or save API keys
  /env [name]         provider blocks in your .env; /env <name> switches to one
  /config             resolved configuration
  /prompts [sub]      prompt layers and fork drift: export/diff/accept/reset
  /clear              drop conversation context, keep grounding
  /yolo [on|off]      auto-approve shell commands for this session
  /events             harness events emitted vs retired this session
  /history [n]        recent prompts, across sessions (default 15)
  /replay <n>         run a prompt from /history again
  /help               this text
  /exit               quit

Keys
  esc                 cancel the running turn, or close a pane
  ctrl+t              token/s and ttft pane (per turn, per model, vs context)
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
 * The command table as data, for a view that offers completion.
 *
 * Parsed from HELP rather than maintained beside it: the web client and the REPL must
 * not drift, and the surest way to guarantee that is to have one list. Only the
 * Commands section is read — the Keys and Input sections below it describe bindings,
 * not commands, and `shift+enter` is not something you can type at a prompt.
 */
export function commandList() {
  const out = [];
  for (const line of HELP.split('\n')) {
    if (/^\S/.test(line) && out.length) break; // next section heading ends the table
    const m = /^ {2}(\S.*?)\s{2,}(\S.*)$/.exec(line);
    if (!m) continue;
    const usage = m[1].trim();
    const name = usage.split(/\s/)[0];
    if (!name.startsWith('/') && name !== 'sh') continue;
    out.push({ name, usage, desc: m[2].trim() });
  }
  return out;
}

/**
 * " (from <source>)" for a variable, or '' when nothing set it. Reads cfg.varOrigins,
 * which holds sources only and never values.
 */
function origin(cfg, name) {
  const from = cfg.varOrigins?.[name];
  if (!from) return '';
  const home = `${cfg.home}/.env`;
  const label = from === home ? '~/.davai/.env' : from;
  return `  (from ${label})`;
}

/** Which providers are usable, for /config. Never a key, only whether there is one. */
function describeKeys(cfg) {
  const have = Object.keys(cfg.keys || {}).filter((p) => cfg.keys[p]);
  const missing = Object.keys(cfg.keys || {}).filter((p) => !cfg.keys[p]);
  return (
    (have.length ? have.join(', ') : 'none') +
    (missing.length ? `  (no key: ${missing.join(', ')} — /keys to add one)` : '')
  );
}

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

    case 'model': {
      // --save additionally remembers the choice in settings.json. Without it a switch
      // is for this session only, which is the common case and the safe default: a
      // model tried once should not become the default for every project.
      const save = /(^|\s)--save(\s|$)/.test(arg);
      const argText = arg.replace(/(^|\s)--save(\s|$)/, ' ').trim();
      if (!argText) {
        session.modelPersist = save;
        setPane('model');
        return { handled: true };
      }
      // `/model openrouter` switches provider and opens the pane; `/model provider/slug`
      // or `/model <known-id>` switches directly; otherwise treat `arg` as a filter query.
      // The switch itself is session/models.js, shared with the pane and the browser.
      const { PROVIDERS, findModel } = await import('../config/models.js');
      const { applyModelChange } = await import('../session/models.js');
      const trimmed = argText;
      if (PROVIDERS.includes(trimmed.toLowerCase())) {
        const nextProv = trimmed.toLowerCase();
        if (!cfg.keys?.[nextProv]) {
          // Naming a provider with no key is the single most common way an operator
          // asks to enable one. Send them where that happens instead of refusing.
          push({
            type: 'warning',
            message: `no API key for ${nextProv} — /keys ${nextProv} to add one`,
          });
          session.keysProvider = nextProv;
          setPane('keys');
          return { handled: true };
        }
        // Browsed, not switched: naming a provider alone says nothing about which of its
        // models to run, and the pane's enter is what commits.
        session.modelBrowse = nextProv;
        session.modelPersist = save;
        setPane('model');
        return { handled: true };
      }
      const isSlug = trimmed.includes('/');
      const known = findModel(trimmed);
      if (isSlug || known) {
        const targetProvider = known
          ? known.provider
          : isSlug && cfg.keys?.openrouter
            ? 'openrouter'
            : cfg.provider;
        try {
          const r = await applyModelChange(
            session,
            { provider: targetProvider, model: trimmed },
            { persist: save },
          );
          for (const message of r.notices) push({ type: 'warning', message });
          push({
            type: 'notice',
            message:
              `model ${glyphs.arrow} ${trimmed} (${r.provider}, ${formatTokens(r.contextLimit)} context)` +
              (r.persisted ? ' · saved as the default' : ' · this session only'),
          });
          refresh();
        } catch (err) {
          push({ type: 'error', message: `could not switch model: ${err.message}` });
        }
        return { handled: true };
      }
      session.modelSearch = trimmed;
      session.modelPersist = save;
      setPane('model');
      return { handled: true };
    }

    case 'tps':
    case 'throughput':
    case 'speed':
    case 'perf':
      setPane('tps');
      return { handled: true };

    case 'context':
      setPane('context');
      return { handled: true };

    case 'artifacts':
      setPane('artifacts');
      return { handled: true };

    case 'compact': {
      // Through manage.js rather than compact.js directly, so this takes the same lock
      // the agent's auto-compact and the web route do. Typing /compact mid-run used to
      // reshape the segment array underneath a compaction already in flight.
      push({ type: 'notice', message: 'compacting…' });
      try {
        const result = await runCompact(ledger, {
          cfg,
          makeProvider: agent.makeProvider,
          onEvent: (e) => push({ type: 'warning', message: e.message }),
        });
        push({ type: 'compact', ...result });
        refresh();
      } catch (err) {
        push({
          type: 'warning',
          message:
            err?.code === 'LEDGER_BUSY'
              ? 'a compaction is already running — wait for it to finish'
              : `compaction failed: ${err.message}`,
        });
      }
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

    case 'stream': {
      // Flush first: the tail of the turn in flight is still buffered.
      log.stream?.flush();
      const turns = readStream(log.dir);
      if (!turns.length) {
        push({ type: 'info', text: 'nothing streamed to disk yet this session' });
        return { handled: true };
      }
      const n = Number.parseInt(arg, 10);
      const picked =
        Number.isFinite(n) && n > 0 ? turns.filter((t) => t.turn === n) : turns.slice(-1);
      if (!picked.length) {
        push({
          type: 'warning',
          message: `no turn ${n} on disk (streamed: ${turns.map((t) => t.turn).join(', ')})`,
        });
        return { handled: true };
      }
      const lines = [];
      for (const t of picked) {
        const how =
          t.status === 'ok'
            ? t.stop || 'ok'
            : t.error
              ? `${t.status}: ${t.error}`
              : t.status === 'open'
                ? 'open — no end marker, the turn never finished'
                : t.status;
        lines.push(
          `turn ${t.turn}${t.attempts ? ` (${t.attempts} attempts)` : ''} ${glyphs.arrow} ${how}` +
            `  ${t.thinking.length} chars thinking, ${t.text.length} chars text`,
        );
        if (t.thinking) lines.push('', '--- thinking ---', t.thinking);
        if (t.text) lines.push('', '--- text ---', t.text);
      }
      lines.push('', `${turns.length} turn(s) in ${path.join(log.dir, 'stream.jsonl')}`);
      push({ type: 'info', text: lines.join('\n') });
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

      const forks = checkForks({ sources: cfg.promptSources, layers: cfg.promptLayers });
      const driftOf = (key) => {
        if (forks.stale.some((s) => s.key === key)) return 'STALE';
        if (forks.unstamped.some((u) => u.key === key)) return 'unstamped';
        return '';
      };

      if (!sub) {
        const lines = PROMPT_SPECS.map((s) => {
          const layer = cfg.promptLayers?.[s.key] || 'default';
          const where = layer === 'default' ? 'built-in' : cfg.promptSources?.[s.key];
          return `  ${s.key.padEnd(10)} ${layer.padEnd(8)} ${driftOf(s.key).padEnd(10)} ${where}`;
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
            '  /prompts export [--force]   write the resolved prompts to ./.prompts',
            '  /prompts diff <key>         what changed in the built-in since you forked',
            "  /prompts accept <key|all>   keep yours, re-baseline against today's built-in",
            '  /prompts reset <key>        discard yours and use the built-in',
          ].join('\n'),
        });
        return { handled: true };
      }

      // --- drift resolution ---

      if (sub === 'diff' || sub === 'accept' || sub === 'reset') {
        const key = flags[0];
        const known = PROMPT_SPECS.map((s) => s.key);

        if (sub === 'accept' && key === 'all') {
          const drifted = [...forks.stale, ...forks.unstamped];
          if (!drifted.length) {
            push({ type: 'notice', message: 'every override is already current' });
            return { handled: true };
          }
          // Overrides may sit in different directories (home and project), and each
          // directory carries its own manifest.
          const byDir = new Map();
          for (const f of drifted) byDir.set(f.dir, [...(byDir.get(f.dir) || []), f.key]);
          for (const [dir, ks] of byDir) stampFork(dir, ks);
          const keys = drifted.map((f) => f.key);
          log.event('prompts-accept', { keys });
          push({
            type: 'notice',
            message: `re-baselined ${keys.join(', ')} against the current built-ins`,
          });
          refresh();
          return { handled: true };
        }

        if (!key || !known.includes(key)) {
          push({ type: 'warning', message: `usage: /prompts ${sub} <${known.join('|')}>` });
          return { handled: true };
        }
        if ((cfg.promptLayers?.[key] || 'default') === 'default') {
          push({ type: 'notice', message: `${key} is not overridden — nothing to ${sub}` });
          return { handled: true };
        }
        const file = cfg.promptSources?.[key];
        const spec = PROMPT_SPECS.find((s) => s.key === key);

        if (sub === 'diff') {
          const entry = forks.stale.find((s) => s.key === key);
          push({
            type: 'info',
            text: [
              `${key}  ${file}`,
              entry
                ? `  forked from davai ${entry.forkedVersion} (${entry.forkedHash}); ` +
                  `built-in is now ${entry.currentVersion} (${entry.currentHash})`
                : `  no recorded drift (built-in hash ${hashText(spec.text)})`,
              '',
              '--- current built-in ---',
              spec.text,
              '',
              '--- yours ---',
              cfg.prompts?.[key] ?? '(unreadable)',
            ].join('\n'),
          });
          return { handled: true };
        }

        if (sub === 'accept') {
          stampFork(path.dirname(file), [key]);
          log.event('prompts-accept', { keys: [key] });
          push({
            type: 'notice',
            message: `${key} re-baselined against the current built-in; ${file} is unchanged`,
          });
          refresh();
          return { handled: true };
        }

        // reset: remove the override so the built-in applies again on relaunch.
        try {
          const kept = snapshot(file);
          fs.rmSync(file);
          log.event('prompts-reset', { key, file, snapshot: kept });
          push({
            type: 'notice',
            message:
              `${key} reset to the built-in — ${file} removed` +
              (kept ? ` (copy kept at ${kept})` : '') +
              '; applies on relaunch',
          });
        } catch (err) {
          push({ type: 'warning', message: `reset failed: ${err.message}` });
        }
        return { handled: true };
      }

      if (sub !== 'export' || flags.some((f) => f !== '--force')) {
        push({
          type: 'warning',
          message:
            'usage: /prompts [export [--force] | diff <key> | accept <key|all> | reset <key>]',
        });
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
        for (const t of targets) {
          if (force) snapshot(t.abs);
          fs.writeFileSync(t.abs, values[t.spec.key]);
        }
        // Record what the built-ins looked like at the moment of the fork. Without this
        // an exported file is indistinguishable from one forked years ago, and the drift
        // check can only shrug at it.
        stampFork(
          path.dirname(targets[0].abs),
          targets.map((t) => t.spec.key),
        );
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

    /**
     * `/keys` — see which providers are usable; `/keys <provider> <key>` makes one so.
     *
     * A key typed at the prompt is in the scrollback and in history.jsonl, so the bare
     * form opens the pane, where the input is masked and never recorded. The inline form
     * stays because it is the only thing that works over a pipe in headless mode, and it
     * scrubs itself from history below.
     */
    case 'keys':
    case 'providers': {
      const { keyState, setProviderKey, clearProviderKey } = await import('../session/keys.js');
      const words = arg.split(/\s+/).filter(Boolean);
      const save = words.includes('--save');
      const noVerify = words.includes('--no-verify');
      const rest2 = words.filter((w) => !w.startsWith('--'));
      const [who, secret] = rest2;

      if (!who) {
        const rows = keyState(cfg).map((p) => {
          const mark = p.current ? glyphs.check : ' ';
          const status = p.hasKey ? `${p.masked}  (${p.varName} from ${p.origin})` : 'no key';
          return `  ${mark} ${p.name.padEnd(12)} ${status}`;
        });
        push({
          type: 'info',
          text: [
            'Providers',
            ...rows,
            '',
            `  /keys <provider>            open the pane and paste a key (not echoed)`,
            `  /keys <provider> <key>      set it for this session`,
            `  /keys <provider> <key> --save   also write it to ${cfg.home}/.env`,
            `  /keys <provider> --clear    forget it`,
          ].join('\n'),
        });
        return { handled: true };
      }

      if (words.includes('--clear')) {
        try {
          const r = clearProviderKey(session, { provider: who, persist: save });
          push({
            type: 'notice',
            message: `${r.provider} key cleared${r.persisted ? ` and removed from ${r.file}` : ' for this session'}`,
          });
          refresh();
        } catch (err) {
          push({ type: 'error', message: err.message });
        }
        return { handled: true };
      }

      if (!secret) {
        session.keysProvider = who.toLowerCase();
        session.keysPersist = save;
        setPane('keys');
        return { handled: true };
      }

      try {
        const r = await setProviderKey(session, {
          provider: who,
          key: secret,
          persist: save,
          verify: !noVerify,
        });
        for (const message of r.warnings) push({ type: 'warning', message });
        push({
          type: 'notice',
          message:
            `${r.provider} key set (${r.masked})` +
            (r.persisted ? ` · saved to ${r.file} as ${r.varName}` : ' · this session only'),
        });
        refresh();
      } catch (err) {
        push({ type: 'error', message: `key not set: ${err.message}` });
      }
      // Nothing to scrub from history.jsonl: dispatch records a line only after
      // handleCommand declines it, so a slash command is never written to disk. The
      // key does remain in this process's up-arrow buffer and in the scrollback,
      // which is why the bare `/keys <provider>` form exists.
      return { handled: true };
    }

    /**
     * `/env` — several endpoint-and-key sets in one .env, one live at a time.
     *
     * Switching is a comment/uncomment edit of $DAVAI_HOME/.env and nothing else: the
     * inactive blocks stay in the file as ordinary comments, so a key pasted six months
     * ago survives every switch since, and the file is still a .env that dotenv, Docker
     * and `set -a; . ./.env` read the same way davai does.
     */
    case 'env':
    case 'profile': {
      const { profileState, switchProfile, chooseProfileVar } = await import(
        '../session/profiles.js'
      );
      const words = arg.split(/\s+/).filter(Boolean);
      const off = words.includes('--off');
      // `/env openrouter DAVAI_MODEL=deepseek/deepseek-v4.1-flash` picks one of several
      // assignments of the same name inside a block: the headless form of the pane's
      // one-hot. Matched against the whole argument, so a value may contain spaces.
      const assign = /(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(\S.*)$/.exec(arg);
      const want = words.filter((w) => !w.startsWith('--') && !w.includes('='))[0];

      // Bare `/env` opens the pane: switching is a keypress there, and the pane is the
      // only view that can show a block's settings without putting them in scrollback.
      // The printed list stays for headless, where there is no pane to open.
      if (!want && !off && setPane && !words.includes('--list')) {
        const hasBlocks = profileState(cfg).blocks.length > 0;
        if (hasBlocks) {
          setPane('env');
          return { handled: true };
        }
      }

      if (!want && !off) {
        const state = profileState(cfg);
        if (!state.blocks.length) {
          push({
            type: 'info',
            text: [
              `No provider blocks in ${state.file}.`,
              '',
              'A block is a sentinel comment and the settings under it:',
              '',
              '  #---# mistral',
              '  DAVAI_PROVIDER=openai',
              '  DAVAI_BASE_URL=https://api.mistral.ai/v1',
              '  DAVAI_OPENAI_API_KEY=sk-...',
              '  #-end-provider-#',
              '',
              'A block runs to the next sentinel, to #-end-provider-#, or to end of file.',
              'Settings above the first sentinel always apply. `##` marks a comment davai',
              'will never uncomment. /env <name> then makes one live and the rest inert.',
            ].join('\n'),
          });
          return { handled: true };
        }
        const rows = state.blocks.map((b) => {
          const mark = b.enabled ? glyphs.check : ' ';
          const what = [b.provider, b.baseURL].filter(Boolean).join(' ' + glyphs.arrow + ' ');
          const names = b.vars.map((v) => v.name).join(', ');
          return `  ${mark} ${b.name.padEnd(14)} ${what || names}`;
        });
        push({
          type: 'info',
          text: [
            `Provider blocks  (${state.file})`,
            ...rows,
            ...(state.active.length > 1
              ? [
                  '',
                  `  ${glyphs.warn || '!'} ${state.active.join(' and ')} are both live — the ` +
                    `last one in the file wins. /env <name> fixes it.`,
                ]
              : []),
            '',
            `  /env <name>     make that block live, every other block inert`,
            `  /env --off      disable them all, leaving only the settings above them`,
            `  /env <name> VAR=value   pick one of several assignments in that block`,
          ].join('\n'),
        });
        return { handled: true };
      }

      if (want && assign) {
        try {
          const r = await chooseProfileVar(session, {
            block: want,
            name: assign[1],
            value: assign[2].trim(),
          });
          for (const message of r.notices) push({ type: 'warning', message });
          push({
            type: 'notice',
            message:
              `${r.block} ${glyphs.bullet} ${r.name}=${r.value} ${glyphs.bullet} ` +
              `${r.provider} ${glyphs.arrow} ${r.model}`,
          });
          log.event('profile-select', { block: r.block, name: r.name, value: r.value });
          refresh();
        } catch (err) {
          push({ type: 'error', message: err.message });
        }
        return { handled: true };
      }

      try {
        const r = await switchProfile(session, off ? null : want);
        for (const message of r.notices) push({ type: 'warning', message });
        push({
          type: 'notice',
          message: r.block
            ? `${r.block} is live — ${r.provider} ${glyphs.arrow} ${r.model}` +
              (r.baseURL ? ` at ${r.baseURL}` : '') +
              (r.disabled.length ? ` (${r.disabled.length} setting(s) commented out)` : '')
            : `all provider blocks disabled — ${r.provider} ${glyphs.arrow} ${r.model}`,
        });
        log.event('profile-switch', { block: r.block, provider: r.provider, model: r.model });
        refresh();
      } catch (err) {
        push({ type: 'error', message: err.message });
      }
      return { handled: true };
    }

    case 'config': {
      const lines = [
        'Configuration',
        // Where a setting came from is half the answer whenever it is not what the
        // operator expected: settings.json is now the weakest layer, not the strongest,
        // and "model, from .env" vs "model, from settings.json" is the whole difference.
        `  provider       ${cfg.provider}${origin(cfg, 'DAVAI_PROVIDER')}`,
        `  model          ${cfg.model.id}${origin(cfg, 'DAVAI_MODEL')}${cfg.model.unverified ? ' (unverified — not in the local registry)' : ''}`,
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
        `  providers      ${describeKeys(cfg)}`,
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
