import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, Static, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { Composer } from './Composer.jsx';
import { StatusBar } from './StatusBar.jsx';
import { ContextPane } from './ContextPane.jsx';
import { ModelPane } from './ModelPane.jsx';
import { KeyPane } from './KeyPane.jsx';
import { EnvPane } from './EnvPane.jsx';
import { ArtifactPane } from './ArtifactPane.jsx';
import { TxPane } from './TxPane.jsx';
import { ApprovalPane } from './ApprovalPane.jsx';
import { ThroughputPane } from './ThroughputPane.jsx';
import { PerfHud } from './PerfHud.jsx';
import { ThinkingBox } from './ThinkingBox.jsx';
import { renderMarkdown } from './markdown.js';
import {
  colors,
  glyphs,
  formatMeter,
  formatPreviewBlock,
  formatTokens,
  safeSlice,
  sanitizeTerminalLine,
  sanitizeTerminalText,
  truncateInline,
} from './theme.js';
import { ThroughputTracker, renderSparkline } from './throughput.js';
import { createDispatcher } from '../session/dispatch.js';

/** Throttle for streaming deltas: repaint at ~30fps, never per token. */
const FRAME_MS = 33;
/** The spinner's meter ticks once a second: it is a progress signal, not a stopwatch. */
const METER_MS = 1000;

let nextKey = 1;

