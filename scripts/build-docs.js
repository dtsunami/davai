/**
 * Regenerate docs/da_ops.md from the protocol prompt.
 *
 * The prompt in src/agent/prompt.js is the source of truth: it is what the model
 * actually receives. The doc is a checked-in rendering of it, so the protocol is
 * readable without digging through a template literal, and so a link in the README
 * points at something that cannot quietly go stale.
 *
 * test/prompts.test.js fails when the two drift. Run this after editing PROTOCOL.
 */
import fs from 'node:fs';
import { DEFAULT_PROMPTS } from '../src/agent/prompt.js';

const out = new URL('../docs/da_ops.md', import.meta.url);
const text = DEFAULT_PROMPTS.protocol.trimEnd() + '\n';
fs.writeFileSync(out, text, 'utf8');
console.log('wrote docs/da_ops.md, ' + Buffer.byteLength(text) + ' bytes');