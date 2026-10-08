import { describe, it, expect } from 'vitest';
import { contentDeltas } from '../src/providers/openai.js';

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