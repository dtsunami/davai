/**
 * Provider blocks as a session operation: list them, switch between them, park a key
 * in one.
 *
 * config/profiles.js is pure text manipulation and knows nothing about a running davai.
 * This is the other half: after the .env on disk changes, the session has to be rebuilt
 * from it, and that must go through `loadConfig` exactly as startup does. The alternative
 * — reaching into `cfg` and setting `baseURL` and `keys` by hand — is how `/model` and
 * ModelPane drifted apart, and a base URL is a worse thing to get wrong than a model: it
 * decides which server receives the key.
 *
 * Ink-free, like session/models.js and session/keys.js, because the browser drives all
 * of this too.
 */
import { loadConfig, applyModelLimits } from '../config/env.js';
import { refineModel } from '../config/models.js';
import { createProvider, maskKey } from '../providers/index.js';
import { envFilePath, editEnvFile, readEnvText } from '../config/envfile.js';
import {
  blockState,
  blockValues,
  enableBlock,
  setBlockVar,
  selectBlockVar,
} from '../config/profiles.js';

/** Variables whose value is a secret, by name shape rather than by list. */
const SECRET = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;

/** Blocks live in the home .env only: a key in a repo's .env is a key in a commit. */
export function profileFile(cfg) {
  return envFilePath(cfg.home);
}

/**
 * Every block in the home .env, with secrets masked.
 *
 * Masked here rather than at the view, because every view is downstream of the bus and
 * the bus is replayed to any attached browser. `blockState` returns raw values by design;
 * this is the boundary that decides a value may leave the process.
 *
 * @param {object} cfg
 * @returns {{file: string, blocks: object[], active: string[], preamble: string[]}}
 */
export function profileState(cfg) {
  const file = profileFile(cfg);
  const state = blockState(readEnvText(file));
  return {
    file,
    active: state.active,
    preamble: state.preamble,
    blocks: state.blocks.map((b) => ({
      ...b,
      vars: b.vars.map((v) => ({
        ...v,
        value: SECRET.test(v.name) ? maskKey(v.value) : v.value,
        secret: SECRET.test(v.name),
        // Duplicate assignments are masked on exactly the same rule: a block holding
        // three candidate keys must not leak two of them because only the effective
        // one went through the mask.
        choices: v.choices.map((c) => ({
          ...c,
          value: SECRET.test(v.name) ? maskKey(c.value) : c.value,
        })),
      })),
      // The two things that decide where the key goes, surfaced so a view can show a
      // block's identity without the operator expanding it.
      provider: b.vars.find((v) => v.name === 'DAVAI_PROVIDER')?.value,
      baseURL: b.vars.find((v) => v.name === 'DAVAI_BASE_URL' || v.name === 'OPENAI_BASE_URL')
        ?.value,
    })),
  };
}

/**
 * Rebuild the session's config from disk, preserving the overrides this run was started
 * with. Shared by every mutation below.
 *
 * Note what is deliberately *not* preserved: a live `/model` switch, which entered as an
 * override, is kept — it was an explicit instruction for this run — while anything the
 * old block supplied is dropped, because that is the thing being replaced.
 */
async function reload(session) {
  const { cfg, ledger } = session;
  const next = loadConfig({
    cwd: cfg.cwd,
    defaults: cfg.defaults,
    overrides: cfg.overrides,
  });
  // `/yolo` is a toggle for this process and is deliberately not persisted anywhere, so
  // rebuilding from disk would quietly re-arm approvals mid-session.
  const yolo = cfg.yolo;
  // Mutated in place: the harness, the agent and every view hold this one object.
  Object.assign(cfg, next);
  cfg.yolo = yolo;

  // The registry is a seed. A block pointing at a different endpoint usually means a
  // different model, so its real limits have to be asked for again — exactly as
  // bootstrap does — before the context window is sized around them.
  if (cfg.keys?.[cfg.provider]) {
    await refineModel(cfg.model, { apiKey: cfg.keys[cfg.provider], baseURL: cfg.baseURL });
  }
  const notices = applyModelLimits(cfg);
  if (ledger) ledger.limit = cfg.contextLimit;
  session.agent.provider = createProvider(cfg);
  return notices;
}

