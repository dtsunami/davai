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
import { describeNative, nativeCallPrompt, resolveNativeCalls, salvageNote } from './native.js';
import { compact } from '../context/compact.js';
import { costOf, isPriceEstimated } from '../config/models.js';

const MAX_REPAIRS = 2;
const MAX_STEPS = 60;
const MAX_NUDGES = 2;
/** Empty turns tolerated in a row before the run is stopped. */
const MAX_EMPTY = 2;
const MAX_PROVIDER_RETRIES = 2;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;
/**
 * One step down the effort ladder, for a turn that reasoned its whole budget away.
 * Caveat: the OpenAI-shaped adapters collapse both xhigh and max onto "high"
 * (providers/base.js), so from max the first step is invisible there and only the second
 * one bites. Worth knowing, not worth special-casing — the default effort is "high",
 * where the first step is real on every provider.
 */
const LOWER_EFFORT = { max: 'high', xhigh: 'high', high: 'medium', medium: 'low', low: null };
const MAX_EFFORT_DEMOTIONS = 2;

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
    // nativeCalls counts every native tool call a model made; nativeSalvaged, the turns
    // whose calls ran as a da_ops batch. Together they say how much a model leans on it.
    this.stats = {
      turns: 0,
      ops: 0,
      cost: 0,
      malformed: 0,
      nudges: 0,
      nudgesWasted: 0,
      nativeCalls: 0,
      nativeSalvaged: 0,
      effortDemotions: 0,
    };
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
      let empties = 0;

      for (let step = 0; step < MAX_STEPS; step++) {
        if (this.controller.signal.aborted) {
          this.emit('cancelled');
          return;
        }

        // Before the request, so a correction typed during the last turn shapes this one.
        this.#applySteers();

        if (this.#overBudget()) return;

        if (this.ledger.shouldCompact) await this.#compact();

        const turn = await this.#streamTurn();
        if (turn.cancelled) {
          this.emit('cancelled');
          return;
        }

        // An empty assistant turn (typically max_tokens spent entirely on thinking) must
        // never reach the ledger. Anthropic rejects an empty text block with a 400, and
        // that one bad segment then failed every later request in the session. Store a
        // placeholder instead, and tell the model what happened so it can change course.
        // A turn whose only output is a native tool call is not empty: the call may be
        // the whole batch, with no text around it.
        if (!(turn.text || '').trim() && !turn.toolCalls?.length) {
          const reason = turn.stop?.reason || 'unknown';
          // The turn produced nothing usable, but it was not necessarily idle: a model
          // that spends its whole budget reasoning (Mistral, routinely) streams tens of
          // thousands of characters and then stops. That output is the only evidence of
          // what it was trying to do, so say how much there was and where to read it.
          const thought = (turn.thinking || '').length;
          this.log.event('empty-turn', {
            reason,
            inARow: empties + 1,
            turn: this.stats.turns,
            thinkingChars: thought,
          });
          if (empties++ >= MAX_EMPTY) {
            this.emit('error', {
              message:
                `The model returned ${empties} empty turns in a row (stop: ${reason}). Stopping. ` +
                (reason === 'max_tokens'
                  ? 'Raise DAVAI_MAX_TOKENS or ask for a smaller step.'
                  : 'Try a narrower request.') +
                thinkingNote(thought, this.stats.turns),
            });
            return;
          }
          this.emit('warning', {
            message:
              `empty turn from the model (stop: ${reason}) — told it why and asked for a smaller step` +
              thinkingNote(thought, this.stats.turns),
          });
          this.ledger.add({ type: 'assistant', label: 'empty turn', role: 'assistant', text: '(no output)' });
          this.ledger.add({
            type: 'op-result',
            label: 'empty turn',
            role: 'user',
            text: emptyTurnPrompt(reason, this.cfg.maxTokens, thought),
          });
          continue;
        }
        empties = 0;

        const fenced = extract(turn.text);
        const { artifacts, prose } = fenced;
        // Native tool calls are read as da_ops only when the reply has no fenced block
        // of its own: the fenced block is the protocol, and wins.
        const native = this.#resolveNative(turn, fenced);
        const ops = fenced.ops || native.ops;
        const parseError = fenced.parseError || native.parseError;

        for (const block of artifacts) {
          const item = this.artifacts.add(block);
          this.emit('artifact', item);
          this.log.event('artifact', { n: item.n, lang: item.lang, lines: item.lines });
        }

        // The assistant turn goes into context verbatim: the model needs to see its
        // own ops to reason about the results that follow. A batch that arrived as a
        // native call is not in the text, so its fenced equivalent is appended: the
        // model then sees both the request its results answer and the form to use.
        this.ledger.add({
          type: 'assistant',
          label:
            firstLine(prose || turn.text) || (native.block ? 'native da_ops call' : 'assistant turn'),
          role: 'assistant',
          text: assistantText(turn.text, native),
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
          // A native call davai could not map is the model trying to act through an
          // interface it does not have. Taking the prose as a conclusion would drop the
          // request, as it did on Mistral's first orata turns, so it is answered like a
          // stall, with a reminder that names the call.
          const strayCalls = native.unusable;
          if (!strayCalls.length && !stalled(prose)) {
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
            this.emit('nudge', { attempt: nudges, prose, nativeCalls: strayCalls });
            this.ledger.add({
              type: 'op-result',
              label: strayCalls.length ? 'native call ignored' : 'nudge',
              role: 'user',
              text: strayCalls.length ? nativeCallPrompt(strayCalls) : this.prompts.nudge,
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

        const outcome = await this.#executeOps(
          ops,
          native.ops ? salvageNote(native.unusable) : '',
        );
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

  /**
   * Enforce DAVAI_MAX_COST at each step boundary: the request in flight is already paid
   * for, so stopping before the next one is the earliest useful point. Warns once at
   * 80%. On a model with no seed pricing the cap runs against FALLBACK_PRICE, and the
   * messages say the figure is an estimate.
   * @returns {boolean} true when the cap is reached and the run should stop
   */
  #overBudget() {
    const cap = this.cfg?.maxCost;
    if (!cap) return false;
    const est = this.stats.costEstimated
      ? ' — estimated, this model has no pricing data'
      : '';
    if (this.stats.cost >= cap) {
      this.emit('error', {
        message:
          `Spend cap reached: $${this.stats.cost.toFixed(2)} of $${cap.toFixed(2)} this session${est} ` +
          `(DAVAI_MAX_COST). Raise it and resume the session to continue.`,
      });
      this.log.event('spend-cap', {
        cost: this.stats.cost,
        cap,
        estimated: Boolean(this.stats.costEstimated),
      });
      return true;
    }
    if (!this.budgetWarned && this.stats.cost >= cap * 0.8) {
      this.budgetWarned = true;
      this.emit('warning', {
        message: `Spent $${this.stats.cost.toFixed(2)} of the $${cap.toFixed(2)} session cap${est}.`,
      });
    }
    return false;
  }

  async #streamTurn() {
    this.emit('turn-start');
    this.stats.turns++;

    const messages = this.ledger.toMessages();
    let provider = this.provider;
    let effort = this.cfg.effort;
    let attemptBase = 0;

    for (let demotion = 0; ; demotion++) {
      const turn = await this.#streamOnce(provider, messages, attemptBase);
      attemptBase += turn.attempts || 1;
      if (turn.cancelled) return turn;

      const { text, thinking, usage, stop, toolCalls } = turn;
      // Billed whatever happens next: a demoted retry pays for both attempts.
      if (usage) this.#accountUsage(usage);

      if (stop?.reason === 'refusal') {
        this.emit('error', { message: `The model declined: ${stop.detail || 'no reason given'}` });
        return { cancelled: true, text };
      }

      // A turn that spent its whole output budget reasoning cannot hold an answer — the
      // model never began writing one. Session ed7f36618e did this twice in a row at effort
      // "high", 16,000 output tokens each, and the thinking says why: it was re-deciding a
      // fact it could not recall ("chan_pipewire was added in Asterisk 22? Let me think.")
      // rather than reading the machine it was running on. Letting the empty turn through
      // costs another full request to say "that produced nothing, try again", which tends
      // to blow up the same way. Re-asking at lower effort is the cheaper correction, and
      // it keeps the reasoning out of context, where it would only re-prime the loop.
      const nextEffort = LOWER_EFFORT[effort];
      if (
        stop?.reason === 'max_tokens' &&
        !text.trim() &&
        !toolCalls.length &&
        nextEffort &&
        demotion < MAX_EFFORT_DEMOTIONS
      ) {
        this.stats.effortDemotions++;
        this.log.event('effort-demoted', {
          turn: this.stats.turns,
          from: effort,
          to: nextEffort,
          thinkingChars: thinking.length,
          out: usage?.out ?? null,
        });
        this.emit('warning', {
          message:
            'the whole output budget went to reasoning and no answer was written' +
            (thinking.length ? ` (${thinking.length.toLocaleString()} chars)` : '') +
            ` — retrying this turn at effort ${nextEffort}`,
        });
        effort = nextEffort;
        provider = this.makeProvider(this.cfg.model.id, { effort });
        continue;
      }

      // Only the truncated-text case is warned about here. A max_tokens turn with no text
      // at all is handled in run(), which knows how many empties came before it and says
      // more; warning twice about one turn would just be noise.
      if (stop?.reason === 'max_tokens' && text.trim()) {
        this.emit('warning', {
          message:
            'Response hit max_tokens and was truncated. Raise DAVAI_MAX_TOKENS if this recurs.',
        });
      }

      this.emit('turn-end', { text });
      // Thinking is logged but never replayed: resume reads only `text` (session/resume.js).
      this.log.event('assistant', {
        text,
        ...(thinking ? { thinking } : {}),
        usage,
        stop: stop?.reason,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(demotion ? { effort, demotions: demotion } : {}),
      });
      return { text, thinking, usage, stop, toolCalls };
    }
  }

  /** Feed one request's usage to stats, the ledger calibrator and the log. */
  #accountUsage(usage) {
    const cost = costOf(this.cfg.model, usage);
    // Models with no seed pricing are costed at FALLBACK_PRICE. Flag it so every
    // display can mark the figure as an estimate.
    const estimated = isPriceEstimated(this.cfg.model);
    if (estimated) this.stats.costEstimated = true;
    this.stats.cost += cost;
    this.ledger.reconcile(usage.in + (usage.cacheRead || 0) + (usage.cacheWrite || 0));
    this.log.addUsage(usage, cost, estimated);
    this.emit('usage', { ...usage, cost, estimated, total: this.stats.cost });
  }

  /**
   * One request, with transient-failure retries. Reports how many attempts it took, so
   * a demotion can keep stream.jsonl attempt numbers monotonic across both requests.
   */
  async #streamOnce(provider, messages, attemptBase = 0) {
    let text = '';
    let thinking = '';
    let usage = null;
    let stop = null;
    /** @type {{id?: string, name: string, args: string}[]} */
    let toolCalls = [];

    // Declared outside the loop so the attempt count survives the break and can be
    // reported to #streamTurn, which numbers a demoted retry's stream records after it.
    let attempt = 0;
    for (; ; attempt++) {
      // Opened before the request: from here on, everything streamed reaches disk as it
      // arrives rather than at turn end (session/stream.js).
      this.log.stream?.begin(this.stats.turns, attemptBase + attempt);
      try {
        for await (const ev of provider.send({
          system: this.ledger.system,
          messages,
          signal: this.controller.signal,
        })) {
          switch (ev.t) {
            case 'text':
              text += ev.delta;
              this.log.stream?.write('text', ev.delta);
              this.emit('text', ev.delta);
              break;
            case 'thinking':
              thinking += ev.delta;
              this.log.stream?.write('thinking', ev.delta);
              this.emit('thinking', ev.delta);
              break;
            case 'usage':
              usage = ev;
              break;
            case 'tool_calls':
              toolCalls = ev.calls || [];
              break;
            case 'stop':
              stop = ev;
              break;
          }
        }
        break;
      } catch (err) {
        // Close the stream record first: it holds the deltas themselves, and every path
        // out of this catch either returns, throws or retries.
        this.log.stream?.end({
          status: err?.cancelled ? 'cancelled' : 'error',
          ...(err?.message ? { error: err.message } : {}),
        });
        // Whatever streamed before the failure is otherwise lost: the assistant event
        // below is never reached, and the UI drops the partial turn on cancel.
        this.#logPartial(err?.cancelled ? 'cancelled' : 'error', text, thinking, err);
        if (err?.cancelled) return { cancelled: true, text, attempts: attempt + 1 };
        // Retry only a transient failure that produced nothing: re-sending after the
        // model has already streamed half an answer would duplicate it. A 429 with
        // "limit: 0" is marked unretryable upstream precisely so it lands here.
        if (!err?.retryable || text || attempt >= MAX_PROVIDER_RETRIES) throw err;
        // Already logged above; the retry streams a fresh turn.
        thinking = '';

        const waitMs = Math.min(err.retryAfterMs || RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
        this.emit('retry', {
          attempt: attempt + 1,
          of: MAX_PROVIDER_RETRIES,
          waitMs,
          message: err.message,
        });
        this.log.event('provider-retry', { attempt: attempt + 1, waitMs, message: err.message });
        if (!(await this.#wait(waitMs))) return { cancelled: true, text, attempts: attempt + 1 };
      }
    }

    this.log.stream?.end({ status: 'ok', ...(stop?.reason ? { stop: stop.reason } : {}) });
    // davai offers no tools, but some models call one anyway. The raw calls ride back with
    // the turn; #streamTurn logs them and run() decides what becomes of them (native.js).
    return { text, thinking, usage, stop, toolCalls, attempts: attempt + 1 };
  }

  /**
   * Record a turn that never completed. Its own event type rather than `assistant`:
   * resume replays `assistant` text into context, and a half-written turn does not
   * belong there. Without this, a cancelled turn left no trace of what the model
   * produced (session 9290eb08bb: ~100k chars of thinking, gone).
   */
  #logPartial(reason, text, thinking, err) {
    if (!text && !thinking) return;
    this.log.event('assistant-partial', {
      reason,
      text,
      ...(thinking ? { thinking } : {}),
      ...(reason === 'error' && err?.message ? { error: err.message } : {}),
    });
  }

  /**
   * Decide what becomes of the turn's native tool calls (agent/native.js) and record
   * it: each call's disposition goes to the transcript, with the fenced equivalent of
   * anything that ran, so --resume restores the request alongside its results.
   */
  #resolveNative(turn, fenced) {
    const native = resolveNativeCalls(turn.toolCalls, turn.text, {
      fenced: Boolean(fenced.ops || fenced.parseError),
    });
    if (!native.report.length) return native;
    this.stats.nativeCalls += native.report.length;
    if (native.ops) this.stats.nativeSalvaged++;
    this.log.event('native-calls', {
      stop: turn.stop?.reason,
      calls: native.report,
      ...(native.block ? { block: native.block } : {}),
    });
    this.emit('warning', { message: describeNative(native) });
    return native;
  }

  /** @param {string} [note] prefixed to the results, e.g. for a salvaged native call */
  async #executeOps(rawOps, note = '') {
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
        text: withNote(note, opsResultPrompt(formatResults(outcome), this.prompts)),
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
      approve: (op, index, extra) => this.#requestApproval(op, index, extra),
      sudo: this.sudo,
    });

    this.stats.ops += ops.length;
    this.log.addOps(ops.length);
    this.emit('ops-result', { outcome, ops });

    const label =
      outcome.status === 'ok'
        ? `${ops.length} op${ops.length > 1 ? 's' : ''} ok`
        : `batch ${outcome.status}`;
    const text = withNote(note, opsResultPrompt(formatResults(outcome), this.prompts));

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
  #requestApproval(op, index, extra) {
    return new Promise((resolve) => {
      this.emit('approval-request', { op, index, ...extra, respond: resolve });
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

/**
 * Point the operator at the streamed reasoning of a turn that produced nothing else.
 * The text is on disk either way (session/stream.js); without this nobody knows to look.
 */
function thinkingNote(chars, turn) {
  if (!chars) return '';
  return ` ${chars.toLocaleString()} chars of thinking were streamed — see /stream ${turn}.`;
}

/**
 * What the model is told after a turn that produced no visible text.
 *
 * The thinking-blowout case gets different advice from the rest. "Continue from where
 * you were, keep it small" invites more reasoning, which is the one thing that cannot
 * help a model that just reasoned its budget away — and the reasoning itself is not in
 * context, so there is no "where you were" for it to resume from. What the transcripts
 * show it doing instead is re-deriving facts about the machine it is sitting on, so the
 * useful instruction is to stop deducing and go and read.
 */
function emptyTurnPrompt(reason, maxTokens, thinkingChars = 0) {
  if (reason === 'max_tokens' && thinkingChars) {
    return (
      `Your previous turn spent its entire output budget (max_tokens ${maxTokens ?? 'unknown'}) ` +
      'on reasoning and wrote no reply, so nothing was executed and none of that reasoning ' +
      'is in this conversation.\n' +
      'Do not try to reconstruct it. Send one small da_ops batch that establishes the facts ' +
      'you were missing — read the file, list the directory, run the command that settles it. ' +
      'Anything about this machine or this codebase is cheaper to look up than to deduce.'
    );
  }
  const why =
    reason === 'max_tokens'
      ? `it hit the output limit (max_tokens ${maxTokens ?? 'unknown'}) before writing any ` +
        'text; the budget most likely went to thinking'
      : `stop reason: ${reason}`;
  return (
    `Your previous turn produced no visible output (${why}). Nothing was executed.\n` +
    'Continue from where you were, but keep this turn small: one modest da_ops batch or a ' +
    'short answer. Split large edits across several turns rather than planning them all at once.'
  );
}

/** The assistant text as context should hold it, given what its native calls became. */
function assistantText(text, native) {
  const body = (text || '').trim();
  if (native.block) return body ? `${text}\n\n${native.block}` : native.block;
  if (body) return text;
  // Never an empty segment (Anthropic rejects one): say what the turn consisted of.
  return `(no text; native tool call: ${native.report.map((r) => r.name).join(', ')})`;
}

/** Prefix an ops-result with a note, when there is one. */
function withNote(note, text) {
  return note ? `${note}\n\n${text}` : text;
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
