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
import { NUDGE, repairPrompt } from './prompt.js';
import { compact } from '../context/compact.js';
import { costOf } from '../config/models.js';

const MAX_REPAIRS = 2;
const MAX_STEPS = 60;
const MAX_NUDGES = 2;

/**
 * First-person intent phrasing. A turn that ends on one of these and carries no ops is
 * an announcement, not an answer.
 */
const INTENT =
  /\b(?:i'?ll|i will|i'?m going to|i am going to|let me|let'?s|first,? i|next,? i|now i'?ll)\b/i;

/**
 * Events emitted:
 *   turn-start, thinking, text, turn-end, usage,
 *   ops-parsed, ops-result, artifact, approval-request,
 *   compact-start, compact-done, nudge, error, done
 */
export class Agent extends EventEmitter {
  /**
   * @param {{cfg: object, provider: object, makeProvider: Function, ledger: object,
   *          sandbox: object, journal: object, artifacts: object, log: object}} deps
   */
  constructor(deps) {
    super();
    Object.assign(this, deps);
    this.busy = false;
    this.controller = null;
    this.stats = { turns: 0, ops: 0, cost: 0, malformed: 0 };
  }

  cancel() {
    this.controller?.abort();
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

      for (let step = 0; step < MAX_STEPS; step++) {
        if (this.controller.signal.aborted) {
          this.emit('cancelled');
          return;
        }

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
            text: repairPrompt(parseError),
          });
          continue;
        }

        repairs = 0;

        if (!ops) {
          // No ops: either the work is done, or the model announced an intention and
          // ended the turn without acting on it. The second case is a stall — some
          // models expect a tool-call round trip and stop after saying what they mean
          // to do — and treating it as a conclusion silently drops the request.
          if (!stalled(prose)) {
            this.emit('done', { prose });
            return;
          }
          if (nudges++ < MAX_NUDGES) {
            this.emit('nudge', { attempt: nudges, prose });
            this.ledger.add({ type: 'op-result', label: 'nudge', role: 'user', text: NUDGE });
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
    } catch (err) {
      if (err?.cancelled) return { cancelled: true, text };
      throw err;
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
        text: formatResults(outcome, []),
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
    const text = formatResults(outcome, ops);

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