export function App({ session, initialInput }) {
  const { agent, cfg, ledger, artifacts, log } = session;
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Committed transcript lives in <Static>, so Ink never re-renders scrollback.
  const [history, setHistory] = useState([]);
  const [live, setLive] = useState('');
  const [thinking, setThinking] = useState('');
  const [status, setStatus] = useState(null);
  // 'context' | 'model' | 'keys' | 'env' | 'artifacts' | 'tps'
  const [pane, setPane] = useState(null);
  const [approval, setApproval] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ turns: 0, ops: 0, cost: 0 });
  const [tick, setTick] = useState(0);
  const [exitArmed, setExitArmed] = useState(false);
  // The clock's start, or null when nothing is running. Counters are read from refs at
  // render time rather than copied into state, so they keep step with the streaming
  // repaint instead of lagging a second behind it.
  const [runStartedAt, setRunStartedAt] = useState(null);
  const [, tickMeter] = useState(0);

  const liveRef = useRef('');
  const frameRef = useRef(null);
  const thinkRef = useRef('');
  const thinkFrameRef = useRef(null);
  // Counters for the spinner line. Refs, not state: they change per delta and the meter
  // samples them once a second rather than re-rendering on every token.
  const runRef = useRef({ startedAt: 0, chars: 0, thought: 0, ops0: 0 });
  const meterTimerRef = useRef(null);
  const throughputRef = useRef(null);
  if (!throughputRef.current) {
    throughputRef.current = session.throughput || new ThroughputTracker();
    session.throughput = throughputRef.current;
  }
  const throughput = throughputRef.current;

  const push = useCallback(
    (entry) => {
      setHistory((h) => [...h, { key: nextKey++, ...entry }]);
      // Mirror to the web sidecar when one is attached. Entries pushed here are the ones
      // the agent's own events do not carry — the user's own lines, command output, the
      // local notices — so without this a browser sees the model's half of the
      // conversation and none of the operator's.
      session.bus?.publish('transcript', entry);
    },
    [session],
  );

  const flushLive = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = setTimeout(() => {
      frameRef.current = null;
      setLive(liveRef.current);
    }, FRAME_MS);
  }, []);

  const flushThinking = useCallback(() => {
    if (thinkFrameRef.current) return;
    thinkFrameRef.current = setTimeout(() => {
      thinkFrameRef.current = null;
      setThinking(thinkRef.current);
    }, FRAME_MS);
  }, []);

  const startMeter = useCallback(() => {
    runRef.current = { startedAt: Date.now(), chars: 0, thought: 0, ops0: agent.stats.ops };
    setRunStartedAt(runRef.current.startedAt);
    clearInterval(meterTimerRef.current);
    // Advances the clock and ticks the throughput tracker so stalls drop to 0 tok/s live.
    meterTimerRef.current = setInterval(() => {
      throughput.tick();
      tickMeter((t) => t + 1);
    }, METER_MS);
  }, [agent, throughput]);

  const stopMeter = useCallback(() => {
    clearInterval(meterTimerRef.current);
    meterTimerRef.current = null;
    setRunStartedAt(null);
  }, []);

  const clearThinking = useCallback(() => {
    clearTimeout(thinkFrameRef.current);
    thinkFrameRef.current = null;
    thinkRef.current = '';
    setThinking('');
  }, []);

  // --- wire the agent's events into the view ---
  useEffect(() => {
    const onThinking = (delta) => {
      thinkRef.current += delta;
      runRef.current.thought += delta.length;
      throughput.record('thinking', delta);
      flushThinking();
    };
    const onText = (delta) => {
      // The answer has started, so the working notes have served their purpose.
      if (thinkRef.current) clearThinking();
      liveRef.current += delta;
      runRef.current.chars += delta.length;
      throughput.record('text', delta);
      flushLive();
    };
    const onTurnStart = () => {
      setBusy(true);
      setStatus('thinking');
      clearThinking();
      throughput.startTurn({
        turn: agent.stats.turns + 1,
        model: session.cfg.model.id,
        provider: session.cfg.provider,
        effort: session.cfg.model.effort ? session.cfg.effort : null,
        maxTokens: session.cfg.maxTokens ?? null,
        contextLimit: session.cfg.contextLimit ?? null,
      });
    };
    const onTurnEnd = ({ text, ttftMs, durationMs, effort }) => {
      // Hand the harness's measurements over before the turn closes, so what is on screen
      // and what is in the session log are the same numbers. `effort` is included because
      // a demoted turn did not run at the level startTurn recorded.
      throughput.applyTiming({ ttftMs, durationMs, effort });
      throughput.endTurn();
      clearTimeout(frameRef.current);
      frameRef.current = null;
      liveRef.current = '';
      setLive('');
      clearThinking();
      if (text.trim()) push({ type: 'assistant', text });
      setStatus(null);
    };
    const onOpsParsed = (ops) => {
      throughput.startOps({ ops: ops.length });
      setStatus(`running ${ops.length} op${ops.length > 1 ? 's' : ''}`);
      push({ type: 'ops', ops });
    };
    const onOpsResult = ({ outcome, ops }) => {
      throughput.endOps();
      setStatus(null);
      push({ type: 'ops-result', outcome, ops });
      // Ops land between usage events, so without this the counter lags a whole turn.
      setStats({ ...agent.stats });
    };
    const onSteerQueued = ({ queued }) =>
      push({
        type: 'notice',
        message:
          queued > 1
            ? `steer queued (${queued} waiting) — applied after this turn`
            : 'steer queued — applied after this turn',
      });
    const onSteered = ({ applied }) =>
      push({
        type: 'notice',
        message: `steering applied (${applied})`,
      });
    const onTxQueued = ({ queued }) => {
      push({
        type: 'notice',
        message:
          queued > 1
            ? `tx queued (${queued} waiting) — applied atomically at next turn boundary`
            : 'tx queued — applied atomically at next turn boundary',
      });
      setTick((t) => t + 1);
    };
    const onTxApplied = ({ entries = [], immediate }) => {
      if (!immediate && entries.length) {
        push({
          type: 'notice',
          message: `queued operator tx applied at turn boundary (${entries.length})`,
        });
      }
      for (const entry of entries) {
        push({ type: 'tx-eval', entry });
      }
      setStats({ ...agent.stats });
      setTick((t) => t + 1);
    };
    // A prompt edited in a browser landed at this step boundary. Said out loud because
    // the cached prefix was just rebuilt, which the operator pays for on the next turn.
    const onPromptsApplied = () => {
      push({ type: 'notice', message: 'prompt changes applied — system prompt rebuilt' });
      setTick((t) => t + 1);
    };
    const onRetry = ({ attempt, of, waitMs, message }) =>
      push({
        type: 'warning',
        message: `${message} — retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${of})`,
      });
    const onArtifact = (item) => push({ type: 'artifact', item });
    const onUsage = (u) => {
      throughput.reconcileUsage(u);
      setStats({ ...agent.stats });
    };
    const onError = (e) => {
      throughput.endTurn();
      // Clear buffered live/thinking regions on error just like `onTurnEnd` and
      // `onCancelled` do — otherwise a socket drop mid-turn leaves the orphaned live
      // `da_ops` block stuck above the prompt forever.
      clearTimeout(frameRef.current);
      frameRef.current = null;
      liveRef.current = '';
      setLive('');
      clearThinking();
      push({ type: 'error', message: e.message, detail: e.detail });
      setApproval(null);
      setBusy(false);
      setStatus(null);
      stopMeter();
    };
    const onWarning = (w) => push({ type: 'warning', message: w.message });
    const onDone = () => {
      throughput.endTurn();
      setApproval(null);
      setBusy(false);
      setStatus(null);
      setStats({ ...agent.stats });
      stopMeter();
    };
    const onCancelled = () => {
      throughput.endTurn();
      clearTimeout(frameRef.current);
      frameRef.current = null;
      if (liveRef.current.trim()) push({ type: 'assistant', text: liveRef.current, cancelled: true });
      liveRef.current = '';
      setLive('');
      clearThinking();
      push({ type: 'notice', message: 'cancelled' });
      setApproval(null);
      setBusy(false);
      setStatus(null);
      stopMeter();
    };
    const onCompactStart = () => setStatus('compacting context');
    const onCompactDone = (r) => {
      push({ type: 'compact', ...r });
      setStatus(null);
    };
    const onApproval = (req) => {
      // session.cfg is read at call time, not captured: /yolo toggles mid-session and
      // the next command must see the new value.
      // yolo skips the question, not the password: a sudo command still needs one typed.
      if (session.cfg.yolo && !req.sudo) {
        req.respond({ allow: true });
        push({ type: 'approval', cmd: req.op.cmd, allowed: true, auto: true });
        return;
      }
      setApproval(req);
    };
    const onRepair = ({ error, attempt }) =>
      push({ type: 'warning', message: `malformed da_ops (repair ${attempt}): ${error}` });
    const onNudge = ({ attempt, nativeCalls, reason }) =>
      push({
        type: 'notice',
        message:
          reason === 'stream-stalled'
            ? `stream cut off mid-turn — nudged the model to continue (${attempt})`
            : nativeCalls?.length
              ? `native tool call ${nativeCalls.join(', ')} not run — told the model to use da_ops (${attempt})`
              : `no ops in that turn — asking it to continue (${attempt})`,
      });

    // Registered from a map so the cleanup can remove exactly these. It used to call
    // agent.removeAllListeners(), which also tore off whatever the harness had attached —
    // the session bus that feeds the web sidecar lives there, and a remount would have
    // silently cut it off from the agent.
    const handlers = {
      thinking: onThinking,
      text: onText,
      'turn-start': onTurnStart,
      'turn-end': onTurnEnd,
      'ops-parsed': onOpsParsed,
      'ops-result': onOpsResult,
      artifact: onArtifact,
      usage: onUsage,
      error: onError,
      warning: onWarning,
      done: onDone,
      cancelled: onCancelled,
      'compact-start': onCompactStart,
      'compact-done': onCompactDone,
      'approval-request': onApproval,
      repair: onRepair,
      nudge: onNudge,
      retry: onRetry,
      'steer-queued': onSteerQueued,
      steered: onSteered,
      'tx-queued': onTxQueued,
      'tx-applied': onTxApplied,
      'prompts-applied': onPromptsApplied,
    };
    for (const [name, fn] of Object.entries(handlers)) agent.on(name, fn);

    return () => {
      for (const [name, fn] of Object.entries(handlers)) agent.off(name, fn);
      clearTimeout(frameRef.current);
      clearTimeout(thinkFrameRef.current);
      clearInterval(meterTimerRef.current);
    };
  }, [agent, flushLive, flushThinking, clearThinking, stopMeter, push, session, throughput]);

  // Lines the web sidecar's own dispatcher produced. Its push goes to the bus, not to
  // Ink, so without this a prompt typed in the browser scrolled past the terminal
  // unrecorded — the answer appeared, the question never did. Entries are re-pushed
  // locally rather than through `push`, which would publish them straight back.
  //
  // `pane` and `session-changed` come the same way: /context typed in a browser should
  // open the REPL's pane too, and /model changes have to invalidate what it is showing.
  useEffect(() => {
    const bus = session.bus;
    if (!bus) return undefined;
    const onEvent = (ev) => {
      if (ev.type === 'transcript' && ev.data?.origin === 'web') {
        setHistory((h) => [...h, { key: nextKey++, ...ev.data }]);
      } else if (ev.type === 'pane') {
        setPane(ev.data?.pane ?? null);
      } else if (ev.type === 'session-changed') {
        setTick((t) => t + 1);
      } else if (ev.type === 'approval-resolved') {
        // A browser (or a second tab) answered the request this pane is showing. The bus
        // already ran the agent's callback, so there is nothing left to respond to — but
        // the pane is modal and useInput returns early while it is open, so leaving it up
        // freezes the terminal on a question that has already been answered. Clear it and
        // record who decided what.
        setApproval((cur) => {
          if (!cur || (ev.data?.id && cur.id !== ev.data.id)) return cur;
          // The bus runs this synchronously from our own respond() as well, before
          // onRespond has had a chance to clear the pane. Without the flag the local
          // path records the decision twice, once here and once below.
          if (cur.answeredLocally) return cur;
          if (!cur.operator) {
            setHistory((h) => [
              ...h,
              {
                key: nextKey++,
                type: 'approval',
                cmd: cur.op?.cmd,
                allowed: Boolean(ev.data?.decision?.allow),
                edited: ev.data?.decision?.cmd,
                remote: true,
              },
            ]);
          }
          return null;
        });
      }
    };
    bus.on('event', onEvent);
    return () => bus.off('event', onEvent);
  }, [session]);

  // The body of this lives in session/dispatch.js so the web sidecar drives the session
  // through the same steering, command, paste and image handling rather than reimplementing
  // it. What stays here is the part that is genuinely Ink: panes, the approval pane, and
  // the spinner's meter.
  //
  // `busy` is read through a ref rather than closed over. The dispatcher is built once and
  // would otherwise capture the first render's value and steer into a turn that had already
  // finished.
  const busyRef = useRef(false);
  busyRef.current = busy;

  const dispatchRef = useRef(null);
  if (!dispatchRef.current) {
    dispatchRef.current = createDispatcher({
      session,
      view: {
        push,
        setPane,
        exit: () => {
          log.close('exit');
          exit();
        },
        refresh: () => setTick((t) => t + 1),
        // `sh` asks for a sudo password through the approval pane, with no approval question.
        requestSecret: (op, extra) =>
          new Promise((resolve) =>
            setApproval({ op, ...extra, operator: true, respond: resolve }),
          ),
        onRunStart: () => startMeter(),
        isBusy: () => busyRef.current,
      },
    });
  }

  const submit = useCallback((raw) => dispatchRef.current(raw), []);

  // Run an initial request passed on the command line.
  const ranInitial = useRef(false);
  useEffect(() => {
    if (initialInput && !ranInitial.current) {
      ranInitial.current = true;
      submit(initialInput);
    }
  }, [initialInput, submit]);

  useInput(
    (input, key) => {
      if (approval) return; // the approval pane owns input while open

      if (key.escape) {
        if (pane) return; // the open pane owns escape (sub-inputs cancel before closing)
        if (session.shellController) {
          session.shellController.abort();
          return;
        }
        if (busy) {
          setStatus('cancelling');
          agent.cancel();
        }
        return;
      }
      if (key.ctrl && input === 'c') {
        if (session.shellController) {
          session.shellController.abort();
          return;
        }
        if (busy && !agent.controller?.signal?.aborted) {
          setStatus('cancelling');
          agent.cancel();
          return;
        }
        // Like a shell: Ctrl+C on a non-empty prompt discards the line first; Ctrl+C on
        // an empty prompt arms exit.
        if (!pane && session._clearComposer?.()) {
          setExitArmed(false);
          return;
        }
        if (exitArmed) {
          log.close('exit');
          exit();
        } else {
          setExitArmed(true);
          setTimeout(() => setExitArmed(false), 2000);
        }
        return;
      }
      if (key.ctrl && input === 'g') return setPane(pane === 'context' ? null : 'context');
      // When text is being edited in the composer or a pane input, Ctrl+A moves the
      // cursor to the start of the line (readline). On an empty prompt it opens Artifacts.
      if (key.ctrl && input === 'a' && !session._paneEditing && (pane || !session._composerHasText)) {
        return setPane(pane === 'artifacts' ? null : 'artifacts');
      }
      if (key.ctrl && input === 't') return setPane(pane === 'tps' ? null : 'tps');
    },
    { isActive: true },
  );

  const width = stdout?.columns || 80;
  const rows = stdout?.rows || 30;
  const liveSnap = runStartedAt ? throughput.snapshot(Date.now(), { seriesPoints: 12 }) : null;
  const liveView = live ? formatLiveWindow(live, { width, rows }) : null;

  return (
    <Box flexDirection="column" width={width}>
      <Static items={history}>
        {(item) => <HistoryItem key={item.key} item={item} width={width} />}
      </Static>

      {!pane ? <PerfHud tracker={throughput} width={width} /> : null}

      {thinking ? <ThinkingBox text={thinking} width={width} /> : null}

      {liveView ? (
        <Box flexDirection="column" paddingX={1}>
          {liveView.hiddenLines > 0 ? (
            <Text color={colors.dim}>
              {glyphs.ellipsis} +{liveView.hiddenLines} earlier streaming line
              {liveView.hiddenLines === 1 ? '' : 's'}
            </Text>
          ) : null}
          <Text>{renderMarkdown(liveView.text, { syntax: false })}</Text>
        </Box>
      ) : null}

      {status ? (
        <Box paddingX={1} width={width}>
          <Text wrap="truncate-end">
            <Text color={colors.accent}>
              <Spinner type="dots" />
            </Text>
            <Text color={colors.dim}> {status}… </Text>
            {runStartedAt ? (
              <Text color={colors.dim}>
                {formatMeter({
                  ms: Date.now() - runStartedAt,
                  chars: runRef.current.chars,
                  thought: runRef.current.thought,
                  ops: Math.max(0, stats.ops - runRef.current.ops0),
                  tps: liveSnap?.currentTps || 0,
                  spark: liveSnap?.series?.length ? renderSparkline(liveSnap.series, { width: 10 }) : '',
                })}{' '}
              </Text>
            ) : null}
            <Text color={colors.dim}>(esc to cancel{busy ? ', type to steer, ctrl+t plot' : ''})</Text>
          </Text>
        </Box>
      ) : null}

      {approval ? (
        <ApprovalPane
          request={approval}
          session={session}
          onRespond={(decision) => {
            // Set before respond(): the bus publishes approval-resolved synchronously
            // from inside it, and the listener above must know this answer was ours.
            approval.answeredLocally = true;
            approval.respond(decision);
            // An operator `sh` only asked for the sudo password; there was no approval to record.
            if (!approval.operator) {
              push({
                type: 'approval',
                cmd: approval.op.cmd,
                allowed: decision.allow,
                edited: decision.cmd,
              });
            }
            setApproval(null);
          }}
        />
      ) : null}

      {pane === 'context' ? (
        <ContextPane
          ledger={ledger}
          width={width}
          onClose={() => setPane(null)}
          // Drop and pin mutate the ledger, so the status bar has to re-read it and an
          // attached browser has to be told. The web routes publish exactly this pair
          // (`contextChanged` in server/http.js); this is the same thing in reverse.
          onChange={(message) => {
            if (message) push({ type: 'notice', message });
            setTick((t) => t + 1);
            session.bus?.publish('session-changed', null);
          }}
        />
      ) : null}
      {pane === 'model' ? (
        <ModelPane session={session} onClose={() => setPane(null)} push={push} />
      ) : null}
      {pane === 'keys' ? (
        <KeyPane session={session} onClose={() => setPane(null)} push={push} />
      ) : null}
      {pane === 'env' ? (
        <EnvPane session={session} onClose={() => setPane(null)} push={push} />
      ) : null}
      {pane === 'artifacts' ? (
        <ArtifactPane
          artifacts={artifacts}
          session={session}
          width={width}
          onClose={() => setPane(null)}
          push={push}
        />
      ) : null}
      {pane === 'tx' ? (
        <TxPane
          session={session}
          width={width}
          rows={stdout?.rows || 30}
          onClose={() => setPane(null)}
          onSubmit={submit}
        />
      ) : null}
      {pane === 'tps' ? (
        <ThroughputPane
          tracker={throughput}
          width={width}
          home={cfg.home}
          excludeDir={log.dir}
          onClose={() => setPane(null)}
        />
      ) : null}

      <Composer onSubmit={submit} session={session} busy={busy} active={!approval && !pane} />

      <StatusBar
        cfg={cfg}
        ledger={ledger}
        stats={stats}
        throughput={throughput}
        width={width}
        exitArmed={exitArmed}
        tick={tick}
      />
    </Box>
  );
}

