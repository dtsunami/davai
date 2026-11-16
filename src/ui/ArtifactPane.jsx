import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { colors, glyphs } from './theme.js';
import { suggestName } from '../context/artifacts.js';
import { completeInput } from './complete.js';
import { HighlightedInput } from './highlight.jsx';
import { useLineEditor } from './editor.js';

/**
 * Artifacts (req 7): every non-da_ops fenced block, copyable to the clipboard or
 * saveable to a file through the same write jail and journal as any other write.
 */
export function ArtifactPane({ artifacts, session, width, onClose, push }) {
  const [sel, setSel] = useState(Math.max(0, artifacts.items.length - 1));
  const [isSaving, setIsSaving] = useState(false);
  const [preview, setPreview] = useState(false);

  const items = artifacts.items;
  const current = items[sel];

  useEffect(() => {
    if (!session) return undefined;
    session._paneEditing = isSaving;
    return () => {
      session._paneEditing = false;
    };
  }, [session, isSaving]);

  const pathEditor = useLineEditor({
    initialValue: '',
    isActive: isSaving,
    multiline: false,
    complete: (val, cur) => completeInput(val, cur, session, { mode: 'path' }),
    onSubmit: (dest) => {
      if (!dest.trim() || !current) return;
      try {
        const r = artifacts.save(current.n, dest.trim(), {
          sandbox: session.sandbox,
          journal: session.journal,
        });
        push({
          type: 'notice',
          message: `artifact #${current.n} ${glyphs.arrow} ${r.path}${r.overwrote ? ' (overwrote)' : ''}`,
        });
        setIsSaving(false);
        onClose();
      } catch (err) {
        push({ type: 'error', message: err.message });
        setIsSaving(false);
      }
    },
    onEscape: () => setIsSaving(false),
    onEffect: (effect) => {
      if (effect.type === 'ctrl' && effect.key === 'c') setIsSaving(false);
    },
  });

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') return onClose();
      if (!items.length) return;
      if (key.upArrow || input === 'k') return setSel((s) => Math.max(0, s - 1));
      if (key.downArrow || input === 'j') return setSel((s) => Math.min(items.length - 1, s + 1));
      if (input === 'v' || key.return) return setPreview((p) => !p);
      if (input === 's') {
        const suggested = suggestName(current);
        pathEditor.setBuffer(suggested, suggested.length);
        setIsSaving(true);
        return;
      }
      if (input === 'c') {
        artifacts
          .copy(current.n)
          .then(() => {
            push({ type: 'notice', message: `artifact #${current.n} copied to clipboard` });
            onClose();
          })
          .catch((err) => push({ type: 'error', message: err.message }));
      }
    },
    { isActive: !isSaving },
  );

  if (!items.length) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
        <Text bold color={colors.accent}>
          Artifacts
        </Text>
        <Text color={colors.dim}>
          None yet. Fenced code blocks the model emits (other than da_ops) land here.
        </Text>
        <Text color={colors.dim}>esc to close</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Text bold color={colors.accent}>
        Artifacts ({items.length})
      </Text>

      <Box marginTop={1} flexDirection="column">
        {items.map((a, i) => (
          <Box key={a.n}>
            <Text color={i === sel ? colors.accent : undefined}>
              {i === sel ? glyphs.prompt : ' '} #{a.n}{' '}
            </Text>
            <Text color={i === sel ? colors.accent : undefined}>{a.lang.padEnd(12)}</Text>
            <Text color={colors.dim}>
              {String(a.lines).padStart(5)} lines {String(a.bytes).padStart(7)} bytes
            </Text>
            <Text color={colors.dim}>{'  '}{firstLine(a.text, width - 45)}</Text>
          </Box>
        ))}
      </Box>

      {preview && current ? (
        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor={colors.dim} paddingX={1}>
          {current.text.split('\n').slice(0, 20).map((l, i) => (
            <Text key={i}>{l.slice(0, width - 8)}</Text>
          ))}
          {current.lines > 20 ? <Text color={colors.dim}>{glyphs.ellipsis} truncated</Text> : null}
        </Box>
      ) : null}

      {isSaving ? (
        <Box marginTop={1} flexDirection="column">
          <HighlightedInput
            value={pathEditor.value}
            cursor={pathEditor.cursor}
            mode="path"
            sandbox={session?.sandbox}
            prefix={<Text color={colors.accent}>save as: </Text>}
          />
          {pathEditor.hint ? <Text color={colors.dim}>  {pathEditor.hint}</Text> : null}
          <Text color={colors.dim}>
            enter save {glyphs.bullet} tab complete path {glyphs.bullet} esc cancel
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={colors.dim}>
            j/k move {glyphs.bullet} v preview {glyphs.bullet} c copy {glyphs.bullet} s save {glyphs.bullet} esc close
          </Text>
        </Box>
      )}
    </Box>
  );
}

function firstLine(text, max) {
  const l = text.split('\n').find((x) => x.trim()) || '';
  const t = l.trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)) + glyphs.ellipsis : t;
}