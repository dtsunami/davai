/**
 * The davai web client.
 *
 * Deliberately keyboard-first. A browser chat box is a worse driver than the REPL —
 * no history recall, no completion, mouse-dependent — so this keeps enter-to-send,
 * shift+enter for a newline, up-arrow history, tab completion and the same escape
 * and ctrl bindings. What it adds is what a terminal cannot do: real plots, a
 * filterable timeline, and a transcript you can scroll on a phone.
 *
 * No framework and no build step, matching the no-build-step rule in DAVAI.md.
 */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = {
  token: '',
  seq: 0,
  es: null,
  busy: false,
  pendingApproval: null,
  history: [],
  histIdx: -1,
  draft: '',
  session: null,
  commands: [],
  filters: {},
  turnNo: 0,
};

// --- transport ---

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${state.token}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function connect() {
  if (state.es) state.es.close();
  // EventSource cannot set headers, so the token rides the query string here only.
  const url = `/api/events?token=${encodeURIComponent(state.token)}&since=${state.seq}`;
  const es = new EventSource(url);
  state.es = es;

  es.addEventListener('open', () => setConnected(true));
  es.addEventListener('error', () => setConnected(false));

  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    state.session = d;
    renderHeader(d);
    // The ring had already dropped events we never saw: stitching would silently lose
    // transcript, so say so rather than pretend continuity.
    if (d.gap) pushEntry({ type: 'warning', message: 'reconnected with a gap — some output was missed' });
    if (d.state) {
      state.busy = d.state.busy;
      setStatus(d.state.status);
      setBusy(d.state.busy);
      // live/thinking are not seeded from the snapshot: everything after `seq` is
      // replayed immediately below, and seeding would double the deltas we are about
      // to receive. A reconnect inside a gap loses the head of the turn, which the
      // gap warning already says.
    }
    state.seq = d.seq || state.seq;
    for (const p of d.pending || []) showApproval(p);
  });

  for (const type of EVENTS) {
    es.addEventListener(type, (e) => {
      if (e.lastEventId) state.seq = Number(e.lastEventId);
      handle(type, e.data ? JSON.parse(e.data) : null);
    });
  }
}

/**
 * REPL pane name -> this client's tab.
 *
 * `keys` maps to the models tab rather than one of its own: in the browser it is a
 * panel inside that tab, because enabling a provider and picking a model are the same
 * errand. `handle()` expands the panel as well, but the entry has to exist here —
 * test/webclient.test.js checks every setPane() name in commands.js is mapped, which
 * is what catches a pane that silently leaves an attached browser sitting on chat.
 */
// `keys` and `env` are panels inside the models tab rather than tabs of their own, so
// both map to 'models'; the branch in the pane handler also expands the right panel.
const PANE_TAB = {
  context: 'ctx',
  tps: 'perf',
  model: 'models',
  artifacts: 'art',
  keys: 'models',
  env: 'models',
};

const EVENTS = [
  'thinking', 'text', 'turn-start', 'turn-end', 'ops-parsed', 'ops-result',
  'artifact', 'usage', 'error', 'warning', 'done', 'cancelled',
  'compact-start', 'compact-done', 'repair', 'nudge', 'retry',
  'steer-queued', 'steered', 'approval-request', 'approval-resolved',
  // Not an agent event: the REPL's own transcript lines, mirrored by App.jsx so a
  // browser sees the operator's half of the conversation too.
  'transcript',
  // Commands that open a pane in the REPL, and config changes made from either view.
  'pane',
  'session-changed',
];

// --- event handling ---

/**
 * Division of labour, and it matters:
 *
 *   `transcript` is the ONLY source of committed timeline entries. App.jsx mirrors every
 *   push — the user's lines, assistant turns, ops, ops results, warnings, notices,
 *   approvals, compactions — through the bus, so handling the agent events here as well
 *   printed everything twice. The agent events drive live state only: the streaming
 *   buffer, the status line, busy, and the perf meter.
 *
 *   The one entry this client commits itself is `thinking`, because the REPL discards
 *   working notes when the answer starts and a scrollable timeline can afford to keep
 *   them folded away.
 */
let live = '';
let thinking = '';

function handle(type, d) {
  switch (type) {
    case 'transcript':
      pushEntry(d);
      break;
    case 'pane':
      // The REPL's pane names, mapped onto this client's tabs. Every pane has one now,
      // so /model or ctrl+a in the terminal moves an attached browser with it.
      //
      // `keys` is the exception: it is not a tab here but a panel inside the models
      // tab, so /keys in the terminal opens that tab with the panel expanded. Routing
      // it through setTab('keys') would look for a #view-keys that does not exist.
      if (d.pane === 'keys') { setTab('models'); toggleKeys(true); }
      else if (d.pane === 'env') { setTab('models'); toggleEnv(true); }
      else if (PANE_TAB[d.pane]) setTab(PANE_TAB[d.pane]);
      else if (d.pane === null) setTab('chat');
      break;
    case 'session-changed':
      refreshSession();
      // A /model switch in the terminal moves the browser's catalog with it, so the
      // '● running' marker does not sit on a model the session stopped using.
      if (models.loaded) loadModels();
      break;
    case 'turn-start':
      live = ''; thinking = '';
      setLive(''); setThinking(''); setBusy(true); setStatus('thinking');
      // stats.turns is only re-read when a run finishes, so it is stale between the
      // steps of one run. Take whichever is further along.
      state.turnNo = Math.max(state.turnNo + 1, (state.session?.stats?.turns || 0) + 1);
      pushEntry({ type: 'turn-sep', n: state.turnNo });
      startLiveMeter();
      break;
    case 'thinking':
      thinking += d; setThinking(thinking); meterChars(d.length);
      break;
    case 'text':
      // The answer has started, so the working notes have served their purpose — but
      // they are worth keeping, folded, in a timeline you can scroll.
      commitThinking();
      live += d; setLive(live); meterChars(d.length);
      break;
    case 'turn-end':
      commitThinking();
      live = '';
      // The committed assistant entry arrives separately over `transcript`; clearing the
      // live region on this frame rather than the next avoids the turn's last tokens
      // flickering below their own finished copy.
      setLive(''); setStatus(null); flushPaint();
      break;
    case 'ops-parsed':
      setStatus(`running ${d.length} op${d.length > 1 ? 's' : ''}`);
      break;
    case 'ops-result':
      setStatus(null);
      break;
    case 'done':
    case 'cancelled':
      commitThinking();
      live = '';
      setLive(''); setBusy(false); setStatus(null); flushPaint();
      stopLiveMeter();
      refreshSession();
      refreshPerf();
      break;
    case 'error':
      setBusy(false); setStatus(null); stopLiveMeter();
      break;
    case 'steer-queued':
      showQueue(d.queued);
      break;
    case 'steered':
      showQueue(0);
      break;
    case 'compact-start':
      setStatus('compacting context');
      break;
    case 'compact-done':
      setStatus(null);
      break;
    case 'usage':
      renderStats(d);
      break;
    case 'artifact':
      // The transcript entry carries the announcement; this keeps the tab in step so a
      // new artifact is there when it is opened.
      if (currentTab === 'art') loadArtifacts();
      break;
    case 'approval-request':
      showApproval(d);
      break;
    case 'approval-resolved':
      hideApproval(d.id);
      break;
    default:
      break;
  }
}

function commitThinking() {
  if (!thinking) return;
  pushEntry({ type: 'thinking', text: thinking });
  thinking = '';
  setThinking('');
  // The block just moved into the transcript, so the live region must be empty on this
  // frame rather than the next one — otherwise a pending paint redraws the notes we have
  // already committed and they appear twice until the following delta.
  flushPaint();
}

// --- timeline ---

/** Entry type -> filter group. Five groups is as many as a chip row can carry usefully. */
const KIND = {
  user: 'msg',
  assistant: 'msg',
  thinking: 'think',
  ops: 'ops',
  'ops-result': 'ops',
  notice: 'note',
  info: 'note',
  compact: 'note',
  approval: 'note',
  artifact: 'note',
  warning: 'err',
  error: 'err',
  'turn-sep': 'sep',
};
const FILTERS = ['msg', 'think', 'ops', 'note', 'err'];

const transcript = () => $('transcript');
const scroller = () => $('scroll');

