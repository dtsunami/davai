/**
 * Editing prompts from a view, without touching the session until it is safe.
 *
 * Three states, and the separation is the whole point:
 *
 *   save    write the file. Pure filesystem; the running session is untouched and does
 *           not care. Safe at any time, including mid-turn.
 *   stage   mark the session as wanting a rebuild. Still no effect on the model.
 *   apply   re-resolve the prompts, rebuild ledger.system. This *must* happen between
 *           turns: the system prompt is the cached prefix, byte-stable for the session
 *           by design (see agent/prompt.js), and rewriting it mid-stream would change
 *           the prompt underneath a request already in flight.
 *
 * So apply is queued rather than executed. The agent drains the queue at a step
 * boundary — the same place steers are applied, and for the same reason: it is the one
 * moment where nothing is in flight and the next request has not been built yet.
 *
 * The cost is real and is stated rather than hidden: rebuilding the prefix invalidates
 * the provider's prompt cache, so the next turn pays full input price.
 */
import { resolvePrompts, buildSystemPrompt, promptDirs, PROMPT_SPECS } from '../agent/prompt.js';
import { snapshot, stampFork } from '../agent/promptfork.js';
import { buildGrounding } from '../agent/grounding.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Write one prompt override.
 *
 * @param {object} session
 * @param {{key: string, text: string, layer?: 'home'|'project'}} spec
 * @returns {{file: string, snapshot: string|null, layer: string}}
 */
export function savePrompt(session, { key, text, layer = 'project' }) {
  const { cfg } = session;
  const spec = resolveSpec(key);
  const dirs = cfg.promptDirs || promptDirs(cfg.home, cfg.cwd);
  const dir = layer === 'home' ? dirs.home : dirs.project;
  const file = path.join(dir, spec.file);

  if (!String(text ?? '').trim()) {
    throw new Error(`${key} cannot be saved empty. Delete the file to use the built-in.`);
  }
  if (spec.placeholder && !text.includes(spec.placeholder)) {
    // The same rule resolvePrompts enforces at load. Caught here so the editor refuses
    // the save rather than writing a file that makes the next session refuse to start.
    throw new Error(
      `${key} must contain ${spec.placeholder}, or nothing davai substitutes there ` +
        `would ever reach the model.`,
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  const kept = snapshot(file);
  fs.writeFileSync(file, text);
  // A hand-edited override is current with respect to today's built-in by definition:
  // the operator just looked at it. Stamping here is what stops the drift gate firing
  // on a file that was edited five seconds ago.
  stampFork(dir, [key]);
  return { file, snapshot: kept, layer };
}

/** Remove an override so the next resolve falls back to the built-in. */
export function revertPrompt(session, { key, layer = 'project' }) {
  const { cfg } = session;
  const spec = resolveSpec(key);
  const dirs = cfg.promptDirs || promptDirs(cfg.home, cfg.cwd);
  const dir = layer === 'home' ? dirs.home : dirs.project;
  const file = path.join(dir, spec.file);
  if (!fs.existsSync(file)) return { file, removed: false, snapshot: null };
  const kept = snapshot(file);
  fs.rmSync(file);
  return { file, removed: true, snapshot: kept };
}

/**
 * What is on disk right now, per prompt — which is not what the session is running if
 * something has been saved since it started. The editor needs both to show "staged".
 */
export function promptState(session) {
  const { cfg, ledger } = session;
  const dirs = cfg.promptDirs || promptDirs(cfg.home, cfg.cwd);
  const onDisk = resolvePromptsSafe(dirs);

  return {
    dirs,
    pendingApply: Boolean(session.pendingPrompts),
    system: ledger?.system || '',
    prompts: Object.keys(cfg.prompts || {}).map((key) => ({
      key,
      live: cfg.prompts[key],
      disk: onDisk.values?.[key] ?? cfg.prompts[key],
      dirty: (onDisk.values?.[key] ?? cfg.prompts[key]) !== cfg.prompts[key],
      layer: onDisk.layers?.[key] ?? cfg.promptLayers?.[key] ?? 'default',
      source: onDisk.sources?.[key] ?? cfg.promptSources?.[key] ?? 'default',
    })),
    error: onDisk.error || null,
  };
}

/**
 * Queue a rebuild for the next step boundary.
 *
 * Returns immediately. `drainPendingPrompts` does the work, and whoever calls it
 * publishes the result — the caller of this function is a click, and the effect lands
 * somewhere else entirely.
 */
export function stageApply(session) {
  // Validate now rather than at the boundary: a broken override discovered mid-run is
  // reported into a transcript the operator may not be watching, whereas an error here
  // goes straight back to the button that caused it.
  const dirs = session.cfg.promptDirs || promptDirs(session.cfg.home, session.cfg.cwd);
  const resolved = resolvePromptsSafe(dirs);
  if (resolved.error) throw new Error(resolved.error);
  session.pendingPrompts = { stagedAt: Date.now() };
  return { staged: true };
}

export function cancelApply(session) {
  session.pendingPrompts = null;
  return { staged: false };
}

/**
 * Rebuild the system prompt from what is on disk. Called at a step boundary, or
 * directly when nothing is running.
 *
 * @returns {{applied: boolean, reason?: string, before?: number, after?: number}}
 */
export function applyPrompts(session) {
  const { cfg, ledger, sandbox } = session;
  const dirs = cfg.promptDirs || promptDirs(cfg.home, cfg.cwd);
  const resolved = resolvePromptsSafe(dirs);
  if (resolved.error) {
    session.pendingPrompts = null;
    return { applied: false, reason: resolved.error };
  }

  cfg.prompts = resolved.values;
  cfg.promptSources = resolved.sources;
  cfg.promptLayers = resolved.layers;
  // The agent holds its own reference, taken once at construction.
  if (session.agent) session.agent.prompts = resolved.values;

  const before = ledger?.systemTokens ?? 0;
  if (ledger && sandbox) {
    // Grounding is rebuilt too: an agents file edited alongside the prompts is part of
    // the same prefix, and resolving one without the other would be arbitrary.
    const ground = buildGrounding({ sandbox, cfg });
    session.agents = ground.agents;
    ledger.setSystem(buildSystemPrompt({ grounding: ground.text, prompts: resolved.values }));
  }
  session.pendingPrompts = null;
  return { applied: true, before, after: ledger?.systemTokens ?? 0 };
}

/**
 * Apply a queued rebuild, if there is one. Safe to call at every step boundary.
 * @returns {null|{applied: boolean, reason?: string, before?: number, after?: number}}
 */
export function drainPendingPrompts(session) {
  if (!session?.pendingPrompts) return null;
  return applyPrompts(session);
}

function resolveSpec(key) {
  const spec = PROMPT_SPECS.find((s) => s.key === key);
  if (!spec) throw new Error(`unknown prompt "${key}"`);
  return spec;
}

/** resolvePrompts throws on a broken override; the editor wants that as a value. */
function resolvePromptsSafe(dirs) {
  try {
    return resolvePrompts(dirs);
  } catch (err) {
    return { error: err.message };
  }
}