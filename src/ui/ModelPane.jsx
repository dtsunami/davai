import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  PROVIDERS,
  modelsFor,
  refineModel,
  fetchOpenRouterCatalog,
} from '../config/models.js';
import { listRemoteModels, createProvider } from '../providers/index.js';
import { saveSettings } from '../config/settings.js';
import { colors, glyphs, formatTokens } from './theme.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * /model (req 15): shows what's available and lets you change it live.
 * Includes live search/filtering (`/` or just typing on OpenRouter) and rich metadata
 * from OpenRouter's model catalog (context window, prompt/completion pricing, vision).
 */
export function ModelPane({ session, onClose, push }) {
  const { cfg, ledger, agent } = session;
  const [tab, setTab] = useState('models'); // 'models' | 'settings'
  const [sel, setSel] = useState(0);
  const [remote, setRemote] = useState(null); // array of strings or ModelSpecs
  const [loading, setLoading] = useState(false);
  // Guards the auto-load below. `remote`/`loading` cannot: a rejected fetch leaves both
  // in the state that re-triggers the effect.
  const catalogTried = useRef(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState(() => session.modelSearch || '');
  useEffect(() => { delete session.modelSearch; }, [session]);
  const [, force] = useState(0);

  // Auto-load the OpenRouter catalog when opening /model on openrouter so the user
  // immediately gets the full searchable model list with pricing and context sizes.
  // The ref, not `remote`/`loading`, is what stops it retrying: both of those are
  // dependencies, so a rejected fetch — leaving remote null and loading false —
  // re-ran the effect and refetched forever. A failure now reports and stops.
  useEffect(() => {
    if (cfg.provider !== 'openrouter' || remote || catalogTried.current) return;
    catalogTried.current = true;
    setLoading(true);
    fetchOpenRouterCatalog({ baseURL: cfg.baseURL })
      .then((specs) => setRemote(specs))
      .catch((err) =>
        push({
          type: 'warning',
          message: `model catalog failed: ${err.message} ${glyphs.bullet} r to retry`,
        }),
      )
      .finally(() => setLoading(false));
  }, [cfg.provider, cfg.baseURL, remote, push]);

  const providerModels = modelsFor(cfg.provider);
  const known = new Set(providerModels.map((m) => m.id));
  const remoteRows = (remote || []).map((item) =>
    typeof item === 'string' ? { id: item, remoteOnly: true } : item,
  );
  // If remote returned full specs (OpenRouter), merge them over the seed list.
  const byId = new Map();
  for (const m of providerModels) byId.set(m.id, m);
  for (const r of remoteRows) {
    if (!known.has(r.id) || !r.remoteOnly) byId.set(r.id, r);
  }
  const allModels = [...byId.values()];
  const q = query.trim().toLowerCase();
  const filteredModels = q
    ? allModels.filter(
        (m) =>
          m.id.toLowerCase().includes(q) ||
          (m.label && m.label.toLowerCase().includes(q)),
      )
    : allModels;

  const rows = tab === 'models' ? filteredModels : EFFORTS;

  useEffect(() => {
    const i = rows.findIndex((r) => (tab === 'models' ? r.id === cfg.model.id : r === cfg.effort));
    setSel(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, cfg.provider]);

  const applyModel = async (id) => {
    if (!id) return;
    try {
      const { loadConfig, applyModelLimits } = await import('../config/env.js');
      const next = loadConfig({
        cwd: cfg.cwd,
        overrides: { DAVAI_PROVIDER: cfg.provider, DAVAI_MODEL: id, DAVAI_EFFORT: cfg.effort },
      });
      await refineModel(next.model, { apiKey: cfg.keys[cfg.provider], baseURL: cfg.baseURL });

      cfg.model = next.model;
      const notices = applyModelLimits(cfg);
      ledger.limit = cfg.contextLimit;
      agent.provider = createProvider(cfg);

      saveSettings(cfg.home, { provider: cfg.provider, model: id, effort: cfg.effort });
      for (const message of notices) push({ type: 'warning', message });
      push({
        type: 'notice',
        message: `model ${glyphs.arrow} ${id} (${formatTokens(cfg.contextLimit)} context)`,
      });
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
    setQuery('');
    setSearching(false);
    // A different provider means a different catalog; switching back should retry.
    catalogTried.current = false;
    force((n) => n + 1);
  };

  const refreshModels = () => {
    // An explicit refresh owns the fetch; mark it tried so the auto-load effect does
    // not race a second one alongside it.
    catalogTried.current = true;
    setLoading(true);
    const p =
      cfg.provider === 'openrouter'
        ? fetchOpenRouterCatalog({ baseURL: cfg.baseURL, force: true })
        : listRemoteModels(cfg);
    p.then((res) => setRemote(res))
      .catch((err) => push({ type: 'warning', message: `model list failed: ${err.message}` }))
      .finally(() => setLoading(false));
  };

  useInput((input, key) => {
    if (searching) {
      if (key.escape) {
        if (query) setQuery('');
        setSearching(false);
        return;
      }
      if (key.return) {
        if (rows[sel]) applyModel(rows[sel].id);
        else if (query.trim()) applyModel(query.trim());
        return;
      }
      if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
      if (key.downArrow) return setSel((s) => Math.min(Math.max(0, rows.length - 1), s + 1));
      if (key.backspace || key.delete) {
        setQuery((prev) => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((prev) => prev + input);
      }
      return;
    }

    if (key.escape || input === 'q') return onClose();
    if (key.tab) return setTab((t) => (t === 'models' ? 'settings' : 'models'));
    if (key.upArrow || input === 'k') return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow || input === 'j')
      return setSel((s) => Math.min(Math.max(0, rows.length - 1), s + 1));
    if (key.leftArrow) return cycleProvider(-1);
    if (key.rightArrow) return cycleProvider(1);

    if (input === '/' && tab === 'models') {
      setSearching(true);
      return;
    }

    if (input === 'r' && tab === 'models') {
      refreshModels();
      return;
    }

    if (key.return) {
      if (tab === 'models' && rows[sel]) applyModel(rows[sel].id);
      else if (tab === 'settings' && rows[sel]) applyEffort(rows[sel]);
    }
  });

  // Scroll window around `sel` so 300+ OpenRouter models can be browsed smoothly.
  const pageSize = 14;
  const startIdx = Math.max(
    0,
    Math.min(sel - Math.floor(pageSize / 2), Math.max(0, rows.length - pageSize)),
  );
  const visibleRows = tab === 'models' ? rows.slice(startIdx, startIdx + pageSize) : rows;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text bold color={colors.accent}>
            {tab === 'models' ? 'Models' : 'Settings'}
          </Text>
          <Text color={colors.dim}>{'  '}provider </Text>
          <Text color={colors.accent}>{cfg.provider}</Text>
          <Text color={colors.dim}> (←/→ change)</Text>
          {loading ? <Text color={colors.dim}>{'  '}loading catalog…</Text> : null}
        </Box>
        {tab === 'models' ? (
          <Text color={colors.dim}>
            {rows.length} model{rows.length === 1 ? '' : 's'}
          </Text>
        ) : null}
      </Box>

      {tab === 'models' && (searching || query) ? (
        <Box marginTop={1}>
          <Text color={colors.accent}>filter/id: </Text>
          <Text>{query}</Text>
          {searching ? <Text inverse> </Text> : null}
          {!rows.length && query.trim() ? (
            <Text color={colors.dim}>
              {'  '}(enter to use custom id &quot;{query.trim()}&quot;)
            </Text>
          ) : null}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {tab === 'models'
          ? visibleRows.map((m, idx) => {
              const i = startIdx + idx;
              return (
                <Box key={m.id}>
                  <Text color={i === sel ? colors.accent : undefined}>
                    {i === sel ? glyphs.prompt : ' '}{' '}
                  </Text>
                  <Text color={m.id === cfg.model.id ? colors.ok : undefined}>
                    {m.id === cfg.model.id ? glyphs.check : ' '}{' '}
                  </Text>
                  <Text color={i === sel ? colors.accent : undefined}>{m.id.padEnd(34)}</Text>
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
              );
            })
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
          enter apply {glyphs.bullet} {tab === 'models' ? `/ search/custom id ${glyphs.bullet} r refresh ${glyphs.bullet} ` : ''}
          tab {tab === 'models' ? 'settings' : 'models'} {glyphs.bullet} esc close
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
