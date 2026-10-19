import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { keyState, setProviderKey, clearProviderKey, verifyKey } from '../session/keys.js';
import { colors, glyphs } from './theme.js';

/**
 * /keys — the pane that makes a provider usable.
 *
 * The whole point is the input: a key pasted here is echoed as dots, is not in the
 * scrollback, and is not in history.jsonl. `/keys <provider> <key>` exists for pipes
 * and headless use, but typing a secret at a prompt that keeps a transcript is exactly
 * the habit this pane is meant to replace.
 *
 * The machinery is session/keys.js, shared with the browser. What lives here is the
 * keyboard and the layout, the same split as ModelPane.
 */
export function KeyPane({ session, onClose, push }) {
  const { cfg } = session;
  const [, force] = useState(0);
  const rows = keyState(cfg);

  const [sel, setSel] = useState(() => {
    const want = session.keysProvider;
    const i = rows.findIndex((r) => r.name === want);
    return i >= 0 ? i : Math.max(0, rows.findIndex((r) => r.current));
  });
  // Entering with a provider named (`/keys openrouter`) goes straight to its input:
  // naming one is already the decision to edit it.
  const [editing, setEditing] = useState(() => Boolean(session.keysProvider));
  const [persist, setPersist] = useState(() => Boolean(session.keysPersist));
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    delete session.keysProvider;
    delete session.keysPersist;
  }, [session]);

  const row = rows[sel];

  // Bumped when the operator abandons a verify. The in-flight submit checks it on the
  // way out, so a probe that resolves after esc does not set a key the operator just
  // said they no longer wanted.
  const attempt = React.useRef(0);

  const submit = async () => {
    const key = value.trim();
    if (!key || busy) return;
    const mine = ++attempt.current;
    setBusy(true);
    try {
      // Verified here rather than inside setProviderKey, so abandoning mid-probe can
      // return before anything is applied. Letting setProviderKey do both would mean
      // the key was already in cfg by the time the guard below ran, and esc would have
      // printed "abandoned" over a key that was in fact set.
      const reason = await verifyKey(cfg, row.name, key);
      if (mine !== attempt.current) return;
      if (reason) throw new Error(`${row.name} rejected that key: ${reason}`);

      const r = await setProviderKey(session, {
        provider: row.name,
        key,
        persist,
        verify: false,
      });
      for (const message of r.warnings) push({ type: 'warning', message });
      push({
        type: 'notice',
        message:
          `${r.provider} key set (${r.masked})` +
          (r.persisted ? ` ${glyphs.bullet} saved to .env as ${r.varName}` : ' · this session only'),
      });
      // Cleared before anything can re-render with it still in state.
      setValue('');
      setEditing(false);
      force((n) => n + 1);
      if (!cfg.keys?.[cfg.provider]) {
        push({
          type: 'notice',
          message: `/model ${row.name} to start using it`,
        });
      }
    } catch (err) {
      push({ type: 'error', message: `key not set: ${err.message}` });
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    // Esc stays live while verifying. The probe is bounded, but a bounded ten seconds
    // of a pane that ignores every key still reads as a hang, and the operator should
    // never have to wait out a network call they no longer care about.
    if (busy) {
      if (key.escape) {
        attempt.current += 1;
        setValue('');
        setEditing(false);
        setBusy(false);
        push({ type: 'notice', message: 'key verification abandoned — nothing was set' });
      }
      return;
    }

    if (editing) {
      if (key.escape) {
        setValue('');
        setEditing(false);
        return;
      }
      if (key.return) {
        submit();
        return;
      }
      if (key.tab) return setPersist((p) => !p);
      if (key.backspace || key.delete) return setValue((v) => v.slice(0, -1));
      // Ink delivers a paste as one multi-character `input`, which is how a 100-char
      // key arrives in a single event rather than as 100 keystrokes.
      if (input && !key.ctrl && !key.meta) setValue((v) => v + input);
      return;
    }

    if (key.escape || input === 'q') return onClose();
    if (key.upArrow || input === 'k') return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') return setSel((s) => Math.min(rows.length - 1, s + 1));
    if (key.tab) return setPersist((p) => !p);

    if (key.return || input === 'e') {
      if (!row.editable) {
        push({
          type: 'warning',
          message:
            `${row.name}'s key comes from ${row.origin} and would outrank anything saved here — ` +
            `unset ${row.varName} in your shell first`,
        });
        return;
      }
      setValue('');
      setEditing(true);
      return;
    }

    if (input === 'x' && row.hasKey) {
      try {
        const r = clearProviderKey(session, { provider: row.name, persist });
        push({
          type: 'notice',
          message: `${r.provider} key cleared${r.persisted ? ' and removed from .env' : ' for this session'}`,
        });
        force((n) => n + 1);
      } catch (err) {
        push({ type: 'warning', message: err.message });
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={colors.accent}>
          Providers
        </Text>
        <Text color={persist ? colors.warn : colors.dim}>
          {persist ? 'saving to ~/.davai/.env' : 'this session only'} (tab)
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {rows.map((p, i) => (
          <Box key={p.name}>
            <Text color={i === sel ? colors.accent : undefined}>
              {i === sel ? glyphs.prompt : ' '}{' '}
            </Text>
            <Text color={p.current ? colors.ok : undefined}>
              {p.current ? glyphs.check : ' '}{' '}
            </Text>
            <Text color={i === sel ? colors.accent : undefined}>{p.name.padEnd(12)}</Text>
            {p.hasKey ? (
              <Text color={colors.dim}>
                {p.masked} {glyphs.bullet} {p.varName} from {p.origin}
              </Text>
            ) : (
              <Text color={colors.warn}>no key {glyphs.bullet} enter to add one</Text>
            )}
          </Box>
        ))}
      </Box>

      {editing ? (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={colors.accent}>{row.name} key: </Text>
            {/* Never the value. A pane is a screen, and a screen gets shoulder-surfed,
                screen-shared and screenshotted. */}
            <Text>{'•'.repeat(Math.min(value.length, 40))}</Text>
            <Text inverse> </Text>
            {value.length ? <Text color={colors.dim}> {value.length} chars</Text> : null}
          </Box>
          <Text color={colors.dim}>
            will be written as {row.varName} {glyphs.bullet} enter verify and set{' '}
            {glyphs.bullet} tab {persist ? 'session only' : 'also save to .env'}{' '}
            {glyphs.bullet} esc cancel
          </Text>
          {busy ? <Text color={colors.dim}>verifying against {row.name}…</Text> : null}
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text color={colors.dim}>
            enter/e add or replace a key {glyphs.bullet} x clear {glyphs.bullet} tab{' '}
            {persist ? 'session only' : 'save to .env'} {glyphs.bullet} esc close
          </Text>
          <Text color={colors.dim}>
            also read: {row?.acceptedVars.join(', ')}
          </Text>
        </Box>
      )}
    </Box>
  );
}