/**
 * The context ledger (req 12).
 *
 * Context is never an opaque message array. It is a list of typed, individually
 * addressable segments — which turns "granular context management and display" into
 * a table render rather than a feature.
 */
import { estimate, estimateImage, TokenCalibrator } from './tokens.js';

/** Segment types, in the order they appear in the prompt. */
export const TYPES = [
  'grounding',
  'user',
  'assistant',
  'op-result',
  'shell',
  'paste',
  'summary',
];

/** Types that are structural and must never be evicted or reordered. */
const PROTECTED = new Set(['grounding']);

let nextId = 1;

/**
 * @typedef {object} Segment
 * @property {number} id
 * @property {string} type
 * @property {string} label       short human-readable description
 * @property {'user'|'assistant'} role
 * @property {number} tokens
 * @property {boolean} pinned
 * @property {number} createdAt
 * @property {{type:'text',text:string}|{type:'image',mediaType:string,data:string}} part
 */

export class Ledger {
  /** @param {{limit: number, compactAt: number}} opts */
  constructor({ limit, compactAt = 0.75 }) {
    this.segments = [];
    this.limit = limit;
    this.compactAt = compactAt;
    this.systemTokens = 0;
    this.calibrator = new TokenCalibrator();
  }

  /** The system prompt is tracked separately: it is the cached prefix, never evicted. */
  setSystem(text) {
    this.system = text;
    this.systemTokens = estimate(text);
  }

  /**
   * @param {{type: string, label: string, role?: 'user'|'assistant', text?: string,
   *          image?: {mediaType: string, data: string}, pinned?: boolean}} spec
   * @returns {Segment}
   */
  add(spec) {
    const part = spec.image
      ? { type: 'image', mediaType: spec.image.mediaType, data: spec.image.data }
      : { type: 'text', text: spec.text ?? '' };
    const tokens = spec.image
      ? estimateImage(Buffer.byteLength(spec.image.data, 'base64'))
      : estimate(part.text);

    const seg = {
      id: nextId++,
      type: spec.type,
      label: spec.label,
      role: spec.role || (spec.type === 'assistant' ? 'assistant' : 'user'),
      tokens,
      pinned: spec.pinned ?? PROTECTED.has(spec.type),
      createdAt: Date.now(),
      part,
    };
    this.segments.push(seg);
    return seg;
  }

  get(id) {
    return this.segments.find((s) => s.id === Number(id));
  }

  drop(id) {
    const i = this.segments.findIndex((s) => s.id === Number(id));
    if (i === -1) return false;
    if (PROTECTED.has(this.segments[i].type)) return false;
    this.segments.splice(i, 1);
    return true;
  }

  pin(id, value = true) {
    const s = this.get(id);
    if (!s) return false;
    s.pinned = value;
    return true;
  }

  /** Total estimated tokens, calibrated against observed usage. */
  get tokens() {
    const raw = this.systemTokens + this.segments.reduce((n, s) => n + s.tokens, 0);
    return this.calibrator.apply(raw);
  }

  get usage() {
    return this.tokens / this.limit;
  }

  get shouldCompact() {
    return this.usage >= this.compactAt;
  }

  /** Feed the calibrator the provider's authoritative input-token count. */
  reconcile(actualInputTokens) {
    const raw = this.systemTokens + this.segments.reduce((n, s) => n + s.tokens, 0);
    this.calibrator.observe(raw, actualInputTokens);
  }

  /**
   * Render segments into provider-shaped messages.
   *
   * Consecutive segments with the same role collapse into one message, which keeps
   * the array small and avoids alternating-role complaints from strict providers.
   * @returns {{role: string, content: object[]}[]}
   */
  toMessages() {
    const out = [];
    for (const s of this.segments) {
      const last = out[out.length - 1];
      if (last && last.role === s.role) last.content.push(s.part);
      else out.push({ role: s.role, content: [s.part] });
    }
    // Every provider requires the conversation to open with a user turn.
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
  }

  /** Pareto breakdown for the context pane. */
  breakdown() {
    const total = this.tokens || 1;
    const rows = [
      {
        id: 0,
        type: 'system',
        label: 'system prompt + protocol',
        tokens: this.calibrator.apply(this.systemTokens),
        pinned: true,
      },
      ...this.segments.map((s) => ({
        id: s.id,
        type: s.type,
        label: s.label,
        tokens: this.calibrator.apply(s.tokens),
        pinned: s.pinned,
      })),
    ];
    return rows
      .map((r) => ({ ...r, pct: (r.tokens / total) * 100 }))
      .sort((a, b) => b.tokens - a.tokens);
  }
}
