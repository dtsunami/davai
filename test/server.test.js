import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionBus } from '../src/session/bus.js';
import { createWebServer } from '../src/server/http.js';
import { tokenMatches, makeToken, assertSafeBind } from '../src/server/auth.js';

class FakeAgent extends EventEmitter {
  constructor() {
    super();
    this.stats = { turns: 1, ops: 2, cost: 0.01 };
    this.cancelled = false;
  }
  cancel() { this.cancelled = true; }
}

let server;
let base;
let session;
let bus;
let submitted;

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-web-'));
  const agent = new FakeAgent();
  submitted = [];
  session = {
    cfg: {
      cwd: base,
      provider: 'anthropic',
      model: { id: 'claude-opus-5', effort: true },
      effort: 'high',
      contextLimit: 1_000_000,
      yolo: false,
    },
    agent,
    log: { id: 'sess123', dir: base },
    sandbox: { writeRoot: base },
    ledger: {
      tokens: 1000,
      limit: 1_000_000,
      usage: 0.001,
      breakdown: () => [{ id: 0, type: 'system', label: 'system', tokens: 1000, pct: 100 }],
    },
    artifacts: {
      items: [
        { n: 1, lang: 'python', text: 'print(1)\nprint(2)\n', lines: 3, bytes: 18, createdAt: 1 },
      ],
      get(n) { return this.items[Number(n) - 1]; },
      save: (n, dest) => ({ path: dest, bytes: 18, overwrote: false }),
    },
    journal: {},
    throughput: {
      turns: [
        {
          turn: 1, model: 'claude-opus-5', provider: 'anthropic',
          startedAt: 1000, endedAt: 3000, ttftMs: 500, durationMs: 2000,
          actualTokens: 300, scale: 1, rawTokens: 300, contextTokens: 5000,
          buckets: [{ t: 0, tok: 10, thinkTok: 2, textTok: 8 }],
        },
      ],
    },
  };
  bus = new SessionBus({ agent });
  server = await createWebServer({
    session,
    bus,
    submit: async (text) => { submitted.push(text); },
    port: 0,
  }).listen();
});

afterEach(async () => {
  await server.close();
  bus.detach();
  fs.rmSync(base, { recursive: true, force: true });
});

const url = (p) => `http://127.0.0.1:${server.port}${p}`;
const auth = (extra = {}) => ({ authorization: `Bearer ${server.token}`, ...extra });

