/**
 * TUI entry. Kept separate from App.jsx so bin/davai.js can import it lazily —
 * React and Ink cost ~100ms to load, which headless mode should not pay.
 */
import { createSession } from '../session/bootstrap.js';
import { prepareTerminal, glyphs, formatTokens } from './theme.js';
import { registerJsx } from './jsx-register.js';
import { writeClipboard } from '../context/artifacts.js';

export async function startTui({ input, cwd, overrides, resume, web }) {
  registerJsx();
  prepareTerminal();

  const [{ default: React }, { render }, { App }] = await Promise.all([
    import('react'),
    import('ink'),
    import('./App.jsx'),
  ]);

  const session = await createSession({ cwd, overrides, resume });
  const { log } = session;

  // Started before Ink renders, so a failed bind is a plain error rather than something
  // scribbled over a live frame.
  // DAVAI_WEB=true starts it without a flag; --web starts it regardless of the setting.
  const wantWeb = web || session.cfg.web?.enabled;
  const sidecar = wantWeb ? await startSidecar(session, web || {}) : null;

  // Put the sidecar URL — token included — on the clipboard before the banner shows it.
  // The banner already prints the same token, so this adds no exposure; it removes the
  // paste step, which is the whole point of reaching the UI from a phone.
  let urlCopied = false;
  if (sidecar) {
    try {
      await writeClipboard(sidecar.url);
      urlCopied = true;
    } catch {
      // No clipboard helper (pbcopy / wl-copy / xclip / clip.exe) on this box. The
      // banner line still shows the URL, so this degrades to manual copy.
    }
  }

  banner(session, sidecar, urlCopied);

  const instance = render(React.createElement(App, { session, initialInput: input }), {
    exitOnCtrlC: false,
  });

  const onSignal = () => {
    log.close('signal');
    instance.unmount();
  };
  process.on('SIGTERM', onSignal);

  try {
    await instance.waitUntilExit();
  } finally {
    process.off('SIGTERM', onSignal);
    if (sidecar) await sidecar.stop();
    if (!log.meta.endedAt) log.close('exit');
  }

  const s = session.agent.stats;
  const cost = s.costUnknown ? 'cost n/a' : `${s.costEstimated ? '~' : ''}$${s.cost.toFixed(4)}`;
  process.stdout.write(
    `\n${s.turns} turns · ${s.ops} ops · ${cost} · session ${log.id}\n` +
      `${log.dir}\n`,
  );

  // Printed on the way out rather than buried in /events: an event that fired with
  // nothing listening is a wiring bug, and the whole point is that it is otherwise silent.
  const pending = session.agent.pendingEvents();
  if (pending.length) {
    const list = pending.map((p) => `${p.name}${p.declared ? '' : ' (undeclared)'} ×${p.count}`);
    process.stdout.write(
      `\u001b[33m${glyphs.warn} emitted with no listener: ${list.join(', ')}\u001b[0m\n`,
    );
  }
  return 0;
}

/**
 * Bring up the web sidecar alongside the REPL.
 *
 * The bus attaches to the agent, not to the TUI: both views are subscribers, and the
 * harness stays the single writer. The dispatcher is the same one App.jsx builds, so a
 * message typed in the browser takes the identical path through steering, commands,
 * pastes and image refs.
 */
async function startSidecar(session, web) {
  const [{ SessionBus }, { createWebServer }, { createDispatcher }] = await Promise.all([
    import('../session/bus.js'),
    import('../server/http.js'),
    import('../session/dispatch.js'),
  ]);

  const bus = new SessionBus({ agent: session.agent, cfg: session.cfg });
  session.bus = bus;

  // A browser has no approval pane of its own until the request reaches it, and no
  // spinner to start; the bus carries both outward.
  const submit = createDispatcher({
    session,
    view: {
      // Tagged so the REPL can mirror it back into Ink: without that, a message typed
      // in the browser never appears in the terminal transcript at all.
      push: (entry) => bus.publish('transcript', { ...entry, origin: 'web' }),
      isBusy: () => bus.state.busy,
      // /context and /tps open a pane in the REPL; in a browser they switch tab. Without
      // this they were accepted and did nothing, which is worse than refusing them.
      setPane: (name) => bus.publish('pane', { pane: name }),
      // The model pane mutates cfg in place, so the browser needs to re-read it.
      refresh: () => bus.publish('session-changed', null),
    },
  });

  // Flags over config over defaults. cfg.web carries the DAVAI_WEB* values; `web` is
  // whatever the command line asked for, and an explicit flag always wins.
  const conf = session.cfg.web || {};
  const server = await createWebServer({
    session,
    bus,
    submit,
    port: web.port ?? conf.port ?? 7878,
    host: web.host || conf.host || '127.0.0.1',
    token: conf.token,
  }).listen();

  return {
    url: server.url(),
    async stop() {
      await server.close();
      bus.detach();
    },
  };
}

function banner(session, sidecar, urlCopied) {
  const { cfg, sandbox } = session;
  const w = (s) => process.stdout.write(s + '\n');
  const dim = (s) => `\u001b[2m${s}\u001b[0m`;
  const cyan = (s) => `\u001b[36m${s}\u001b[0m`;

  w('');
  w(cyan('  davai') + dim('  agentic repl'));
  w(
    dim(
      `  ${cfg.provider}/${cfg.model.id}  ${formatTokens(cfg.contextLimit)} ctx` +
        (cfg.model.effort ? `  effort ${cfg.effort}` : '') +
        (cfg.model.unverified ? '  (unverified model)' : ''),
    ),
  );
  w(dim(`  write ${glyphs.arrow} ${sandbox.writeRoot}`));
  if (cfg.roDirs.length) w(dim(`  read  ${glyphs.arrow} + ${cfg.roDirs.join(', ')}`));
  if (cfg.yolo) {
    w(`\u001b[31m  ${glyphs.warn} yolo: shell commands run without approval\u001b[0m`);
  }
  if (session.resumed) {
    const r = session.resumed;
    w(
      dim(
        `  resumed ${r.id}: ${r.turns} turn(s), ${r.segments} segment(s)` +
          (r.omitted ? `, ${r.omitted} omitted` : ''),
      ),
    );
  }
  // Printed before Ink draws, as plain lines, so a command in a warning (adopting an
  // ignored project setting) copies cleanly. Only the headline is coloured.
  for (const message of [...cfg.warnings, ...session.limitNotices]) {
    const [first, ...rest] = message.split('\n');
    w(`\u001b[33m  ${glyphs.warn} ${first}\u001b[0m`);
    for (const line of rest) w(`  ${line}`);
  }
  if (sidecar) {
    // Printed with the token in it: this is the thing you paste into a phone, and the
    // alternative is making the operator assemble a URL from two lines of banner.
    w(dim(`  web ${glyphs.arrow} ${sidecar.url}${urlCopied ? ' · copied to clipboard' : ''}`));
  }
  w(dim('  /help for commands · ctrl+g context · ctrl+a artifacts · esc cancel'));
  w('');
}
