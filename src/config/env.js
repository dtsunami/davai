/**
 * DAVAI_HOME resolution, .env loading, and validated config.
 *
 * Precedence, lowest to highest:
 *   $DAVAI_HOME/.env  ->  ./.env (cwd)  ->  real process environment
 *     ->  $DAVAI_HOME/settings.json  ->  CLI flags
 * (settings.json and flags arrive as `overrides`, assembled in session/bootstrap.js)
 *
 * The cwd overlay exists because a per-project .env is a natural thing to reach for
 * even though DAVAI_HOME is the documented location.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { resolvePrompts } from '../agent/prompt.js';
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
 * @property {Record<string,string|undefined>} keys
 * @property {string[]} envFiles   which .env files were actually loaded
 */

/**
 * Build the validated config. Throws with an actionable message on bad input.
 * @param {{cwd?: string, overrides?: Record<string,string>}} [opts]
 * @returns {Config}
 */
export function loadConfig(opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const home = resolveHome();

  const homeEnvFile = path.join(home, '.env');
  const cwdEnvFile = path.join(cwd, '.env');
  const envFiles = [];
  let merged = {};

  for (const file of [homeEnvFile, cwdEnvFile]) {
    const parsed = readEnvFile(file);
    if (Object.keys(parsed).length) {
      envFiles.push(file);
      merged = { ...merged, ...parsed };
    }
  }
  // Real environment always wins over a file.
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && v !== '') merged[k] = v;
  }
  // Explicit overrides (CLI flags, /model pane) win over everything.
  merged = { ...merged, ...(opts.overrides || {}) };

  const provider = (merged.DAVAI_PROVIDER || 'anthropic').trim().toLowerCase();
  const model = resolveModel(provider, merged.DAVAI_MODEL?.trim());

  const effort = (merged.DAVAI_EFFORT || 'high').trim().toLowerCase();
  if (!EFFORTS.includes(effort)) {
    throw new Error(
      `DAVAI_EFFORT="${effort}" is not valid. Expected one of: ${EFFORTS.join(', ')}`,
    );
  }

  const openaiApi = (merged.DAVAI_OPENAI_API || 'responses').trim().toLowerCase();
  if (!['responses', 'chat'].includes(openaiApi)) {
    throw new Error(`DAVAI_OPENAI_API="${openaiApi}" is not valid. Expected responses or chat.`);
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

  const roDirs = splitPathList(merged.DAVAI_RO_DIRS)
    .map((p) => {
      try {
        return fs.realpathSync(path.resolve(p));
      } catch {
        return null; // a configured dir that doesn't exist is skipped, not fatal
      }
    })
    .filter(Boolean);

  const keys = {
    anthropic: merged.ANTHROPIC_API_KEY,
    openai: merged.OPENAI_API_KEY,
    gemini: merged.GEMINI_API_KEY || merged.GOOGLE_API_KEY,
    grok: merged.XAI_API_KEY || merged.GROK_API_KEY,
  };

  const limitsRequested = {
    maxTokens: positiveInt(merged.DAVAI_MAX_TOKENS, 'DAVAI_MAX_TOKENS'),
    contextLimit: positiveInt(merged.DAVAI_CONTEXT_LIMIT, 'DAVAI_CONTEXT_LIMIT'),
  };
  // Against the seed spec for now; bootstrap re-derives once refineModel() has run.
  const { maxTokens, contextLimit } = resolveLimits(model, limitsRequested);
  // Resolved here rather than in the agent so that an unreadable prompt file or a
  // template missing its placeholder fails at startup, next to every other bad setting.
  const { values: prompts, sources: promptSources } = resolvePrompts(merged);

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
    compactAt,
    maxCost,
    thinkingVisible: bool(merged.DAVAI_THINKING, false),
    // Turn a half-wired event into a loud failure instead of a counter nobody reads.
    strictEvents: bool(merged.DAVAI_STRICT_EVENTS, false),
    openaiApi,
    prompts,
    promptSources,
    // Auto-approve shell ops. Deliberately not a persisted setting (see settings.js):
    // it lives for one run, or for one `/yolo` toggle, and never outlives the session.
    yolo: bool(merged.DAVAI_YOLO, false),
    keys,
    envFiles,
  };
}

/**
 * Check that the active provider has a key. Separated from loadConfig so that
 * `--models` and `--help` work without credentials.
 */
export function requireKey(cfg) {
  const key = cfg.keys[cfg.provider];
  if (!key) {
    const varName = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      gemini: 'GEMINI_API_KEY',
      grok: 'XAI_API_KEY',
    }[cfg.provider];
    throw new Error(
      `No API key for provider "${cfg.provider}".\n` +
        `  Set ${varName} in ${path.join(cfg.home, '.env')} or in your environment.`,
    );
  }
  return key;
}

/** Ensure $DAVAI_HOME and its subdirectories exist. */
export function ensureHome(cfg) {
  fs.mkdirSync(path.join(cfg.home, 'sessions'), { recursive: true });
  return cfg.home;
}
