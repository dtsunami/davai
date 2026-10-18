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

  it('returns raw per-turn perf rows for the client to aggregate', async () => {
    const d = await (await fetch(url('/api/perf'), { headers: auth() })).json();
    expect(d.turns).toHaveLength(1);
    expect(d.turns[0]).toMatchObject({ turn: 1, ttftMs: 500, durationMs: 2000, tokens: 300 });
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