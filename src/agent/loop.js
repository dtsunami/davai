/**
 * The harness (req 8, 11). Hand-rolled: no agent framework.
 *
 *   stream a turn -> scan for fenced blocks -> execute ops -> feed results back
 *
 * The loop owns all state. The UI is a view over it, which is what makes headless
 * mode free and the whole thing testable without a terminal.
 */
import { EventEmitter } from 'node:events';
import { extract } from './parser.js';
import { normalizeBatch } from './ops/schema.js';
import { executeBatch, formatResults } from './ops/executor.js';
import { DEFAULT_PROMPTS, opsResultPrompt, repairPrompt, steerPrompt } from './prompt.js';
import { compact } from '../context/compact.js';
import { costOf } from '../config/models.js';

const MAX_REPAIRS = 2;
const MAX_STEPS = 60;
const MAX_NUDGES = 2;
const MAX_PROVIDER_RETRIES = 2;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;

/**
 * First-person intent phrasing. A turn that ends on one of these and carries no ops is
 * an announcement, not an answer.
 */
const INTENT =
  /\b(?:i'?ll|i will|i'?m going to|i am going to|let me|let'?s|first,? i|next,? i|now i'?ll)\b/i;

/**
 * Every event the harness emits.
 *
 * A list in code rather than a comment because the comment version rotted: `nudge`,
 * `thinking` and `retry` were all emitted for a while with nothing listening, and the
 * docstring said so without anything checking. test/events.test.js holds this against the
 * front ends, so an event added here with no consumer fails the suite instead of going
 * quietly nowhere.
 */
export const EVENTS = [
  'turn-start',
  'thinking',
  'text',
  'turn-end',
  'usage',
  'ops-parsed',
  'ops-result',
  'artifact',
  'approval-request',
  'compact-start',
  'compact-done',
  'nudge',
  'retry',
  'steer-queued',
  'steered',
  'repair',
  'warning',
  'cancelled',
  'error',
  'done',
];
export class Agent extends EventEmitter {
  /**
   * @param {{cfg: object, provider: object, makeProvider: Function, ledger: object,
   *          sandbox: object, journal: object, artifacts: object, log: object}} deps
   */
  constructor(deps) {
    super();
    Object.assign(this, deps);
    // Resolved once by loadConfig; DEFAULT_PROMPTS keeps the agent constructible from
    // a bare cfg, as the tests do.
    this.prompts = deps.cfg?.prompts || DEFAULT_PROMPTS;
    this.busy = false;
    this.controller = null;
    // nudges/nudgesWasted measure the stalled() heuristic: a nudge that produced ops was
    // a real stall caught, one that produced another bare conclusion was a false
    // positive and cost a turn. The rule is English-only regex matching, so the only
    // honest way to know whether it earns its keep is to count.
    this.stats = { turns: 0, ops: 0, cost: 0, malformed: 0, nudges: 0, nudgesWasted: 0 };
    /** Operator text typed mid-run, applied at the next step boundary. */
    this.steers = [];
    /** How many of each event was emitted, and how many went nowhere. */
    this.eventCounts = {};
    this.unretiredEvents = {};
    this.unknownEvents = {};
    this.strictEvents = Boolean(deps.cfg?.strictEvents);
  }

