import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors, glyphs } from './theme.js';
import { completeInput } from './complete.js';
import { HighlightedInput } from './highlight.jsx';
import { useLineEditor } from './editor.js';

/**
 * Shell approval (req 8). Shell is the one irreversible op, so it stops here and
 * waits for a human. Editing before running is offered because the common case is
 * "almost right" — with full shell cursor movement, Tab completion, and syntax
 * highlighting so fixing a flag or path mid-command feels identical to a shell.
 *
 * When the command calls sudo and sudo wants a password, the same pane collects it
 * (`request.sudo.state === 'password'`): typing it and pressing enter approves and
 * supplies it in one step.
 */
export function ApprovalPane({ request, session, onRespond }) {
  const [isEditing, setIsEditing] = useState(false);
  const sudo = request.sudo?.state === 'password' ? request.sudo : null;

  const cmdEditor = useLineEditor({
    initialValue: request.op.cmd || '',
    isActive: !sudo && isEditing,
    multiline: false,
    complete: (val, cur) =>
      completeInput(val, cur, session, { mode: 'shell', cwd: request.op.cwd }),
    onSubmit: (val) => {
      if (!val.trim()) return;
      onRespond({ allow: true, cmd: val });
    },
    onEscape: () => setIsEditing(false),
    onEffect: (effect) => {
      if (effect.type === 'ctrl' && effect.key === 'c') setIsEditing(false);
    },
  });

  const secretEditor = useLineEditor({
    initialValue: '',
    isActive: Boolean(sudo),
    multiline: false,
    onSubmit: (secret) => {
      if (secret) onRespond({ allow: true, secret });
    },
    onEscape: () =>
      onRespond({ allow: false, reason: 'operator did not give the sudo password' }),
    onEffect: (effect) => {
      if (effect.type === 'ctrl' && effect.key === 'c') {
        onRespond({ allow: false, reason: 'operator did not give the sudo password' });
      }
    },
  });

  useInput(
    (input, key) => {
      if (input === 'y' || key.return) return onRespond({ allow: true });
      if (input === 'n' || key.escape || (key.ctrl && input === 'c')) {
        return onRespond({ allow: false });
      }
      if (input === 'e') {
        cmdEditor.setBuffer(request.op.cmd || '', (request.op.cmd || '').length);
        setIsEditing(true);
      }
    },
    { isActive: !sudo && !isEditing },
  );

  let help = 'y run · n deny · e edit first · this cannot be undone';
  if (sudo) {
    help = request.operator
      ? 'enter run · esc cancel · kept in memory only, never logged'
      : 'enter approve and run · esc deny · kept in memory only, never logged';
  } else if (isEditing) {
    help = 'enter run edited · tab complete · ←/→/home/end/ctrl+w edit · esc cancel edit';
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.warn} paddingX={1} marginTop={1}>
      <Text bold color={colors.warn}>
        {glyphs.warn}{' '}
        {request.operator
          ? 'sudo password needed'
          : sudo
            ? 'shell command needs approval and a sudo password'
            : 'shell command needs approval'}
      </Text>

      <Box marginTop={1} flexDirection="column">
        {isEditing ? (
          <>
            <HighlightedInput
              value={cmdEditor.value}
              cursor={cmdEditor.cursor}
              mode="shell"
              sandbox={session?.sandbox}
              cwd={request.op.cwd}
              prefix={<Text color={colors.warn} bold>$ </Text>}
            />
            {cmdEditor.hint ? <Text color={colors.dim}>  {cmdEditor.hint}</Text> : null}
          </>
        ) : (
          <HighlightedInput
            value={request.op.cmd || ''}
            hideCursor
            mode="shell"
            sandbox={session?.sandbox}
            cwd={request.op.cwd}
            prefix={<Text color={colors.dim}>$ </Text>}
          />
        )}
      </Box>

      {request.op.cwd ? <Text color={colors.dim}>  in {request.op.cwd}</Text> : null}

      {sudo ? (
        <Box marginTop={1} flexDirection="column">
          {sudo.retry ? (
            <Text color={colors.err}>
              {glyphs.cross} {sudo.retry}
            </Text>
          ) : null}
          <Box>
            <Text>[sudo] password: </Text>
            {renderMaskedWithCursor(secretEditor.value.length, secretEditor.cursor)}
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={colors.dim}>{help}</Text>
      </Box>
    </Box>
  );
}

function renderMaskedWithCursor(length, cursor) {
  const masked = glyphs.pin.repeat(length);
  const clamped = Math.max(0, Math.min(length, cursor));
  const before = masked.slice(0, clamped * glyphs.pin.length);
  const at = clamped < length ? glyphs.pin : ' ';
  const after = clamped < length ? masked.slice((clamped + 1) * glyphs.pin.length) : '';
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}