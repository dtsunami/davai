import { describe, it, expect } from 'vitest';
import { createOpenAIResponses, translateStream } from '../src/providers/openai-responses.js';
import { OPENAI_EFFORT } from '../src/providers/base.js';

/** Collect a davai event stream. */
async function collect(iter) {
  const out = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

const USAGE = {
  input_tokens: 1200,
  output_tokens: 340,
  input_tokens_details: { cached_tokens: 900 },
  output_tokens_details: { reasoning_tokens: 210 },
};

const OPS_TEXT = '\n```da_ops\n{"ops": []}\n```';

/** A recorded-shape Responses stream for a reasoning model. */
const REASONING_STREAM = [
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.reasoning_summary_part.added', summary_index: 0 },
  { type: 'response.reasoning_summary_text.delta', delta: 'The helper never collapses ' },
  { type: 'response.reasoning_summary_text.delta', delta: 'runs of punctuation.' },
  { type: 'response.reasoning_summary_part.added', summary_index: 1 },
  { type: 'response.reasoning_summary_text.delta', delta: 'So read the file first.' },
  { type: 'response.output_text.delta', delta: 'Reading slug.js.' },
  { type: 'response.output_text.delta', delta: OPS_TEXT },
  { type: 'response.completed', response: { usage: USAGE } },
];

describe('translateStream', () => {
  it('maps reasoning summaries to thinking and output to text', async () => {
    const events = await collect(translateStream(REASONING_STREAM));

    const thinking = events.filter((e) => e.t === 'thinking').map((e) => e.delta);
    expect(thinking.join('')).toBe(
      'The helper never collapses runs of punctuation.\n\nSo read the file first.',
    );
    const text = events.filter((e) => e.t === 'text').map((e) => e.delta);
    expect(text.join('')).toContain('Reading slug.js.');
    expect(text.join('')).toContain('da_ops');
  });

  it('separates summary parts but does not lead with a blank', async () => {
    const events = await collect(translateStream(REASONING_STREAM));
    expect(events[0].t).toBe('thinking');
    expect(events[0].delta).not.toBe('\n\n');
  });

  it('reports usage with cached reads, counting reasoning inside output', async () => {
    const events = await collect(translateStream(REASONING_STREAM));
    const usage = events.find((e) => e.t === 'usage');
    expect(usage).toEqual({ t: 'usage', in: 1200, out: 340, cacheRead: 900, cacheWrite: 0 });
  });

  it('ends on end_turn', async () => {
    const events = await collect(translateStream(REASONING_STREAM));
    expect(events.at(-1)).toEqual({ t: 'stop', reason: 'end_turn' });
  });

  it('accepts the preview event name for summaries', async () => {
    const events = await collect(
      translateStream([
        { type: 'response.reasoning_summary.delta', delta: 'older name' },
        { type: 'response.completed', response: { usage: USAGE } },
      ]),
    );
    expect(events.find((e) => e.t === 'thinking').delta).toBe('older name');
  });

  it('reports truncation as max_tokens', async () => {
    const events = await collect(
      translateStream([
        { type: 'response.output_text.delta', delta: 'half a thou' },
        {
          type: 'response.incomplete',
          response: { usage: USAGE, incomplete_details: { reason: 'max_output_tokens' } },
        },
      ]),
    );
    expect(events.at(-1)).toEqual({ t: 'stop', reason: 'max_tokens' });
  });

  it('surfaces a refusal with its text', async () => {
    const events = await collect(
      translateStream([
        { type: 'response.refusal.delta', delta: 'I cannot help ' },
        { type: 'response.refusal.delta', delta: 'with that.' },
        { type: 'response.completed', response: { usage: USAGE } },
      ]),
    );
    const stop = events.at(-1);
    expect(stop.reason).toBe('refusal');
    expect(stop.detail).toBe('I cannot help with that.');
  });

  it('throws a ProviderError on a failed response', async () => {
    await expect(
      collect(
        translateStream([{ type: 'response.failed', response: { error: { message: 'boom' } } }]),
      ),
    ).rejects.toThrow(/boom/);
  });

  it('throws on a stream error event', async () => {
    await expect(
      collect(translateStream([{ type: 'error', message: 'connection reset' }])),
    ).rejects.toThrow(/connection reset/);
  });

  it('still stops cleanly when the stream carries no usage', async () => {
    const events = await collect(
      translateStream([{ type: 'response.output_text.delta', delta: 'hi' }]),
    );
    expect(events.some((e) => e.t === 'usage')).toBe(false);
    expect(events.at(-1)).toEqual({ t: 'stop', reason: 'end_turn' });
  });
});

describe('createOpenAIResponses request shape', () => {
  /** A client that records the params it was handed and replays a canned stream. */
  const spyClient = (stream = REASONING_STREAM, fail = null) => {
    const calls = [];
    return {
      calls,
      responses: {
        async create(params) {
          // A copy, because the adapter deletes `reasoning` from this object on retry.
          calls.push({ ...params });
          if (fail && calls.length === 1) throw fail;
          return stream;
        },
      },
    };
  };

  const send = async (opts, client) => {
    const p = createOpenAIResponses({ model: 'gpt-5', maxTokens: 4000, client, ...opts });
    await collect(
      p.send({
        system: 'SYSTEM',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    );
    return client.calls;
  };

  it('sends the system prompt as instructions and opts out of storage', async () => {
    const [params] = await send({ effort: 'high', thinkingVisible: true }, spyClient());
    expect(params.instructions).toBe('SYSTEM');
    expect(params.max_output_tokens).toBe(4000);
    expect(params.store).toBe(false);
    expect(params.stream).toBe(true);
    // No system message smuggled into the input.
    expect(params.input.some((i) => i.role === 'system')).toBe(false);
  });

  it('asks for summaries only when thinking is visible', async () => {
    const [on] = await send({ effort: 'high', thinkingVisible: true }, spyClient());
    expect(on.reasoning).toEqual({ effort: 'high', summary: 'auto' });

    const [off] = await send({ effort: 'high', thinkingVisible: false }, spyClient());
    expect(off.reasoning).toEqual({ effort: 'high' });
  });

  it('maps every davai effort onto a level OpenAI accepts', async () => {
    for (const [davai, expected] of Object.entries(OPENAI_EFFORT)) {
      const [params] = await send({ effort: davai }, spyClient());
      expect(params.reasoning.effort).toBe(expected);
    }
  });

  it('retries without reasoning when the model rejects it', async () => {
    const rejection = Object.assign(new Error('unsupported'), { status: 400 });
    const client = spyClient(REASONING_STREAM, rejection);
    const calls = await send({ effort: 'high' }, client);
    expect(calls).toHaveLength(2);
    expect(calls[0].reasoning).toBeDefined();
    expect(calls[1].reasoning).toBeUndefined();
  });

  it('tags user text as input_text and assistant text as output_text', async () => {
    const client = spyClient();
    const p = createOpenAIResponses({ model: 'gpt-5', maxTokens: 100, client });
    await collect(
      p.send({
        system: 'S',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
          { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
        ],
      }),
    );
    const { input } = client.calls[0];
    expect(input[0].content[0].type).toBe('input_text');
    expect(input[1].content[0].type).toBe('output_text');
    expect(input[2].content[0]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,AAAA',
    });
  });
});