function HistoryItem({ item, width = 80 }) {
  const maxDetailCols = Math.max(24, width - 12);

  switch (item.type) {
    case 'user':
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color={colors.user}>
            <Text bold>{glyphs.prompt} </Text>
            {sanitizeTerminalText(item.text)}
          </Text>
        </Box>
      );

    case 'assistant':
      return (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text>{renderMarkdown(item.text)}</Text>
          {item.cancelled ? <Text color={colors.warn}>{glyphs.warn} cancelled mid-turn</Text> : null}
        </Box>
      );

    case 'ops':
      return (
        <Box flexDirection="column" paddingX={1}>
          {item.ops.map((op, i) => (
            <Text key={i} color={colors.op} wrap="truncate-end">
              {'  '}
              {glyphs.bullet} {describeOp(op, Math.max(24, width - 8))}
            </Text>
          ))}
        </Box>
      );

    case 'ops-result': {
      const { outcome } = item;
      if (outcome.status === 'ok') {
        return (
          <Box flexDirection="column" paddingX={1}>
            {outcome.results
              .filter((r) => r.result && MUTATING.has(r.op))
              .map((r, i) => {
                const txChanges = r.op === 'tx' ? r.result?.changes || [] : [];
                const txOut =
                  r.op === 'tx' && r.result?.output !== undefined
                    ? formatPreviewBlock(r.result.output, {
                        maxLines: 4,
                        maxCols: maxDetailCols,
                      })
                    : null;
                return (
                  <Box key={i} flexDirection="column">
                    <Text color={colors.ok} wrap="truncate-end">
                      {'  '}
                      {glyphs.check} {summarizeResult(r, Math.max(24, width - 8))}
                    </Text>
                    {txChanges.slice(0, 6).map((c, ci) => (
                      <Text key={`ch-${ci}`} color={colors.dim} wrap="truncate-end">
                        {'      '}
                        {truncateInline(c.path, Math.max(16, maxDetailCols - 24))} {c.action} (
                        {c.delta >= 0 ? '+' : ''}
                        {c.delta} lines)
                      </Text>
                    ))}
                    {txChanges.length > 6 ? (
                      <Text color={colors.dim} wrap="truncate-end">
                        {'      '}
                        {glyphs.ellipsis} +{txChanges.length - 6} more file(s)
                      </Text>
                    ) : null}
                    {r.op === 'tx' && r.result?.logs?.length ? (
                      <Text color={colors.accent} wrap="truncate-end">
                        {'      '}logs:{' '}
                        {truncateInline(r.result.logs.slice(0, 3).join(' | '), maxDetailCols - 6)}
                      </Text>
                    ) : null}
                    {txOut
                      ? txOut.lines.map((line, li) => (
                          <Text key={li} color={colors.dim} wrap="truncate-end">
                            {'      '}
                            {li === 0 ? `${glyphs.arrow} ${line}` : `  ${line}`}
                          </Text>
                        ))
                      : null}
                    {txOut?.truncated ? (
                      <Text color={colors.dim} wrap="truncate-end">
                        {'      '}
                        {glyphs.ellipsis} ({formatTokens(txOut.totalChars)} chars, {txOut.totalLines}{' '}
                        line{txOut.totalLines === 1 ? '' : 's'} — /tx for full output)
                      </Text>
                    ) : null}
                  </Box>
                );
              })}
          </Box>
        );
      }
      return (
        <Box flexDirection="column" paddingX={1}>
          {outcome.errors.map((e, i) => (
            <Text key={i} color={colors.err}>
              {'  '}
              {glyphs.cross} [{e.index}] {e.op}: {sanitizeTerminalText(e.message)}
            </Text>
          ))}
          <Text color={colors.dim}>
            {'  '}
            {outcome.status === 'plan-failed'
              ? 'nothing was applied; asking the model to resubmit'
              : outcome.errors.some((e) => e.op === 'shell')
                ? 'stopped at the shell op; earlier file changes kept'
                : 'changes rolled back'}
          </Text>
        </Box>
      );
    }

    case 'tx-eval': {
      const e = item.entry || {};
      if (!e.ok) {
        return (
          <Box flexDirection="column" paddingX={1}>
            <Text color={colors.err}>
              {'  '}
              {glyphs.cross} tx (operator): {sanitizeTerminalText(e.error)}
            </Text>
          </Box>
        );
      }
      const changes = e.changes || [];
      const outBlock =
        e.output !== undefined
          ? formatPreviewBlock(e.output, { maxLines: 12, maxCols: maxDetailCols })
          : null;
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={colors.ok} wrap="truncate-end">
            {'  '}
            {glyphs.check} tx (operator):{' '}
            {changes.length
              ? `${changes.length} file(s) modified (${e.opsCount || 0} fs ops, ${e.durationMs || 0}ms)`
              : `${e.opsCount || 0} fs ops (read-only, ${e.durationMs || 0}ms)`}
            {' · added to context'}
          </Text>
          {changes.slice(0, 10).map((c, ci) => (
            <Text key={`ch-${ci}`} color={colors.dim} wrap="truncate-end">
              {'      '}
              {truncateInline(c.path, Math.max(16, maxDetailCols - 24))} {c.action} (
              {c.delta >= 0 ? '+' : ''}
              {c.delta} lines)
            </Text>
          ))}
          {changes.length > 10 ? (
            <Text color={colors.dim} wrap="truncate-end">
              {'      '}
              {glyphs.ellipsis} +{changes.length - 10} more file(s)
            </Text>
          ) : null}
          {e.logs?.length ? (
            <Text color={colors.accent} wrap="truncate-end">
              {'      '}logs: {truncateInline(e.logs.join(' | '), maxDetailCols - 6)}
            </Text>
          ) : null}
          {outBlock
            ? outBlock.lines.map((line, li) => (
                <Text key={`out-${li}`} color={colors.dim} wrap="truncate-end">
                  {'      '}
                  {li === 0 ? `${glyphs.arrow} ${line}` : `  ${line}`}
                </Text>
              ))
            : null}
          {outBlock?.truncated ? (
            <Text color={colors.dim} wrap="truncate-end">
              {'      '}
              {glyphs.ellipsis} ({formatTokens(outBlock.totalChars)} chars, {outBlock.totalLines}{' '}
              line{outBlock.totalLines === 1 ? '' : 's'} — /tx for full output)
            </Text>
          ) : null}
        </Box>
      );
    }

    case 'artifact':
      return (
        <Box paddingX={1}>
          <Text color={colors.artifact}>
            {'  '}
            {glyphs.bullet} artifact #{item.item.n} ({item.item.lang}, {item.item.lines} lines) —
            ctrl+a to save or copy
          </Text>
        </Box>
      );

    case 'approval':
      return (
        <Box paddingX={1}>
          <Text color={item.allowed ? colors.ok : colors.warn}>
            {'  '}
            {item.allowed ? glyphs.check : glyphs.cross} shell{' '}
            {item.allowed
              ? item.auto
                ? 'auto-approved (yolo)'
                : item.remote
                  ? 'approved in the browser'
                  : 'approved'
              : item.remote
                ? 'denied in the browser'
                : 'denied'}
            : {item.edited || item.cmd}
          </Text>
        </Box>
      );

    case 'compact':
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={colors.dim}>
            {'  '}
            {glyphs.bullet} auto-compacted, freed ~{item.freed} tokens
          </Text>
          {(item.actions || []).map((a, i) => (
            <Text key={i} color={colors.dim}>
              {'      '}
              {a}
            </Text>
          ))}
        </Box>
      );

    case 'error':
      return (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Text color={colors.err}>
            {glyphs.cross} {item.message}
          </Text>
        </Box>
      );

    case 'warning':
      return (
        <Box paddingX={1}>
          <Text color={colors.warn}>
            {'  '}
            {glyphs.warn} {item.message}
          </Text>
        </Box>
      );

    case 'notice':
      return (
        <Box paddingX={1}>
          <Text color={colors.dim}>
            {'  '}
            {item.message}
          </Text>
        </Box>
      );

    case 'info':
      return (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          {String(item.text).split('\n').map((l, i) => (
            <Text key={i} color={item.color || colors.dim}>
              {l}
            </Text>
          ))}
        </Box>
      );

    default:
      return null;
  }
}

