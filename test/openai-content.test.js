import { describe, it, expect } from 'vitest';
import { contentDeltas, createOpenAI, mergeToolCallDeltas } from '../src/providers/openai.js';

const all = (c) => [...contentDeltas(c)];

describe('contentDeltas', () => {
  it('passes a plain string through as text', () => {
    expect(all('hi')).toEqual([{ t: 'text', delta: 'hi' }]);
    expect(all('')).toEqual([]);
  });

  it('flattens Mistral text chunks', () => {
    expect(all([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toEqual([
      { t: 'text', delta: 'a' },
      { t: 'text', delta: 'b' },
    ]);
  });

  it('routes Mistral thinking chunks to thinking', () => {
    expect(
      all([
        { type: 'thinking', thinking: [{ type: 'text', text: 'hmm ' }, { type: 'text', text: 'ok' }] },
        { type: 'text', text: 'pong' },
      ]),
    ).toEqual([
      { t: 'thinking', delta: 'hmm ok' },
      { t: 'text', delta: 'pong' },
    ]);
  });

  it('drops unknown chunks instead of stringifying them', () => {
    expect(all([{ type: 'reference', ids: [1] }, null])).toEqual([]);
    expect(all({ weird: true })).toEqual([]);
  });
});

describe('mergeToolCallDeltas', () => {
  const merge = (...chunks) => {
    const acc = new Map();
    for (const c of chunks) mergeToolCallDeltas(acc, c);
    return [...acc.values()];
  };

  it('reassembles argument fragments by index', () => {
    expect(
      merge(
        [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"pa' } }],
        [{ index: 0, function: { arguments: 'th":"README' } }],
        [{ index: 0, function: { arguments: '.md"}' } }],
      ),
    ).toEqual([{ id: 'c1', name: 'read_file', args: '{"path":"README.md"}' }]);
  });

  it('keeps parallel calls apart', () => {
    expect(
      merge(
        [
          { index: 0, id: 'a', function: { name: 'ls', arguments: '{}' } },
          { index: 1, id: 'b', function: { name: 'cat', arguments: '{"f":' } },
        ],
        [{ index: 1, function: { arguments: '"x"}' } }],
      ),
    ).toEqual([
      { id: 'a', name: 'ls', args: '{}' },
      { id: 'b', name: 'cat', args: '{"f":"x"}' },
    ]);
  });

  it('treats index-less fragments as whole calls and stringifies object arguments', () => {
    expect(
      merge([
        { id: 'a', function: { name: 'ls', arguments: { path: '.' } } },
        { id: 'b', function: { name: 'pwd', arguments: '' } },
      ]),
    ).toEqual([
      { id: 'a', name: 'ls', args: '{"path":"."}' },
      { id: 'b', name: 'pwd', args: '' },
    ]);
  });

  it('ignores junk', () => {
    expect(merge(null, 'x', [null, 3])).toEqual([]);
  });
});

describe('createOpenAI stream end', () => {
  const run = async (chunks) => {
    const client = { chat: { completions: { async create() { return chunks; } } } };
    const p = createOpenAI({ model: 'm', maxTokens: 10, client });
    const out = [];
    for await (const e of p.send({
      system: 'S',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) {
      out.push(e);
    }
    return out;
  };

  it('reports a stream that closes without finish_reason as an error, not end_turn', async () => {
    const ev = await run([
      { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'hmm' }] }] } }] },
    ]);
    expect(ev[0]).toEqual({ t: 'thinking', delta: 'hmm' });
    expect(ev.at(-1)).toEqual({ t: 'stop', reason: 'error' });
  });

  it('maps length to max_tokens and stop to end_turn', async () => {
    const length = await run([{ choices: [{ delta: { content: 'a' }, finish_reason: 'length' }] }]);
    expect(length.at(-1)).toEqual({ t: 'stop', reason: 'max_tokens' });
    const stop = await run([{ choices: [{ delta: { content: 'a' }, finish_reason: 'stop' }] }]);
    expect(stop.at(-1)).toEqual({ t: 'stop', reason: 'end_turn' });
  });
});