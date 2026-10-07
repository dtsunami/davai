import { describe, it, expect } from 'vitest';
import { withCacheBreakpoints } from '../src/providers/anthropic.js';

const msg = (role, ...texts) => ({ role, content: texts.map((text) => ({ type: 'text', text })) });

/** "message.block" coordinates of every block carrying cache_control. */
const marked = (messages) =>
  messages
    .flatMap((m, i) => m.content.map((c, j) => (c.cache_control ? `${i}.${j}` : null)))
    .filter(Boolean);

describe('withCacheBreakpoints', () => {
  it('marks the last block of the two newest user messages', () => {
    const out = withCacheBreakpoints([
      msg('user', 'a'),
      msg('assistant', 'b'),
      msg('user', 'c', 'd'),
      msg('assistant', 'e'),
      msg('user', 'f', 'g'),
    ]);
    expect(marked(out)).toEqual(['2.1', '4.1']);
  });

  it('never marks assistant turns and copes with a single user message', () => {
    const out = withCacheBreakpoints([msg('user', 'a'), msg('assistant', 'b')]);
    expect(marked(out)).toEqual(['0.0']);
  });

  it('marks image blocks too', () => {
    const out = withCacheBreakpoints([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAAA' } }] },
    ]);
    expect(marked(out)).toEqual(['0.0']);
  });

  it('leaves an empty conversation alone', () => {
    expect(withCacheBreakpoints([])).toEqual([]);
  });
});