import { describe, it, expect } from 'vitest';
import { Ledger } from '../src/context/ledger.js';
import { Pastes } from '../src/context/pastes.js';
import { compact } from '../src/context/compact.js';
import { estimate, TokenCalibrator } from '../src/context/tokens.js';
import { createOpsFilter } from '../src/headless.js';

function makeLedger(limit = 10_000) {
  const l = new Ledger({ limit, compactAt: 0.75 });
  l.setSystem('system prompt');
  l.add({ type: 'grounding', label: 'grounding', role: 'user', text: 'project info' });
  return l;
}

describe('token estimation', () => {
  it('counts code more densely than prose', () => {
    const code = 'const x={a:1,b:[2,3]};func(x,()=>{return x.a+x.b[0];});';
    const prose = 'The quick brown fox jumps over the lazy dog again and again.';
    expect(estimate(code) / code.length).toBeGreaterThan(estimate(prose) / prose.length);
  });

  it('calibrates toward observed usage', () => {
    const c = new TokenCalibrator();
    c.observe(100, 130);
    expect(c.apply(100)).toBe(130);
    c.observe(100, 130);
    expect(c.apply(100)).toBeCloseTo(130, 0);
  });

  it('ignores implausible calibration samples', () => {
    const c = new TokenCalibrator();
    c.observe(100, 130);
    c.observe(100, 100_000); // ratio 1000 — bogus
    expect(c.apply(100)).toBe(130);
  });
});

describe('ledger', () => {
  it('collapses consecutive same-role segments into one message', () => {
    const l = makeLedger();
    l.add({ type: 'user', label: 'q', role: 'user', text: 'one' });
    l.add({ type: 'op-result', label: 'r', role: 'user', text: 'two' });
    l.add({ type: 'assistant', label: 'a', role: 'assistant', text: 'three' });
    const msgs = l.toMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toHaveLength(3); // grounding + user + op-result
    expect(msgs[1].role).toBe('assistant');
  });

  it('always opens with a user turn', () => {
    const l = new Ledger({ limit: 1000 });
    l.setSystem('s');
    l.add({ type: 'assistant', label: 'a', role: 'assistant', text: 'leading assistant' });
    l.add({ type: 'user', label: 'u', role: 'user', text: 'hi' });
    expect(l.toMessages()[0].role).toBe('user');
  });

  it('refuses to drop grounding', () => {
    const l = makeLedger();
    const g = l.segments[0];
    expect(l.drop(g.id)).toBe(false);
    expect(l.segments).toHaveLength(1);
  });

  it('orders the breakdown by token count', () => {
    const l = makeLedger();
    l.add({ type: 'op-result', label: 'small', role: 'user', text: 'x' });
    l.add({ type: 'op-result', label: 'large', role: 'user', text: 'y'.repeat(5000) });
    const rows = l.breakdown();
    expect(rows[0].label).toBe('large');
    expect(rows[0].pct).toBeGreaterThan(rows[1].pct);
  });

  it('flags when compaction is due', () => {
    const l = makeLedger(1000);
    expect(l.shouldCompact).toBe(false);
    l.add({ type: 'op-result', label: 'big', role: 'user', text: 'z'.repeat(6000) });
    expect(l.shouldCompact).toBe(true);
  });
});

describe('compaction', () => {
  const deps = {
    cfg: { provider: 'anthropic' },
    makeProvider: () => ({
      async *send() {
        yield { t: 'text', delta: 'condensed summary' };
      },
    }),
  };

  it('evicts op-results before touching conversation turns', async () => {
    const l = makeLedger(2000);
    l.add({ type: 'user', label: 'q1', role: 'user', text: 'first question' });
    l.add({ type: 'assistant', label: 'a1', role: 'assistant', text: 'first answer' });
    const big = l.add({ type: 'op-result', label: 'huge read', role: 'user', text: 'x'.repeat(9000) });
    l.add({ type: 'user', label: 'q2', role: 'user', text: 'second question' });

    await compact(l, deps);
    expect(l.get(big.id)).toBeUndefined();
    expect(l.segments.some((s) => s.label === 'q1')).toBe(true);
  });

  it('never drops grounding', async () => {
    const l = makeLedger(500);
    l.add({ type: 'op-result', label: 'huge', role: 'user', text: 'x'.repeat(20000) });
    await compact(l, deps);
    expect(l.segments.some((s) => s.type === 'grounding')).toBe(true);
  });

  it('protects pinned segments', async () => {
    const l = makeLedger(1500);
    const pinned = l.add({
      type: 'op-result',
      label: 'keep me',
      role: 'user',
      text: 'y'.repeat(4000),
      pinned: true,
    });
    l.add({ type: 'op-result', label: 'drop me', role: 'user', text: 'z'.repeat(4000) });
    await compact(l, deps);
    expect(l.get(pinned.id)).toBeDefined();
  });

  it('summarizes old turns when evicting op-results is not enough', async () => {
    const l = makeLedger(800);
    for (let i = 0; i < 6; i++) {
      l.add({ type: 'user', label: `q${i}`, role: 'user', text: `question ${i} `.repeat(40) });
      l.add({ type: 'assistant', label: `a${i}`, role: 'assistant', text: `answer ${i} `.repeat(40) });
    }
    const result = await compact(l, deps);
    expect(result.actions.some((a) => a.includes('summarized'))).toBe(true);
    const summary = l.segments.find((s) => s.type === 'summary');
    expect(summary.part.text).toContain('condensed summary');
  });
});

describe('pastes', () => {
  it('stores multi-line pastes behind a placeholder', () => {
    const p = new Pastes();
    const c = p.capture('line one\nline two\nline three');
    expect(c.placeholder).toBe('[[paste#1: 3 lines]]');
    expect(p.get(1).lines).toBe(3);
  });

  it('passes single-line pastes through literally', () => {
    expect(new Pastes().capture('just one line')).toBeNull();
  });

  it('expands placeholders on submit', () => {
    const p = new Pastes();
    const c = p.capture('a\nb');
    const { text, referenced } = p.expand(`look at ${c.placeholder} please`);
    expect(text).toBe('look at [paste#1] please');
    expect(referenced).toHaveLength(1);
    expect(referenced[0].text).toBe('a\nb');
  });

  it('does not duplicate a paste referenced twice', () => {
    const p = new Pastes();
    const c = p.capture('a\nb');
    const { referenced } = p.expand(`${c.placeholder} and ${c.placeholder}`);
    expect(referenced).toHaveLength(1);
  });

  it('leaves an unknown placeholder visible rather than silently dropping it', () => {
    const { text, referenced } = new Pastes().expand('see [[paste#9: 4 lines]]');
    expect(text).toContain('[[paste#9');
    expect(referenced).toHaveLength(0);
  });
});

describe('headless ops filter', () => {
  it('suppresses da_ops blocks but keeps prose', () => {
    let out = '';
    const f = createOpsFilter((s) => (out += s));
    f.write('before\n```da_ops\n{"ops":[]}\n```\nafter\n');
    f.reset();
    expect(out).toBe('before\nafter\n');
  });

  it('keeps ordinary code fences', () => {
    let out = '';
    const f = createOpsFilter((s) => (out += s));
    f.write('```js\nconst x = 1;\n```\n');
    f.reset();
    expect(out).toContain('const x = 1;');
  });
});