  /** Event names that fired with nothing listening — the half-wired ones. */
  pendingEvents() {
    return Object.entries(this.unretiredEvents)
      .map(([name, count]) => ({ name, count, declared: EVENTS.includes(name) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  /**
   * Count every event, and whether anything was listening when it fired.
   *
   * The recurring bug in this codebase has been the half-wired event: emitted, documented,
   * consumed by nobody, and silent because an emit with no listeners is not an error. An
   * unknown name is tracked separately because a typo'd emit fails the same silent way.
   */
  emit(name, ...args) {
    this.eventCounts[name] = (this.eventCounts[name] || 0) + 1;
    if (!EVENTS.includes(name)) {
      this.unknownEvents[name] = (this.unknownEvents[name] || 0) + 1;
    }

    if (this.listenerCount(name) === 0) {
      const first = !this.unretiredEvents[name];
      this.unretiredEvents[name] = (this.unretiredEvents[name] || 0) + 1;
      if (first) {
        // Once per name, not per emission: a pending 'text' would otherwise write a line
        // per token. The transcript is the durable record — grep it across sessions.
        this.log?.event?.('unretired-emit', { name, declared: EVENTS.includes(name) });
        if (this.strictEvents) {
          // Opt-in development aid. Thrown from inside run()'s try, so it surfaces as a
          // normal error rather than taking the process down.
          throw new Error(
            `event "${name}" was emitted with no listener (DAVAI_STRICT_EVENTS is on)`,
          );
        }
      }
    }
    return super.emit(name, ...args);
  }

  /** Emitted-vs-retired, for /events. Declared events that never fired are included. */
  eventSummary() {
    const names = [...new Set([...EVENTS, ...Object.keys(this.eventCounts)])];
    return names
      .map((name) => ({
        name,
        emitted: this.eventCounts[name] || 0,
        unretired: this.unretiredEvents[name] || 0,
        declared: EVENTS.includes(name),
      }))
      .sort((a, b) => b.emitted - a.emitted || a.name.localeCompare(b.name));
  }

  cancel() {
    this.controller?.abort();
  }

  /**
   * Queue a correction from the operator while a run is in flight.
   *
   * Applied at the next step boundary rather than interrupting the request in progress:
   * aborting mid-stream would throw away tokens already paid for, and the model cannot
   * act on anything until it is between turns anyway. When no run is in flight the
   * caller should submit normally — there is nothing to steer.
   *
   * @returns {boolean} true if it was queued
   */
  steer(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || !this.busy) return false;
    this.steers.push(trimmed);
    this.emit('steer-queued', { text: trimmed, queued: this.steers.length });
    return true;
  }

  /** Move any queued steers into context. @returns {number} how many were applied */
  #applySteers() {
    if (!this.steers.length) return 0;
    const pending = this.steers.splice(0, this.steers.length);
    for (const text of pending) {
      this.ledger.add({
        type: 'user',
        label: `steer: ${firstLine(text)}`,
        role: 'user',
        text: steerPrompt(text, this.prompts),
      });
      this.log.event('steer', { text });
    }
    this.emit('steered', { applied: pending.length, texts: pending });
    return pending.length;
  }

  /**
   * Run one operator request to completion.
   * @param {string} input
   */
  async run(input) {
    if (this.busy) throw new Error('agent is already running');
    this.busy = true;
    this.controller = new AbortController();

    try {
      if (input) {
        this.ledger.add({ type: 'user', label: firstLine(input), role: 'user', text: input });
        this.log.event('user', { text: input });
      }

      let repairs = 0;
      let nudges = 0;
      let nudgedAt = -1;

      for (let step = 0; step < MAX_STEPS; step++) {
        if (this.controller.signal.aborted) {
          this.emit('cancelled');
          return;
        }

        // Before the request, so a correction typed during the last turn shapes this one.
        this.#applySteers();

        if (this.ledger.shouldCompact) await this.#compact();

        const turn = await this.#streamTurn();
        if (turn.cancelled) {
          this.emit('cancelled');
          return;
        }

        const { ops, parseError, artifacts, prose } = extract(turn.text);

        for (const block of artifacts) {
          const item = this.artifacts.add(block);
          this.emit('artifact', item);
          this.log.event('artifact', { n: item.n, lang: item.lang, lines: item.lines });
        }

        // The assistant turn goes into context verbatim: the model needs to see its
        // own ops to reason about the results that follow.
        this.ledger.add({
          type: 'assistant',
          label: firstLine(prose || turn.text) || 'assistant turn',
          role: 'assistant',
          text: turn.text,
        });

        if (parseError) {
          this.stats.malformed++;
          this.log.event('parse-error', { error: parseError, repairs });
          if (repairs++ >= MAX_REPAIRS) {
            this.emit('error', {
              message: `The model produced an unparseable da_ops block ${repairs} times. Giving up on this request.`,
              detail: parseError,
            });
            return;
          }
          this.emit('repair', { error: parseError, attempt: repairs });
          this.ledger.add({
            type: 'op-result',
            label: 'parse error',
            role: 'user',
            text: repairPrompt(parseError, this.prompts),
          });
          continue;
        }

        repairs = 0;

        if (!ops) {
          // No ops: either the work is done, or the model announced an intention and
          // ended the turn without acting on it. The second case is a stall — some
          // models expect a tool-call round trip and stop after saying what they mean
          // to do — and treating it as a conclusion silently drops the request.
          // A steer that lands as the model is wrapping up should keep the loop alive;
          // otherwise the correction would be answered only on the next request.
          if (!stalled(prose)) {
            // Reached a conclusion immediately after a nudge: the previous turn was a
            // conclusion too, and stalled() misread it.
            // The >= 0 guard matters: on step 0 the -1 sentinel would equal step - 1.
            if (nudgedAt >= 0 && nudgedAt === step - 1) {
              this.stats.nudgesWasted++;
              this.log.event('nudge-wasted', { prose: firstLine(prose) });
            }
            if (this.steers.length) continue;
            this.emit('done', { prose });
            return;
          }
          if (nudges++ < MAX_NUDGES) {
            this.stats.nudges++;
            nudgedAt = step;
            this.emit('nudge', { attempt: nudges, prose });
            this.ledger.add({
              type: 'op-result',
              label: 'nudge',
              role: 'user',
              text: this.prompts.nudge,
            });
            continue;
          }
          // Reminding it is not working. Stop rather than spend the rest of MAX_STEPS
          // watching it promise.
          this.emit('warning', {
            message: `The model said it would act but emitted no ops after ${MAX_NUDGES} reminders. Stopping.`,
          });
          this.emit('done', { prose });
          return;
        }

        const outcome = await this.#executeOps(ops);
        if (outcome === 'cancelled') {
          this.emit('cancelled');
          return;
        }
        nudgedAt = -1;
        nudges = 0; // real progress: the next stall gets a fresh budget
      }

      this.emit('error', {
        message: `Stopped after ${MAX_STEPS} steps without a conclusion. The model may be looping.`,
      });
    } catch (err) {
      if (err?.cancelled) this.emit('cancelled');
      else this.emit('error', { message: err.message, detail: err.stack });
      this.log.event('error', { message: err.message });
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }

  async #streamTurn() {
    this.emit('turn-start');
    this.stats.turns++;

    const messages = this.ledger.toMessages();
    let text = '';
    let usage = null;
    let stop = null;

    for (let attempt = 0; ; attempt++) {
      try {
        for await (const ev of this.provider.send({
          system: this.ledger.system,
          messages,
          signal: this.controller.signal,
        })) {
          switch (ev.t) {
            case 'text':
              text += ev.delta;
              this.emit('text', ev.delta);
              break;
            case 'thinking':
              this.emit('thinking', ev.delta);
              break;
            case 'usage':
              usage = ev;
              break;
            case 'stop':
              stop = ev;
              break;
          }
        }
        break;
      } catch (err) {
        if (err?.cancelled) return { cancelled: true, text };
        // Retry only a transient failure that produced nothing: re-sending after the
        // model has already streamed half an answer would duplicate it. A 429 with
        // "limit: 0" is marked unretryable upstream precisely so it lands here.
        if (!err?.retryable || text || attempt >= MAX_PROVIDER_RETRIES) throw err;

        const waitMs = Math.min(err.retryAfterMs || RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
        this.emit('retry', {
          attempt: attempt + 1,
          of: MAX_PROVIDER_RETRIES,
          waitMs,
          message: err.message,
        });
        this.log.event('provider-retry', { attempt: attempt + 1, waitMs, message: err.message });
        if (!(await this.#wait(waitMs))) return { cancelled: true, text };
      }
    }

    if (usage) {
      const cost = costOf(this.cfg.model, usage);
      // Pricing is unknown for models not in the seed table; track that rather than
      // reporting a confidently wrong dollar figure.
      if (cost == null) this.stats.costUnknown = true;
      else this.stats.cost += cost;
      this.ledger.reconcile(usage.in + (usage.cacheRead || 0) + (usage.cacheWrite || 0));
      this.log.addUsage(usage, cost);
      this.emit('usage', { ...usage, cost, total: this.stats.cost });
    }

    if (stop?.reason === 'refusal') {
      this.emit('error', { message: `The model declined: ${stop.detail || 'no reason given'}` });
      return { cancelled: true, text };
    }
    if (stop?.reason === 'max_tokens') {
      this.emit('warning', {
        message: 'Response hit max_tokens and was truncated. Raise DAVAI_MAX_TOKENS if this recurs.',
      });
    }

    this.emit('turn-end', { text });
    this.log.event('assistant', { text, usage, stop: stop?.reason });
    return { text, usage, stop };
  }

  async #executeOps(rawOps) {
    const { ops, errors } = normalizeBatch(rawOps);

    if (errors.length) {
      // Schema errors never reach the filesystem.
      const outcome = { status: 'plan-failed', results: [], errors };
      this.emit('ops-result', { outcome, ops: [] });
      this.log.event('ops-rejected', { errors });
      this.ledger.add({
        type: 'op-result',
        label: `batch rejected (${errors.length} error${errors.length > 1 ? 's' : ''})`,
        role: 'user',
        text: opsResultPrompt(formatResults(outcome), this.prompts),
      });
      return outcome.status;
    }

    this.emit('ops-parsed', ops);
    this.log.event('ops', { ops: ops.map((o) => ({ ...o, text: undefined, new: undefined })) });

    const outcome = await executeBatch(ops, {
      sandbox: this.sandbox,
      journal: this.journal,
      shellTimeout: this.cfg.shellTimeout,
      signal: this.controller.signal,
      approve: (op, index) => this.#requestApproval(op, index),
    });

    this.stats.ops += ops.length;
    this.log.addOps(ops.length);
    this.emit('ops-result', { outcome, ops });

    const label =
      outcome.status === 'ok'
        ? `${ops.length} op${ops.length > 1 ? 's' : ''} ok`
        : `batch ${outcome.status}`;
    const text = opsResultPrompt(formatResults(outcome), this.prompts);

    // label and text are logged verbatim so --resume can rebuild this segment
    // exactly, rather than re-deriving it from per-op status.
    this.log.event('ops-result', {
      status: outcome.status,
      errors: outcome.errors,
      results: outcome.results.map((r) => ({ index: r.index, op: r.op, ok: r.ok })),
      label,
      text,
    });

    this.ledger.add({
      type: 'op-result',
      label,
      role: 'user',
      text,
    });

    if (this.controller.signal.aborted) return 'cancelled';
    return outcome.status;
  }

  /** Sleep, unless the operator cancels first. @returns {Promise<boolean>} false if cancelled */
  #wait(ms) {
    return new Promise((resolve) => {
      const signal = this.controller.signal;
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** The UI answers this; headless mode supplies its own policy. */
  #requestApproval(op, index) {
    return new Promise((resolve) => {
      this.emit('approval-request', { op, index, respond: resolve });
    });
  }

  async #compact() {
    this.emit('compact-start', { tokens: this.ledger.tokens, limit: this.ledger.limit });
    try {
      const result = await compact(this.ledger, {
        cfg: this.cfg,
        makeProvider: this.makeProvider,
        onEvent: (e) => this.emit('warning', e),
      });
      this.emit('compact-done', result);
      this.log.event('compact', result);
    } catch (err) {
      this.emit('warning', { message: `auto-compact failed: ${err.message}` });
    }
  }
}

function firstLine(text) {
  if (!text) return '';
  const line = text.trim().split('\n')[0];
  return line.length > 70 ? line.slice(0, 67) + '…' : line;
}

/**
 * A turn with prose and no ops is usually a conclusion. The exception is a turn that
 * trails off mid-thought, which the nudge catches.
 */
/**
 * Did a turn with no ops stall rather than conclude?
 *
 * The last sentence decides. A stall ends on the promise ("I'll read the config and
 * fix the timeout"), while a report of finished work ends on a fact, even when it
 * opened with "I'll explain what changed". Splitting on sentence enders is crude, but
 * the alternative — asking a second model whether the turn concluded — costs a call
 * per turn to catch a case a reminder already fixes.
 *
 * Erring either way is cheap: a false positive spends one extra turn, and a miss
 * leaves today's behaviour, where the request is silently dropped.
 */
function stalled(prose) {
  const text = (prose || '').trim();
  if (!text) return true;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
  return INTENT.test(sentences.at(-1) || text);
}
