import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, Static, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { Composer } from './Composer.jsx';
import { StatusBar } from './StatusBar.jsx';
import { ContextPane } from './ContextPane.jsx';
import { ModelPane } from './ModelPane.jsx';
import { ArtifactPane } from './ArtifactPane.jsx';
import { ApprovalPane } from './ApprovalPane.jsx';
import { ThroughputPane } from './ThroughputPane.jsx';
import { PerfHud } from './PerfHud.jsx';
import { ThinkingBox } from './ThinkingBox.jsx';
import { renderMarkdown } from './markdown.js';
import { colors, glyphs, formatMeter } from './theme.js';
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
  const [pane, setPane] = useState(null); // 'context' | 'model' | 'artifacts'
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
      });
    };
    const onTurnEnd = ({ text, ttftMs, durationMs }) => {
      // Hand the harness's measurements over before the turn closes, so what is on screen
      // and what is in the session log are the same numbers.
      throughput.applyTiming({ ttftMs, durationMs });
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
      setStatus(`running ${ops.length} op${ops.length > 1 ? 's' : ''}`);
      push({ type: 'ops', ops });
    };
    const onOpsResult = ({ outcome, ops }) => {
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
      push({ type: 'error', message: e.message, detail: e.detail });
      setBusy(false);
      setStatus(null);
      stopMeter();
    };
    const onWarning = (w) => push({ type: 'warning', message: w.message });
    const onDone = () => {
      throughput.endTurn();
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
    const onNudge = ({ attempt, nativeCalls }) =>
      push({
        type: 'notice',
        message: nativeCalls?.length
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
        if (pane) return setPane(null);
        if (busy) agent.cancel();
        return;
      }
      if (key.ctrl && input === 'c') {
        if (busy) {
          agent.cancel();
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
      if (key.ctrl && input === 'a') return setPane(pane === 'artifacts' ? null : 'artifacts');
      if (key.ctrl && input === 't') return setPane(pane === 'tps' ? null : 'tps');
    },
    { isActive: true },
  );

  const width = stdout?.columns || 80;
  const liveSnap = runStartedAt ? throughput.snapshot(Date.now(), { seriesPoints: 12 }) : null;

  return (
    <Box flexDirection="column" width={width}>
      <Static items={history}>{(item) => <HistoryItem key={item.key} item={item} />}</Static>

      {!pane ? <PerfHud tracker={throughput} width={width} /> : null}

      {thinking ? <ThinkingBox text={thinking} width={width} /> : null}

      {live ? (
        <Box flexDirection="column" paddingX={1}>
          <Text>{renderMarkdown(live)}</Text>
        </Box>
      ) : null}

      {status ? (
        <Box paddingX={1}>
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
        </Box>
      ) : null}

      {approval ? (
        <ApprovalPane
          request={approval}
          onRespond={(decision) => {
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
        <ContextPane ledger={ledger} width={width} onClose={() => setPane(null)} />
      ) : null}
      {pane === 'model' ? (
        <ModelPane session={session} onClose={() => setPane(null)} push={push} />
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
      {pane === 'tps' ? (
        <ThroughputPane
          tracker={throughput}
          width={width}
          home={cfg.home}
          excludeDir={log.dir}
          onClose={() => setPane(null)}
        />
      ) : null}

      {!approval && !pane ? <Composer onSubmit={submit} session={session} busy={busy} /> : null}

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

function HistoryItem({ item }) {
  switch (item.type) {
    case 'user':
      return (
        <Box paddingX={1} marginTop={1}>
          <Text color={colors.user} bold>
            {glyphs.prompt}{' '}
          </Text>
          <Text color={colors.user}>{item.text}</Text>
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
            <Text key={i} color={colors.op}>
              {'  '}
              {glyphs.bullet} {describeOp(op)}
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
              .map((r, i) => (
                <Text key={i} color={colors.ok}>
                  {'  '}
                  {glyphs.check} {summarizeResult(r)}
                </Text>
              ))}
          </Box>
        );
      }
      return (
        <Box flexDirection="column" paddingX={1}>
          {outcome.errors.map((e, i) => (
            <Text key={i} color={colors.err}>
              {'  '}
              {glyphs.cross} [{e.index}] {e.op}: {e.message}
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
            {item.allowed ? (item.auto ? 'auto-approved (yolo)' : 'approved') : 'denied'}:{' '}
            {item.edited || item.cmd}
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

const MUTATING = new Set(['write', 'replace', 'delete', 'move', 'shell']);

function describeOp(op) {
  switch (op.op) {
    case 'shell':
      return `shell: ${op.cmd}`;
    case 'move':
      return `move: ${op.from} ${glyphs.arrow} ${op.to}`;
    case 'grep':
    case 'glob':
      return `${op.op}: "${op.pattern}" in ${op.path}`;
    case 'read':
      return `read: ${op.path}${op.lines ? ` [${op.lines[0]}-${op.lines[1]}]` : ''}`;
    default:
      return `${op.op}: ${op.path}`;
  }
}

function summarizeResult(r) {
  const x = r.result;
  switch (r.op) {
    case 'write':
      return `${x.path} ${x.action} (${x.lines} lines)`;
    case 'replace':
      return `${x.path} edited (${x.delta >= 0 ? '+' : ''}${x.delta} lines)`;
    case 'delete':
      return `${x.path} deleted`;
    case 'move':
      return `${x.from} ${glyphs.arrow} ${x.to}`;
    case 'shell':
      return `$ ${x.cmd} (exit ${x.exitCode}, ${x.durationMs}ms)`;
    default:
      return r.op;
  }
}
