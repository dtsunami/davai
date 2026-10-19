/**
 * Enabling a provider, as machinery rather than as a pane.
 *
 * "Enabling" is one thing: giving davai a key it can reach the provider with. Everything
 * else — which model, which effort — already has a home in session/models.js. This exists
 * because the answer to "why can't I pick openrouter?" used to be a paragraph of prose
 * telling the operator to quit, find $DAVAI_HOME/.env, know which of five variable names
 * to write, and relaunch. A key pasted into a pane is the same act with the guesswork
 * removed.
 *
 * Ink-free, like session/models.js, because the browser needs all of it too.
 */
import { loadConfig, requireKey, KEY_VARS, keyVarFor } from '../config/env.js';
import { PROVIDERS, DEFAULT_MODEL } from '../config/models.js';
import { maskKey, createProvider } from '../providers/index.js';
import { envFilePath, setEnvVars } from '../config/envfile.js';
import { applyModelChange } from './models.js';

/** Where a key came from, phrased for a human rather than as a path. */
function describeOrigin(from, home) {
  if (!from) return 'not set';
  if (from === 'environment') return 'your shell environment';
  if (from === 'settings.json') return 'settings.json';
  if (from === 'command-line flag') return 'a command-line flag';
  if (from === envFilePath(home)) return '.env';
  return from;
}

/**
 * Every provider and its current state: whether it has a key, which variable supplied
 * it, and a masked description of the value.
 *
 * Never returns a key. The pane renders this straight to a screen that may be a browser
 * on someone else's network, and `maskKey` is deliberately the only view of a secret
 * anywhere in the codebase.
 *
 * @param {object} cfg
 * @returns {Array<{name: string, hasKey: boolean, current: boolean, varName: string,
 *   origin: string, masked: string, editable: boolean, defaultModel: string,
 *   acceptedVars: string[]}>}
 */
export function keyState(cfg) {
  return PROVIDERS.map((name) => {
    const key = cfg.keys?.[name];
    const ko = cfg.keyOrigins?.[name];
    const from = key ? ko?.from : undefined;
    return {
      name,
      hasKey: Boolean(key),
      current: name === cfg.provider,
      varName: ko?.name || keyVarFor(name),
      origin: describeOrigin(from, cfg.home),
      masked: maskKey(key),
      // A key exported in the shell outranks the .env, so writing one there would have
      // no visible effect until the operator unset the export. Say so instead.
      editable: from !== 'environment',
      defaultModel: DEFAULT_MODEL[name],
      acceptedVars: KEY_VARS[name] || [],
    };
  });
}

