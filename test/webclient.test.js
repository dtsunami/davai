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

describe('the hidden attribute actually hides', () => {
  /**
   * The client shows and hides panes, overlays and the gate by setting `.hidden`. The UA
   * stylesheet's `[hidden] { display: none }` is weaker than any author rule that sets
   * display, and app.css sets it on #app, .gate, .view.chat and .approval. The approval
   * overlay was therefore painted over the chat on every page load, with no pending
   * request behind it, and its buttons — which read state.pendingApproval — did nothing.
   */
  it('overrides the author display rules', () => {
    expect(css, 'app.css needs a [hidden] rule that beats its own display rules').toMatch(
      /\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/,
    );
  });

  it('toggles hidden on elements that exist and are styled, not on bare ids', () => {
    // Every `$('x').hidden = ...` target must be a real element; a typo here is silent.
    const toggled = new Set(
      [...client.matchAll(/\$\('([a-z0-9-]+)'\)\.hidden\s*=/g)].map((m) => m[1]),
    );
    expect(toggled.size).toBeGreaterThan(0);
    for (const id of toggled) {
      expect(html, `${id} is toggled but not in the page`).toContain(`id="${id}"`);
    }
  });
});

describe('perf charts do not treat turn numbers or elapsed seconds as epoch timestamps', () => {
  /**
   * uPlot defaults `scales.x.time` to true, which formats x=1, 2, 3 as 1970-01-01 00:00:01
   * UTC — "12/31/69 4:00pm" in US Pacific time. `chartOpts` must disable time scaling on x.
   */
  it('sets scales.x.time = false in chartOpts', () => {
    const block = /function chartOpts\([\s\S]*?\n\}/.exec(client);
    expect(block, 'chartOpts missing in app.js').toBeTruthy();
    expect(block[0]).toMatch(/scales:\s*\{\s*x:\s*\{\s*time:\s*false\s*\}\s*\}/);
  });
});

describe('the intra-turn plot is drawn on the same scale as the figures beside it', () => {
  /**
   * Buckets are the harness's pre-reconciliation estimate; the provider's usage rescales
   * the turn by `scale` at turn end. `tokens` in the payload is already scaled, so a
   * bucket curve drawn without it disagrees with both the token count printed next to it
   * and the terminal's plot of the very same turn.
   */
  it('applies the turn scale to the bucket series', () => {
    const block = /function drawTurnDetail\([\s\S]*?\n\}/.exec(client);
    expect(block, 'drawTurnDetail missing in app.js').toBeTruthy();
    expect(block[0], 'bucket rate ignores t.scale').toMatch(/t\.scale/);
  });

  it('is sent the scale by the server', () => {
    const http = read('server/http.js');
    const block = /function perf\(\)[\s\S]*?\n {2}\}/.exec(http);
    expect(block, 'perf() missing in http.js').toBeTruthy();
    expect(block[0], 'buckets are serialised without the scale to interpret them')
      .toMatch(/scale:/);
  });
});

describe('the accumulator cannot invent time between polls', () => {
  /**
   * renderSessionAccumulator extrapolates from the last sample to keep the clock moving.
   * Unbounded, a stale sample charges the whole gap to one bucket: hovering the chip
   * after ten idle minutes put all ten into modelMs if a turn happened to be running.
   */
  it('caps the extrapolation window', () => {
    const block = /function renderSessionAccumulator\([\s\S]*?\n {2}const totals/.exec(client);
    expect(block, 'renderSessionAccumulator missing in app.js').toBeTruthy();
    expect(block[0], 'extraMs is not clamped').toMatch(/Math\.min\(\s*MAX_EXTRAPOLATE_MS/);
  });

  it('refetches when the hover overlay opens', () => {
    const block = /function openPop\([\s\S]*?\n\}/.exec(client);
    expect(block, 'openPop missing in app.js').toBeTruthy();
    expect(block[0], 'the overlay draws from whatever was last fetched').toMatch(/refreshPerf\(\)/);
  });
});

describe('the perf pane reuses its charts instead of rebuilding them', () => {
  /**
   * Destroying and re-constructing four canvases on every poll is both slow and visibly
   * disruptive: it discards the cursor and the legend, so a tooltip being read vanished
   * every couple of seconds.
   */
  it('reconciles through setData/setSize rather than new uPlot per refresh', () => {
    const block = /function upsertChart\([\s\S]*?\n\}/.exec(client);
    expect(block, 'upsertChart missing in app.js').toBeTruthy();
    expect(block[0]).toMatch(/setData/);
    expect(block[0]).toMatch(/setSize/);
  });

  it('reflows on resize without rebuilding', () => {
    const block = /function resizePaneCharts\([\s\S]*?\n\}/.exec(client);
    expect(block, 'resizePaneCharts missing in app.js').toBeTruthy();
    expect(block[0]).toMatch(/setSize/);
    expect(block[0], 'a rebuild on every resize event is the thing this replaces')
      .not.toMatch(/new uPlot/);
  });
});

describe('streaming deltas are painted per frame, not per token', () => {
  it('coalesces the live region onto an animation frame', () => {
    expect(client).toMatch(/function schedulePaint\(\)/);
    const block = /function setLive\([\s\S]*?\n\}/.exec(client);
    expect(block[0], 'setLive writes to the DOM synchronously on every delta')
      .toMatch(/pendingPaint/);
  });

  it('can force a flush where ordering matters', () => {
    // commitThinking moves the block into the transcript; a pending frame would redraw
    // the notes we just committed and show them twice.
    expect(client).toMatch(/function flushPaint\(\)/);
    const block = /function commitThinking\([\s\S]*?\n\}/.exec(client);
    expect(block[0]).toMatch(/flushPaint\(\)/);
  });
});