/**
 * DAVAI_HOME resolution, .env loading, and validated config.
 *
 * Precedence, lowest to highest:
 *   $DAVAI_HOME/settings.json  ->  $DAVAI_HOME/.env  ->  ./.env (cwd)
 *     ->  real process environment  ->  CLI flags
 * (settings.json arrives as `defaults` and flags as `overrides`; both are assembled
 * in session/bootstrap.js)
 *
 * settings.json used to outrank every .env. A model chosen once in the /model pane
 * therefore shadowed DAVAI_MODEL on every later run, with nothing on screen to say
 * why the .env had stopped mattering. It is a remembered default now: the files the
 * operator writes by hand win, and a switch made in a pane lives for the session
 * unless it is deliberately written to .env.
 *
 * The cwd overlay exists because a per-project .env is a natural thing to reach for
 * even though DAVAI_HOME is the documented location.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { promptDirs, removedPromptVars, resolvePrompts } from '../agent/prompt.js';
import { resolveModel } from './models.js';

/** @returns {string} */
export function resolveHome() {
  const fromEnv = process.env.DAVAI_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.davai');
}

/**
 * Read a .env file into a plain object without touching process.env.
 * @returns {Record<string,string>}
 */
function readEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return dotenv.parse(fs.readFileSync(file));
  } catch {
    return {};
  }
}

/** Split a PATH-like string on the platform separator. */
export function splitPathList(value) {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function num(v, dflt) {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Undefined when unset; throws on anything but a positive integer. Accepts `64_000`. */
function positiveInt(v, name) {
  if (v === undefined || String(v).trim() === '') return undefined;
  const n = Number(String(v).trim().replace(/_/g, ''));
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer token count (got "${v}").`);
  }
  return n;
}

/** A TCP port. Separate from positiveInt because the range matters and 0 is legal. */
function port(v, name) {
  if (v === undefined || String(v).trim() === '') return undefined;
  const n = Number(String(v).trim());
  // 0 is "pick a free one", which is genuinely useful when two sessions share a host.
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${name} must be a port between 0 and 65535 (got "${v}").`);
  }
  return n;
}

export const DEFAULT_MAX_TOKENS = 32_000;

/**
 * Turn requested limits into effective ones for a model. Requests above what the
 * model supports are clamped: an oversized max_tokens is a 400 from the API, and a
 * context limit past the real window means compacting too late. A synthesized
 * (`unverified`) spec holds only guesses, so explicit requests are trusted there.
 *
 * @param {import('./models.js').ModelSpec} model
 * @param {{maxTokens?: number, contextLimit?: number}} [requested]
 * @returns {{maxTokens: number, contextLimit: number, clamped: string[]}}
 */
export function resolveLimits(model, requested = {}) {
  const clamped = [];
  const cap = (want, max, name) => {
    if (model.unverified || want <= max) return want;
    clamped.push(`${name}=${want} exceeds ${model.id}'s limit of ${max}; using ${max}`);
    return max;
  };
  const maxTokens =
    requested.maxTokens != null
      ? cap(requested.maxTokens, model.maxOutput, 'DAVAI_MAX_TOKENS')
      : Math.min(model.maxOutput, DEFAULT_MAX_TOKENS);
  const contextLimit =
    requested.contextLimit != null
      ? cap(requested.contextLimit, model.context, 'DAVAI_CONTEXT_LIMIT')
      : model.context;
  return { maxTokens, contextLimit, clamped };
}

/**
 * Recompute cfg.maxTokens / cfg.contextLimit after cfg.model changed (refinement, a
 * model switch). Works from what was requested, not the previous effective values,
 * so moving to a smaller model and back doesn't ratchet the limits down.
 * @returns {string[]} clamp notices, empty when nothing was clamped
 */
export function applyModelLimits(cfg) {
  const { maxTokens, contextLimit, clamped } = resolveLimits(cfg.model, cfg.limitsRequested);
  cfg.maxTokens = maxTokens;
  cfg.contextLimit = contextLimit;
  return clamped;
}

/** Providers whose adapter can be pointed at another endpoint. */
const BASE_URL_PROVIDERS = ['openai', 'grok', 'openrouter'];