const MUTATING = new Set(['write', 'replace', 'delete', 'move', 'tx', 'shell']);

function describeOp(op, maxCols = 120) {
  let raw;
  switch (op.op) {
    case 'shell':
      raw = `shell: ${op.cmd}`;
      break;
    case 'tx':
      raw = `tx: ${op.description || `${String(op.code || '').replace(/\r\n?/g, '\n').split('\n').length} line(s) JS`}`;
      break;
    case 'move':
      raw = `move: ${op.from} ${glyphs.arrow} ${op.to}`;
      break;
    case 'grep':
    case 'glob':
      raw = `${op.op}: "${op.pattern}" in ${op.path}`;
      break;
    case 'read':
      raw = `read: ${op.path}${op.lines ? ` [${op.lines[0]}-${op.lines[1]}]` : ''}`;
      break;
    default:
      raw = `${op.op}: ${op.path}`;
  }
  return truncateInline(raw, maxCols);
}

function summarizeResult(r, maxCols = 120) {
  const x = r.result;
  let raw;
  switch (r.op) {
    case 'write':
      raw = `${x.path} ${x.action} (${x.lines} lines)`;
      break;
    case 'replace':
      raw = `${x.path} edited (${x.delta >= 0 ? '+' : ''}${x.delta} lines)`;
      break;
    case 'delete':
      raw = `${x.path} deleted`;
      break;
    case 'move':
      raw = `${x.from} ${glyphs.arrow} ${x.to}`;
      break;
    case 'tx':
      raw = x.changes?.length
        ? `tx: ${x.changes.length} file(s) modified (${x.opsCount} fs ops)`
        : `tx: ${x.opsCount} fs ops (read-only)`;
      break;
    case 'shell':
      raw = `$ ${x.cmd} (exit ${x.exitCode}, ${x.durationMs}ms)`;
      break;
    default:
      raw = r.op;
  }
  return truncateInline(raw, maxCols);
}