function pushEntry(entry) {
  if (!entry || !entry.type) return;
  const box = scroller();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const node = renderEntry(entry);
  if (!node) return;
  node.dataset.kind = KIND[entry.type] || 'note';
  node.title = new Date().toLocaleTimeString();
  transcript().appendChild(node);
  // Only follow if they were already at the bottom; yanking the view while someone
  // reads scrollback is the most irritating thing a live log can do.
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** A <details> entry: native collapse, keyboard accessible, no state of our own. */
function fold(cls, summary, open) {
  const d = el('details', `entry ${cls}`);
  d.open = Boolean(open);
  d.appendChild(el('summary', null, summary));
  return d;
}

function renderEntry(e) {
  switch (e.type) {
    case 'turn-sep': {
      const n = el('div', 'entry sep');
      n.appendChild(el('span', null, `turn ${e.n || ''}`.trim()));
      return n;
    }

    case 'thinking': {
      const chars = e.text.length;
      const d = fold('think', `thinking · ${chars >= 1000 ? `${(chars / 1000).toFixed(1)}k` : chars} chars`, false);
      d.appendChild(el('pre', null, e.text));
      return d;
    }

    case 'ops': {
      const ops = e.ops || [];
      const head = `${ops.length} op${ops.length === 1 ? '' : 's'} · ${ops.map(opLabel).slice(0, 2).join(', ')}${ops.length > 2 ? ' …' : ''}`;
      const d = fold('ops', head, ops.length <= 5);
      for (const op of ops) d.appendChild(el('div', 'op-line', opLabel(op)));
      return d;
    }

    case 'ops-result': {
      const out = e.outcome || {};
      const ok = out.status === 'ok';
      const rows = ok ? (out.results || []).filter((r) => r.result && MUTATING.has(r.op)) : out.errors || [];
      const head = ok
        ? `✓ applied · ${rows.length || (out.results || []).length} result${rows.length === 1 ? '' : 's'}`
        : `✗ ${rows.length} error${rows.length === 1 ? '' : 's'} — nothing was applied`;
      const d = fold(`opsres ${ok ? 'ok' : 'fail'}`, head, !ok);
      if (ok) {
        for (const r of rows) d.appendChild(el('div', 'op-ok', summarize(r)));
        if (!rows.length) d.appendChild(el('div', 'op-ok', 'read-only batch'));
      } else {
        for (const err of rows) d.appendChild(el('div', 'op-fail', `[${err.index}] ${err.op}: ${err.message}`));
      }
      return d;
    }

    case 'compact': {
      const d = fold('note', `compacted · freed ~${e.freed || 0} tokens`, false);
      for (const a of e.actions || []) d.appendChild(el('div', null, a));
      return d;
    }

    case 'approval': {
      const n = el('div', `entry ${e.allowed ? 'ok-line' : 'warning'}`);
      n.textContent = `${e.allowed ? '✓' : '✗'} shell ${
        e.allowed ? (e.auto ? 'auto-approved (yolo)' : 'approved') : 'denied'
      }: ${e.edited || e.cmd || ''}`;
      return n;
    }

    case 'artifact': {
      const it = e.item || {};
      const n = el('div', 'entry artifact');
      n.appendChild(document.createTextNode(`artifact #${it.n} (${it.lang || '?'}, ${it.lines || 0} lines) `));
      const b = el('button', 'chip', 'open');
      b.onclick = () => setTab('art');
      n.appendChild(b);
      return n;
    }

    case 'error': {
      if (!e.detail) {
        const n = el('div', 'entry error');
        n.textContent = e.message || 'error';
        return n;
      }
      const d = fold('error', e.message || 'error', false);
      d.appendChild(el('pre', null, e.detail));
      return d;
    }

    case 'assistant': {
      const n = el('div', 'entry assistant');
      n.textContent = e.text || '';
      if (e.cancelled) n.appendChild(el('div', 'warning', '⚠ cancelled mid-turn'));
      return n;
    }

    case 'info': {
      const n = el('div', 'entry info');
      n.textContent = e.text || '';
      return n;
    }

    default: {
      const n = el('div', `entry ${e.type}`);
      n.textContent = e.text || e.message || '';
      return n;
    }
  }
}

const MUTATING = new Set(['write', 'replace', 'delete', 'move', 'shell']);

function opLabel(op) {
  switch (op.op) {
    case 'shell': return `shell: ${op.cmd}`;
    case 'move': return `move: ${op.from} → ${op.to}`;
    case 'grep':
    case 'glob': return `${op.op}: "${op.pattern}" in ${op.path}`;
    case 'read': return `read: ${op.path}${op.lines ? ` [${op.lines[0]}-${op.lines[1]}]` : ''}`;
    default: return `${op.op}: ${op.path || ''}`;
  }
}

function summarize(r) {
  const x = r.result || {};
  switch (r.op) {
    case 'write': return `${x.path} ${x.action} (${x.lines} lines)`;
    case 'replace': return `${x.path} edited (${x.delta >= 0 ? '+' : ''}${x.delta} lines)`;
    case 'delete': return `${x.path} deleted`;
    case 'move': return `${x.from} → ${x.to}`;
    case 'shell': return `$ ${x.cmd} (exit ${x.exitCode}, ${x.durationMs}ms)`;
    default: return `${r.op} ${x.path || 'ok'}`;
  }
}

// --- filters ---

function loadFilters() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('davai-filters')) || {}; } catch { /* first run */ }
  state.filters = Object.fromEntries(FILTERS.map((k) => [k, saved[k] !== false]));
}

function applyFilters() {
  const t = transcript();
  for (const k of FILTERS) {
    t.classList.toggle(`hide-${k}`, !state.filters[k]);
    const chip = $(`f-${k}`);
    if (chip) chip.setAttribute('aria-pressed', String(Boolean(state.filters[k])));
  }
  // The live thinking box lives outside the transcript, so it needs telling separately.
  $('thinking').classList.toggle('filtered', !state.filters.think);
  try { localStorage.setItem('davai-filters', JSON.stringify(state.filters)); } catch { /* private mode */ }
}

function toggleFilter(kind) {
  state.filters[kind] = !state.filters[kind];
  applyFilters();
}

function setFoldAll(open) {
  for (const d of transcript().querySelectorAll('details.entry')) d.open = open;
}

// --- live region ---
//
// Deltas arrive faster than a screen refreshes — a fast model is several hundred events
// a second — and each one of these writes forces layout and a paint of a growing block.
// Painting per token is strictly wasted work: coalesce onto an animation frame so the
// cost is one reflow per displayed frame no matter how fast the tokens land. The REPL
// does the same thing with FRAME_MS in App.jsx, for the same reason.

const pendingPaint = { live: null, thinking: null };
let paintFrame = null;

function schedulePaint() {
  if (paintFrame) return;
  paintFrame = requestAnimationFrame(() => {
    paintFrame = null;
    if (pendingPaint.live !== null) {
      const text = pendingPaint.live;
      pendingPaint.live = null;
      const n = $('live');
      n.textContent = text;
      n.hidden = !text;
      if (text) {
        // Measure before the write has a chance to move it, and only follow if they were
        // already at the bottom; yanking the view while someone reads scrollback is the
        // most irritating thing a live log can do.
        const box = scroller();
        if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) {
          box.scrollTop = box.scrollHeight;
        }
      }
    }
    if (pendingPaint.thinking !== null) {
      const text = pendingPaint.thinking;
      pendingPaint.thinking = null;
      const n = $('thinking');
      n.textContent = text;
      n.hidden = !text;
    }
  });
}

function setLive(text) {
  pendingPaint.live = text;
  schedulePaint();
}

function setThinking(text) {
  pendingPaint.thinking = text;
  schedulePaint();
}

/**
 * Force any coalesced text out now. Needed wherever the next statement depends on the
 * DOM being current — committing the thinking block, or ending a turn — because a frame
 * that has not fired yet would otherwise overwrite what came after it.
 */
function flushPaint() {
  if (!paintFrame) return;
  cancelAnimationFrame(paintFrame);
  paintFrame = null;
  if (pendingPaint.live !== null) {
    const n = $('live');
    n.textContent = pendingPaint.live;
    n.hidden = !pendingPaint.live;
    pendingPaint.live = null;
  }
  if (pendingPaint.thinking !== null) {
    const n = $('thinking');
    n.textContent = pendingPaint.thinking;
    n.hidden = !pendingPaint.thinking;
    pendingPaint.thinking = null;
  }
}

function setStatus(text) {
  const n = $('status');
  n.textContent = text || '';
  n.hidden = !text;
}

function setBusy(busy) {
  state.busy = busy;
  $('cancel').hidden = !busy;
  $('input').placeholder = busy
    ? 'steer the running turn — enter sends'
    : 'message, or / for commands — enter sends, shift+enter newline';
}

function setConnected(on) {
  $('conn').classList.toggle('on', on);
  $('conn').title = on ? 'connected' : 'disconnected';
}

function showQueue(n) {
  const q = $('queue');
  q.hidden = !n;
  q.textContent = n ? `${n} steer${n > 1 ? 's' : ''} queued — applied at the next step` : '';
}

