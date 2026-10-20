/**
 * Fork provenance for overridden prompts.
 *
 * A prompt file in $DAVAI_HOME/prompts or ./.prompts *replaces* davai's own contract
 * text. That text is versioned with the code: when an op is added, `protocol.md` changes.
 * A fork taken six months ago still describes the protocol as it was, so the model is
 * told about ops that no longer exist and not told about ones that do — and nothing
 * anywhere notices. `checkOverride` already catches this class of failure for missing
 * placeholders; this is the same problem one level up.
 *
 * The fix is to record what the built-in looked like *at the moment of the fork*, and to
 * compare on every load. A manifest rather than a header comment inside the file,
 * because prompt files are read verbatim — anything embedded in one is sent to the model.
 *
 * Two outcomes, deliberately different in severity:
 *
 *   stale      we recorded hash X and the built-in is now Y. Positive evidence of drift,
 *              so the session refuses to run until the operator resolves it.
 *   unstamped  a fork with no manifest entry — every fork that predates this feature.
 *              Might be fine, might not; we have no evidence either way, so it warns.
 *              Blocking here would wall off everybody at upgrade for a maybe.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROMPT_SPECS } from './prompt.js';

export const MANIFEST_FILE = '.davai-prompts.json';
export const HISTORY_DIR = '.history';

/** The running davai version, recorded in the manifest so a diff has a frame of reference. */
export const DAVAI_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

/** Short, because it is read by humans in a warning, not used as a security boundary. */
export function hashText(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12);
}

export function manifestPath(dir) {
  return path.join(dir, MANIFEST_FILE);
}

/** @returns {{version: number, prompts: Record<string, {davaiVersion: string, defaultHash: string, stampedAt: string}>}} */
export function readManifest(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
    return { version: 1, prompts: {}, ...parsed };
  } catch {
    return { version: 1, prompts: {} };
  }
}

export function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/**
 * Record that `keys` were forked from the built-ins as they are right now.
 *
 * Called by `/prompts export`, by the editor's save, and by `/prompts accept` — anything
 * that establishes "this file is current with respect to today's default".
 */
export function stampFork(dir, keys, { version = DAVAI_VERSION } = {}) {
  const manifest = readManifest(dir);
  const stampedAt = new Date().toISOString();
  for (const key of keys) {
    const spec = PROMPT_SPECS.find((s) => s.key === key);
    if (!spec) continue;
    manifest.prompts[key] = { davaiVersion: version, defaultHash: hashText(spec.text), stampedAt };
  }
  return writeManifest(dir, manifest);
}

/** Copy a file aside before overwriting it. Same instinct as the ops journal. */
export function snapshot(file) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(path.dirname(file), HISTORY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, `${path.basename(file)}.${stamp}`);
  fs.copyFileSync(file, dest);
  return dest;
}

/**
 * Compare every overridden prompt against the built-in it was forked from.
 *
 * @param {{sources: Record<string,string>, layers: Record<string,string>}} resolved
 * @returns {{stale: object[], unstamped: object[]}}
 */
export function checkForks({ sources = {}, layers = {} } = {}) {
  const stale = [];
  const unstamped = [];

  for (const spec of PROMPT_SPECS) {
    const layer = layers[spec.key];
    if (!layer || layer === 'default') continue;

    const file = sources[spec.key];
    if (!file) continue;
    const dir = path.dirname(file);
    const entry = readManifest(dir).prompts?.[spec.key];
    const currentHash = hashText(spec.text);

    if (!entry?.defaultHash) {
      unstamped.push({ key: spec.key, file, dir, layer, currentHash });
      continue;
    }
    if (entry.defaultHash !== currentHash) {
      stale.push({
        key: spec.key,
        file,
        dir,
        layer,
        forkedHash: entry.defaultHash,
        currentHash,
        forkedVersion: entry.davaiVersion,
        currentVersion: DAVAI_VERSION,
        stampedAt: entry.stampedAt,
      });
    }
  }

  return { stale, unstamped };
}

/** One line per drifted prompt, for a warning list. */
export function describeStale(stale) {
  return stale.map(
    (s) =>
      `${s.key}: ${s.file} was forked from davai ${s.forkedVersion} (${s.forkedHash}) and the ` +
      `built-in is now ${s.currentVersion} (${s.currentHash}). It may describe behaviour that ` +
      `no longer exists.`,
  );
}

/** Same, for forks taken before provenance was recorded. */
export function describeUnstamped(unstamped) {
  return unstamped.map(
    (u) =>
      `${u.key}: ${u.file} has no recorded fork point, so davai cannot tell whether it is ` +
      `current. \`/prompts accept ${u.key}\` records today's built-in as its baseline.`,
  );
}