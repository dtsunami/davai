import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  resolveModel,
  parseOpenRouterModel,
  refineModel,
} from '../src/config/models.js';
import { createProvider, maskKey, describeAuth } from '../src/providers/index.js';
import { createOpenAI } from '../src/providers/openai.js';
import {
  ThroughputTracker,
  renderSparkline,
  buildThroughputChart,
} from '../src/ui/throughput.js';

async function collect(gen) {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('OpenRouter provider & catalog integration', () => {
  it('registers openrouter in PROVIDERS and resolves seeded + arbitrary slug models', () => {
    expect(PROVIDERS).toContain('openrouter');
    const seeded = resolveModel('openrouter', 'anthropic/claude-sonnet-4.5');
    expect(seeded.provider).toBe('openrouter');
    expect(seeded.inputPrice).toBe(3);

    const custom = resolveModel('openrouter', 'meta-llama/llama-4-maverick');
    expect(custom.provider).toBe('openrouter');
    expect(custom.unverified).toBe(true);
    expect(custom.effort).toBe(true);
    expect(custom.thinking).toBe(true);
  });

  it('parses OpenRouter /api/v1/models entries into ModelSpecs with pricing per Mtok', () => {
    const spec = parseOpenRouterModel({
      id: 'anthropic/claude-3.7-sonnet',
      name: 'Anthropic: Claude 3.7 Sonnet',
      context_length: 200000,
      top_provider: { context_length: 200000, max_completion_tokens: 64000 },
      pricing: { prompt: '0.000003', completion: '0.000015' },
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: ['reasoning', 'temperature'],
    });
    expect(spec).toMatchObject({
      id: 'anthropic/claude-3.7-sonnet',
      provider: 'openrouter',
      label: 'Anthropic: Claude 3.7 Sonnet',
      context: 200000,
      maxOutput: 64000,
      vision: true,
      effort: true,
      thinking: true,
      inputPrice: 3,
      outputPrice: 15,
      refined: true,
    });
  });

  it('refineModel enriches an unverified OpenRouter spec from the catalog', async () => {
    const spec = resolveModel('openrouter', 'deepseek/deepseek-v3.2');
    expect(spec.unverified).toBe(true);

    const fakeFetch = async () => ({
      ok: true,
      async json() {
        return {
          data: [
            {
              id: 'deepseek/deepseek-v3.2',
              name: 'DeepSeek V3.2',
              context_length: 163840,
              top_provider: { max_completion_tokens: 32768 },
              pricing: { prompt: '0.00000027', completion: '0.0000011' },
              architecture: { input_modalities: ['text'] },
              supported_parameters: ['reasoning'],
            },
          ],
        };
      },
    });

    await refineModel(spec, { fetchImpl: fakeFetch });
    expect(spec.unverified).toBeUndefined();
    expect(spec.context).toBe(163840);
    expect(spec.maxOutput).toBe(32768);
    expect(spec.inputPrice).toBeCloseTo(0.27, 4);
    expect(spec.outputPrice).toBeCloseTo(1.1, 4);
    expect(spec.vision).toBe(false);
  });

  it('streams OpenRouter delta.reasoning alongside delta.content', async () => {
    const fakeClient = {
      chat: {
        completions: {
          async create() {
            return (async function* () {
              yield {
                choices: [{ delta: { reasoning: 'thinking step 1' }, finish_reason: null }],
              };
              yield {
                choices: [{ delta: { content: 'final answer' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 100, completion_tokens: 25 },
              };
            })();
          },
        },
      },
    };

    const p = createOpenAI({
      apiKey: 'sk-or-v1-test',
      model: 'anthropic/claude-sonnet-4.5',
      maxTokens: 1024,
      name: 'openrouter',
      client: fakeClient,
    });

    const events = await collect(
      p.send({
        system: 'sys',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    );

    expect(events).toEqual([
      { t: 'thinking', delta: 'thinking step 1' },
      { t: 'text', delta: 'final answer' },
      { t: 'usage', in: 100, out: 25, cacheRead: 0, cacheWrite: 0 },
      { t: 'stop', reason: 'end_turn' },
    ]);
  });

  it('recognizes sk-or-v1- keys in maskKey and warns if sent to OpenAI by mistake', () => {
    expect(maskKey('sk-or-v1-1234567890abcdef1234')).toContain('starts sk-or-v1-');
    const diag = describeAuth(
      {
        provider: 'openai',
        keys: { openai: 'sk-or-v1-1234567890abcdef1234' },
        keyOrigins: { openai: { name: 'OPENAI_API_KEY', from: 'environment' } },
      },
      'gpt-5.1',
    );
    expect(diag).toContain('DAVAI_PROVIDER=openrouter');

    const provider = createProvider({
      provider: 'openrouter',
      model: resolveModel('openrouter', 'anthropic/claude-sonnet-4.5'),
      maxTokens: 4096,
      effort: 'high',
      keys: { openrouter: 'sk-or-v1-test' },
    });
    expect(provider.name).toBe('openrouter');
  });
});

describe('ThroughputTracker and terminal plots', () => {
  it('buckets streaming deltas over time, detects slowdowns, and rescales on usage.out', () => {
    const tracker = new ThroughputTracker({ bucketMs: 1000 });
    const t0 = 1_000_000;
    tracker.startTurn({ turn: 1, model: 'claude-opus-5-5', now: t0 });

    // Fast thinking burst in bucket 0..1s (~100 tok/s)
    tracker.record('thinking', 'a'.repeat(400), t0 + 200);
    tracker.record('thinking', 'b'.repeat(400), t0 + 1200);

    // Slowdown during structured da_ops payload in bucket 2..3s (~10 tok/s)
    tracker.record('text', 'c'.repeat(40), t0 + 2200);
    tracker.record('text', 'd'.repeat(40), t0 + 3200);

    // Fast conclusion in bucket 4s
    tracker.record('text', 'e'.repeat(320), t0 + 4200);

    let snap = tracker.snapshot(t0 + 4500);
    expect(snap.active).toBe(true);
    expect(snap.ttftMs).toBe(200);
    expect(snap.buckets).toHaveLength(5);
    expect(snap.peakTps).toBeGreaterThan(snap.lowTps * 3);

    // Reconcile with exact provider output token count
    tracker.reconcileUsage({ out: 300 });
    tracker.endTurn(t0 + 5000);

    snap = tracker.snapshot(t0 + 5000);
    expect(snap.active).toBe(false);
    expect(snap.totalTokens).toBe(300);

    const spark = renderSparkline(snap.series, { width: 5 });
    expect(spark).toHaveLength(5);

    const chart = buildThroughputChart(snap.buckets, { width: 20, height: 6 });
    expect(chart.lines).toHaveLength(6);
    // Should contain slowdown ('low') cells where throughput dipped during structured output
    const allCells = chart.lines.flatMap((r) => r.cells);
    expect(allCells.some((c) => c.kind === 'low')).toBe(true);
    expect(allCells.some((c) => c.kind === 'think')).toBe(true);
    expect(allCells.some((c) => c.kind === 'text')).toBe(true);
  });

  it('fills zero-rate buckets on tick() when a stream stalls', () => {
    const tracker = new ThroughputTracker({ bucketMs: 1000 });
    const t0 = 2_000_000;
    tracker.startTurn({ turn: 1, model: 'claude-opus-5-5', now: t0 });
    tracker.record('text', 'hello world '.repeat(20), t0 + 100);
    // 4 seconds of silence
    tracker.tick(t0 + 4100);
    const snap = tracker.snapshot(t0 + 4100);
    expect(snap.buckets.length).toBeGreaterThanOrEqual(5);
    expect(snap.buckets.at(-1).tps).toBe(0);
    expect(snap.currentTps).toBe(0);
  });
});