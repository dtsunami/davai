import React from 'react';
import { Box, Text } from 'ink';
import { colors } from './theme.js';

/** Visual lines of reasoning kept on screen. The tail is what matters, not the head. */
const MAX_LINES = 6;

/**
 * Transient reasoning panel.
 *
 * It sits at the top of the dynamic region — above the streaming answer — and vanishes
 * the moment the model starts writing. It is not pinned to the top of the terminal:
 * davai prints its transcript as ordinary scrollback rather than taking over the screen,
 * so there is no fixed viewport to anchor to, and Ink has no absolute positioning. A
 * true header would mean the alternate screen buffer, which would cost the scrollback.
 *
 * Thoughts are never committed to <Static>. They are the model's working notes, they can
 * run longer than the answer, and scrollback is for what was decided.
 */
export function ThinkingBox({ text, width }) {
  const inner = Math.max(16, width - 6);
  const lines = wrapTail(text, inner, MAX_LINES);
  if (!lines.length) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={colors.dim}
      paddingX={1}
      marginLeft={1}
      width={Math.max(20, width - 2)}
    >
      <Text color={colors.dim} dimColor>
        thinking
      </Text>
      {lines.map((line, i) => (
        <Text key={i} color={colors.dim} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Soft-wrap to `width` and keep the last `maxLines`.
 *
 * Wrapping here rather than letting Ink do it is deliberate: Ink would wrap the whole
 * buffer and then the box would grow without bound, which pushes the composer off
 * screen on a long reasoning pass.
 */
export function wrapTail(text, width, maxLines) {
  const out = [];
  for (const paragraph of String(text || '').split('\n')) {
    if (!paragraph.trim()) continue;
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!line.length) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line.length) out.push(line);
  }
  return out.slice(-maxLines);
}