// --- header / stats ---

function renderHeader(d) {
  $('model').textContent = `${d.provider}/${d.model}`;
  $('cwd').textContent = d.cwd || '';
  if (d.stats) renderStats({ ...d.stats, total: d.stats.cost });
  if (d.yolo) $('model').style.color = 'var(--red)';
}

function renderStats(u) {
  const s = state.session?.stats || {};
  const cost = u.total ?? s.cost ?? 0;
  $('stats').textContent = `${s.turns || 0}t · ${s.ops || 0}ops · $${Number(cost).toFixed(4)}`;
}

async function refreshSession() {
  try {
    const d = await api('/api/session');
    state.session = d;
    renderHeader(d);
    renderContext(d.context);
    if (currentTab === 'perf') drawPane();
  } catch { /* the stream reports connection trouble already */ }
}

// --- context view ---

function renderContext(ctx) {
  if (!ctx) return;
  const pct = Math.round((ctx.usage || 0) * 100);
  const meter = $('ctx-meter');
  meter.innerHTML = '';
  const bar = el('i');
  bar.style.width = `${Math.min(100, pct)}%`;
  if (pct > 80) bar.className = 'hot';
  else if (pct > 60) bar.className = 'warn';
  meter.appendChild(bar);

  const t = $('ctx-table');
  t.innerHTML = '';
  const head = el('tr');
  head.appendChild(el('td', null, `${fmtTokens(ctx.tokens)} / ${fmtTokens(ctx.limit)}`));
  head.appendChild(el('td', 'n', `${pct}%`));
  t.appendChild(head);
  for (const r of ctx.rows || []) {
    const tr = el('tr');
    tr.appendChild(el('td', null, `${r.pinned ? '• ' : ''}${r.label}`));
    tr.appendChild(el('td', 'n', `${fmtTokens(r.tokens)}  ${r.pct.toFixed(1)}%`));
    t.appendChild(tr);
  }
}

const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));

// --- models ---
//
// Aimed squarely at OpenRouter, which is the only provider whose list is worth browsing
// rather than knowing: 300+ entries with real pricing, context windows and modality
// flags. A terminal pane can only show fourteen rows at a time and filters by typing;
// a browser can show the lot, sort by price, and filter on capability.

const models = {
  provider: null,     // the provider being browsed, which is not necessarily the live one
  rows: [],
  current: {},
  providers: [],
  efforts: [],
  loaded: false,
};

async function loadModels({ provider, refresh = false } = {}) {
  const p = provider || models.provider || state.session?.provider;
  $('m-status').textContent = refresh ? 'refreshing catalog…' : 'loading…';
  try {
    const q = new URLSearchParams({ provider: p, ...(refresh ? { refresh: '1' } : {}) });
    const d = await api(`/api/models?${q}`);
    models.provider = d.provider;
    models.rows = d.models || [];
    models.current = d.current || {};
    models.providers = d.providers || [];
    models.efforts = d.efforts || [];
    models.loaded = true;
    // A catalog that failed still renders the seed list; the reason sits beside it.
    $('m-status').textContent = d.error
      ? `${d.models.length} from seed — catalog failed: ${d.error}`
      : `${d.models.length} models · ${d.source}`;
  } catch (e) {
    $('m-status').textContent = `could not load models: ${e.message}`;
    models.rows = [];
  }
  renderModels();
}

function renderModels() {
  const provs = $('m-providers');
  provs.innerHTML = '';
  for (const p of models.providers) {
    const b = el('button', 'chip', p.name + (p.hasKey ? '' : ' (no key)'));
    b.disabled = !p.hasKey;
    // Pressed means "being browsed"; the live provider carries a dot as well, so that
    // looking at openrouter while running anthropic is unambiguous.
    b.setAttribute('aria-pressed', String(p.name === models.provider));
    if (p.current) b.appendChild(el('span', 'live-dot', ' ●'));
    b.onclick = () => loadModels({ provider: p.name });
    provs.appendChild(b);
  }

  const eff = $('m-efforts');
  eff.innerHTML = '';
  if (models.current.effort) {
    eff.appendChild(el('span', 'muted', 'effort '));
    for (const e of models.efforts) {
      const b = el('button', 'chip', e.id);
      b.title = e.desc;
      b.setAttribute('aria-pressed', String(e.id === models.current.effort));
      b.onclick = () => switchModel({ effort: e.id });
      eff.appendChild(b);
    }
  }

  const q = $('m-search').value.trim().toLowerCase();
  const wantVision = $('m-vision').checked;
  const wantReason = $('m-reason').checked;
  let rows = models.rows.filter((m) => {
    if (wantVision && !m.vision) return false;
    if (wantReason && !m.effort && !m.thinking) return false;
    if (!q) return true;
    return m.id.toLowerCase().includes(q) || (m.label || '').toLowerCase().includes(q);
  });

  const sort = $('m-sort').value;
  if (sort === 'price') {
    // Unpriced last rather than free: "price n/a" sorting to the top of a cheapest-first
    // list is actively misleading on OpenRouter, where unpriced usually means unknown.
    rows = [...rows].sort((a, b) => (a.inputPrice ?? Infinity) - (b.inputPrice ?? Infinity));
  } else if (sort === 'context') {
    rows = [...rows].sort((a, b) => (b.context || 0) - (a.context || 0));
  } else {
    rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  }

  const list = $('m-list');
  list.innerHTML = '';
  for (const m of rows) list.appendChild(modelRow(m));

  // A filter that matches nothing is still a usable way to name a model the catalog has
  // not heard of — a brand-new slug, or a proxy serving something private.
  if (!rows.length && q) {
    const b = el('button', 'm-custom', `use "${$('m-search').value.trim()}" as a custom model id`);
    b.onclick = () => switchModel({ model: $('m-search').value.trim() });
    list.appendChild(b);
  }
}

function modelRow(m) {
  const live = models.provider === models.current.provider && m.id === models.current.model;
  const row = el('div', `m-row${live ? ' live' : ''}`);

  const main = el('div', 'm-main');
  main.appendChild(el('span', 'm-id', m.id));
  if (m.label && m.label !== m.id) main.appendChild(el('span', 'muted', m.label));
  row.appendChild(main);

  const meta = el('div', 'm-meta');
  if (m.remoteOnly) {
    meta.appendChild(el('span', 'muted', 'from provider — no local metadata'));
  } else {
    meta.appendChild(el('span', null, `${fmtTokens(m.context)} ctx`));
    meta.appendChild(
      el('span', m.inputPrice == null ? 'muted' : '',
        m.inputPrice == null ? 'price n/a' : `$${m.inputPrice} / $${m.outputPrice} per Mtok`),
    );
    if (m.vision) meta.appendChild(el('span', 'tag', 'vision'));
    if (m.effort || m.thinking) meta.appendChild(el('span', 'tag', 'reasoning'));
    if (m.maxOutput) meta.appendChild(el('span', 'muted', `${fmtTokens(m.maxOutput)} out`));
  }
  row.appendChild(meta);

  const act = el('div', 'm-act');
  if (live) {
    act.appendChild(el('span', 'live-tag', '● running'));
  } else {
    const b = el('button', 'chip', 'use');
    b.onclick = () => switchModel({ model: m.id });
    act.appendChild(b);
  }
  row.appendChild(act);
  return row;
}

/**
 * Switching is a POST, not a local mutation: the harness owns cfg, and the REPL has to
 * see the change too. The confirmation comes back over the event stream as a transcript
 * notice like any other.
 */
async function switchModel(want) {
  $('m-status').textContent = 'switching…';
  try {
    await api('/api/model', {
      provider: models.provider,
      persist: $('m-persist').checked,
      ...want,
    });
    await refreshSession();
    await loadModels();
  } catch (e) {
    $('m-status').textContent = `could not switch: ${e.message}`;
  }
}

// --- provider keys ---
//
// The only part of this client that handles a secret. The value goes straight into the
// POST body and is never put in the DOM, never logged, and never kept in `keys` state:
// the input is read at submit time and cleared immediately after. What comes back, and
// what the event stream broadcasts, is maskKey's description.

const keys = { providers: [], open: false, editing: null };

async function loadKeys() {
  try {
    const d = await api('/api/keys');
    keys.providers = d.providers || [];
  } catch (e) {
    keys.providers = [];
    $('m-status').textContent = `could not load providers: ${e.message}`;
  }
  renderKeys();
}

