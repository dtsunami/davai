import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { MODELS, PROVIDERS, modelsFor, refineModel } from '../config/models.js';
import { listRemoteModels, createProvider } from '../providers/index.js';
import { saveSettings } from '../config/settings.js';
import { colors, glyphs, formatTokens } from './theme.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * /model (req 15): shows what's available and lets you change it live.
 * Changes are applied to the running session and persisted to settings.json.
 */
export function ModelPane({ session, width, onClose, push }) {
  const { cfg, ledger, agent } = session;
  const [tab, setTab] = useState('models'); // 'models' | 'settings'
  const [sel, setSel] = useState(0);
  const [remote, setRemote] = useState(null);
  const [loading, setLoading] = useState(false);
  const [, force] = useState(0);

  const providerModels = modelsFor(cfg.provider);
  const known = new Set(providerModels.map((m) => m.id));
  const extras = (remote || []).filter((id) => !known.has(id)).map((id) => ({ id, remoteOnly: true }));
  const rows = tab === 'models' ? [...providerModels, ...extras] : EFFORTS;

  useEffect(() => {
    const i = rows.findIndex((r) => (tab === 'models' ? r.id === cfg.model.id : r === cfg.effort));
    if (i >= 0) setSel(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const applyModel = async (id) => {
    try {
      const { loadConfig } = await import('../config/env.js');
      const next = loadConfig({
        cwd: cfg.cwd,
        overrides: { DAVAI_PROVIDER: cfg.provider, DAVAI_MODEL: id, DAVAI_EFFORT: cfg.effort },
      });
      await refineModel(next.model, { apiKey: cfg.keys[cfg.provider] });

      cfg.model = next.model;
      cfg.maxTokens = Math.min(next.model.maxOutput, cfg.maxTokens);
      cfg.contextLimit = next.model.context;
      ledger.limit = next.model.context;
      agent.provider = createProvider(cfg);

      saveSettings(cfg.home, { provider: cfg.provider, model: id, effort: cfg.effort });
      push({ type: 'notice', message: `model ${glyphs.arrow} ${id} (${formatTokens(next.model.context)} context)` });
      onClose();
    } catch (err) {
      push({ type: 'error', message: `could not switch model: ${err.message}` });
    }
  };

  const applyEffort = (effort) => {
    cfg.effort = effort;
    agent.provider = createProvider(cfg);
    saveSettings(cfg.home, { provider: cfg.provider, model: cfg.model.id, effort });
    push({ type: 'notice', message: `effort ${glyphs.arrow} ${effort}` });
    onClose();
  };

  const cycleProvider = (dir) => {
    const i = PROVIDERS.indexOf(cfg.provider);
    const next = PROVIDERS[(i + dir + PROVIDERS.length) % PROVIDERS.length];
    if (!cfg.keys[next]) {
      push({ type: 'warning', message: `no API key configured for ${next}` });
      return;
    }
    cfg.provider = next;
    setRemote(null);
    force((n) => n + 1);
  };

  useInput((input, key) => {
    if (key.escape || input === 'q') return onClose();
    if (key.tab) return setTab((t) => (t === 'models' ? 'settings' : 'models'));
    if (key.upArrow || input === 'k') return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') return setSel((s) => Math.min(rows.length - 1, s + 1));
    if (key.leftArrow) return cycleProvider(-1);
    if (key.rightArrow) return cycleProvider(1);

    if (input === 'r' && tab === 'models') {
      setLoading(true);
      listRemoteModels(cfg)
        .then((ids) => setRemote(ids))
        .catch((err) => push({ type: 'warning', message: `model list failed: ${err.message}` }))
        .finally(() => setLoading(false));
      return;
    }

    if (key.return) {
      if (tab === 'models') applyModel(rows[sel].id);
      else applyEffort(rows[sel]);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Box>
        <Text bold color={colors.accent}>
          {tab === 'models' ? 'Models' : 'Settings'}
        </Text>
        <Text color={colors.dim}>
          {'  '}provider{' '}
        </Text>
        <Text color={colors.accent}>{cfg.provider}</Text>
        <Text color={colors.dim}> ({glyphs.arrow} arrows to change)</Text>
        {loading ? <Text color={colors.dim}>{'  '}loading…</Text> : null}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {tab === 'models'
          ? rows.slice(0, 16).map((m, i) => (
              <Box key={m.id}>
                <Text color={i === sel ? colors.accent : undefined}>
                  {i === sel ? glyphs.prompt : ' '}{' '}
                </Text>
                <Text color={m.id === cfg.model.id ? colors.ok : undefined}>
                  {m.id === cfg.model.id ? glyphs.check : ' '}{' '}
                </Text>
                <Text color={i === sel ? colors.accent : undefined}>{m.id.padEnd(30)}</Text>
                {m.remoteOnly ? (
                  <Text color={colors.dim}>from provider (no local metadata)</Text>
                ) : (
                  <>
                    <Text color={colors.dim}>{formatTokens(m.context).padStart(6)} ctx </Text>
                    <Text color={colors.dim}>
                      {m.inputPrice == null
                        ? '  price n/a'
                        : `$${m.inputPrice}/$${m.outputPrice} per Mtok`}
                    </Text>
                    <Text color={colors.dim}>{m.vision ? '  vision' : ''}</Text>
                  </>
                )}
              </Box>
            ))
          : rows.map((e, i) => (
              <Box key={e}>
                <Text color={i === sel ? colors.accent : undefined}>
                  {i === sel ? glyphs.prompt : ' '}{' '}
                </Text>
                <Text color={e === cfg.effort ? colors.ok : undefined}>
                  {e === cfg.effort ? glyphs.check : ' '}{' '}
                </Text>
                <Text color={i === sel ? colors.accent : undefined}>{e.padEnd(10)}</Text>
                <Text color={colors.dim}>{EFFORT_HELP[e]}</Text>
              </Box>
            ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={colors.dim}>
          enter apply {glyphs.bullet} tab {tab === 'models' ? 'settings' : 'models'} {glyphs.bullet}{' '}
          {tab === 'models' ? 'r refresh from provider ' : ''}
          {glyphs.bullet} esc close
        </Text>
        <Text color={colors.dim}>
          max output {formatTokens(cfg.maxTokens)} {glyphs.bullet} compact at{' '}
          {Math.round(cfg.compactAt * 100)}% {glyphs.bullet} set via .env
        </Text>
      </Box>
    </Box>
  );
}

const EFFORT_HELP = {
  low: 'fastest, cheapest — simple edits',
  medium: 'balanced',
  high: 'default — most coding work',
  xhigh: 'harder problems, more tool calls',
  max: 'correctness over cost',
};
