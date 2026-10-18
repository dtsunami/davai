/**
 * The web sidecar: an HTTP view onto a running session.
 *
 * Downstream is Server-Sent Events, not a WebSocket. The stream is append-only and
 * SSE's Last-Event-ID gives reconnect-and-replay for free, which is what makes this
 * usable from a phone on cellular against a Pi. Upstream is plain POST: user messages
 * and approvals are low-frequency and request-shaped.
 *
 * The harness owns all state. Clients send intents and render what comes back; nothing
 * here is applied optimistically on the client, so two attached browsers and the REPL
 * cannot disagree about what happened.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeToken, tokenMatches, readToken, assertSafeBind, isLoopback } from './auth.js';
import { commandList } from '../ui/commands.js';

const require = createRequire(import.meta.url);

/**
 * Served from node_modules rather than vendored into the tree. uPlot is ~40kB, canvas
 * based and dependency free, which is what a Pi serving a phone wants; bundling it would
 * mean a build step, and DAVAI.md says there isn't one.
 */
const VENDOR = {
  '/assets/uplot.js': 'uplot/dist/uPlot.iife.min.js',
  '/assets/uplot.css': 'uplot/dist/uPlot.min.css',
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.join(HERE, '..', 'ui', 'web');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * @param {object} opts
 * @param {object} opts.session   from bootstrap
 * @param {object} opts.bus       SessionBus
 * @param {(text: string) => Promise<void>} opts.submit  the shared dispatcher
 * @param {number} [opts.port]    0 picks a free one
 * @param {string} [opts.host]
 * @param {string} [opts.token]
 */
export function createWebServer({ session, bus, submit, port = 7878, host = '127.0.0.1', token }) {
  assertSafeBind({ host, yolo: Boolean(session.cfg?.yolo) });
  const secret = token || makeToken();
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isStream = url.pathname === '/api/events';
    const given = readToken(req, url, { allowQuery: isStream });

    // The client bundle is public; everything else needs the token. Serving the shell
    // unauthenticated means a wrong token shows a login prompt rather than a dead socket.
    const open = url.pathname === '/' || url.pathname.startsWith('/assets/');
    if (!open && !tokenMatches(secret, given)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad or missing token' }));
      return;
    }

    if (req.method === 'GET' && open) return serveStatic(url.pathname, res);
    if (req.method === 'GET' && isStream) return stream(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/session') return json(res, describe());
    if (req.method === 'GET' && url.pathname === '/api/perf') return json(res, perf());
    if (req.method === 'GET' && url.pathname === '/api/commands') {
      return json(res, { commands: commandList() });
    }
    if (req.method === 'POST' && url.pathname === '/api/submit') return postSubmit(req, res);
    if (req.method === 'POST' && url.pathname === '/api/approve') return postApprove(req, res);
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      session.agent.cancel();
      return json(res, { ok: true });
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  // --- SSE ---

  function stream(req, res, url) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Nginx and friends buffer SSE into uselessness without this.
      'x-accel-buffering': 'no',
    });

    // Last-Event-ID on reconnect, ?since= on a deliberate catch-up.
    const last = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0);
    const { events, gap } = bus.since(last);

    send(res, 'hello', { ...describe(), ...bus.snapshot(), gap });
    for (const ev of events) send(res, ev.type, ev.data, ev.seq);

    clients.add(res);
    // Proxies and phone radios drop idle connections; this keeps the pipe warm and lets
    // the client notice a dead one.
    const beat = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(beat);
      clients.delete(res);
    });
  }

  const onEvent = (ev) => {
    for (const res of clients) send(res, ev.type, ev.data, ev.seq);
  };
  bus.on('event', onEvent);

  // --- routes ---

  function describe() {
    const { cfg, log, sandbox } = session;
    return {
      id: log.id,
      cwd: cfg.cwd,
      writeRoot: sandbox.writeRoot,
      provider: cfg.provider,
      model: cfg.model.id,
      contextLimit: cfg.contextLimit,
      effort: cfg.model.effort ? cfg.effort : null,
      yolo: Boolean(cfg.yolo),
      stats: session.agent.stats,
      context: {
        tokens: session.ledger.tokens,
        limit: session.ledger.limit,
        usage: session.ledger.usage,
        rows: session.ledger.breakdown(),
      },
    };
  }

  /**
   * Raw per-turn rows. Aggregation is the client's job: the harness should not grow a
   * stats engine for a view's benefit, and uPlot wants the raw series anyway.
   */
  function perf() {
    const t = session.throughput;
    if (!t) return { turns: [] };
    return {
      turns: t.turns.map((x) => ({
        turn: x.turn,
        model: x.model,
        provider: x.provider,
        startedAt: x.startedAt,
        endedAt: x.endedAt,
        ttftMs: x.ttftMs,
        durationMs: x.durationMs,
        tokens: Math.round(x.actualTokens ?? x.rawTokens * (x.scale || 1)),
        contextTokens: x.contextTokens,
        buckets: x.buckets.map((b) => ({ t: b.t, tok: b.tok, think: b.thinkTok, text: b.textTok })),
      })),
    };
  }

  function postSubmit(req, res) {
    body(req, (err, data) => {
      if (err) return json(res, { error: err.message }, 400);
      const text = String(data?.text || '').trim();
      if (!text) return json(res, { error: 'empty' }, 400);
      // Not awaited: a turn runs for minutes and the answer arrives over the event
      // stream. The POST only reports that the request was accepted.
      Promise.resolve(submit(text)).catch((e) => bus.publish('error', { message: e.message }));
      json(res, { ok: true });
    });
  }

  function postApprove(req, res) {
    body(req, (err, data) => {
      if (err) return json(res, { error: err.message }, 400);
      const ok = bus.resolveApproval(String(data?.id || ''), {
        allow: Boolean(data?.allow),
        ...(data?.secret ? { secret: String(data.secret) } : {}),
      });
      // Already answered, most likely from the REPL or another tab. Not an error.
      json(res, { ok, stale: !ok });
    });
  }

  function serveStatic(pathname, res) {
    let file;
    if (VENDOR[pathname]) {
      try {
        file = require.resolve(VENDOR[pathname]);
      } catch {
        // uplot not installed: the charts degrade to empty panels rather than a dead page.
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not installed');
        return;
      }
    } else {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/assets\//, '');
      file = path.join(CLIENT_DIR, rel);
      // The client directory is ours, but the path came off the wire.
      if (!file.startsWith(CLIENT_DIR)) {
        res.writeHead(403).end();
        return;
      }
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  }

  // --- helpers ---

  function send(res, type, data, id) {
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data ?? null)}\n\n`);
  }

  function json(res, payload, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  function body(req, cb) {
    let raw = '';
    let tooBig = false;
    req.on('data', (c) => {
      raw += c;
      // A prompt is text. Anything past this is not one.
      if (raw.length > 1_000_000 && !tooBig) {
        tooBig = true;
        req.destroy();
        cb(new Error('body too large'));
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        cb(null, raw ? JSON.parse(raw) : {});
      } catch {
        cb(new Error('invalid json'));
      }
    });
  }

  return {
    server,
    token: secret,
    get port() {
      const a = server.address();
      return typeof a === 'object' && a ? a.port : port;
    },
    url() {
      const h = isLoopback(host) ? 'localhost' : host;
      return `http://${h}:${this.port}/?token=${secret}`;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(this));
      });
    },
    close() {
      bus.off('event', onEvent);
      for (const res of clients) res.end();
      clients.clear();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}