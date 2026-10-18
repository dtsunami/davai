/**
 * The davai web client.
 *
 * Deliberately keyboard-first. A browser chat box is a worse driver than the REPL —
 * no history recall, no completion, mouse-dependent — so this keeps enter-to-send,
 * shift+enter for a newline, up-arrow history, tab completion and the same escape
 * and ctrl bindings. What it adds is what a terminal cannot do: real plots, and a
 * transcript you can scroll on a phone.
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
    state.seq = d.seq || state.seq;
    renderHeader(d);
    // The ring had already dropped events we never saw: stitching would silently lose
    // transcript, so say so rather than pretend continuity.
    if (d.gap) pushEntry({ type: 'warning', message: 'reconnected with a gap — some output was missed' });
    if (d.state) {
      state.busy = d.state.busy;
      setLive(d.state.live || '');
      setThinking(d.state.thinking || '');
      setStatus(d.state.status);
      setBusy(d.state.busy);
    }
    for (const p of d.pending || []) showApproval(p);
  });

  for (const type of EVENTS) {
    es.addEventListener(type, (e) => {
      if (e.lastEventId) state.seq = Number(e.lastEventId);
      handle(type, e.data ? JSON.parse(e.data) : null);
    });
  }
}

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

let live = '';
let thinking = '';

function handle(type, d) {
  switch (type) {
    case 'transcript':
      pushEntry(d);
      break;
    case 'pane':
      // The REPL's pane names, mapped onto this client's tabs. 'model' and 'artifacts'
      // have no tab yet, so they stay on chat rather than blanking the view.
      if (d.pane === 'context') setTab('ctx');
      else if (d.pane === 'tps') setTab('perf');
      else if (d.pane === null) setTab('chat');
      break;
    case 'session-changed':
      refreshSession();
      break;
    case 'turn-start':
      live = ''; thinking = '';
      setLive(''); setThinking(''); setBusy(true); setStatus('thinking');
      break;
    case 'thinking':
      thinking += d; setThinking(thinking);
      break;
    case 'text':
      // The answer has started, so the working notes have served their purpose.
      if (thinking) { thinking = ''; setThinking(''); }
      live += d; setLive(live);
      break;
    case 'turn-end':
      if (d?.text?.trim()) pushEntry({ type: 'assistant', text: d.text });
      live = ''; thinking = '';
      setLive(''); setThinking(''); setStatus(null);
      break;
    case 'ops-parsed':
      setStatus(`running ${d.length} op${d.length > 1 ? 's' : ''}`);
      pushEntry({ type: 'ops', ops: d });
      break;
    case 'ops-result':
      setStatus(null);
      pushEntry({ type: 'ops-result', ...d });
      break;
    case 'done':
    case 'cancelled':
      if (type === 'cancelled') {
        if (live.trim()) pushEntry({ type: 'assistant', text: live });
        pushEntry({ type: 'notice', message: 'cancelled' });
      }
      live = ''; thinking = '';
      setLive(''); setThinking(''); setBusy(false); setStatus(null);
      refreshSession();
      break;
    case 'error':
      pushEntry({ type: 'error', message: d.message, detail: d.detail });
      setBusy(false); setStatus(null);
      break;
    case 'warning':
      pushEntry({ type: 'warning', message: d.message });
      break;
    case 'retry':
      pushEntry({
        type: 'warning',
        message: `${d.message} — retrying in ${Math.round(d.waitMs / 1000)}s (${d.attempt}/${d.of})`,
      });
      break;
    case 'nudge':
    case 'repair':
      pushEntry({ type: 'notice', message: d.error ? `malformed da_ops: ${d.error}` : 'no ops in that turn — asking it to continue' });
      break;
    case 'steer-queued':
      showQueue(d.queued);
      break;
    case 'steered':
      showQueue(0);
      pushEntry({ type: 'notice', message: `steering applied (${d.applied})` });
      break;
    case 'compact-start':
      setStatus('compacting context');
      break;
    case 'compact-done':
      setStatus(null);
      pushEntry({ type: 'notice', message: `compacted: ${d.before} → ${d.after} tokens` });
      break;
    case 'usage':
      renderStats(d);
      break;
    case 'artifact':
      pushEntry({ type: 'notice', message: `artifact: ${d.label || d.name || 'saved'}` });
      break;
    case 'approval-request':
      showApproval(d);
      break;
    case 'approval-resolved':
      if (state.pendingApproval?.id === d.id) hideApproval();
      break;
    default:
      break;
  }
}

// --- transcript rendering ---

const transcript = () => $('transcript');

function pushEntry(entry) {
  const box = transcript();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.appendChild(renderEntry(entry));
  // Only follow if they were already at the bottom; yanking the view while someone
  // reads scrollback is the most irritating thing a live log can do.
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderEntry(e) {
  if (e.type === 'ops') {
    const n = el('div', 'entry ops');
    for (const op of e.ops) {
      n.appendChild(el('div', 'op-line', `${op.op}: ${op.path || op.cmd || op.pattern || ''}`));
    }
    return n;
  }
  if (e.type === 'ops-result') {
    const n = el('div', 'entry');
    const out = e.outcome || {};
    if (out.status === 'ok') {
      for (const r of out.results || []) {
        const d = r.result || {};
        n.appendChild(el('div', 'op-ok', `${d.path || r.op} ${d.action || 'ok'}`));
      }
    } else {
      for (const err of out.errors || []) {
        n.appendChild(el('div', 'op-fail', `${err.op}: ${err.message}`));
      }
      n.appendChild(el('div', 'op-fail', 'nothing was applied'));
    }
    return n;
  }
  const n = el('div', `entry ${e.type}`);
  n.textContent = e.text || e.message || '';
  if (e.detail) n.appendChild(el('pre', null, e.detail));
  return n;
}

function setLive(text) {
  const n = $('live');
  n.textContent = text;
  n.hidden = !text;
  if (text) {
    const box = transcript().parentElement;
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
  }
}

function setThinking(text) {
  const n = $('thinking');
  n.textContent = text;
  n.hidden = !text;
}

function setStatus(text) {
  const n = $('status');
  n.textContent = text || '';
  n.hidden = !text;
}

function setBusy(busy) {
  state.busy = busy;
  $('cancel').hidden = !busy;
  $('send').disabled = busy && false; // still allowed: typing mid-turn steers
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
  if (d.stats) renderStats({ total: d.stats.cost, ...d.stats });
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
    if (currentTab === 'perf') drawCharts();
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

// --- perf view ---

let charts = [];

async function drawCharts() {
  const { turns } = await api('/api/perf');
  for (const c of charts) c.destroy();
  charts = [];
  if (!turns.length) return;

  const idx = turns.map((t) => t.turn);
  const tps = turns.map((t) =>
    t.durationMs && t.ttftMs != null && t.durationMs > t.ttftMs
      ? t.tokens / ((t.durationMs - t.ttftMs) / 1000)
      : 0,
  );
  const ttft = turns.map((t) => (t.ttftMs ?? 0) / 1000);
  const ctxTok = turns.map((t) => t.contextTokens || 0);

  const w = $('view-perf').clientWidth - 40;
  const opts = (title, label, stroke) => ({
    title,
    width: w,
    height: 180,
    series: [
      { label: 'turn' },
      { label, stroke, width: 2, points: { show: turns.length < 40 } },
    ],
    axes: axes(),
    legend: { show: false },
  });

  charts.push(new uPlot(opts('tokens/sec (streaming)', 'tok/s', '#98c379'), [idx, tps], $('chart-tps')));
  charts.push(new uPlot(opts('time to first token (s)', 'ttft', '#e5c07b'), [idx, ttft], $('chart-ttft')));
  charts.push(new uPlot(opts('context tokens', 'ctx', '#56b6c2'), [idx, ctxTok], $('chart-ctx')));
}

const axes = () => [
  { stroke: '#6b7487', grid: { stroke: '#1e2430' }, ticks: { stroke: '#1e2430' } },
  { stroke: '#6b7487', grid: { stroke: '#1e2430' }, ticks: { stroke: '#1e2430' } },
];

// --- approvals ---

function showApproval(req) {
  state.pendingApproval = req;
  $('approval-cmd').textContent = req.op?.cmd || '(unknown command)';
  const secret = $('approval-secret');
  secret.hidden = !req.sudo;
  secret.value = '';
  $('approval').hidden = false;
  (req.sudo ? secret : $('approve-yes')).focus();
}

function hideApproval() {
  state.pendingApproval = null;
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

let currentTab = 'chat';
function setTab(name) {
  currentTab = name;
  for (const t of ['chat', 'perf', 'ctx']) {
    $(`view-${t}`).hidden = t !== name;
    $(`tab-${t}`).classList.toggle('active', t === name);
  }
  if (name === 'perf') drawCharts();
  if (name === 'ctx') refreshSession();
}

// --- wiring ---

function bind() {
  const input = $('input');

  input.addEventListener('input', () => {
    resize(input);
    updateComplete();
  });

  input.addEventListener('keydown', (e) => {
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

  $('tab-chat').onclick = () => setTab('chat');
  $('tab-perf').onclick = () => setTab('perf');
  $('tab-ctx').onclick = () => setTab('ctx');

  // Global keys, matching the REPL where a browser allows it.
  document.addEventListener('keydown', (e) => {
    if (state.pendingApproval) {
      if (e.key === 'Escape') { e.preventDefault(); answer(false); }
      return;
    }
    if (e.key === 'Escape') {
      if (completeItems.length) return hideComplete();
      if (state.busy) api('/api/cancel', {}).catch(() => {});
      return;
    }
    if (e.ctrlKey && e.key === 'g') { e.preventDefault(); setTab(currentTab === 'ctx' ? 'chat' : 'ctx'); }
    if (e.ctrlKey && e.key === 't') { e.preventDefault(); setTab(currentTab === 'perf' ? 'chat' : 'perf'); }
  });

  window.addEventListener('resize', () => { if (currentTab === 'perf') drawCharts(); });
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
  try {
    state.commands = (await api('/api/commands')).commands || [];
  } catch { state.commands = []; }
  bind();
  connect();
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