/**
 * The API endpoint, for an OpenAI-compatible server (Mistral, a local server, a proxy).
 * Read here from the merged config, so .env works like it does for every other setting,
 * and passed to the SDK explicitly. The SDK's own OPENAI_BASE_URL fallback reads only the
 * real process environment: a value in .env never reached it, and the key silently went
 * to api.openai.com. OPENAI_BASE_URL is honoured here for that reason.
 *
 * @returns {string|undefined}
 */
function resolveBaseURL(provider, merged) {
  const fromDavai = merged.DAVAI_BASE_URL?.trim();
  const raw = fromDavai || (provider === 'openai' ? merged.OPENAI_BASE_URL?.trim() : '');
  if (!raw) return undefined;
  const name = fromDavai ? 'DAVAI_BASE_URL' : 'OPENAI_BASE_URL';
  if (!BASE_URL_PROVIDERS.includes(provider)) {
    throw new Error(
      `${name} is set, but provider "${provider}" does not support a custom base URL ` +
        `(supported: ${BASE_URL_PROVIDERS.join(', ')}). For an OpenAI-compatible endpoint ` +
        `use DAVAI_PROVIDER=openai; otherwise unset ${name}.`,
    );
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name}="${raw}" is not a valid URL. Expected e.g. https://api.mistral.ai/v1`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name}="${raw}" must be an http or https URL.`);
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Settings that decide where the API key is sent. A project's ./.env may not set them:
 * running davai inside a cloned repo would otherwise hand your key to whatever server
 * that repo named, with nothing on screen to say so.
 */
const HOME_ONLY_VARS = ['DAVAI_BASE_URL', 'OPENAI_BASE_URL'];

/**
 * The variables each provider's key is read from, in priority order.
 *
 * The DAVAI_-prefixed name comes first and is the one davai writes. The bare names are
 * shared with every other tool on the machine — OPENAI_API_KEY in particular is read by
 * the OpenAI SDK itself, by other CLIs, and by anything else that imports it from the
 * environment — so "the key davai sends" and "the key my shell exports" could not be
 * different values, and a key set for something else was silently adopted here. They
 * stay as a fallback, because adopting them is usually what an operator wants on a
 * first run; the prefixed name is how you override that without touching anything else.
 *
 * DAVAI_OPENAI_API_KEY is also why the surface selector was renamed: DAVAI_OPENAI_API
 * and DAVAI_OPENAI_API_KEY differ by a suffix, which is a typo waiting to happen. It is
 * DAVAI_OPENAI_SURFACE now, with the old name still honoured.
 */
export const KEY_VARS = {
  anthropic: ['DAVAI_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
  openai: ['DAVAI_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  gemini: ['DAVAI_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  grok: ['DAVAI_GROK_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY'],
  openrouter: ['DAVAI_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
};

/** The variable davai writes when it is asked to persist a key for `provider`. */
export function keyVarFor(provider) {
  const names = KEY_VARS[provider];
  if (!names) throw new Error(`unknown provider "${provider}"`);
  return names[0];
}

/** Single-quote a string for sh. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Undo, in place, what the project .env set for HOME_ONLY_VARS, falling back to the home
 * .env value. The real environment and explicit overrides are the operator's own and are
 * left alone. Each dropped value comes back as a warning carrying the command that adopts
 * it, so trusting the project is a deliberate step on relaunch rather than a default.
 *
 * @returns {string[]} warnings
 */
function dropProjectOnly(merged, { homeVars, projectVars, homeEnvFile, cwdEnvFile, overrides, origins }) {
  const warnings = [];
  for (const name of HOME_ONLY_VARS) {
    const value = projectVars[name]?.trim();
    if (!value) continue;
    if (process.env[name] || overrides[name] !== undefined) continue;
    const fallback = homeVars[name]?.trim();
    if (fallback) {
      merged[name] = fallback;
      origins[name] = homeEnvFile;
    } else {
      delete merged[name];
      delete origins[name];
    }
    warnings.push(
      `${cwdEnvFile} sets ${name}=${value}, which was ignored: a project .env cannot ` +
        `choose where your API key is sent. ` +
        (fallback ? `Using ${fallback} from ${homeEnvFile}. ` : '') +
        `To use it, export it in this shell and relaunch` +
        (fallback ? ' (the environment takes precedence over the home .env)' : '') +
        `:\n  export ${name}=${shQuote(value)}`,
    );
  }
  return warnings;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * @typedef {object} Config
 * @property {string} home
 * @property {string} cwd
 * @property {string} provider
 * @property {import('./models.js').ModelSpec} model
 * @property {string[]} roDirs
 * @property {string} effort
 * @property {number} maxTokens
 * @property {number|undefined} temperature
 * @property {number} shellTimeout
 * @property {number} contextLimit
 * @property {{maxTokens?: number, contextLimit?: number}} limitsRequested  as configured, before clamping
 * @property {number} compactAt
 * @property {number} maxCost      session spend cap in dollars; 0 = no cap
 * @property {boolean} thinkingVisible
 * @property {string|undefined} baseURL  OpenAI-compatible endpoint; undefined = the provider's own
 * @property {Record<string,string|undefined>} keys
 * @property {string[]} envFiles   which .env files were actually loaded
 * @property {string[]} warnings   startup notices for the operator, e.g. an ignored project setting
 * @property {string[]} agentsFiles  DAVAI_AGENTS_MD, resolved; empty means use the default search
 * @property {number|undefined} agentsBudget  max estimated tokens of agents files in grounding
 * @property {Record<string,{name: string, from: string|undefined}>} keyOrigins
 *   per provider: the variable that supplied the key and where it was set (never the value)
 * @property {{name: string, from: string|undefined}|undefined} baseURLOrigin  same, for the endpoint
 */

/**
 * Build the validated config. Throws with an actionable message on bad input.
 *
 * `defaults` are remembered preferences (settings.json) and sit below every file;
 * `overrides` are an explicit instruction for this run (CLI flags) and sit above
 * everything. Anything that should be beaten by a hand-written .env belongs in the
 * first, and anything that should beat one belongs in the second.
 *
 * @param {{cwd?: string, defaults?: Record<string,string>,
 *   overrides?: Record<string,string>}} [opts]
 * @returns {Config}
 */
export function loadConfig(opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const home = resolveHome();

  const homeEnvFile = path.join(home, '.env');
  const cwdEnvFile = path.join(cwd, '.env');
  const envFiles = [];
  let merged = {};

  // Where each merged value came from, for diagnostics. Holds sources, never values.
  /** @type {Record<string,string>} */
  const origins = {};

  // The floor: remembered defaults, outranked by every file and by the environment.
  for (const [k, v] of Object.entries(opts.defaults || {})) {
    if (v !== undefined && v !== '') {
      merged[k] = v;
      origins[k] = 'settings.json';
    }
  }

  const fileVars = {};
  for (const file of [homeEnvFile, cwdEnvFile]) {
    const parsed = readEnvFile(file);
    fileVars[file] = parsed;
    if (Object.keys(parsed).length) {
      envFiles.push(file);
      merged = { ...merged, ...parsed };
      for (const k of Object.keys(parsed)) origins[k] = file;
    }
  }
  // Real environment always wins over a file.
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && v !== '') {
      merged[k] = v;
      origins[k] = 'environment';
    }
  }
  // Explicit overrides (CLI flags, a live switch) win over everything.
  merged = { ...merged, ...(opts.overrides || {}) };
  for (const [k, v] of Object.entries(opts.overrides || {})) {
    if (v !== undefined) origins[k] = 'command-line flag';
  }
  // Run inside $DAVAI_HOME, the project .env is the home one and is trusted.
  const warnings =
    cwdEnvFile === homeEnvFile
      ? []
      : dropProjectOnly(merged, {
          homeVars: fileVars[homeEnvFile],
          projectVars: fileVars[cwdEnvFile],
          homeEnvFile,
          cwdEnvFile,
          overrides: opts.overrides || {},
          origins,
        });

  const provider = (merged.DAVAI_PROVIDER || 'anthropic').trim().toLowerCase();
  const model = resolveModel(provider, merged.DAVAI_MODEL?.trim());

  const effort = (merged.DAVAI_EFFORT || 'high').trim().toLowerCase();
  if (!EFFORTS.includes(effort)) {
    throw new Error(
      `DAVAI_EFFORT="${effort}" is not valid. Expected one of: ${EFFORTS.join(', ')}`,
    );
  }

  const baseURL = resolveBaseURL(provider, merged);

  // A custom endpoint defaults to Chat Completions: that is what OpenAI-compatible
  // servers implement, and most (Mistral included) have no /v1/responses.
  // DAVAI_OPENAI_API is the old spelling, one suffix away from DAVAI_OPENAI_API_KEY.
  // Still read, so an existing .env keeps working.
  const surfaceVar = merged.DAVAI_OPENAI_SURFACE !== undefined
    ? 'DAVAI_OPENAI_SURFACE'
    : 'DAVAI_OPENAI_API';
  const openaiApi = (merged[surfaceVar] || (baseURL ? 'chat' : 'responses'))
    .trim()
    .toLowerCase();
  if (!['responses', 'chat'].includes(openaiApi)) {
    throw new Error(`${surfaceVar}="${openaiApi}" is not valid. Expected responses or chat.`);
  }

  const compactAt = num(merged.DAVAI_COMPACT_AT, 0.75);
  if (compactAt <= 0 || compactAt >= 1) {
    throw new Error(
      `DAVAI_COMPACT_AT must be a fraction strictly between 0 and 1 (got ${compactAt}).`,
    );
  }

  const maxCost = num(merged.DAVAI_MAX_COST, 0);
  if (maxCost < 0) {
    throw new Error(`DAVAI_MAX_COST must be a dollar amount >= 0, or 0 for no cap (got ${maxCost}).`);
  }

  // The operator's own standing instructions. A path list like DAVAI_RO_DIRS, and it
  // *replaces* the AGENTS.md/DAVAI.md/CLAUDE.md search rather than extending it: an
  // explicit setting that still picks up surprise files is worse than one that does not.
  // Resolved against cwd, not realpath'd — a dangling entry is reported by resolveAgents
  // with the path in the message, which is more useful than silently dropping it.
  const agentsFiles = splitPathList(merged.DAVAI_AGENTS_MD).map((p) => path.resolve(cwd, p));

  const agentsBudget = positiveInt(merged.DAVAI_AGENTS_BUDGET, 'DAVAI_AGENTS_BUDGET');

  const roDirs = splitPathList(merged.DAVAI_RO_DIRS)
    .map((p) => {
      try {
        return fs.realpathSync(path.resolve(p));
      } catch {
        return null; // a configured dir that doesn't exist is skipped, not fatal
      }
    })
    .filter(Boolean);

  // Built from KEY_VARS so the accepted names live in exactly one place. The value is
  // taken raw, not trimmed: maskKey's "contains trailing whitespace" diagnostic is the
  // only thing that explains a 401 on a key that looks right.
  /** @type {Record<string,string|undefined>} */
  const keys = {};
  for (const [p, names] of Object.entries(KEY_VARS)) {
    keys[p] = names.map((n) => merged[n]).find((v) => v !== undefined && String(v).trim() !== '');
  }
  // Where the key and endpoint came from, for the auth-failure diagnostic. Names and
  // sources only; the values stay in `keys` and `baseURL`.
  const keyOrigins = {};
  for (const [p, names] of Object.entries(KEY_VARS)) {
    const name = names.find((n) => merged[n]) || names[0];
    keyOrigins[p] = { name, from: merged[name] ? origins[name] : undefined };
  }
  const baseURLVar = merged.DAVAI_BASE_URL?.trim() ? 'DAVAI_BASE_URL' : 'OPENAI_BASE_URL';
  const baseURLOrigin = baseURL ? { name: baseURLVar, from: origins[baseURLVar] } : undefined;

  const limitsRequested = {
    maxTokens: positiveInt(merged.DAVAI_MAX_TOKENS, 'DAVAI_MAX_TOKENS'),
    contextLimit: positiveInt(merged.DAVAI_CONTEXT_LIMIT, 'DAVAI_CONTEXT_LIMIT'),
  };
  // Against the seed spec for now; bootstrap re-derives once refineModel() has run.
  const { maxTokens, contextLimit } = resolveLimits(model, limitsRequested);
  // Resolved here rather than in the agent so that an unreadable prompt file or a
  // template missing its placeholder fails at startup, next to every other bad setting.
  const promptLocations = promptDirs(home, cwd);
  const {
    values: prompts,
    sources: promptSources,
    layers: promptLayers,
  } = resolvePrompts(promptLocations);
  warnings.push(...removedPromptVars(merged));

  return {
    home,
    cwd,
    provider,
    model,
    roDirs,
    effort,
    maxTokens,
    temperature:
      merged.DAVAI_TEMPERATURE === undefined || merged.DAVAI_TEMPERATURE === ''
        ? undefined
        : num(merged.DAVAI_TEMPERATURE, undefined),
    shellTimeout: num(merged.DAVAI_SHELL_TIMEOUT, 120) * 1000,
    // How long a verified sudo password stays in memory, in seconds; each use slides
    // it, as sudo's own timestamp does. 0 asks every time. Never persisted.
    sudoTtlMs: Math.max(0, num(merged.DAVAI_SUDO_TTL, 900)) * 1000,
    contextLimit,
    limitsRequested,
    agentsFiles,
    agentsBudget,
    compactAt,
    maxCost,
    thinkingVisible: bool(merged.DAVAI_THINKING, false),
    // Turn a half-wired event into a loud failure instead of a counter nobody reads.
    strictEvents: bool(merged.DAVAI_STRICT_EVENTS, false),
    openaiApi,
    baseURL,
    prompts,
    promptSources,
    promptLayers,
    promptDirs: promptLocations,
    // Auto-approve shell ops. Deliberately not a persisted setting (see settings.js):
    // it lives for one run, or for one `/yolo` toggle, and never outlives the session.
    yolo: bool(merged.DAVAI_YOLO, false),
    // The web sidecar. `enabled` only says the operator wants it by default; the flags
    // still win, and the bind is checked against yolo in server/auth.js regardless of
    // which one asked for it.
    web: {
      enabled: bool(merged.DAVAI_WEB, false),
      port: port(merged.DAVAI_WEB_PORT, 'DAVAI_WEB_PORT') ?? 7878,
      host: (merged.DAVAI_WEB_HOST || '127.0.0.1').trim(),
      // A fixed token makes a bookmark survive a restart. Absent, one is minted per run,
      // which is the safer default and why this is opt-in.
      token: merged.DAVAI_WEB_TOKEN?.trim() || undefined,
    },
    keys,
    keyOrigins,
    baseURLOrigin,
    // Every merged variable's source, names only. `/config` reads it to say which
    // layer won, and a live switch reads it to warn that a .env will beat what it
    // just persisted.
    varOrigins: origins,
    // The layers this config was built from, kept so it can be rebuilt. A provider
    // block switch rewrites the .env and has to re-run loadConfig with the same floor
    // and the same explicit overrides; without these it would silently drop the CLI
    // flags the session was started with.
    defaults: opts.defaults || {},
    overrides: opts.overrides || {},
    envFiles,
    warnings,
  };
}

/**
 * Check that the active provider has a key. Separated from loadConfig so that
 * `--models` and `--help` work without credentials.
 */
export function requireKey(cfg) {
  const key = cfg.keys[cfg.provider];
  if (!key) {
    const [preferred, ...fallbacks] = KEY_VARS[cfg.provider] || [];
    throw new Error(
      `No API key for provider "${cfg.provider}".\n` +
        `  Run \`/keys\` to paste one, or set ${preferred} in ` +
        `${path.join(cfg.home, '.env')}.\n` +
        (fallbacks.length
          ? `  ${fallbacks.join(' or ')} ${fallbacks.length > 1 ? 'are' : 'is'} also read, ` +
            `if another tool already set one.`
          : ''),
    );
  }
  return key;
}

/** Ensure $DAVAI_HOME and its subdirectories exist. */
export function ensureHome(cfg) {
  fs.mkdirSync(path.join(cfg.home, 'sessions'), { recursive: true });
  return cfg.home;
}
