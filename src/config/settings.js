/**
 * Runtime-mutable settings, persisted to $DAVAI_HOME/settings.json.
 * These are the knobs the /model pane edits; they overlay the .env config.
 */
import fs from 'node:fs';
import path from 'node:path';

// `yolo` is absent on purpose. Auto-approving shell commands is a per-run decision;
// a persisted one would silently outlive the task it was turned on for.
const FIELDS = [
  'provider',
  'model',
  'effort',
  'maxTokens',
  'temperature',
  'thinkingVisible',
  'compactAt',
];

export function settingsPath(home) {
  return path.join(home, 'settings.json');
}

/** @returns {Record<string, any>} */
export function loadSettings(home) {
  try {
    const raw = fs.readFileSync(settingsPath(home), 'utf8');
    const parsed = JSON.parse(raw);
    return Object.fromEntries(
      Object.entries(parsed).filter(([k]) => FIELDS.includes(k)),
    );
  } catch {
    return {};
  }
}

/**
 * Merge `settings` into what is already persisted. `undefined` leaves a field as it
 * is; `null` removes it. A caller writing only the fields it knows about must not
 * wipe the rest — the /model pane used to erase maxTokens and compactAt that way.
 */
export function saveSettings(home, settings) {
  const merged = { ...loadSettings(home) };
  for (const [k, v] of Object.entries(settings)) {
    if (!FIELDS.includes(k) || v === undefined) continue;
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(settingsPath(home), JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

/**
 * Translate persisted settings into the env-shaped overrides loadConfig expects,
 * so there is exactly one code path that validates configuration.
 */
export function settingsToOverrides(settings) {
  const o = {};
  if (settings.provider) o.DAVAI_PROVIDER = settings.provider;
  if (settings.model) o.DAVAI_MODEL = settings.model;
  if (settings.effort) o.DAVAI_EFFORT = settings.effort;
  if (settings.maxTokens != null) o.DAVAI_MAX_TOKENS = String(settings.maxTokens);
  if (settings.temperature != null)
    o.DAVAI_TEMPERATURE = String(settings.temperature);
  if (settings.compactAt != null) o.DAVAI_COMPACT_AT = String(settings.compactAt);
  if (settings.thinkingVisible != null)
    o.DAVAI_THINKING = settings.thinkingVisible ? 'true' : 'false';
  return o;
}
