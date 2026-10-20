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
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeToken, tokenMatches, readToken, assertSafeBind, isLoopback } from './auth.js';
import { commandList } from '../ui/commands.js';
import {
  EFFORTS,
  EFFORT_HELP,
  providerState,
  loadCatalog,
  serializeModel,
  applyModelChange,
} from '../session/models.js';
import { keyState, setProviderKey, clearProviderKey } from '../session/keys.js';
import { profileState, switchProfile, chooseProfileVar } from '../session/profiles.js';
import { suggestName } from '../context/artifacts.js';
import { dropSegment, pinSegment, summarizeSegments, runCompact } from '../context/manage.js';

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

/**
 * How many session phases the perf payload carries. The accumulator's totals are exact
 * regardless; this bounds only the drawn timeline, which has one pixel per segment at
 * best.
 */
const MAX_PHASES_OUT = 400;

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
export function createWebServer({
  session,
  bus,
  submit,
  port = 7878,
  host = '127.0.0.1',
  token,
}) {
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
    const open =
      url.pathname === '/' ||
      url.pathname.startsWith('/assets/') ||
      url.pathname === '/favicon.svg' ||
      url.pathname === '/favicon.ico';
    if (!open && !tokenMatches(secret, given)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad or missing token' }));
      return;
    }

    if (req.method === 'GET' && open) return serveStatic(url.pathname, res);
    if (req.method === 'GET' && isStream) return stream(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/session') return json(res, describe());
    if (req.method === 'GET' && url.pathname === '/api/perf') return json(res, perf());
    if (req.method === 'POST' && url.pathname === '/api/typing') {
      session.throughput?.recordKeystroke?.();
      return json(res, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/commands') {
      return json(res, { commands: commandList() });
    }
    if (req.method === 'GET' && url.pathname === '/api/models') return getModels(res, url);
    if (req.method === 'POST' && url.pathname === '/api/model') return postModel(req, res);
    if (req.method === 'GET' && url.pathname === '/api/keys') return json(res, { providers: keyState(session.cfg) });
    if (req.method === 'POST' && url.pathname === '/api/keys') return postKeys(req, res);
    if (req.method === 'GET' && url.pathname === '/api/env') {
      return json(res, profileState(session.cfg));
    }
    if (req.method === 'POST' && url.pathname === '/api/env') return postEnv(req, res);
    if (req.method === 'GET' && url.pathname === '/api/prompts') return json(res, prompts());
    if (req.method === 'GET' && url.pathname === '/api/context/history') return json(res, contextHistory());
    if (req.method === 'GET' && url.pathname.startsWith('/api/context/segment/')) {
      return getContextSegment(url, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/context/drop') return postCtxDrop(req, res);
    if (req.method === 'POST' && url.pathname === '/api/context/pin') return postCtxPin(req, res);
    if (req.method === 'POST' && url.pathname === '/api/context/summarize') return postCtxSummarize(req, res);
    if (req.method === 'POST' && url.pathname === '/api/compact') return postCompact(req, res);
    if (req.method === 'GET' && url.pathname === '/api/artifacts') return json(res, artifacts());
    if (req.method === 'GET' && url.pathname.startsWith('/api/artifact/')) {
      return getArtifact(url, res);
    }
    if (req.method === 'POST' && url.pathname === '/api/artifact/save') {
      return postArtifactSave(req, res);
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
    if (!t) return { turns: [], session: null };
    const summary = typeof t.sessionSummary === 'function' ? t.sessionSummary() : null;
    return {
      session: summary
        ? {
            ...summary,
            // Totals stay exact; only the drawn strip is trimmed. A browser cannot render
            // four thousand segments into a 600px bar, and re-sending the whole array
            // every poll makes the payload grow with session length for no gain.
            phases: (summary.phases || []).slice(-MAX_PHASES_OUT),
            phasesTotal: (summary.phases || []).length,
          }
        : null,
      turns: t.turns.map((x) => ({
        turn: x.turn,
        model: x.model,
        provider: x.provider,
        effort: x.effort ?? null,
        maxTokens: x.maxTokens ?? null,
        contextLimit: x.contextLimit ?? null,
        startedAt: x.startedAt,
        endedAt: x.endedAt,
        ttftMs: x.ttftMs,
        durationMs: x.durationMs,
        tokens: Math.round(x.actualTokens ?? x.rawTokens * (x.scale || 1)),
        contextTokens: x.contextTokens,
        // Buckets are the pre-reconciliation estimate and `scale` is what turns them into
        // the same figure as `tokens`. Sending the buckets without it is how the web
        // turn-detail curve came to disagree with both the terminal's plot and the token
        // count printed beside it.
        scale: x.scale || 1,
        buckets: x.buckets.map((b) => ({ t: b.t, tok: b.tok, think: b.thinkTok, text: b.textTok })),
      })),
    };
  }

  /** The prompt layers and the exact system prompt that was sent. */
  function prompts() {
    const { cfg, ledger } = session;
    return {
      system: ledger?.system || '',
      values: cfg.prompts || {},
      sources: cfg.promptSources || {},
      layers: cfg.promptLayers || [],
    };
  }

  /** Context growth as a step series: each segment's creation adds its tokens. */
  function contextHistory() {
    const l = session.ledger;
    if (!l) return { points: [], limit: null };
    const t0 = session.log?.startedAt || Date.now();
    let cum = l.systemTokens || 0;
    const applyCal = (n) => l.calibrator?.apply?.(n) ?? n;
    const points = [{ t: t0, tokens: applyCal(cum) }];
    for (const s of l.segments || []) {
      cum += s.tokens || 0;
      points.push({ t: s.createdAt || t0, tokens: applyCal(cum) });
    }
    return { points, limit: l.limit };
  }

  /** One segment's content, for the detail view. Images report presence, not data. */
  function getContextSegment(url, res) {
    const id = Number(url.pathname.split('/').pop());
    if (id === 0) {
      const l = session.ledger;
      return json(res, {
        id: 0,
        type: 'system',
        label: 'system prompt + protocol',
        tokens: l?.calibrator?.apply?.(l.systemTokens) ?? 0,
        pinned: true,
        role: null,
        text: l?.system || '',
        image: false,
      });
    }
    if (!session.ledger) return json(res, { error: 'no ledger' }, 404);
    const seg = session.ledger.get(id);
    if (!seg) return json(res, { error: `no segment #${id}` }, 404);
    return json(res, {
      id: seg.id,
      type: seg.type,
      label: seg.label,
      tokens: seg.tokens,
      pinned: seg.pinned,
      role: seg.role,
      text: seg.part?.type === 'text' ? seg.part.text : null,
      image: seg.part?.type === 'image',
    });
  }

  /** Announce a manual ledger mutation to every view, including the REPL. */
  function contextChanged(message) {
    bus.publish('transcript', { type: 'notice', message, origin: 'web' });
    bus.publish('session-changed', null);
  }

  function postCtxDrop(req, res) {
    body(req, (err, data) => {
      if (err) return json(res, { error: err.message }, 400);
      const ok = dropSegment(session.ledger, Number(data?.id));
      if (!ok) return json(res, { error: 'no droppable segment with that id' }, 400);
      contextChanged(`dropped segment #${Number(data.id)}`);
      json(res, { ok: true });
    });
  }

  function postCtxPin(req, res) {
    body(req, (err, data) => {
      if (err) return json(res, { error: err.message }, 400);
      const ok = pinSegment(session.ledger, Number(data?.id), Boolean(data?.pinned));
      if (!ok) return json(res, { error: 'no segment with that id' }, 400);
      contextChanged(`segment #${Number(data.id)} ${data.pinned ? 'pinned' : 'unpinned'}`);
      json(res, { ok: true });
    });
  }

  function postCtxSummarize(req, res) {
    body(req, async (err, data) => {
      if (err) return json(res, { error: err.message }, 400);
      const ids = Array.isArray(data?.ids) ? data.ids.map(Number) : [];
      if (!ids.length) return json(res, { error: 'no segments selected' }, 400);
      try {
        const r = await summarizeSegments(session.ledger, ids, {
          cfg: session.cfg,
          makeProvider: session.agent.makeProvider,
          onEvent: (ev) => {
            if (ev?.type === 'compact-warning') {
              bus.publish('transcript', { type: 'warning', message: ev.message, origin: 'web' });
            }
          },
        });
        for (const a of r.actions) contextChanged(a);
        json(res, { ok: true, freed: r.freed, actions: r.actions });
      } catch (e) {
        json(res, { error: e.message }, 400);
      }
    });
  }

  function postCompact(req, res) {
    body(req, async (err) => {
      if (err) return json(res, { error: err.message }, 400);
      try {
        const r = await runCompact(session.ledger, {
          cfg: session.cfg,
          makeProvider: session.agent.makeProvider,
          onEvent: (ev) => {
            if (ev?.type === 'compact-warning') {
              bus.publish('transcript', { type: 'warning', message: ev.message, origin: 'web' });
            }
          },
        });
        if (r.actions.length) {
          session.log.event('compact', r);
          for (const a of r.actions) contextChanged(a);
          contextChanged(`compacted · freed ~${r.freed} tokens`);
        } else {
          contextChanged('compaction found nothing to trim');
        }
        json(res, { ok: true, freed: r.freed, actions: r.actions });
      } catch (e) {
        json(res, { error: e.message }, 400);
      }
    });
  }

  /**
   * The model catalog for one provider, with the session's current selection alongside.
   *
   * `?refresh=1` forces a re-fetch; without it OpenRouter's 300-model catalog comes from
   * the in-process cache, which is the difference between a pane that opens instantly and
   * one that waits on a network round trip every time a tab is clicked.
   *
   * A catalog that failed to load is a 200 with `error` set, not a 5xx: the seed list is
   * still worth rendering, and the browser shows the reason next to it.
   */
  async function getModels(res, url) {
    const { cfg } = session;
    const provider = url.searchParams.get('provider') || cfg.provider;
    const refresh = url.searchParams.get('refresh') === '1';
    try {
      const { models, error, source } = await loadCatalog(cfg, { provider, force: refresh });
      json(res, {
        provider,
        source,
        error,
        providers: providerState(cfg),
        efforts: EFFORTS.map((id) => ({ id, desc: EFFORT_HELP[id] })),
        current: {
          provider: cfg.provider,
          model: cfg.model.id,
          effort: cfg.model.effort ? cfg.effort : null,
          contextLimit: cfg.contextLimit,
          maxTokens: cfg.maxTokens,
        },
        models: models.map(serializeModel),
      });
    } catch (e) {
      json(res, { error: e.message, models: [], providers: providerState(cfg) }, 500);
    }
  }

  /**
   * Switch model, provider and/or effort. Goes through the same `applyModelChange` the
   * REPL's pane uses, then publishes `session-changed` so the REPL re-reads a config the
   * browser just mutated underneath it.
   */
  function postModel(req, res) {
    body(req, async (err, data) => {
      if (err) return json(res, { error: err.message }, 400);
      try {
        const r = await applyModelChange(
          session,
          { provider: data?.provider, model: data?.model, effort: data?.effort },
          { persist: Boolean(data?.persist) },
        );
        for (const message of r.notices) {
          bus.publish('transcript', { type: 'warning', message, origin: 'web' });
        }
        bus.publish('transcript', {
          type: 'notice',
          message: `model → ${r.model.id} (${r.provider}, effort ${r.effort})`,
          origin: 'web',
        });
        bus.publish('session-changed', null);
        json(res, { ok: true, provider: r.provider, model: r.model.id, effort: r.effort });
      } catch (e) {
        json(res, { error: e.message }, 400);
      }
    });
  }

  /**
   * Switch which provider block in $DAVAI_HOME/.env is live.
   *
   * A write and a reconfigure from one HTTP request, so it is behind the same mandatory
   * token as everything else. It is safe to get wrong in the way that matters: the
   * switch only comments and uncomments, so the failure mode is a session pointed at a
   * provider you did not want, not a key you can no longer recover. `block: null`
   * disables every block, which is how you fall back to the settings above them.
   */
  function postEnv(req, res) {
    body(req, async (err, data) => {
      if (err) return json(res, { error: err.message }, 400);
      try {
        // `var` picks between several assignments of one name inside a block — the four
        // candidate OpenRouter models, say — and makes that block live. Without it the
        // browser could switch blocks but not choose within one.
        if (data?.var) {
          const c = await chooseProfileVar(session, {
            block: data.block,
            name: data.var,
            line: data.line,
            value: data.value,
          });
          for (const message of c.notices) {
            bus.publish('transcript', { type: 'warning', message, origin: 'web' });
          }
          bus.publish('transcript', {
            type: 'notice',
            message: `.env ${c.block} · ${c.name}=${c.value} (${c.provider}, ${c.model})`,
            origin: 'web',
          });
          bus.publish('session-changed', null);
          return json(res, { ok: true, ...c, ...profileState(session.cfg) });
        }
        const r = await switchProfile(session, data?.block ?? null);
        for (const message of r.notices) {
          bus.publish('transcript', { type: 'warning', message, origin: 'web' });
        }
        bus.publish('transcript', {
          type: 'notice',
          message: r.block
            ? `.env block → ${r.block} (${r.provider}, ${r.model}${r.baseURL ? ` at ${r.baseURL}` : ''})`
            : `.env blocks all disabled (${r.provider}, ${r.model})`,
          origin: 'web',
        });
        bus.publish('session-changed', null);
        json(res, { ok: true, ...r, ...profileState(session.cfg) });
      } catch (e) {
        json(res, { error: e.message }, 400);
      }
    });
  }

  /**
   * Set or clear a provider key.
   *
   * The request body carries a secret, which is the one place in this server where that
   * is true. Three consequences, all enforced here rather than left to the client:
   * the value is never echoed back (only `maskKey`'s description of it), it is never
   * written to the event stream — where it would be replayed to every attached browser
   * and sit in the SSE backlog — and the response says where it was stored.
   *
   * `persist` writes $DAVAI_HOME/.env. That is a genuine filesystem write triggered by
   * an HTTP request, which is why the sidecar's token is mandatory and the bind is
   * loopback by default.
   */
  function postKeys(req, res) {
    body(req, async (err, data) => {
      if (err) return json(res, { error: err.message }, 400);
      try {
        if (data?.clear) {
          const r = clearProviderKey(session, {
            provider: data.provider,
            persist: Boolean(data.persist),
          });
          bus.publish('transcript', {
            type: 'notice',
            message: `${r.provider} key cleared${r.persisted ? ' and removed from .env' : ' for this session'}`,
            origin: 'web',
          });
          bus.publish('session-changed', null);
          return json(res, { ok: true, providers: keyState(session.cfg) });
        }

        const r = await setProviderKey(session, {
          provider: data?.provider,
          key: data?.key,
          persist: Boolean(data?.persist),
          verify: data?.verify !== false,
        });
        for (const message of r.warnings) {
          bus.publish('transcript', { type: 'warning', message, origin: 'web' });
        }
        // The masked form is safe to broadcast; the key itself never reaches the bus.
        bus.publish('transcript', {
          type: 'notice',
          message:
            `${r.provider} key set (${r.masked})` +
            (r.persisted ? ` — saved to .env as ${r.varName}` : ' — this session only'),
          origin: 'web',
        });
        bus.publish('session-changed', null);
        json(res, {
          ok: true,
          provider: r.provider,
          masked: r.masked,
          persisted: r.persisted,
          varName: r.varName,
          providers: keyState(session.cfg),
        });
      } catch (e) {
        json(res, { error: e.message }, 400);
      }
    });
  }

  /** Metadata only. The bodies can be megabytes, and the list is rendered without them. */
  function artifacts() {
    const items = session.artifacts?.items || [];
    return {
      items: items.map((a) => ({
        n: a.n,
        lang: a.lang,
        lines: a.lines,
        bytes: a.bytes,
        createdAt: a.createdAt,
        name: suggestName(a),
        preview: a.text.split('\n').slice(0, 3).join('\n').slice(0, 300),
      })),
    };
  }

  /**
   * One artifact's body. `?download=1` sets Content-Disposition, which is the thing a
   * browser can do that a terminal cannot — the REPL's clipboard copy runs on the machine
   * davai is on, which is the wrong machine when you are reading this from a phone.
   */
  function getArtifact(url, res) {
    const n = Number(url.pathname.slice('/api/artifact/'.length));
    const item = session.artifacts?.get(n);
    if (!item) return json(res, { error: `no artifact #${n}` }, 404);
    if (url.searchParams.get('download') === '1') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        // The name is derived from the fence language, never from client input.
        'content-disposition': `attachment; filename="${suggestName(item)}"`,
      });
      return res.end(item.text);
    }
    json(res, { n: item.n, lang: item.lang, lines: item.lines, text: item.text });
  }

  /** Save to disk through the sandbox and journal, exactly as the REPL's pane does. */
  function postArtifactSave(req, res) {
    body(req, (err, data) => {
      if (err) return json(res, { error: err.message }, 400);
      try {
        const r = session.artifacts.save(Number(data?.n), String(data?.path || ''), {
          sandbox: session.sandbox,
          journal: session.journal,
        });
        bus.publish('transcript', {
          type: 'notice',
          message: `artifact #${data.n} → ${r.path}${r.overwrote ? ' (overwrote)' : ''}`,
          origin: 'web',
        });
        json(res, { ok: true, ...r });
      } catch (e) {
        // A path outside the write jail lands here: the operator's mistake, not a crash.
        json(res, { error: e.message }, 400);
      }
    });
  }

  function postSubmit(req, res) {
    body(req, (err, data) => {
      if (err) return json(res, { error: err.message }, 400);
      const text = String(data?.text || '').trim();
      if (!text) return json(res, { error: 'empty' }, 400);
      // Not awaited: a turn runs for minutes and the answer arrives over the event
      // stream. The POST only reports that the request was accepted.
      // A transcript line, not an 'error' event: this is the dispatcher refusing, not the
      // agent failing, and the transcript channel is the one both views already render.
      Promise.resolve(submit(text)).catch((e) =>
        bus.publish('transcript', { type: 'error', message: e.message, origin: 'web' }),
      );
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
      // /favicon.ico is what a browser asks for unprompted; both names serve the SVG.
      const rel =
        pathname === '/'
          ? 'index.html'
          : pathname === '/favicon.ico' || pathname === '/favicon.svg'
            ? 'favicon.svg'
            : pathname.replace(/^\/assets\//, '');
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
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        // The client bundle is the live source; serving it with cache headers lets a
        // stale copy hide a fix.
        'cache-control': 'no-cache, no-transform',
      });
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
      // 0.0.0.0 means "every interface", and pasting it into a browser reaches nothing.
      // Print a LAN address instead, since the banner's URL is meant to be typed.
      let h = host;
      if (isLoopback(host)) h = 'localhost';
      else if (host === '0.0.0.0' || host === '::') {
        const nets = Object.values(os.networkInterfaces()).flat();
        h = nets.find((i) => i && i.family === 'IPv4' && !i.internal)?.address || 'localhost';
      }
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