function renderKeys() {
  $('keys').hidden = !keys.open;
  const list = $('k-list');
  list.innerHTML = '';

  for (const p of keys.providers) {
    const row = el('div', `k-row${p.current ? ' live' : ''}`);

    const name = el('div', 'k-name');
    name.appendChild(el('span', null, p.name));
    if (p.current) name.appendChild(el('span', 'live-tag', ' ● running'));
    row.appendChild(name);

    const meta = el('div', 'k-meta');
    if (p.hasKey) {
      meta.appendChild(el('span', null, p.masked));
      meta.appendChild(el('span', 'muted', `${p.varName} from ${p.origin}`));
    } else {
      meta.appendChild(el('span', 'warn', 'no key'));
      meta.appendChild(el('span', 'muted', `will be saved as ${p.varName}`));
    }
    row.appendChild(meta);

    const act = el('div', 'k-act');
    if (keys.editing === p.name) {
      const input = el('input', 'k-input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = `paste a ${p.name} key`;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitKey(p.name, input);
        if (e.key === 'Escape') { keys.editing = null; renderKeys(); }
      });
      act.appendChild(input);
      const ok = el('button', 'chip', 'set');
      ok.onclick = () => submitKey(p.name, input);
      act.appendChild(ok);
      const no = el('button', 'chip plain', 'cancel');
      no.onclick = () => { keys.editing = null; renderKeys(); };
      act.appendChild(no);
      // Focus after the row is in the DOM, or the caret lands nowhere.
      setTimeout(() => input.focus(), 0);
    } else if (!p.editable) {
      // Set in the server's shell environment, which outranks the .env davai writes.
      // Offering an edit that cannot take effect is worse than not offering one.
      act.appendChild(el('span', 'muted', 'from the environment — unset it to change'));
    } else {
      const b = el('button', 'chip', p.hasKey ? 'replace' : 'add key');
      b.onclick = () => { keys.editing = p.name; renderKeys(); };
      act.appendChild(b);
      if (p.hasKey && !p.current) {
        const x = el('button', 'chip plain', 'clear');
        x.onclick = () => clearKey(p.name);
        act.appendChild(x);
      }
    }
    row.appendChild(act);
    list.appendChild(row);
  }
}

async function submitKey(provider, input) {
  const key = input.value.trim();
  if (!key) return;
  // Cleared before the await: a slow verify must not leave the secret sitting in a
  // focused field on a phone screen.
  input.value = '';
  input.disabled = true;
  $('m-status').textContent = `verifying ${provider} key…`;
  try {
    const d = await api('/api/keys', {
      provider,
      key,
      persist: $('k-persist').checked,
    });
    keys.providers = d.providers || keys.providers;
    keys.editing = null;
    $('m-status').textContent = `${provider} key set${d.persisted ? ' and saved to .env' : ''}`;
    renderKeys();
    await loadModels({ provider });
  } catch (e) {
    $('m-status').textContent = `key not set: ${e.message}`;
    input.disabled = false;
    renderKeys();
  }
}

async function clearKey(provider) {
  try {
    const d = await api('/api/keys', {
      provider,
      clear: true,
      persist: $('k-persist').checked,
    });
    keys.providers = d.providers || keys.providers;
    renderKeys();
  } catch (e) {
    $('m-status').textContent = `could not clear: ${e.message}`;
  }
}

function toggleKeys(open) {
  keys.open = open ?? !keys.open;
  keys.editing = null;
  if (keys.open) loadKeys();
  else renderKeys();
}

// --- .env provider blocks ---
//
// Several endpoint-and-key sets in one .env, one live at a time. The server does the
// editing; this renders the blocks and sends the name of the one to switch to. Values
// arrive with secrets already masked — session/profiles.js masks before the state
// leaves the process, so an unmasked key is never on this connection.

const envb = { file: '', blocks: [], active: [], preamble: [], open: false, expanded: null };

async function loadEnv() {
  try {
    const d = await api('/api/env');
    Object.assign(envb, { file: d.file, blocks: d.blocks || [], active: d.active || [], preamble: d.preamble || [] });
  } catch (e) {
    envb.blocks = [];
    $('m-status').textContent = `could not read .env: ${e.message}`;
  }
  renderEnv();
}

function renderEnv() {
  $('envblocks').hidden = !envb.open;
  $('e-file').textContent = envb.file || '';
  const list = $('e-list');
  list.innerHTML = '';

  if (!envb.blocks.length) {
    list.appendChild(
      el('div', 'muted', 'No #---# blocks in this .env — add one to keep several providers side by side.'),
    );
    return;
  }

  for (const b of envb.blocks) {
    const row = el('div', `k-row${b.enabled ? ' live' : ''}`);

    const name = el('div', 'k-name');
    name.appendChild(el('span', null, b.name));
    if (b.enabled) name.appendChild(el('span', 'live-tag', ' ● live'));
    row.appendChild(name);

    const meta = el('div', 'k-meta');
    const what = [b.provider, b.baseURL].filter(Boolean).join(' → ');
    // The remark on the header line: "#---# mistral sucks" is a note, not part of the name.
    if (b.note) meta.appendChild(el('span', 'muted', b.note));
    meta.appendChild(el('span', null, what || b.vars.map((v) => v.name).join(', ')));
    if (!b.closed) meta.appendChild(el('span', 'muted', 'open-ended (no #-end-provider-#)'));
    // Duplicates are candidates, not clutter: say how many and let "show" offer the pick.
    const opts = b.vars.filter((v) => v.choices.length);
    if (opts.length) {
      meta.appendChild(
        el('span', 'muted', opts.map((v) => `${v.name}: ${v.choices.length} options`).join(' · ')),
      );
    }
    row.appendChild(meta);

    const act = el('div', 'k-act');
    const show = el('button', 'chip plain', envb.expanded === b.name ? 'hide' : 'show');
    show.onclick = () => {
      envb.expanded = envb.expanded === b.name ? null : b.name;
      renderEnv();
    };
    act.appendChild(show);
    if (!b.enabled) {
      const use = el('button', 'chip', 'make live');
      use.onclick = () => switchEnv(b.name);
      act.appendChild(use);
    }
    row.appendChild(act);

    if (envb.expanded === b.name) {
      const box = el('div', 'e-vars');
      for (const v of b.vars) {
        if (!v.choices.length) {
          const line = el('div', v.enabled ? null : 'off');
          line.textContent = `${v.enabled ? ' ' : '#'}${v.name}=${v.value}`;
          box.appendChild(line);
          continue;
        }
        // One-hot: several assignments of the same name, exactly one effective.
        box.appendChild(el('div', 'muted', `${v.name} — ${v.choices.length} options, one live`));
        for (const c of v.choices) {
          const opt = el('div', `e-opt${c.chosen ? ' on' : ''}`);
          const pick = el('button', 'chip plain', c.chosen ? '●' : '○');
          pick.title = c.chosen ? 'in effect' : 'use this value';
          pick.onclick = () => chooseEnvVar(b.name, v.name, c.line);
          opt.appendChild(pick);
          opt.appendChild(el('span', c.chosen ? null : 'off', c.value));
          box.appendChild(opt);
        }
      }
      row.appendChild(box);
    }
    list.appendChild(row);
  }

  if (envb.active.length > 1) {
    list.appendChild(
      el('div', 'warn', `${envb.active.join(' and ')} are both live — the last in the file wins. Pick one.`),
    );
  }
  if (envb.preamble.length) {
    list.appendChild(el('div', 'muted', `always applied: ${envb.preamble.join(', ')}`));
  }
}

async function switchEnv(block) {
  $('m-status').textContent = block ? `switching to ${block}…` : 'disabling all blocks…';
  try {
    const d = await api('/api/env', { block });
    Object.assign(envb, { blocks: d.blocks || [], active: d.active || [], preamble: d.preamble || [] });
    $('m-status').textContent = d.block
      ? `${d.block} is live — ${d.provider} → ${d.model}`
      : `all blocks disabled — ${d.provider} → ${d.model}`;
    renderEnv();
    // The provider may have moved, so the catalog on screen is for the old one.
    await loadModels({ provider: d.provider });
  } catch (e) {
    $('m-status').textContent = `not switched: ${e.message}`;
    // The server rolls the file back on failure; re-read rather than trust local state.
    loadEnv();
  }
}

/**
 * Pick one of several assignments of the same name inside a block, and make that block
 * live. Same request as a switch, with `var` and the line of the chosen assignment.
 */
async function chooseEnvVar(block, name, line) {
  $('m-status').textContent = `${block}: ${name}…`;
  try {
    const d = await api('/api/env', { block, var: name, line });
    Object.assign(envb, { blocks: d.blocks || [], active: d.active || [], preamble: d.preamble || [] });
    $('m-status').textContent = `${d.block} — ${d.name}=${d.value} — ${d.provider} → ${d.model}`;
    renderEnv();
    await loadModels({ provider: d.provider });
  } catch (e) {
    $('m-status').textContent = `not changed: ${e.message}`;
    // The server rolls the file back on failure; re-read rather than trust local state.
    loadEnv();
  }
}

