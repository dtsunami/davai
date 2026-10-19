import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { profileState, switchProfile, chooseProfileVar } from '../session/profiles.js';
import { colors, glyphs } from './theme.js';

/**
 * /env — the provider blocks in $DAVAI_HOME/.env, and which one is live.
 *
 * Switching here does exactly what editing the file by hand would: comment the old
 * block's assignments, uncomment the new one's. Nothing is deleted, so the pane is a
 * safe thing to press enter in — the worst case is a switch back, which restores the
 * file byte for byte.
 *
 * A block often holds several candidates for the same setting — four OpenRouter models,
 * each under the note saying why. Expanding the block shows them as a one-hot group:
 * the duplicates used to be summarised as "shadowed: DAVAI_MODEL, DAVAI_MODEL" and could
 * only be chosen between in an editor.
 *
 * The machinery is session/profiles.js, shared with the browser. What lives here is the
 * keyboard and the layout, the same split as KeyPane and ModelPane.
 */
export function EnvPane({ session, onClose, push }) {
  const { cfg } = session;
  const [state, setState] = useState(() => profileState(cfg));
  const [sel, setSel] = useState(() => Math.max(0, state.blocks.findIndex((b) => b.enabled)));
  const [csel, setCsel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const row = state.blocks[sel];
  // Every duplicate assignment in the expanded block, flattened: these are the rows the
  // cursor walks once a block is open.
  const choices =
    expanded && row
      ? row.vars.flatMap((v) => v.choices.map((c) => ({ ...c, var: v.name })))
      : [];

  const after = (r) => {
    for (const message of r.notices) push({ type: 'warning', message });
    setState(profileState(cfg));
  };

  const apply = async (name) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await switchProfile(session, name);
      after(r);
      push({
        type: 'notice',
        message: r.block
          ? `${r.block} is live ${glyphs.bullet} ${r.provider} ${glyphs.arrow} ${r.model}` +
            (r.baseURL ? ` at ${r.baseURL}` : '')
          : `all provider blocks disabled ${glyphs.bullet} ${r.provider} ${glyphs.arrow} ${r.model}`,
      });
    } catch (err) {
      push({ type: 'error', message: err.message });
      // The switch rolled the file back, so the pane must not keep showing the block
      // as live.
      setState(profileState(cfg));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Pick one of several assignments of the same name, and make its block live. Choosing
   * a model inside a block you are not running and staying where you are is a distinction
   * nobody wants at the keyboard; the file keeps the choice either way.
   */
  const choose = async (c) => {
    if (busy || !row) return;
    setBusy(true);
    try {
      const r = await chooseProfileVar(session, { block: row.name, name: c.var, line: c.line });
      after(r);
      push({
        type: 'notice',
        message:
          `${r.block} ${glyphs.bullet} ${r.name}=${r.value} ${glyphs.bullet} ` +
          `${r.provider} ${glyphs.arrow} ${r.model}`,
      });
    } catch (err) {
      push({ type: 'error', message: err.message });
      setState(profileState(cfg));
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (busy) return;
    if (key.escape || input === 'q') return onClose();
    if (input === ' ') {
      setCsel(0);
      return setExpanded((e) => !e);
    }
    // While a block with alternatives is open the cursor belongs to the options; this is
    // the only state in which enter means "pick this value" rather than "make this block
    // live".
    if (choices.length) {
      if (key.upArrow || input === 'k') return setCsel((s) => Math.max(0, s - 1));
      if (key.downArrow || input === 'j')
        return setCsel((s) => Math.min(choices.length - 1, s + 1));
      if (key.return) return choose(choices[csel]);
    }
    if (key.upArrow || input === 'k') {
      setCsel(0);
      return setSel((s) => Math.max(0, s - 1));
    }
    if (key.downArrow || input === 'j') {
      setCsel(0);
      return setSel((s) => Math.min(state.blocks.length - 1, s + 1));
    }
    if (input === '0') return apply(null);
    if (key.return && row) return apply(row.name);
  });

  if (!state.blocks.length) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
        <Text bold color={colors.accent}>
          Provider blocks
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={colors.dim}>None in {state.file}.</Text>
          <Text color={colors.dim}>A block is a sentinel comment and the settings under it:</Text>
          <Text> </Text>
          <Text color={colors.accent}> #---# mistral</Text>
          <Text color={colors.dim}> DAVAI_PROVIDER=openai</Text>
          <Text color={colors.dim}> DAVAI_BASE_URL=https://api.mistral.ai/v1</Text>
          <Text color={colors.dim}> DAVAI_OPENAI_API_KEY=sk-...</Text>
          <Text color={colors.accent}> {'#-end-provider-#'}</Text>
          <Text> </Text>
          <Text color={colors.dim}>
            It ends at the next sentinel, at {'#-end-provider-#'}, or at end of file.
          </Text>
          <Text color={colors.dim}>esc close</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={colors.accent}>
          Provider blocks
        </Text>
        <Text color={colors.dim}>{state.file}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {state.blocks.map((b, i) => {
          const opts = b.vars.filter((v) => v.choices.length);
          return (
            <Box key={`${b.name}-${b.line}`}>
              <Text color={i === sel ? colors.accent : undefined}>
                {i === sel ? glyphs.prompt : ' '}{' '}
              </Text>
              <Text color={b.enabled ? colors.ok : undefined}>
                {b.enabled ? glyphs.check : ' '}{' '}
              </Text>
              <Text color={i === sel ? colors.accent : undefined}>{b.name.padEnd(14)}</Text>
              <Text color={colors.dim}>
                {b.note ? `(${b.note}) ` : ''}
                {[b.provider, b.baseURL].filter(Boolean).join(` ${glyphs.arrow} `) ||
                  b.vars.map((v) => v.name).join(', ')}
                {opts.length
                  ? ` ${glyphs.bullet} ${opts
                      .map((v) => `${v.choices.length} ${v.name.replace(/^DAVAI_/, '').toLowerCase()}s`)
                      .join(', ')}`
                  : ''}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Two blocks live at once is not something the pane can cause, but a
          hand-edited file can, and the symptom — the last one silently winning — is
          worth naming rather than leaving to be discovered. */}
      {state.active.length > 1 ? (
        <Box marginTop={1}>
          <Text color={colors.warn}>
            {glyphs.warn} {state.active.join(' and ')} are both live {glyphs.bullet} the last in
            the file wins {glyphs.bullet} enter fixes it
          </Text>
        </Box>
      ) : null}

      {expanded && row ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={colors.dim}>
            {row.name} {glyphs.bullet} line {row.line}
            {row.closed ? '' : ` ${glyphs.bullet} no ${'#-end-provider-#'}`}
          </Text>
          {row.vars.map((v) =>
            v.choices.length ? (
              <Box key={v.name} flexDirection="column">
                <Text color={colors.dim}>
                  {'  '}
                  {v.name} {glyphs.bullet} {v.choices.length} options, one live
                </Text>
                {v.choices.map((c) => {
                  const at = choices.findIndex((x) => x.var === v.name && x.line === c.line);
                  const cur = at === csel;
                  return (
                    <Text
                      key={c.line}
                      color={cur ? colors.accent : c.chosen ? undefined : colors.dim}
                    >
                      {'    '}
                      {cur ? glyphs.prompt : ' '} {c.chosen ? `(${glyphs.pin})` : '( )'} {c.value}
                    </Text>
                  );
                })}
              </Box>
            ) : (
              <Text key={v.name} color={v.enabled ? undefined : colors.dim}>
                {'  '}
                {v.enabled ? ' ' : '#'}
                {/* profileState masked the secrets; this renders what it was given. */}
                {v.name}={v.value}
              </Text>
            ),
          )}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {state.preamble.length ? (
          <Text color={colors.dim}>
            always applied, above the blocks: {state.preamble.join(', ')}
          </Text>
        ) : null}
        <Text color={colors.dim}>
          {busy
            ? 'switching…'
            : choices.length
              ? `enter use this value ${glyphs.bullet} ${glyphs.prompt} picks ${glyphs.bullet} space back to blocks ${glyphs.bullet} esc close`
              : `enter make live ${glyphs.bullet} space show settings ${glyphs.bullet} 0 disable all ${glyphs.bullet} esc close`}
        </Text>
      </Box>
    </Box>
  );
}