/** Obvious paste damage, caught before it becomes a puzzling 401. */
function validateKey(provider, key) {
  const raw = String(key ?? '');
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty key');
  if (/^['"`].*['"`]$/.test(trimmed)) {
    throw new Error(
      'the key is wrapped in quotes — paste the value itself, davai quotes it if needed',
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error('the key contains control characters — it was probably pasted with a newline');
  }
  if (/\s/.test(trimmed)) throw new Error('the key contains whitespace');
  // Prefixes are a hint, not a rule: providers mint new shapes, and a proxy may issue
  // its own. A mismatch warns rather than refuses.
  const EXPECTED = {
    anthropic: /^sk-ant-/,
    openai: /^sk-/,
    openrouter: /^sk-or-/,
    grok: /^xai-/,
    gemini: /^AIza/,
  };
  const want = EXPECTED[provider];
  const warnings =
    want && !want.test(trimmed)
      ? [
          `this does not look like a ${provider} key (expected ${String(want).replace(/[/^]/g, '')}…) — ` +
            `saving it anyway, but check it is for the right provider`,
        ]
      : [];
  return { key: trimmed, warnings };
}

/**
 * Give a provider a key.
 *
 * Session-scoped by default: the key lives in cfg for this run and nothing touches the
 * disk. `persist: true` writes it to $DAVAI_HOME/.env — the home one, never the project
 * one, because a key in a repo's .env is a key in a commit.
 *
 * The key is verified before it is persisted when `verify` is on, so a typo fails here
 * with "that key was rejected" rather than three turns later in the middle of a task.
 *
 * `block` parks the key inside a provider block instead of writing it at the top level.
 * Without it the assignment lands after the last block, where it outranks every block in
 * the file — so saving a key for a provider you are not running would quietly override
 * the one you are.
 *
 * @param {object} session
 * @param {{provider: string, key: string, persist?: boolean, verify?: boolean,
 *   block?: string}} opts
 * @returns {Promise<{provider: string, masked: string, persisted: boolean,
 *   varName: string, file: string|null, block: string|null, warnings: string[]}>}
 */
export async function setProviderKey(
  session,
  { provider, key, persist = false, verify = true, block = null },
) {
  const { cfg } = session;
  const name = String(provider || '').trim().toLowerCase();
  if (!PROVIDERS.includes(name)) {
    throw new Error(`unknown provider "${provider}" — expected one of: ${PROVIDERS.join(', ')}`);
  }
  const { key: value, warnings } = validateKey(name, key);

  if (verify) {
    const reason = await verifyKey(cfg, name, value);
    if (reason) throw new Error(`${name} rejected that key: ${reason}`);
  }

  cfg.keys = { ...cfg.keys, [name]: value };
  // The origin moves with the value, or a later auth failure names the file the key
  // used to come from.
  cfg.keyOrigins = {
    ...cfg.keyOrigins,
    [name]: { name: keyVarFor(name), from: persist ? envFilePath(cfg.home) : 'this session' },
  };
  // An adapter built before the key existed closed over `undefined`.
  if (name === cfg.provider) session.agent.provider = createProvider(cfg);

  let file = null;
  if (persist) {
    const target = envFilePath(cfg.home);
    if (block) {
      const { setProfileVar } = await import('./profiles.js');
      await setProfileVar(session, { block, name: keyVarFor(name), value });
    } else {
      setEnvVars(target, { [keyVarFor(name)]: value });
    }
    file = target;
    const shadowing = (KEY_VARS[name] || []).filter(
      (v) => v !== keyVarFor(name) && process.env[v],
    );
    if (shadowing.length) {
      // Only matters for the bare names: the environment beats the file.
      warnings.push(
        `${shadowing.join(', ')} ${shadowing.length > 1 ? 'are' : 'is'} exported in your ` +
          `shell and will outrank the saved key on the next run — unset ${shadowing.length > 1 ? 'them' : 'it'} ` +
          `or davai will keep using that value.`,
      );
    }
  }

  return {
    provider: name,
    masked: maskKey(value),
    persisted: persist,
    varName: keyVarFor(name),
    file,
    warnings,
  };
}

/** Forget a provider's key. Removes it from the home .env only when `persist`. */
export function clearProviderKey(session, { provider, persist = false }) {
  const { cfg } = session;
  const name = String(provider || '').trim().toLowerCase();
  if (!PROVIDERS.includes(name)) throw new Error(`unknown provider "${provider}"`);
  if (name === cfg.provider) {
    throw new Error(
      `${name} is the provider this session is running — switch with /model first, ` +
        `or the next turn has nothing to send to`,
    );
  }
  cfg.keys = { ...cfg.keys, [name]: undefined };
  let file = null;
  if (persist) {
    file = envFilePath(cfg.home);
    setEnvVars(file, Object.fromEntries((KEY_VARS[name] || []).map((v) => [v, null])));
  }
  return { provider: name, persisted: persist, file };
}

/** A verification probe may not outlive the operator's patience. */
export const VERIFY_TIMEOUT_MS = 10_000;

/**
 * Does this key actually work? One cheap authenticated call — the models list, which
 * every provider serves and which costs nothing.
 *
 * Returns the failure reason, or null when the key is good. A network error is *not* a
 * rejection: being offline must not make davai refuse a key that is perfectly valid, so
 * anything that is not an explicit 401/403 passes.
 *
 * Bounded, and that is the important part. The SDKs retry with backoff and some of them
 * have no default timeout at all, so an unreachable host — a typo'd DAVAI_BASE_URL, a
 * proxy that blackholes, a captive portal — left this awaiting forever. Both callers
 * disable their input while it runs, so "forever" meant a pane that could not be typed
 * into or escaped: the whole REPL looked hung. A probe that times out is treated as
 * unverified, which is the same as being offline: the key is accepted.
 *
 * @returns {Promise<string|null>}
 */
export async function verifyKey(cfg, provider, key) {
  const { listRemoteModels } = await import('../providers/index.js');
  let timer;
  try {
    const probe = loadConfig({ cwd: cfg.cwd, overrides: { DAVAI_PROVIDER: provider } });
    const call = listRemoteModels({
      ...probe,
      provider,
      keys: { ...probe.keys, [provider]: key },
    });
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), VERIFY_TIMEOUT_MS);
    });
    // The losing promise keeps running to completion in the background; it holds no
    // resources worth reclaiming and its rejection is swallowed below.
    call.catch(() => {});
    if ((await Promise.race([call, timeout])) === '__timeout__') return null;
    return null;
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403) return err.message?.split('\n')[0] || `HTTP ${status}`;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Enable a provider and start using it: set the key, then switch the session to that
 * provider's default model. The two-step version of this ("add a key", then "oh, also
 * run /model") is the thing that made enabling a provider feel like a chore.
 *
 * @param {object} session
 * @param {{provider: string, key?: string, persist?: boolean, model?: string,
 *   verify?: boolean}} opts
 */
export async function enableProvider(session, opts) {
  const { provider, key, persist = false, model, verify = true } = opts;
  const out = { key: null, switched: null, warnings: [] };

  if (key) {
    out.key = await setProviderKey(session, { provider, key, persist, verify });
    out.warnings.push(...out.key.warnings);
  } else if (!session.cfg.keys?.[provider]) {
    throw new Error(`no key for ${provider} — pass one to enable it`);
  }

  out.switched = await applyModelChange(session, { provider, model }, { persist });
  out.warnings.push(...out.switched.notices);
  return out;
}

/** `requireKey`, re-exported so a view needs one import to check a session is usable. */
export { requireKey };