function toggleEnv(open) {
  envb.open = open ?? !envb.open;
  if (envb.open) loadEnv();
  else renderEnv();
}

// --- artifacts ---

const arts = { items: [], open: new Set() };

async function loadArtifacts() {
  try {
    const d = await api('/api/artifacts');
    arts.items = d.items || [];
  } catch { arts.items = []; }
  renderArtifacts();
}

function renderArtifacts() {
  const list = $('art-list');
  list.innerHTML = '';
  $('art-empty').hidden = arts.items.length > 0;
  // Newest first: the one just emitted is the one being looked for.
  for (const a of [...arts.items].reverse()) list.appendChild(artifactRow(a));
}

function artifactRow(a) {
  const d = el('details', 'art');
  d.open = arts.open.has(a.n);
  d.addEventListener('toggle', () => {
    if (d.open) { arts.open.add(a.n); loadArtifactBody(a, d); }
    else arts.open.delete(a.n);
  });

  const s = el('summary');
  s.appendChild(el('span', 'art-n', `#${a.n}`));
  s.appendChild(el('span', 'art-lang', a.lang || 'text'));
  s.appendChild(el('span', 'muted', `${a.lines} lines · ${fmtBytes(a.bytes)}`));
  s.appendChild(el('span', 'art-prev', (a.preview || '').split('\n')[0] || ''));
  d.appendChild(s);

  const body = el('pre', 'art-body', '…');
  d.appendChild(body);

  const act = el('div', 'art-act');
  // Download is the thing a browser can do and a terminal cannot: the REPL's clipboard
  // copy runs on the machine davai is on, which is the wrong machine from a phone.
  const dl = el('a', 'chip', 'download');
  dl.href = `/api/artifact/${a.n}?download=1&token=${encodeURIComponent(state.token)}`;
  dl.setAttribute('download', a.name || `artifact-${a.n}.txt`);
  act.appendChild(dl);

  const copy = el('button', 'chip', 'copy');
  copy.onclick = async () => {
    try {
      const text = body.dataset.loaded ? body.textContent : (await api(`/api/artifact/${a.n}`)).text;
      await navigator.clipboard.writeText(text);
      copy.textContent = 'copied';
      setTimeout(() => { copy.textContent = 'copy'; }, 1200);
    } catch {
      // Clipboard needs a secure context: plain http over a LAN is not one, and the
      // download link is the honest fallback rather than a silent no-op.
      copy.textContent = 'use download';
    }
  };
  act.appendChild(copy);

  const nameIn = el('input', 'art-path');
  nameIn.value = a.name || `artifact-${a.n}.txt`;
  nameIn.spellcheck = false;
  act.appendChild(nameIn);

  const save = el('button', 'chip', 'save to repo');
  save.onclick = async () => {
    save.disabled = true;
    try {
      const r = await api('/api/artifact/save', { n: a.n, path: nameIn.value.trim() });
      save.textContent = `saved → ${r.path}`;
    } catch (e) {
      save.textContent = e.message;
    }
    setTimeout(() => { save.textContent = 'save to repo'; save.disabled = false; }, 2500);
  };
  act.appendChild(save);

  d.appendChild(act);
  if (d.open) loadArtifactBody(a, d);
  return d;
}

async function loadArtifactBody(a, d) {
  const body = d.querySelector('.art-body');
  if (body.dataset.loaded) return;
  try {
    const full = await api(`/api/artifact/${a.n}`);
    body.textContent = full.text;
    body.dataset.loaded = '1';
  } catch (e) {
    body.textContent = `could not load: ${e.message}`;
  }
}

const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}kB` : `${n}B`);

// --- perf: one dataset, three resolutions ---
//
// The chip in the header is a canvas sparkline of per-turn throughput, drawn by hand
// because a 120px strip does not justify a chart library. Hovering it opens the same
// series at readable size in an overlay; clicking it opens the dedicated pane, which is
// the only place with room for the intra-turn bucket plot.

/**
 * How far the accumulator may extrapolate past its last sample. It exists to keep the
 * clock moving between polls, not to invent history: a sample older than this means the
 * poll stalled, and the next refresh corrects it.
 */
const MAX_EXTRAPOLATE_MS = 6000;

const perf = {
  turns: [],
  session: null,
  /** Live estimate, char-derived: the provider's token count only arrives at turn end. */
  liveTps: 0,
  chars: 0,
  timer: null,
  paneTimer: null,
  paneTick: 0,
  lastTypingPost: 0,
};

function recordLocalTyping() {
  const now = Date.now();
  if (perf.session) {
    perf.session.state = 'user-typing';
    perf.session.lastLocalTypingAt = now;
  }
  if (now - perf.lastTypingPost > 1000) {
    perf.lastTypingPost = now;
    api('/api/typing', {}).catch(() => {});
  }
}

async function refreshPerf() {
  try {
    const d = await api('/api/perf');
    perf.turns = d.turns || [];
    perf.session = d.session ? { ...d.session, fetchedAt: Date.now() } : null;
  } catch { /* leave the last good series up */ }
  drawSpark();
  if (!$('perf-pop').hidden) drawPop();
  if (currentTab === 'perf') drawPane();
}

/**
 * The perf tab's heartbeat.
 *
 * Two cadences, deliberately split. The accumulator is redrawn locally every second so
 * the session clock ticks smoothly; the network poll is slower and only as frequent as
 * the data can actually change — a completed turn needs a turn to finish. Polling at the
 * redraw rate was spending a request a second to re-render numbers that had not moved.
 */
function startPaneTick() {
  stopPaneTick();
  perf.paneTick = 0;
  perf.paneTimer = setInterval(() => {
    renderSessionAccumulator();
    perf.paneTick++;
    const every = state.busy ? 2 : 5;
    if (perf.paneTick % every === 0) refreshPerf();
  }, 1000);
}

function stopPaneTick() {
  clearInterval(perf.paneTimer);
  perf.paneTimer = null;
}

function meterChars(n) { perf.chars += n; }

function startLiveMeter() {
  clearInterval(perf.timer);
  perf.chars = 0;
  perf.liveTps = 0;
  perf.timer = setInterval(() => {
    // ~4 chars per token. Approximate on purpose: the exact figure is reconciled against
    // the provider's usage at turn end, and this only has to move the right way.
    perf.liveTps = perf.chars / 4;
    perf.chars = 0;
    drawSpark();
  }, 1000);
}

function stopLiveMeter() {
  clearInterval(perf.timer);
  perf.timer = null;
  perf.liveTps = 0;
  perf.chars = 0;
  drawSpark();
}

const turnTps = (t) =>
  t.durationMs && t.ttftMs != null && t.durationMs > t.ttftMs
    ? t.tokens / ((t.durationMs - t.ttftMs) / 1000)
    : 0;

function fmtDuration(ms) {
  const sec = Math.max(0, ms || 0) / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

function describeTurnConfig(t) {
  if (!t) return '';
  const provModel = [t.provider, t.model].filter(Boolean).join('/') || 'unknown model';
  const parts = [`turn ${t.turn}`, provModel];
  if (t.effort) parts.push(`effort ${t.effort}`);
  if (t.contextTokens) parts.push(`${fmtTokens(t.contextTokens)} ctx`);
  if (t.contextLimit) parts.push(`limit ${fmtTokens(t.contextLimit)}`);
  if (t.maxTokens) parts.push(`max ${fmtTokens(t.maxTokens)} out`);
  if (t.startedAt) parts.push(new Date(t.startedAt).toLocaleTimeString());
  return parts.join(' · ');
}

function sparkSeries() {
  const hist = perf.turns.map(turnTps);
  return state.busy ? [...hist, perf.liveTps] : hist;
}

function drawSpark() {
  const c = $('spark');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 120;
  const h = c.clientHeight || 18;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const all = sparkSeries();
  const data = all.slice(-40);
  const now = data.length ? data[data.length - 1] : 0;
  $('perf-now').textContent = data.length ? `${now.toFixed(0)} tok/s` : '—';
  $('perf-now').className = state.busy ? 'hot-text' : 'muted';
  if (data.length < 2) return;

  const max = Math.max(...data, 1);
  const step = w / (data.length - 1);
  g.lineWidth = 1.5;
  g.strokeStyle = state.busy ? '#98c379' : '#56b6c2';
  g.beginPath();
  data.forEach((v, i) => {
    const x = i * step;
    const y = h - 1 - (v / max) * (h - 2);
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  });
  g.stroke();
}

/**
 * Shared uPlot options.
 *
 * Notice `scales: { x: { time: false } }`! uPlot defaults `scales.x.time` to `true`, which
 * interprets x values as Unix epoch seconds and formats turn numbers (1, 2, 3...) or
 * intra-turn elapsed seconds (0, 1, 2...) as 1970-01-01 00:00:01 UTC — i.e.
 * "12/31/69 4:00pm" in US Pacific time.
 */
const AXES = (xFmt) => [
  {
    stroke: '#6b7487',
    grid: { stroke: '#1e2430' },
    ticks: { stroke: '#1e2430' },
    ...(xFmt ? { values: (_u, splits) => splits.map(xFmt) } : {}),
  },
  { stroke: '#6b7487', grid: { stroke: '#1e2430' }, ticks: { stroke: '#1e2430' } },
];

function chartOpts({ title, width, height, xLabel = 'turn', xValue, xAxisFmt, series, onHover }) {
  return {
    title,
    width,
    height,
    scales: { x: { time: false } },
    series: [
      {
        label: xLabel,
        ...(xValue ? { value: xValue } : {}),
      },
      ...series,
    ],
    axes: AXES(xAxisFmt),
    legend: { show: true },
    cursor: { y: false },
    ...(onHover
      ? {
          hooks: {
            setCursor: [
              (u) => {
                // Passed through even when null — that is the cursor leaving the plot,
                // and the readout has to clear rather than keep showing the last point
                // as though it were still selected.
                const idx = u.cursor.idx;
                onHover(idx == null || idx < 0 ? -1 : idx);
              },
            ],
          },
        }
      : {}),
  };
}

function hasPlot() { return typeof uPlot !== 'undefined'; }

function turnXValue(_u, v, _sIdx, idx) {
  if (idx == null || !perf.turns[idx]) return v == null ? '—' : `#${v}`;
  return describeTurnConfig(perf.turns[idx]);
}