describe('auth', () => {
  it('refuses a request with no token', async () => {
    const res = await fetch(url('/api/session'));
    expect(res.status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const res = await fetch(url('/api/session'), { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('accepts the right one', async () => {
    const res = await fetch(url('/api/session'), { headers: auth() });
    expect(res.status).toBe(200);
    expect((await res.json()).model).toBe('claude-opus-5');
  });

  it('serves the client shell without a token so a bad one can be corrected', async () => {
    const res = await fetch(url('/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('compares tokens in constant time and rejects length mismatches', () => {
    const t = makeToken();
    expect(tokenMatches(t, t)).toBe(true);
    expect(tokenMatches(t, t.slice(0, -1))).toBe(false);
    expect(tokenMatches(t, '')).toBe(false);
    expect(tokenMatches(t, undefined)).toBe(false);
  });

  it('refuses to bind off-loopback with yolo on', () => {
    expect(() => assertSafeBind({ host: '0.0.0.0', yolo: true })).toThrow(/unauthenticated remote shell/);
    // Either alone is fine.
    expect(() => assertSafeBind({ host: '0.0.0.0', yolo: false })).not.toThrow();
    expect(() => assertSafeBind({ host: '127.0.0.1', yolo: true })).not.toThrow();
  });

  it('refuses to construct a yolo server on a public bind', () => {
    session.cfg.yolo = true;
    expect(() => createWebServer({ session, bus, submit: async () => {}, host: '0.0.0.0' })).toThrow();
  });
});

describe('routes', () => {
  it('describes the session', async () => {
    const d = await (await fetch(url('/api/session'), { headers: auth() })).json();
    expect(d).toMatchObject({ id: 'sess123', provider: 'anthropic', effort: 'high' });
    expect(d.context.rows).toHaveLength(1);
  });

  it('returns raw per-turn perf rows and session accumulator for the client', async () => {
    let keystroked = false;
    session.throughput.recordKeystroke = () => { keystroked = true; };
    session.throughput.sessionSummary = () => ({
      startedAt: 500,
      now: 3500,
      elapsedMs: 3000,
      state: 'user-idle',
      totals: { modelMs: 2000, opsMs: 0, userTypingMs: 200, userIdleMs: 800 },
      phases: [],
    });
    session.throughput.turns[0].effort = 'high';
    session.throughput.turns[0].maxTokens = 32000;
    session.throughput.turns[0].contextLimit = 1_000_000;

    const ty = await fetch(url('/api/typing'), {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: '{}',
    });
    expect(ty.status).toBe(200);
    expect(keystroked).toBe(true);

    const d = await (await fetch(url('/api/perf'), { headers: auth() })).json();
    expect(d.turns).toHaveLength(1);
    expect(d.turns[0]).toMatchObject({
      turn: 1,
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: 'high',
      maxTokens: 32000,
      contextLimit: 1_000_000,
      ttftMs: 500,
      durationMs: 2000,
      tokens: 300,
    });
    expect(d.session).toMatchObject({ state: 'user-idle', elapsedMs: 3000 });
  });

  it('sends the scale needed to read the raw buckets', () => {
    // `tokens` is reconciled against the provider's usage but `buckets` are the estimate.
    // Without `scale` the client cannot draw the two on one axis.
    session.throughput.turns[0].scale = 1.5;
    session.throughput.turns[0].rawTokens = 200;
    session.throughput.turns[0].actualTokens = null;
    return fetch(url('/api/perf'), { headers: auth() })
      .then((r) => r.json())
      .then((d) => {
        expect(d.turns[0].scale).toBe(1.5);
        expect(d.turns[0].tokens).toBe(300); // 200 raw * 1.5
      });
  });

  it('caps the phase timeline without distorting the totals', () => {
    const phases = [];
    for (let i = 0; i < 1200; i++) {
      phases.push({ kind: 'model', startedAt: i * 10, endedAt: i * 10 + 5 });
    }
    session.throughput.sessionSummary = () => ({
      startedAt: 0,
      now: 12_000,
      elapsedMs: 12_000,
      state: 'model',
      totals: { modelMs: 6000, opsMs: 0, userTypingMs: 0, userIdleMs: 6000 },
      phases,
    });
    return fetch(url('/api/perf'), { headers: auth() })
      .then((r) => r.json())
      .then((d) => {
        expect(d.session.phases.length).toBeLessThan(phases.length);
        expect(d.session.phasesTotal).toBe(1200);
        // Trimming the strip must not change what the accumulator reports.
        expect(d.session.totals.modelMs).toBe(6000);
        expect(d.session.elapsedMs).toBe(12_000);
      });
  });

  it('serves the command table so the web client cannot drift from the REPL', async () => {
    const d = await (await fetch(url('/api/commands'), { headers: auth() })).json();
    const names = d.commands.map((c) => c.name);
    expect(names).toContain('/model');
    expect(names).toContain('/context');
    expect(names).toContain('sh');
    // Keys and Input are not commands.
    expect(names).not.toContain('shift+enter');
    expect(d.commands.every((c) => c.desc)).toBe(true);
  });

  it('accepts a submission and hands it to the shared dispatcher', async () => {
    const res = await fetch(url('/api/submit'), {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(200);
    expect(submitted).toEqual(['hello']);
  });

  it('rejects an empty submission', async () => {
    const res = await fetch(url('/api/submit'), {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
  });

  it('cancels the running turn', async () => {
    await fetch(url('/api/cancel'), { method: 'POST', headers: auth({ 'content-type': 'application/json' }), body: '{}' });
    expect(session.agent.cancelled).toBe(true);
  });

  it('answers an approval, and reports a stale one as stale rather than failed', async () => {
    let answered = null;
    session.agent.emit('approval-request', { op: { cmd: 'ls' }, respond: (d) => { answered = d; } });

    const post = () =>
      fetch(url('/api/approve'), {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ id: 'ap1', allow: true }),
      }).then((r) => r.json());

    expect(await post()).toEqual({ ok: true, stale: false });
    expect(answered).toEqual({ allow: true });
    expect(await post()).toEqual({ ok: false, stale: true });
  });

  it('serves the model catalog with the live selection alongside it', async () => {
    const d = await (await fetch(url('/api/models'), { headers: auth() })).json();
    expect(d.provider).toBe('anthropic');
    expect(d.current).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' });
    // Every provider is listed, including the ones with no key, so the browser can say
    // "needs a key" rather than silently omitting them.
    expect(d.providers.map((p) => p.name)).toContain('gemini');
    expect(d.providers.find((p) => p.name === 'gemini').hasKey).toBe(false);
    expect(d.models.length).toBeGreaterThan(0);
    // Serialized, not raw: a 300-model payload has no business carrying internals.
    expect(Object.keys(d.models[0]).sort()).toEqual([
      'context', 'effort', 'id', 'inputPrice', 'label', 'maxOutput',
      'outputPrice', 'remoteOnly', 'thinking', 'unverified', 'vision',
    ]);
  });

  it('browses another provider without switching the session to it', async () => {
    const d = await (await fetch(url('/api/models?provider=openrouter'), { headers: auth() })).json();
    expect(d.provider).toBe('openrouter');
    expect(d.current.provider).toBe('anthropic');
    expect(session.cfg.provider).toBe('anthropic');
  });

  it('reports a bad model switch as a 400 and leaves the session alone', async () => {
    const res = await fetch(url('/api/model'), {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ provider: 'gemini', model: 'gemini-3-pro-preview' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no API key/);
    expect(session.cfg.provider).toBe('anthropic');
  });

  it('lists artifacts as metadata, without the bodies', async () => {
    const d = await (await fetch(url('/api/artifacts'), { headers: auth() })).json();
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ n: 1, lang: 'python', lines: 3, name: 'artifact-1.py' });
    // The body can be megabytes and the list renders without it.
    expect(d.items[0].text).toBeUndefined();
    expect(d.items[0].preview).toContain('print(1)');
  });

  it('serves one artifact body, and as a download when asked', async () => {
    const d = await (await fetch(url('/api/artifact/1'), { headers: auth() })).json();
    expect(d.text).toBe('print(1)\nprint(2)\n');

    const dl = await fetch(url('/api/artifact/1?download=1'), { headers: auth() });
    expect(dl.headers.get('content-disposition')).toContain('artifact-1.py');
    expect(await dl.text()).toBe('print(1)\nprint(2)\n');
  });

  it('404s an artifact that does not exist', async () => {
    const res = await fetch(url('/api/artifact/99'), { headers: auth() });
    expect(res.status).toBe(404);
  });

  it('saves an artifact and announces it on the transcript channel', async () => {
    const seen = [];
    bus.on('event', (ev) => seen.push(ev));
    const res = await fetch(url('/api/artifact/save'), {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ n: 1, path: 'out.py' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).path).toBe('out.py');
    // Tagged origin:'web' so App.jsx mirrors it into the terminal rather than ignoring it.
    const note = seen.find((e) => e.type === 'transcript');
    expect(note.data).toMatchObject({ type: 'notice', origin: 'web' });
  });

  it('reports a rejected save as a 400, not a crash', async () => {
    session.artifacts.save = () => { throw new Error('outside the write root'); };
    const res = await fetch(url('/api/artifact/save'), {
      method: 'POST',
      headers: auth({ 'content-type': 'application/json' }),
      body: JSON.stringify({ n: 1, path: '../../etc/passwd' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/outside the write root/);
  });

  it('404s an unknown route', async () => {
    const res = await fetch(url('/api/nope'), { headers: auth() });
    expect(res.status).toBe(404);
  });
});

describe('event stream', () => {
  it('opens with a hello carrying the snapshot, then streams', async () => {
    const res = await fetch(url(`/api/events?token=${server.token}`));
    expect(res.headers.get('content-type')).toMatch(/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    const readUntil = async (needle) => {
      const deadline = Date.now() + 2000;
      while (!buf.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}; got: ${buf}`);
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    };

    await readUntil('event: hello');
    expect(buf).toContain('claude-opus-5');

    session.agent.emit('text', 'streamed');
    await readUntil('event: text');
    expect(buf).toMatch(/id: \d+/);
    expect(buf).toContain('"streamed"');

    await reader.cancel();
  });

  it('replays from ?since= so a reconnect does not lose output', async () => {
    session.agent.emit('text', 'first');
    session.agent.emit('text', 'second');

    const res = await fetch(url(`/api/events?token=${server.token}&since=1`));
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    // "first" was seq 1 and is not replayed; "second" is.
    expect(chunk).toContain('"second"');
    await reader.cancel();
  });

  it('refuses a stream with a bad token', async () => {
    const res = await fetch(url('/api/events?token=wrong'));
    expect(res.status).toBe(401);
  });
});