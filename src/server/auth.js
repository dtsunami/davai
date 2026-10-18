/**
 * Access control for the web sidecar.
 *
 * The sidecar can approve shell commands, so anything that reaches the port gets a shell
 * as the operator. Three rules, none of them clever:
 *
 *   1. Loopback by default. Remote access is a tunnel's job (ssh -L, Tailscale), not
 *      this file's. Binding elsewhere requires saying so explicitly.
 *   2. A token on every request, compared in constant time.
 *   3. Yolo plus a non-loopback bind is refused outright. Yolo makes the approval pane a
 *      no-op, so that combination is an unauthenticated remote shell with extra steps.
 */
import crypto from 'node:crypto';

/** 160 bits, url-safe: it has to survive being pasted into a phone browser. */
export function makeToken() {
  return crypto.randomBytes(20).toString('base64url');
}

/** Timing-safe compare that tolerates length mismatch without leaking it. */
export function tokenMatches(expected, given) {
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) {
    // Still do the work, so a wrong-length guess costs the same as a wrong-value one.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host) {
  return LOOPBACK.has(host);
}

/**
 * @param {{host: string, yolo: boolean}} opts
 * @throws if the combination is one we refuse to serve
 */
export function assertSafeBind({ host, yolo }) {
  if (!isLoopback(host) && yolo) {
    throw new Error(
      `refusing to serve ${host} with yolo on: yolo auto-approves shell commands, so a ` +
        `reachable port would be an unauthenticated remote shell.\n` +
        `  Use the default loopback bind and forward it:  ssh -L 7878:localhost:7878 ${process.env.USER || 'you'}@host`,
    );
  }
}

/**
 * Pull the token from a request. The header is the real mechanism; the query parameter
 * exists because EventSource cannot set headers, and is therefore accepted only there.
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url
 * @param {{allowQuery?: boolean}} [opts]
 */
export function readToken(req, url, { allowQuery = false } = {}) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (allowQuery) return url.searchParams.get('token') || '';
  return '';
}