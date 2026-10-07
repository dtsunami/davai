import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors, glyphs } from './theme.js';

/**
 * Shell approval (req 8). Shell is the one irreversible op, so it stops here and
 * waits for a human. Editing before running is offered because the common case is
 * "almost right".
 *
 * When the command calls sudo and sudo wants a password, the same pane collects it
 * (`request.sudo.state === 'password'`): typing it and pressing enter approves and
 * supplies it in one step. The executor checks it before anything runs and comes back
 * with `request.sudo.retry` if it was wrong. The password goes to `onRespond` and
 * nowhere else: not the transcript, the session log or the model.
 */
export function ApprovalPane({ request, onRespond }) {
  const [editing, setEditing] = useState(null);
  const [secret, setSecret] = useState('');
  const sudo = request.sudo?.state === 'password' ? request.sudo : null;

  useInput((input, key) => {
    if (sudo) {
      if (key.escape) {
        return onRespond({ allow: false, reason: 'operator did not give the sudo password' });
      }
      if (key.return) return secret ? onRespond({ allow: true, secret }) : undefined;
      if (key.backspace || key.delete) return setSecret((s) => s.slice(0, -1));
      if (input && !key.ctrl && !key.meta) {
        return setSecret((s) => s + input.replace(/[\r\n]/g, ''));
      }
      return;
    }

    if (editing !== null) {
      if (key.escape) return setEditing(null);
      if (key.return) return onRespond({ allow: true, cmd: editing });
      if (key.backspace || key.delete) return setEditing((s) => s.slice(0, -1));
      if (input && !key.ctrl && !key.meta) return setEditing((s) => s + input);
      return;
    }

    if (input === 'y' || key.return) return onRespond({ allow: true });
    if (input === 'n' || key.escape) return onRespond({ allow: false });
    if (input === 'e') return setEditing(request.op.cmd);
  });

  let help = 'y run · n deny · e edit first · this cannot be undone';
  if (sudo) {
    help = request.operator
      ? 'enter run · esc cancel · kept in memory only, never logged'
      : 'enter approve and run · esc deny · kept in memory only, never logged';
  }
  else if (editing !== null) help = 'enter run edited · esc cancel edit';

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

      <Box marginTop={1}>
        <Text color={colors.dim}>$ </Text>
        {editing !== null ? (
          <>
            <Text>{editing}</Text>
            <Text inverse> </Text>
          </>
        ) : (
          <Text bold>{request.op.cmd}</Text>
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
            <Text>{glyphs.pin.repeat(secret.length)}</Text>
            <Text inverse> </Text>
          </Box>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={colors.dim}>{help}</Text>
      </Box>
    </Box>
  );
}