function turnAxisFmt(v) {
  return Number.isInteger(v) ? `#${v}` : '';
}

// --- perf: session accumulator ---

function renderSessionAccumulator() {
  const s = perf.session;
  if (!s) return;
  // Capped: this extrapolates one sample forward to keep the clock moving between polls,
  // and a stale sample must not be able to invent minutes. Anything longer than a couple
  // of poll intervals means the data is old, and the next refresh will correct it.
  const extraMs = Math.min(MAX_EXTRAPOLATE_MS, Math.max(0, Date.now() - (s.fetchedAt || Date.now())));
  const totals = { ...(s.totals || { modelMs: 0, opsMs: 0, userTypingMs: 0, userIdleMs: 0 }) };
  let liveState = s.state || (state.busy ? 'model' : 'user-idle');
  if (state.busy) {
    liveState = 'model';
    totals.modelMs += extraMs;
  } else if (s.lastLocalTypingAt && Date.now() - s.lastLocalTypingAt <= 5000) {
    liveState = 'user-typing';
    totals.userTypingMs += extraMs;
  } else if (liveState === 'user-typing' && extraMs <= 5000) {
    totals.userTypingMs += extraMs;
  } else {
    if (!state.busy) liveState = 'user-idle';
    totals.userIdleMs += extraMs;
  }
  const elapsedMs = Math.max(
    1,
    (s.elapsedMs || 0) + extraMs,
    totals.modelMs + totals.opsMs + totals.userTypingMs + totals.userIdleMs,
  );

  const stateTag =
    liveState === 'user-typing'
      ? '*user-typing*'
      : liveState === 'user-idle'
        ? '*user-idle*'
        : liveState;
  $('perf-state').textContent = stateTag;
  $('pop-state').textContent = `· ${stateTag}`;
  $('perf-elapsed').textContent =
    `started ${new Date(s.startedAt).toLocaleTimeString()} · ${fmtDuration(elapsedMs)} total`;

  const bar = $('perf-bar');
  bar.innerHTML = '';
  const cats = [
    { kind: 'model', label: 'model', ms: totals.modelMs },
    { kind: 'ops', label: 'ops', ms: totals.opsMs },
    { kind: 'user-typing', label: '*user-typing*', ms: totals.userTypingMs },
    { kind: 'user-idle', label: '*user-idle*', ms: totals.userIdleMs },
  ];
  for (const c of cats) {
    if (c.ms <= 0) continue;
    const seg = el('div', `perf-seg ${c.kind}`);
    const pct = (c.ms / elapsedMs) * 100;
    seg.style.width = `${pct.toFixed(2)}%`;
    seg.title = `${c.label}: ${fmtDuration(c.ms)} (${pct.toFixed(1)}%)`;
    bar.appendChild(seg);
  }

  const tot = $('perf-totals');
  tot.innerHTML = '';
  for (const c of cats) {
    const pct = ((c.ms / elapsedMs) * 100).toFixed(0);
    const item = el('span');
    item.appendChild(el('i', `perf-swatch ${c.kind}`));
    item.appendChild(document.createTextNode(`${c.label} `));
    item.appendChild(el('b', null, fmtDuration(c.ms)));
    item.appendChild(document.createTextNode(` (${pct}%)`));
    tot.appendChild(item);
  }

  const tl = $('perf-timeline');
  tl.innerHTML = '';
  const phases = s.phases || [];
  for (const p of phases) {
    const dur = Math.max(0, (p.endedAt || s.now) - (p.startedAt || s.startedAt));
    if (dur <= 0) continue;
    const seg = el('div', `perf-seg ${p.kind}`);
    seg.style.width = `${((dur / elapsedMs) * 100).toFixed(2)}%`;
    const who =
      p.kind === 'model'
        ? `turn #${p.turn || '?'} (${[p.provider, p.model].filter(Boolean).join('/')}${p.effort ? `, effort ${p.effort}` : ''})`
        : p.kind === 'ops'
          ? `${p.ops || 1} op(s)`
          : `*${p.kind}*`;
    seg.title = `${who} · ${fmtDuration(dur)} (${new Date(p.startedAt).toLocaleTimeString()})`;
    tl.appendChild(seg);
  }
}

// --- perf: hover overlay ---

let popCharts = [];

function drawPop() {
  for (const c of popCharts) c.destroy();
  popCharts = [];
  if (perf.session) renderSessionAccumulator();
  if (!hasPlot() || !perf.turns.length) return;
  const idx = perf.turns.map((t) => t.turn);
  // The overlay is `left:8px; right:8px` on a phone, and a canvas does not shrink to fit
  // its box the way an image would — a fixed 340 overflowed the panel below ~360px.
  const w = Math.max(220, Math.min(340, document.documentElement.clientWidth - 32));
  popCharts.push(
    new uPlot(
      chartOpts({
        title: 'tok/s per turn',
        width: w,
        height: 110,
        xValue: turnXValue,
        xAxisFmt: turnAxisFmt,
        series: [{ label: 'tok/s', stroke: '#98c379', width: 2 }],
      }),
      [idx, perf.turns.map(turnTps)],
      $('pop-tps'),
    ),
  );
  popCharts.push(
    new uPlot(
      chartOpts({
        title: 'ttft (s)',
        width: w,
        height: 110,
        xValue: turnXValue,
        xAxisFmt: turnAxisFmt,
        series: [{ label: 'ttft', stroke: '#e5c07b', width: 2 }],
      }),
      [idx, perf.turns.map((t) => (t.ttftMs ?? 0) / 1000)],
      $('pop-ttft'),
    ),
  );
}

function openPop() {
  if (currentTab === 'perf') return; // the full pane is already showing this
  $('perf-pop').hidden = false;
  // Draw from what we have so the overlay appears on the same frame as the hover, then
  // refresh. Without the refetch the accumulator extrapolates from whenever perf was
  // last fetched — which outside the perf tab is the last `done` event, so hovering
  // after ten idle minutes charged all ten to whichever bucket was live.
  drawPop();
  refreshPerf();
}

function closePop() {
  $('perf-pop').hidden = true;
  for (const c of popCharts) c.destroy();
  popCharts = [];
}

// --- perf: full pane ---

/**
 * Live uPlot instances, keyed by slot.
 *
 * Reconciled rather than rebuilt. Destroying and re-constructing four canvases on every
 * poll is what made this pane feel heavy, and it also threw away the cursor, the legend
 * readout and any in-progress hover on each refresh — so the tooltip you were reading
 * vanished under you every two seconds. An instance is torn down only when its identity
 * changes (a different turn in the detail plot); a size change goes through setSize and
 * new numbers go through setData.
 *
 * @type {Map<string, {u: object, w: number, h: number, cols: number}>}
 */
const paneCharts = new Map();

function paneWidth() {
  return Math.max(240, $('view-perf').clientWidth - 40);
}

/**
 * Create, resize or refill one chart. `key` is its identity: change it and the old
 * instance is discarded, keep it and the existing canvas is reused.
 */