/**
 * Make one block live, or none of them when `name` is null, then rebuild the session.
 *
 * The file is written before the reload and restored if the reload throws, so a block
 * naming a provider that cannot be constructed — a bad base URL, a missing key — leaves
 * neither the file nor the session half-switched. Without it a typo in a parked block
 * became a dead session whose .env said the switch had worked.
 *
 * @param {object} session
 * @param {string|null} name
 * @returns {{block: string|null, enabled: string[], disabled: string[], provider: string,
 *   model: string, baseURL: string|undefined, notices: string[]}}
 */
export async function switchProfile(session, name) {
  const { cfg } = session;
  const file = profileFile(cfg);
  const before = readEnvText(file);
  const result = enableBlock(before, name);
  const notices = [];

  editEnvFile(file, () => result.text);
  try {
    notices.push(...(await reload(session)));
  } catch (err) {
    editEnvFile(file, () => before);
    await reload(session);
    throw new Error(`block "${name}" is not usable, so nothing was switched: ${err.message}`, {
      cause: err,
    });
  }

  // The environment outranks any file, so a shell export silently defeats the switch.
  // Saying so here is the difference between "davai ignored my block" and a one-line fix.
  const shadowed = Object.keys(blockValues(result.text, name ?? '')).filter(
    (v) => process.env[v] !== undefined && process.env[v] !== '',
  );
  if (shadowed.length) {
    notices.push(
      `${shadowed.join(', ')} ${shadowed.length > 1 ? 'are' : 'is'} exported in your shell ` +
        `and outranks the .env — the block's ${shadowed.length > 1 ? 'values' : 'value'} ` +
        `will not take effect until you unset ${shadowed.length > 1 ? 'them' : 'it'}.`,
    );
  }
  if (!cfg.keys?.[cfg.provider]) {
    notices.push(`no key for ${cfg.provider} — /keys ${cfg.provider} to add one`);
  }

  return {
    block: result.block,
    enabled: result.enabled,
    disabled: result.disabled,
    provider: cfg.provider,
    model: cfg.model.id,
    baseURL: cfg.baseURL,
    notices,
  };
}

/**
 * Pick one of several assignments of the same name inside a block, then make that block
 * live.
 *
 * A block that collects candidates — four OpenRouter models, each under the note saying
 * why — is a normal block. Before this, `profileState` reported the extras as "shadowed"
 * and there was no way to choose between them short of an editor, which is what made the
 * .env pane look like it was hiding half the file.
 *
 * Choosing and switching are one operation here on purpose. `selectBlockVar` deliberately
 * does not enable an inert block — half-enabling one would be a worse failure than not
 * switching at all — so this pairs it with `switchProfile`, which already owns the
 * write-reload-rollback dance. If the reload fails the block switch is rolled back and
 * the *selection* stays, which is the right half to keep: the file still records the
 * choice, and nothing is pointing at a provider that cannot be built.
 *
 * @param {object} session
 * @param {{block: string, name: string, line?: number, value?: string}} opts
 */
export async function chooseProfileVar(session, { block, name, line, value }) {
  const { cfg } = session;
  const file = profileFile(cfg);
  let picked;
  editEnvFile(file, (text) => {
    picked = selectBlockVar(text, block, name, line != null ? { line } : { value });
    return picked.text;
  });

  // switchProfile reloads even when the block is already live, so the session picks up
  // the new value in one path rather than two.
  const r = await switchProfile(session, picked.block);
  return {
    ...r,
    name: picked.name,
    value: SECRET.test(picked.name) ? maskKey(picked.value) : picked.value,
  };
}

/**
 * Write a variable into a block without switching to it.
 *
 * This is how a key is saved for a provider you are not running: the assignment lands
 * inside the block, commented to match, rather than being appended at the end of the
 * file where it would outrank every block. `session/keys.js` persists through
 * `setEnvVars`, which is correct when there are no blocks and wrong the moment there
 * are — hence this.
 *
 * @param {object} session
 * @param {{block: string, name: string, value: string, live?: boolean}} opts
 */
export async function setProfileVar(session, { block, name, value, live }) {
  const file = profileFile(session.cfg);
  let out;
  editEnvFile(file, (text) => {
    out = setBlockVar(text, block, name, value, live === undefined ? {} : { live });
    return out.text;
  });
  // A live assignment changes what this session should be using.
  if (out.enabled) await reload(session);
  return {
    file,
    block: out.block,
    created: out.created,
    enabled: out.enabled,
    masked: SECRET.test(name) ? maskKey(value) : value,
  };
}