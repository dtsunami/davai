import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS } from '../src/agent/loop.js';

/**
 * The web client is plain browser JS with no module boundary a test can import, so this
 * checks it the way test/events.test.js checks the front ends: by reading the source.
 *
 * Two kinds of drift are worth catching, because both fail silently in a browser:
 *
 *   1. An agent event the client never subscribes to. SSE delivers by name, so an
 *      unlisted event simply never arrives and the symptom is a view that stops updating.
 *   2. A transcript entry type App.jsx renders and the client does not. Entries reach the
 *      browser through the bus verbatim; an unknown type falls through to a bare div and
 *      loses whatever structure it had, which is how an ops batch would quietly become
 *      the empty string.
 */
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const client = read('ui/web/app.js');
const app = read('ui/App.jsx');
const html = read('ui/web/index.html');
const css = read('ui/web/app.css');

/** The `const EVENTS = [...]` array in the client. */
function clientEvents() {
  const block = /const EVENTS = \[([\s\S]*?)\];/.exec(client);
  return new Set([...block[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]));
}

/** Keys of the client's KIND map: entry type -> filter group. */
function clientKinds() {
  const block = /const KIND = \{([\s\S]*?)\n\};/.exec(client);
  const names = [...block[1].matchAll(/^\s*'?([a-z-]+)'?:\s*'([a-z]+)'/gm)];
  return new Map(names.map((m) => [m[1], m[2]]));
}

/** `case 'x':` labels in App.jsx's HistoryItem — every entry type the REPL renders. */
function transcriptTypes() {
  const start = app.indexOf('function HistoryItem');
  const end = app.indexOf('const MUTATING', start);
  return [...app.slice(start, end).matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]);
}

describe('the web client subscribes to what the bus publishes', () => {
  const subscribed = clientEvents();

  it('listens for every event the agent emits', () => {
    // approval-request is forwarded with a serialisable payload; the rest go verbatim.
    const missing = EVENTS.filter((n) => !subscribed.has(n));
    expect(missing, 'emitted by the agent, never subscribed in the browser').toEqual([]);
  });

  it('listens for the bus-synthesised events too', () => {
    for (const n of ['transcript', 'pane', 'session-changed', 'approval-resolved']) {
      expect(subscribed.has(n), `${n} is published by the bus but not subscribed`).toBe(true);
    }
  });

  it('does not subscribe to names nothing publishes', () => {
    const extra = ['transcript', 'pane', 'session-changed', 'approval-resolved'];
    const dead = [...subscribed].filter((n) => !EVENTS.includes(n) && !extra.includes(n));
    expect(dead, 'subscribed in the browser but never published').toEqual([]);
  });
});

describe('the timeline covers every transcript entry', () => {
  const kinds = clientKinds();

  it('classifies every entry type App.jsx renders', () => {
    const missing = transcriptTypes().filter((t) => !kinds.has(t));
    expect(missing, 'pushed by the REPL, unclassified in the web timeline').toEqual([]);
  });

  it('maps every entry onto a filter that exists', () => {
    const block = /const FILTERS = \[([\s\S]*?)\];/.exec(client);
    const filters = new Set([...block[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
    for (const [type, group] of kinds) {
      expect(filters.has(group) || group === 'sep', `${type} -> ${group} is not a filter`).toBe(true);
    }
  });

  it('has a chip and a hide rule for every filter', () => {
    const block = /const FILTERS = \[([\s\S]*?)\];/.exec(client);
    for (const m of block[1].matchAll(/'([a-z]+)'/g)) {
      expect(html, `no chip for the ${m[1]} filter`).toContain(`id="f-${m[1]}"`);
      expect(css, `no hide rule for the ${m[1]} filter`).toContain(`hide-${m[1]}`);
    }
  });
});

describe('every REPL pane has a browser tab', () => {
  it('maps each setPane name onto a tab that exists', () => {
    // commands.js calls setPane('model'), setPane('artifacts') and so on. A name with no
    // mapping used to leave the browser on chat, silently ignoring the command.
    const panes = new Set(
      [...read('ui/commands.js').matchAll(/setPane\('([a-z]+)'\)/g)].map((m) => m[1]),
    );
    const block = /const PANE_TAB = \{([\s\S]*?)\};/.exec(client);
    const mapped = new Map(
      [...block[1].matchAll(/([a-z]+):\s*'([a-z]+)'/g)].map((m) => [m[1], m[2]]),
    );
    const missing = [...panes].filter((p) => !mapped.has(p));
    expect(missing, 'opened by a slash command, no browser tab').toEqual([]);

    const tabs = /const TABS = \[([\s\S]*?)\];/.exec(client);
    const names = new Set([...tabs[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]));
    for (const [pane, tab] of mapped) {
      expect(names.has(tab), `${pane} maps to tab "${tab}", which is not in TABS`).toBe(true);
    }
  });

  it('has a button and a section in the page for every tab', () => {
    const tabs = /const TABS = \[([\s\S]*?)\];/.exec(client);
    for (const m of tabs[1].matchAll(/'([a-z]+)'/g)) {
      expect(html, `no tab button for ${m[1]}`).toContain(`id="tab-${m[1]}"`);
      expect(html, `no view section for ${m[1]}`).toContain(`id="view-${m[1]}"`);
    }
  });
});

describe('the ids the client reaches for exist in the page', () => {
  it('resolves every $(...) lookup against index.html', () => {
    const ids = new Set([...client.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
    // Built from the FILTERS list at runtime rather than written out, so it has its own
    // check above.
    const missing = [...ids].filter((id) => !html.includes(`id="${id}"`));
    expect(missing, 'referenced by the client, absent from index.html').toEqual([]);
  });
});