function upsertChart(key, target, opts, data) {
  const prev = paneCharts.get(key);
  if (prev && prev.cols === data.length) {
    if (prev.w !== opts.width || prev.h !== opts.height) {
      prev.w = opts.width;
      prev.h = opts.height;
      prev.u.setSize({ width: opts.width, height: opts.height });
    }
    prev.u.setData(data);
    return;
  }
  if (prev) prev.u.destroy();
  target.innerHTML = '';
  paneCharts.set(key, {
    u: new uPlot(opts, data, target),
    w: opts.width,
    h: opts.height,
    cols: data.length,
  });
}

/** Drop every chart whose key is not in `keep` — e.g. the detail plot for an old turn. */
function reapCharts(keep) {
  for (const [key, c] of paneCharts) {
    if (keep.has(key)) continue;
    c.u.destroy();
    paneCharts.delete(key);
  }
}

function destroyPaneCharts() {
  for (const c of paneCharts.values()) c.u.destroy();
  paneCharts.clear();
}

/**
 * Width-only reflow. setSize re-lays-out an existing canvas, which is far cheaper than a
 * rebuild and is what makes dragging a window edge smooth rather than stuttery.
 */
function resizePaneCharts() {
  if (currentTab !== 'perf' || !paneCharts.size) return;
  const w = paneWidth();
  for (const c of paneCharts.values()) {
    // Guarded: setSize can itself change the scrollbar and therefore the width, and
    // without this the observer and the resize feed each other.
    if (c.w === w) continue;
    c.w = w;
    c.u.setSize({ width: w, height: c.h });
  }
}

function showPointMeta(idx) {
  const t = perf.turns[idx];
  if (!t) {
    // The cursor left the plot area. Leaving the last hovered turn up reads as the
    // current selection, which it is not.
    $('perf-point-meta').textContent = '';
    return;
  }
  $('perf-point-meta').textContent =
    `${describeTurnConfig(t)} · ${turnTps(t).toFixed(1)} tok/s · ttft ${((t.ttftMs ?? 0) / 1000).toFixed(2)}s · ${t.tokens || 0} out tok`;
}

function drawPane() {
  renderSessionAccumulator();

  // The <select> is rebuilt only when the turn list actually changed. Replacing its
  // options on every poll closed the dropdown in the operator's face if they happened to
  // have it open, and reset the keyboard selection.
  const sel = $('perf-turn');
  const want = perf.turns.map((t) => String(t.turn)).join(',');
  if (sel.dataset.turns !== want) {
    const prev = sel.value;
    sel.innerHTML = '';
    for (const t of perf.turns) {
      const label = [
        `turn ${t.turn}`,
        [t.provider, t.model].filter(Boolean).join('/'),
        t.effort ? `effort ${t.effort}` : null,
      ].filter(Boolean).join(' · ');
      const o = el('option', null, label);
      o.value = String(t.turn);
      sel.appendChild(o);
    }
    sel.dataset.turns = want;
    if (prev && perf.turns.some((t) => String(t.turn) === prev)) sel.value = prev;
    else if (perf.turns.length) sel.value = String(perf.turns[perf.turns.length - 1].turn);
  }

  const selectedTurn = perf.turns.find((x) => String(x.turn) === sel.value) || perf.turns.at(-1);
  $('perf-turn-meta').textContent = selectedTurn ? describeTurnConfig(selectedTurn) : '';

  if (!hasPlot()) {
    $('perf-note').textContent = 'uplot is not installed — plots unavailable';
    return;
  }
  $('perf-note').textContent = perf.turns.length ? '' : 'no completed turns yet';
  if (!perf.turns.length) {
    destroyPaneCharts();
    return;
  }

  const w = paneWidth();
  const idx = perf.turns.map((t) => t.turn);
  const points = { show: perf.turns.length < 40 };

  upsertChart('tps', $('chart-tps'), chartOpts({
    title: 'tokens/sec (streaming) — hover point for model/provider/settings',
    width: w,
    height: 190,
    xValue: turnXValue,
    xAxisFmt: turnAxisFmt,
    onHover: showPointMeta,
    series: [{ label: 'tok/s', stroke: '#98c379', width: 2, points }],
  }), [idx, perf.turns.map(turnTps)]);

  upsertChart('ttft', $('chart-ttft'), chartOpts({
    title: 'time to first token (s)',
    width: w,
    height: 190,
    xValue: turnXValue,
    xAxisFmt: turnAxisFmt,
    onHover: showPointMeta,
    series: [{ label: 'ttft', stroke: '#e5c07b', width: 2, points }],
  }), [idx, perf.turns.map((t) => (t.ttftMs ?? 0) / 1000)]);

  upsertChart('ctx', $('chart-ctx'), chartOpts({
    title: 'context tokens',
    width: w,
    height: 190,
    xValue: turnXValue,
    xAxisFmt: turnAxisFmt,
    onHover: showPointMeta,
    series: [{ label: 'ctx', stroke: '#56b6c2', width: 2, points }],
  }), [idx, perf.turns.map((t) => t.contextTokens || 0)]);

  drawTurnDetail(w);
}

/**
 * Second-by-second throughput inside one turn — the view that shows a stall during a
 * large da_ops payload as a hole rather than averaging it away. Bucket tokens are the
 * harness's pre-reconciliation estimate, which is why the title says so.
 */
function drawTurnDetail(w) {
  const t = perf.turns.find((x) => String(x.turn) === $('perf-turn').value);
  const b = t?.buckets || [];
  const keep = new Set(['tps', 'ttft', 'ctx']);
  if (b.length < 2) {
    reapCharts(keep);
    $('chart-turn').innerHTML = '';
    return;
  }
  // Buckets are the harness's pre-reconciliation estimate; `scale` is what the provider's
  // reported usage rescaled the turn by. Both are needed for this curve's area to match
  // the token count shown beside it and the terminal's own plot of the same turn.
  const step = (b[1].t - b[0].t) || 1000;
  const per = (1000 / step) * (t.scale || 1);
  const x = b.map((p) => (p.t - b[0].t) / 1000);
  // Keyed by turn: the title carries the turn's settings and uPlot fixes a title at
  // construction, so a different turn has to be a different instance.
  const key = `turn-${t.turn}`;
  keep.add(key);
  reapCharts(keep);
  upsertChart(key, $('chart-turn'), chartOpts({
    title: `${describeTurnConfig(t)} · estimated tok/s by second`,
    width: w,
    height: 190,
    xLabel: 'elapsed (s)',
    xValue: (_u, v) => (v == null ? '—' : `${Number(v).toFixed(1)}s`),
    xAxisFmt: (v) => `${v}s`,
    series: [
      { label: 'total', stroke: '#98c379', width: 2 },
      { label: 'thinking', stroke: '#c678dd', width: 1 },
      { label: 'text', stroke: '#56b6c2', width: 1 },
    ],
  }), [x, b.map((p) => p.tok * per), b.map((p) => (p.think || 0) * per), b.map((p) => (p.text || 0) * per)]);
}

// --- approvals ---

/**
 * One overlay, but the agent can have more than one request outstanding and a reconnect
 * replays every open one. Queue the rest rather than overwriting: a request that is shown
 * and then clobbered is never answered, and the agent waits on it forever.
 */
const approvalQueue = [];

function showApproval(req) {
  if (!req?.id) return;
  if (state.pendingApproval?.id === req.id) return;
  if (approvalQueue.some((r) => r.id === req.id)) return;
  if (state.pendingApproval) {
    approvalQueue.push(req);
    return;
  }
  renderApproval(req);
}

function renderApproval(req) {
  state.pendingApproval = req;
  $('approval-cmd').textContent = req.op?.cmd || '(unknown command)';
  const secret = $('approval-secret');
  secret.hidden = !req.sudo;
  secret.value = '';
  $('approval').hidden = false;
  (req.sudo ? secret : $('approve-yes')).focus();
}

/**
 * @param {string} [id] resolve this specific request; omitted means whatever is on screen.
 *   `approval-resolved` can name one still in the queue, and promoting a dead request to
 *   the screen is the other way the buttons end up doing nothing.
 */
function hideApproval(id) {
  if (id) {
    const i = approvalQueue.findIndex((r) => r.id === id);
    if (i !== -1) approvalQueue.splice(i, 1);
    if (state.pendingApproval && state.pendingApproval.id !== id) return;
  }
  state.pendingApproval = null;
  const next = approvalQueue.shift();
  if (next) return renderApproval(next);
  $('approval').hidden = true;
  $('input').focus();
}

async function answer(allow) {
  const req = state.pendingApproval;
  if (!req) return;
  const secret = $('approval-secret');
  const body = { id: req.id, allow };
  if (allow && req.sudo && secret.value) body.secret = secret.value;
  secret.value = '';
  hideApproval();
  // A stale answer (the REPL got there first) comes back {stale:true} and is not an error.
  await api('/api/approve', body).catch(() => {});
}

