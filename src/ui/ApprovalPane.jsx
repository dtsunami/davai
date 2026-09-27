import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors, glyphs } from './theme.js';

/**
 * Shell approval (req 8). Shell is the one irreversible op, so it stops here and
 * waits for a human. Editing before running is offered because the common case is
 * "almost right".
 */
export function ApprovalPane({ request, onRespond }) {
  const [editing, setEditing] = useState(null);

  useInput((input, key) => {
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

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.warn} paddingX={1} marginTop={1}>
      <Text bold color={colors.warn}>
        {glyphs.warn} shell command needs approval
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

      <Box marginTop={1}>
        <Text color={colors.dim}>
          {editing !== null
            ? 'enter run edited · esc cancel edit'
            : 'y run · n deny · e edit first · this cannot be undone'}
        </Text>
      </Box>
    </Box>
  );
}
