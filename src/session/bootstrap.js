/**
 * Wire up one davai session. Shared by the TUI and headless mode so both run
 * identical machinery.
 */
import { loadConfig, requireKey, ensureHome } from '../config/env.js';
import { loadSettings, settingsToOverrides } from '../config/settings.js';
import { createProvider } from '../providers/index.js';
import { refineModel } from '../config/models.js';
import { Sandbox } from '../agent/sandbox.js';
import { DaIgnore } from '../agent/daignore.js';
import { Journal } from '../agent/journal.js';
import { Ledger } from '../context/ledger.js';
import { Artifacts } from '../context/artifacts.js';
import { Pastes } from '../context/pastes.js';
import { Agent } from '../agent/loop.js';
import { buildGrounding } from '../agent/grounding.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { SessionLog, pruneSessions } from './log.js';
import { findSession, restoreLedger } from './resume.js';
import { resolveHome } from '../config/env.js';

/**
 * @param {{cwd?: string, overrides?: Record<string,string>, resume?: string|true}} [opts]
 */
export async function createSession(opts = {}) {
  const home = resolveHome();
  const settings = loadSettings(home);

  // Resolve the session to resume before loadConfig: a resumed session defaults to the
  // working directory it ran in, or grounding and the sandbox would describe a
  // different tree than the transcript talks about.
  const prior = opts.resume ? resolvePrior(home, opts.resume) : null;

  const cfg = loadConfig({
    cwd: opts.cwd || prior?.cwd,
    overrides: { ...settingsToOverrides(settings), ...(opts.overrides || {}) },
  });
  const apiKey = requireKey(cfg);
  ensureHome(cfg);
  pruneSessions(cfg.home, prior ? { except: prior.dir } : {});

  // The registry is a seed; ask the provider for this model's real limits before we
  // size the context window around them.
  await refineModel(cfg.model, { apiKey });
  if (cfg.model.refined) cfg.contextLimit = cfg.model.context;

  const ignore = DaIgnore.fromDir(cfg.cwd);
  const sandbox = new Sandbox({ cwd: cfg.cwd, roDirs: cfg.roDirs, ignore });

  const log = new SessionLog({ home: cfg.home, cfg, resumedFrom: prior?.id });
  const journal = new Journal({ dir: log.dir });

  const ledger = new Ledger({ limit: cfg.contextLimit, compactAt: cfg.compactAt });
  const grounding = buildGrounding({ sandbox, cfg });
  ledger.setSystem(buildSystemPrompt({ grounding }));

  // After setSystem, so the replay budget accounts for the cached prefix.
  const resumed = prior ? restoreLedger(ledger, prior) : null;
  if (resumed) log.event('resume', resumed);

  const provider = createProvider(cfg);
  const makeProvider = (model) => createProvider(cfg, { model });

  const agent = new Agent({
    cfg,
    provider,
    makeProvider,
    ledger,
    sandbox,
    journal,
    artifacts: new Artifacts(),
    log,
  });

  return {
    cfg,
    agent,
    ledger,
    sandbox,
    journal,
    log,
    settings,
    pastes: new Pastes(),
    artifacts: agent.artifacts,
    grounding,
    resumed,
  };
}

function resolvePrior(home, resume) {
  const id = resume === true ? undefined : resume;
  const found = findSession(home, id);
  if (!found) {
    throw new Error(
      id
        ? `no session matches "${id}" — \`davai --sessions\` lists them`
        : 'no sessions to resume yet',
    );
  }
  return found;
}