/**
 * Bound the live streaming region in both lines and visual rows so Ink's dynamic
 * repaint stays O(viewport) instead of O(turn_size) and never grows taller than
 * `stdout.rows` (once Ink's dynamic region scrolls off the top of the viewport, ANSI
 * cursor-up clamps at row 0 and duplicates lines into scrollback every 33ms, while
 * Yoga layout + cli-highlight over 70KB batches spikes V8 heap past 1GB).
 *
 * Full untruncated markdown with syntax highlighting is still committed to `<Static>`
 * once `onTurnEnd` fires.
 *
 * @param {string} raw
 * @param {{width?: number, rows?: number}} [opts]
 * @returns {{text: string, hiddenLines: number}}
 */
export function formatLiveWindow(raw, { width = 80, rows = 30 } = {}) {
  const innerCols = Math.max(20, width - 4);
  // Leave room for PerfHud, spinner, composer, status bar, and the "+N lines" banner.
  const maxVisualRows = Math.max(8, Math.min(40, rows - 10));
  // Cheap tail pre-slice on huge 70KB+ streams so we don't sanitize/split 2,000 earlier
  // lines on every 33ms frame; count `\n` in the skipped prefix so hiddenLines stays exact.
  const TAIL_CHARS = Math.max(4096, innerCols * maxVisualRows * 4);
  let skippedNewlines = 0;
  let tail = String(raw || '');
  if (tail.length > TAIL_CHARS) {
    const cut = tail.indexOf('\n', tail.length - TAIL_CHARS);
    if (cut > 0) {
      for (let i = 0; i <= cut; i++) {
        if (tail.charCodeAt(i) === 10) skippedNewlines++;
      }
      tail = tail.slice(cut + 1);
    }
  }

  const lines = tail.replace(/\r\n?/g, '\n').split('\n');
  const maxLineChars = innerCols * 3;
  const kept = [];
  let usedRows = 0;
  let i = lines.length - 1;
  for (; i >= 0; i--) {
    let clean = sanitizeTerminalLine(lines[i]);
    if (clean.length > maxLineChars) {
      const keep = Math.max(1, maxLineChars - glyphs.ellipsis.length);
      clean = `${safeSlice(clean, keep)}${glyphs.ellipsis}`;
    }
    const visualRows = Math.max(1, Math.ceil((clean.length || 1) / innerCols));
    if (kept.length > 0 && usedRows + visualRows > maxVisualRows) break;
    kept.push(clean);
    usedRows += visualRows;
  }
  kept.reverse();

  // If truncating the head severed an open ``` fence, prepend a matching opener so
  // `renderMarkdown` still styles the visible tail as inside-fence rather than flipping
  // an upcoming closing ``` into an opening fence.
  let fenceCount = 0;
  let firstFenceLang = '';
  for (const l of kept) {
    const m = l.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    if (m) {
      if (fenceCount === 0) firstFenceLang = m[2] || '';
      fenceCount++;
    }
  }
  const hiddenLines = skippedNewlines + (i + 1);
  if (hiddenLines > 0 && fenceCount % 2 === 1 && !firstFenceLang) {
    kept.unshift('```');
  }

  return {
    text: kept.join('\n'),
    hiddenLines,
  };
}
