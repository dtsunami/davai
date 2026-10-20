/**
 * Wire up one davai session. Shared by the TUI and headless mode so both run
 * identical machinery.
 */
import { loadConfig, requireKey, ensureHome, applyModelLimits } from '../config/env.js';
import { loadSettings, settingsToDefaults } from '../config/settings.js';
import { createProvider } from '../providers/index.js';
import { refineModel } from '../config/models.js';
import { Sandbox } from '../agent/sandbox.js';
import { DaIgnore } from '../agent/daignore.js';
import { Journal } from '../agent/journal.js';
import { Ledger } from '../context/ledger.js';
import { Artifacts } from '../context/artifacts.js';
import { Pastes } from '../context/pastes.js';
import { Agent } from '../agent/loop.js';
import { SudoAuth, SUDO_TTL_MS } from '../agent/askpass.js';
import { buildGrounding } from '../agent/grounding.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { SessionLog, pruneSessions } from './log.js';
import { findSession, restoreLedger } from './resume.js';
import { drainPendingPrompts } from './promptedit.js';
import { checkForks, describeStale, describeUnstamped } from '../agent/promptfork.js';
import { PromptHistory } from './history.js';
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

  // Remembered preferences go in as `defaults` — under the .env files, not over them.
  const cfg = loadConfig({
    cwd: opts.cwd || prior?.cwd,
    defaults: settingsToDefaults(settings),
    overrides: opts.overrides || {},
  });
  // Before anything else reads cfg.prompts: an override forked from an older davai may
  // describe a protocol that no longer exists, and the model has no way to know. A
  // stale fork is positive evidence of drift, so it stops the session rather than
  // warning into a scrollback nobody reads — the whole point is that silent prompt rot
  // is undetectable from the transcript. `opts.acceptStalePrompts` is the escape hatch
  // the CLI and the resolve commands use.
  const forks = checkForks({ sources: cfg.promptSources, layers: cfg.promptLayers });
  if (forks.stale.length && !opts.acceptStalePrompts) {
    const err = new Error(
      `${forks.stale.length} prompt override${forks.stale.length === 1 ? '' : 's'} ` +
        `forked from an older davai:\n\n` +
        describeStale(forks.stale).map((l) => `  ${l}`).join('\n\n') +
        `\n\nResolve with one of:\n` +
        `  /prompts diff <key>     see what changed in the built-in\n` +
        `  /prompts accept <key>   keep your version, record today's built-in as its baseline\n` +
        `  /prompts reset <key>    discard your version and use the built-in\n` +
        `  davai --accept-prompts  start anyway, this once`,
    );
    err.code = 'PROMPT_FORK_STALE';
    err.forks = forks.stale;
    throw err;
  }
  // No recorded fork point is not evidence of anything — every fork predating this
  // feature looks like it. Say so, do not block.
  if (forks.unstamped.length) cfg.warnings.push(...describeUnstamped(forks.unstamped));

  const apiKey = requireKey(cfg);
  ensureHome(cfg);
  pruneSessions(cfg.home, prior ? { except: prior.dir } : {});

  // The registry is a seed; ask the provider for this model's real limits before we
  // size the context window around them.
  await refineModel(cfg.model, { apiKey, baseURL: cfg.baseURL });
  // Re-derive from what was requested, now that the real limits are known. Overwriting
  // contextLimit with the model window here used to discard DAVAI_CONTEXT_LIMIT.
  const limitNotices = applyModelLimits(cfg);
  const ignore = DaIgnore.fromDir(cfg.cwd);
  const sandbox = new Sandbox({ cwd: cfg.cwd, roDirs: cfg.roDirs, ignore });

  const log = new SessionLog({ home: cfg.home, cfg, resumedFrom: prior?.id });
  const journal = new Journal({ dir: log.dir });
  if (limitNotices.length) log.event('limits-clamped', { notices: limitNotices });
  if (cfg.warnings.length) log.event('config-warnings', { warnings: cfg.warnings });

  const ledger = new Ledger({ limit: cfg.contextLimit, compactAt: cfg.compactAt });
  // After applyModelLimits, so the agents budget is clamped against the real context
  // window rather than the seed spec's guess at it.
  const ground = buildGrounding({ sandbox, cfg });
  const grounding = ground.text;
  // A clipped or unreadable agents file is the operator's problem to fix, and the old
  // code discarded 42% of a large AGENTS.md without a word. Surface it where every other
  // startup notice goes.
  if (ground.notices.length) {
    cfg.warnings.push(...ground.notices);
    log.event('agents-notices', { notices: ground.notices });
  }
  ledger.setSystem(buildSystemPrompt({ grounding, prompts: cfg.prompts }));

  // After setSystem, so the replay budget accounts for the cached prefix.
  const resumed = prior ? restoreLedger(ledger, prior) : null;
  if (resumed) log.event('resume', resumed);

  const provider = createProvider(cfg);
  const makeProvider = (model, extra = {}) => createProvider(cfg, { model, ...extra });

  const agent = new Agent({
    cfg,
    provider,
    makeProvider,
    ledger,
    sandbox,
    journal,
    artifacts: new Artifacts(),
    log,
    // In memory only, for this process. Headless gets one too: its approvals never carry
    // a password, so sudo commands fail fast exactly as before, with a note saying why.
    sudo: new SudoAuth({ ttlMs: cfg.sudoTtlMs ?? SUDO_TTL_MS }),
  });

  const session = {
    cfg,
    agent,
    ledger,
    sandbox,
    journal,
    log,
    settings,
    // Which agents files were read, and whether any was clipped. The web sidecar reports
    // these; without it a clipped file is a one-line startup warning that scrolls away.
    agents: ground.agents,
    pastes: new Pastes(),
    history: new PromptHistory({ home: cfg.home, cwd: cfg.cwd }),
    artifacts: agent.artifacts,
    grounding,
    resumed,
    limitNotices,
    /** Set by stageApply; drained by the agent at the next step boundary. */
    pendingPrompts: null,
  };

  // Bound to the session object rather than imported into the harness, so the agent
  // stays unaware of session wiring. Only ever called from inside run(), long after
  // this returns.
  agent.onPendingPrompts = () => drainPendingPrompts(session);

  return session;
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
