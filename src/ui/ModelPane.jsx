import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { PROVIDERS } from '../config/models.js';
import {
  EFFORTS,
  EFFORT_HELP,
  loadCatalog,
  applyModelChange,
} from '../session/models.js';
import { colors, glyphs, formatTokens } from './theme.js';

/**
 * /model (req 15): shows what's available and lets you change it live.
 * Includes live search/filtering (`/` or just typing on OpenRouter) and rich metadata
 * from OpenRouter's model catalog (context window, prompt/completion pricing, vision).
 *
 * The catalog merge and the switch itself live in session/models.js, because the web
 * sidecar does both too. What stays here is the keyboard and the layout.
 */
export function ModelPane({ session, onClose, push }) {
  const { cfg } = session;
  const [tab, setTab] = useState('models'); // 'models' | 'settings'
  const [sel, setSel] = useState(0);
  const [catalog, setCatalog] = useState(null); // ModelSpec[]
  const [loading, setLoading] = useState(false);
  // Guards the auto-load below. `catalog`/`loading` cannot: a rejected fetch leaves both
  // in the state that re-triggers the effect.
  const catalogTried = useRef(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState(() => session.modelSearch || '');
  useEffect(() => { delete session.modelSearch; }, [session]);
  const [, force] = useState(0);

  // Load the list on open — the full OpenRouter catalog with pricing and context sizes
  // where there is one, the seed otherwise. The ref, not `catalog`/`loading`, is what
  // stops it retrying: both of those are dependencies, so a rejected fetch — leaving
  // catalog null and loading false — re-ran the effect and refetched forever. A failure
  // now reports and stops.
  useEffect(() => {
    if (catalogTried.current) return;
    catalogTried.current = true;
    setLoading(true);
    loadCatalog(cfg, { provider: browsing })
      .then(({ models, error }) => {
        setCatalog(models);
        if (error) {
          push({
            type: 'warning',
            message: `model catalog failed: ${error} ${glyphs.bullet} r to retry`,
          });
        }
      })
      .finally(() => setLoading(false));
    // `browsing` is read for the initial provider only — the ref makes this run once, and
    // every later change goes through cycleProvider, which fetches for itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, push]);

  const allModels = catalog || [];
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
  }, [tab, q, browsing]);

  const change = async (want, describe) => {
    try {
      const r = await applyModelChange(session, want);
      for (const message of r.notices) push({ type: 'warning', message });
      push({ type: 'notice', message: describe(r) });
      onClose();
    } catch (err) {
      push({ type: 'error', message: `could not switch: ${err.message}` });
    }
  };

  const applyModel = (id) =>
    id &&
    change(
      { provider: browsing, model: id },
      (r) => `model ${glyphs.arrow} ${id} (${r.provider}, ${formatTokens(r.contextLimit)} context)`,
    );

  const applyEffort = (effort) => change({ effort }, () => `effort ${glyphs.arrow} ${effort}`);

  // Browsing a provider is not switching to it: the model list is shown, and the switch
  // happens when a model is chosen. Previously this wrote cfg.provider immediately, so
  // arrowing past a provider and pressing esc left the session pointing at a provider
  // whose model id it was not using.
  const [browsing, setBrowsing] = useState(() => session.modelBrowse || cfg.provider);
  useEffect(() => { delete session.modelBrowse; }, [session]);
  const cycleProvider = (dir) => {
    const i = PROVIDERS.indexOf(browsing);
    const next = PROVIDERS[(i + dir + PROVIDERS.length) % PROVIDERS.length];
    if (!cfg.keys[next]) {
      push({ type: 'warning', message: `no API key configured for ${next}` });
      return;
    }
    setBrowsing(next);
    setQuery('');
    setSearching(false);
    setLoading(true);
    loadCatalog(cfg, { provider: next })
      .then(({ models, error }) => {
        setCatalog(models);
        if (error) push({ type: 'warning', message: `model list failed: ${error}` });
      })
      .finally(() => setLoading(false));
    force((n) => n + 1);
  };

  const refreshModels = () => {
    setLoading(true);
    loadCatalog(cfg, { provider: browsing, force: true })
      .then(({ models, error }) => {
        setCatalog(models);
        if (error) push({ type: 'warning', message: `model list failed: ${error}` });
      })
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

  // The checkmark means "this is what the session is running", so it only applies while
  // the list being browsed is the active provider's.
  const isCurrent = (m) => browsing === cfg.provider && m.id === cfg.model.id;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Box justifyContent="space-between">
        <Box>
          <Text bold color={colors.accent}>
            {tab === 'models' ? 'Models' : 'Settings'}
          </Text>
          <Text color={colors.dim}>{'  '}provider </Text>
          <Text color={browsing === cfg.provider ? colors.accent : colors.warn}>{browsing}</Text>
          <Text color={colors.dim}>
            {browsing === cfg.provider ? ' (←/→ change)' : ` (←/→ ${glyphs.bullet} enter to switch from ${cfg.provider})`}
          </Text>
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
                  <Text color={isCurrent(m) ? colors.ok : undefined}>
                    {isCurrent(m) ? glyphs.check : ' '}{' '}
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