// --- composer ---

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text) return;
  state.history.unshift(text);
  state.histIdx = -1;
  input.value = '';
  resize(input);
  hideComplete();
  // The echo comes back over the event stream like every other entry: the harness is
  // the single writer, so nothing here is applied optimistically.
  try {
    await api('/api/submit', { text });
  } catch (e) {
    pushEntry({ type: 'error', message: e.message });
  }
}

function resize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
}

// --- completion ---

let completeItems = [];
let completeSel = 0;

function updateComplete() {
  const v = $('input').value;
  if (!v.startsWith('/') || v.includes(' ') || v.includes('\n')) return hideComplete();
  const q = v.slice(1).toLowerCase();
  completeItems = state.commands.filter((c) => c.name.slice(1).startsWith(q));
  if (!completeItems.length) return hideComplete();
  completeSel = 0;
  renderComplete();
}

function renderComplete() {
  const box = $('complete');
  box.innerHTML = '';
  completeItems.forEach((c, i) => {
    const row = el('div', i === completeSel ? 'sel' : '');
    row.appendChild(el('b', null, c.name));
    row.appendChild(document.createTextNode(`  ${c.desc}`));
    row.onclick = () => acceptComplete(i);
    box.appendChild(row);
  });
  box.hidden = false;
}

function acceptComplete(i = completeSel) {
  const c = completeItems[i];
  if (!c) return;
  $('input').value = `${c.name} `;
  hideComplete();
  $('input').focus();
}

function hideComplete() {
  completeItems = [];
  $('complete').hidden = true;
}

// --- tabs ---

const TABS = ['chat', 'perf', 'ctx', 'models', 'art'];

let currentTab = 'chat';
function setTab(name) {
  currentTab = name;
  for (const t of TABS) {
    $(`view-${t}`).hidden = t !== name;
    $(`tab-${t}`).classList.toggle('active', t === name);
  }
  stopPaneTick();
  if (name === 'perf') {
    closePop();
    // Draw immediately from the data already in hand so the tab paints on the click,
    // then refresh in the background. Awaiting the fetch first showed an empty pane for
    // a round trip, which on a phone over cellular is very visible.
    drawPane();
    refreshPerf();
    // The accumulator ticks every second so the session clock moves; the network poll
    // inside is slower. See startPaneTick.
    startPaneTick();
  } else {
    // Charts of a hidden pane cannot be measured and will not be seen. Dropping them
    // keeps four canvases and their listeners out of memory while the tab is away.
    destroyPaneCharts();
  }
  if (name === 'ctx') refreshSession();
  // The catalog is cached in-process on the server, so reopening is cheap; the first
  // open is the only one that waits on the network.
  if (name === 'models' && !models.loaded) loadModels();
  if (name === 'art') loadArtifacts();
}

// --- wiring ---

function bind() {
  const input = $('input');

  input.addEventListener('input', () => {
    recordLocalTyping();
    resize(input);
    updateComplete();
  });

  input.addEventListener('keydown', (e) => {
    recordLocalTyping();
    if (completeItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        completeSel = (completeSel + 1) % completeItems.length;
        return renderComplete();
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        completeSel = (completeSel - 1 + completeItems.length) % completeItems.length;
        return renderComplete();
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && completeItems.length === 1)) {
        e.preventDefault();
        return acceptComplete();
      }
      if (e.key === 'Escape') return hideComplete();
    }

    // Enter sends, shift+enter is a newline — the REPL's binding, not a browser's.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      return send();
    }
    // History recall, only from an untouched or already-recalled line.
    if (e.key === 'ArrowUp' && (input.selectionStart === 0 || state.histIdx >= 0)) {
      if (state.histIdx === -1) state.draft = input.value;
      if (state.histIdx + 1 < state.history.length) {
        e.preventDefault();
        state.histIdx++;
        input.value = state.history[state.histIdx];
        resize(input);
      }
      return;
    }
    if (e.key === 'ArrowDown' && state.histIdx >= 0) {
      e.preventDefault();
      state.histIdx--;
      input.value = state.histIdx === -1 ? state.draft : state.history[state.histIdx];
      resize(input);
    }
  });

  $('send').onclick = send;
  $('cancel').onclick = () => api('/api/cancel', {}).catch(() => {});
  $('approve-yes').onclick = () => answer(true);
  $('approve-no').onclick = () => answer(false);
  $('approval-secret').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); answer(true); }
  });

  for (const t of TABS) $(`tab-${t}`).onclick = () => setTab(t);

  for (const id of ['m-search', 'm-vision', 'm-reason', 'm-sort']) {
    $(id).addEventListener('input', renderModels);
  }
  $('m-search').addEventListener('keydown', (e) => {
    // Enter on a filter that matched exactly one model picks it, like the REPL pane.
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const rows = $('m-list').querySelectorAll('.m-row');
    if (rows.length === 1) rows[0].querySelector('button')?.click();
  });
  $('m-refresh').onclick = () => loadModels({ refresh: true });
  $('m-keys').onclick = () => toggleKeys();
  $('k-close').onclick = () => toggleKeys(false);
  $('m-env').onclick = () => toggleEnv();
  $('e-close').onclick = () => toggleEnv(false);
  $('e-off').onclick = () => switchEnv(null);

  for (const k of FILTERS) $(`f-${k}`).onclick = () => toggleFilter(k);
  $('fold-all').onclick = () => setFoldAll(false);
  $('unfold-all').onclick = () => setFoldAll(true);

  // Hover explodes the chip into an overlay; click goes to the full-resolution pane.
  // Touch has no hover, so the click path has to be the complete one.
  const chip = $('perf-chip');
  chip.addEventListener('mouseenter', openPop);
  chip.addEventListener('focus', openPop);
  chip.addEventListener('blur', closePop);
  chip.addEventListener('click', () => { closePop(); setTab('perf'); });
  const pop = $('perf-pop');
  const maybeClose = (e) => {
    if (!chip.contains(e.relatedTarget) && !pop.contains(e.relatedTarget)) closePop();
  };
  chip.addEventListener('mouseleave', maybeClose);
  pop.addEventListener('mouseleave', maybeClose);

  $('perf-turn').onchange = () => drawPane();

  // Global keys, matching the REPL where a browser allows it.
  document.addEventListener('keydown', (e) => {
    if (state.pendingApproval) {
      if (e.key === 'Escape') { e.preventDefault(); answer(false); }
      return;
    }
    if (e.key === 'Escape') {
      if (completeItems.length) return hideComplete();
      if (!$('perf-pop').hidden) return closePop();
      if (state.busy) api('/api/cancel', {}).catch(() => {});
      return;
    }
    if (e.ctrlKey && e.key === 'g') { e.preventDefault(); setTab(currentTab === 'ctx' ? 'chat' : 'ctx'); }
    if (e.ctrlKey && e.key === 't') { e.preventDefault(); setTab(currentTab === 'perf' ? 'chat' : 'perf'); }
  });

  // Resize is a reflow, not a rebuild: setSize keeps the data and the cursor. Coalesced
  // onto an animation frame because a window drag fires this continuously, and four
  // chart rebuilds per event is what made dragging the edge stutter.
  let resizeFrame = null;
  const onResize = () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      drawSpark();
      resizePaneCharts();
      if (!$('perf-pop').hidden) drawPop();
    });
  };
  window.addEventListener('resize', onResize);
  // Catches the cases a window resize does not: the on-screen keyboard opening, a phone
  // rotating, or the scrollbar appearing as the transcript grows.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(onResize).observe($('view-perf'));
  }
}

// --- boot ---

async function start(token) {
  state.token = token;
  const d = await api('/api/session'); // the token's first real test
  state.session = d;
  sessionStorage.setItem('davai-token', token);
  $('gate').hidden = true;
  $('app').hidden = false;
  renderHeader(d);
  renderContext(d.context);
  loadFilters();
  applyFilters();
  try {
    state.commands = (await api('/api/commands')).commands || [];
  } catch { state.commands = []; }
  bind();
  connect();
  refreshPerf();
  $('input').focus();
}

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await start($('gate-token').value.trim());
  } catch (err) {
    $('gate-error').textContent = err.message;
  }
});

// A token in the URL (the link the banner prints) or from this tab's last connection.
const urlToken = new URL(location.href).searchParams.get('token');
const saved = sessionStorage.getItem('davai-token');
if (urlToken || saved) {
  start(urlToken || saved)
    .then(() => history.replaceState(null, '', '/'))
    .catch(() => { $('gate').hidden = false; });
} else {
  $('gate').hidden = false;
}