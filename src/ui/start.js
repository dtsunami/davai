/**
 * TUI entry. Kept separate from App.jsx so bin/davai.js can import it lazily —
 * React and Ink cost ~100ms to load, which headless mode should not pay.
 */
import { createSession } from '../session/bootstrap.js';
import { prepareTerminal, glyphs, formatTokens } from './theme.js';
import { registerJsx } from './jsx-register.js';

export async function startTui({ input, cwd, overrides }) {
  registerJsx();
  prepareTerminal();

  const [{ default: React }, { render }, { App }] = await Promise.all([
    import('react'),
    import('ink'),
    import('./App.jsx'),
  ]);

  const session = await createSession({ cwd, overrides });
  const { cfg, log } = session;

  banner(session);

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
    if (!log.meta.endedAt) log.close('exit');
  }

  const s = session.agent.stats;
  const cost = s.costUnknown ? 'cost n/a' : `$${s.cost.toFixed(4)}`;
  process.stdout.write(
    `\n${s.turns} turns · ${s.ops} ops · ${cost} · session ${log.id}\n` +
      `${log.dir}\n`,
  );
  return 0;
}

function banner(session) {
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
  w(dim('  /help for commands · ctrl+g context · ctrl+a artifacts · esc cancel'));
  w('');
}
