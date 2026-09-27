import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, Static, useApp, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { Composer } from './Composer.jsx';
import { StatusBar } from './StatusBar.jsx';
import { ContextPane } from './ContextPane.jsx';
import { ModelPane } from './ModelPane.jsx';
import { ArtifactPane } from './ArtifactPane.jsx';
import { ApprovalPane } from './ApprovalPane.jsx';
import { renderMarkdown } from './markdown.js';
import { colors, glyphs } from './theme.js';
import { handleCommand } from './commands.js';
import { extractImageRefs, loadImage } from '../context/images.js';

/** Throttle for streaming deltas: repaint at ~30fps, never per token. */
const FRAME_MS = 33;

let nextKey = 1;

export function App({ session, initialInput }) {
  const { agent, cfg, ledger, artifacts, pastes, log } = session;
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Committed transcript lives in <Static>, so Ink never re-renders scrollback.
  const [history, setHistory] = useState([]);
  const [live, setLive] = useState('');
  const [status, setStatus] = useState(null);
  const [pane, setPane] = useState(null); // 'context' | 'model' | 'artifacts'
  const [approval, setApproval] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ turns: 0, ops: 0, cost: 0 });
  const [tick, setTick] = useState(0);
  const [exitArmed, setExitArmed] = useState(false);

  const liveRef = useRef('');
  const frameRef = useRef(null);

  const push = useCallback((entry) => {
    setHistory((h) => [...h, { key: nextKey++, ...entry }]);
  }, []);

  const flushLive = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = setTimeout(() => {
      frameRef.current = null;
      setLive(liveRef.current);
    }, FRAME_MS);
  }, []);

  // --- wire the agent's events into the view ---
  useEffect(() => {
    const onText = (delta) => {
      liveRef.current += delta;
      flushLive();
    };
    const onTurnStart = () => {
      setBusy(true);
      setStatus('thinking');
    };
    const onTurnEnd = ({ text }) => {
      clearTimeout(frameRef.current);
      frameRef.current = null;
      liveRef.current = '';
      setLive('');
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
    };
    const onArtifact = (item) => push({ type: 'artifact', item });
    const onUsage = () => setStats({ ...agent.stats });
    const onError = (e) => {
      push({ type: 'error', message: e.message, detail: e.detail });
      setBusy(false);
      setStatus(null);
    };
    const onWarning = (w) => push({ type: 'warning', message: w.message });
    const onDone = () => {
      setBusy(false);
      setStatus(null);
      setStats({ ...agent.stats });
    };
    const onCancelled = () => {
      clearTimeout(frameRef.current);
      frameRef.current = null;
      if (liveRef.current.trim()) push({ type: 'assistant', text: liveRef.current, cancelled: true });
      liveRef.current = '';
      setLive('');
      push({ type: 'notice', message: 'cancelled' });
      setBusy(false);
      setStatus(null);
    };
    const onCompactStart = () => setStatus('compacting context');
    const onCompactDone = (r) => {
      push({ type: 'compact', ...r });
      setStatus(null);
    };
    const onApproval = (req) => {
      // session.cfg is read at call time, not captured: /yolo toggles mid-session and
      // the next command must see the new value.
      if (session.cfg.yolo) {
        req.respond({ allow: true });
        push({ type: 'approval', cmd: req.op.cmd, allowed: true, auto: true });
        return;
      }
      setApproval(req);
    };
    const onRepair = ({ error, attempt }) =>
      push({ type: 'warning', message: `malformed da_ops (repair ${attempt}): ${error}` });
    const onNudge = ({ attempt }) =>
      push({ type: 'notice', message: `no ops in that turn — asking it to continue (${attempt})` });

    agent.on('text', onText);
    agent.on('turn-start', onTurnStart);
    agent.on('turn-end', onTurnEnd);
    agent.on('ops-parsed', onOpsParsed);
    agent.on('ops-result', onOpsResult);
    agent.on('artifact', onArtifact);
    agent.on('usage', onUsage);
    agent.on('error', onError);
    agent.on('warning', onWarning);
    agent.on('done', onDone);
    agent.on('cancelled', onCancelled);
    agent.on('compact-start', onCompactStart);
    agent.on('compact-done', onCompactDone);
    agent.on('approval-request', onApproval);
    agent.on('repair', onRepair);
    agent.on('nudge', onNudge);

    return () => {
      agent.removeAllListeners();
      clearTimeout(frameRef.current);
    };
  }, [agent, flushLive, push, session]);

  const submit = useCallback(
    async (raw) => {
      const text = raw.trim();
      if (!text) return;

      const cmd = await handleCommand(text, {
        session,
        push,
        setPane,
        exit: () => {
          log.close('exit');
          exit();
        },
        refresh: () => setTick((t) => t + 1),
      });
      if (cmd.handled) return;

      const { text: expanded, referenced } = pastes.expand(cmd.input ?? text);
      for (const p of referenced) {
        ledger.add({
          type: 'paste',
          label: `paste#${p.n} (${p.lines} lines)`,
          role: 'user',
          text: `[paste#${p.n}]\n${p.text}`,
        });
      }

      // @path references to images become their own segments (req 9).
      const { text: withoutImages, images } = extractImageRefs(expanded, session.sandbox);
      for (const ref of images) {
        if (!cfg.model.vision) {
          push({
            type: 'warning',
            message: `${cfg.model.id} has no vision support — ${ref} was not attached`,
          });
          continue;
        }
        try {
          const img = loadImage(ref, session.sandbox);
          ledger.add({
            type: 'paste',
            label: `image ${img.name} (${Math.round(img.bytes / 1024)}kB)`,
            role: 'user',
            image: img,
          });
          push({ type: 'notice', message: `attached ${img.name} (~${img.tokens} tokens)` });
        } catch (err) {
          push({ type: 'warning', message: err.message });
        }
      }

      push({ type: 'user', text: withoutImages });
      await agent.run(withoutImages);
    },
    [agent, ledger, pastes, push, session, exit, log],
  );

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
    },
    { isActive: true },
  );

  const width = stdout?.columns || 80;

  return (
    <Box flexDirection="column" width={width}>
      <Static items={history}>{(item) => <HistoryItem key={item.key} item={item} width={width} />}</Static>

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
          <Text color={colors.dim}>(esc to cancel)</Text>
        </Box>
      ) : null}

      {approval ? (
        <ApprovalPane
          request={approval}
          onRespond={(decision) => {
            approval.respond(decision);
            push({
              type: 'approval',
              cmd: approval.op.cmd,
              allowed: decision.allow,
              edited: decision.cmd,
            });
            setApproval(null);
          }}
        />
      ) : null}

      {pane === 'context' ? (
        <ContextPane ledger={ledger} width={width} onClose={() => setPane(null)} />
      ) : null}
      {pane === 'model' ? (
        <ModelPane session={session} width={width} onClose={() => setPane(null)} push={push} />
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

      {!approval && !pane ? <Composer onSubmit={submit} session={session} busy={busy} /> : null}

      <StatusBar
        cfg={cfg}
        ledger={ledger}
        stats={stats}
        width={width}
        exitArmed={exitArmed}
        tick={tick}
      />
    </Box>
  );
}

function HistoryItem({ item, width }) {
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
