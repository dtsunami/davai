import { describe, it, expect } from 'vitest';
import { extract, parseDaOps, scanBlocks } from '../src/agent/parser.js';

const fence = (lang, body) => '```' + lang + '\n' + body + '\n```';

describe('scanBlocks', () => {
  it('separates da_ops from artifacts and prose', () => {
    const text = [
      'Here is the plan.',
      fence('da_ops', '{"ops":[{"op":"read","path":"a.js"}]}'),
      'And the result:',
      fence('js', 'const x = 1;'),
    ].join('\n');
    const { blocks, prose } = scanBlocks(text);
    expect(blocks.map((b) => b.kind)).toEqual(['da_ops', 'artifact']);
    expect(blocks[1].lang).toBe('js');
    expect(prose).toContain('Here is the plan.');
    expect(prose).not.toContain('const x = 1');
  });

  it('handles nested fences via longer outer fence', () => {
    const text = '````md\n```js\nnested\n```\n````';
    const { blocks } = scanBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toBe('```js\nnested\n```');
  });

  it('flags an unterminated block', () => {
    const { blocks } = scanBlocks('```da_ops\n{"ops":[]}');
    expect(blocks[0].unterminated).toBe(true);
  });

  it('strips fence indentation from the body', () => {
    const text = '  ```js\n  const x = 1;\n  ```';
    const { blocks } = scanBlocks(text);
    expect(blocks[0].body).toBe('const x = 1;');
  });
});

describe('parseDaOps envelope', () => {
  it('parses the {"ops": [...]} form', () => {
    expect(parseDaOps('{"ops":[{"op":"read","path":"a.js"}]}')).toEqual([
      { op: 'read', path: 'a.js' },
    ]);
  });

  it('accepts a bare array', () => {
    expect(parseDaOps('[{"op":"read","path":"a.js"}]')).toHaveLength(1);
  });

  it('tolerates trailing commas', () => {
    expect(parseDaOps('{"ops":[{"op":"read","path":"a.js"},]}')).toHaveLength(1);
  });

  it('rejects the invalid { [ ... ] } shape from the original spec with a useful message', () => {
    expect(() => parseDaOps('{ [ {"read":"a"} ] }')).toThrow(/not valid JSON/);
  });

  it('rejects an object without ops', () => {
    expect(() => parseDaOps('{"operations":[]}')).toThrow(/must be \{"ops"/);
  });

  it('rejects an empty batch', () => {
    expect(() => parseDaOps('{"ops":[]}')).toThrow(/no operations/);
  });
});

describe('payload blocks', () => {
  it('resolves @refs to verbatim content', () => {
    const body = [
      '{"ops":[{"op":"write","path":"a.py","text":"@1"}]}',
      '--davai:1--',
      'def f(value: str):',
      '    return "ok"',
      '--davai:end--',
    ].join('\n');
    const ops = parseDaOps(body);
    expect(ops[0].text).toBe('def f(value: str):\n    return "ok"');
  });

  it('keeps JSON-significant characters verbatim', () => {
    const body = [
      '{"ops":[{"op":"write","path":"a.json","text":"@p"}]}',
      '--davai:p--',
      '{"nested": "quotes \\"here\\"", "back\\\\slash": true}',
      '--davai:end--',
    ].join('\n');
    const ops = parseDaOps(body);
    expect(ops[0].text).toBe('{"nested": "quotes \\"here\\"", "back\\\\slash": true}');
  });

  it('supports multiple payloads in one block', () => {
    const body = [
      '{"ops":[{"op":"replace","path":"a.js","old":"@1","new":"@2"}]}',
      '--davai:1--',
      'old text',
      '--davai:end--',
      '--davai:2--',
      'new text',
      '--davai:end--',
    ].join('\n');
    const ops = parseDaOps(body);
    expect(ops[0]).toMatchObject({ old: 'old text', new: 'new text' });
  });

  it('errors on a dangling reference', () => {
    const body = '{"ops":[{"op":"write","path":"a","text":"@9"}]}';
    expect(() => parseDaOps(body)).toThrow(/no --davai:9-- block/);
  });

  it('errors on an unreferenced payload', () => {
    const body = [
      '{"ops":[{"op":"read","path":"a"}]}',
      '--davai:1--',
      'orphan',
      '--davai:end--',
    ].join('\n');
    expect(() => parseDaOps(body)).toThrow(/never referenced/);
  });

  it('errors on an unclosed payload', () => {
    const body = ['{"ops":[{"op":"write","path":"a","text":"@1"}]}', '--davai:1--', 'x'].join('\n');
    expect(() => parseDaOps(body)).toThrow(/never closed/);
  });

  it('still accepts strict JSON with escaped newlines', () => {
    const ops = parseDaOps('{"ops":[{"op":"write","path":"a.js","text":"line1\\nline2"}]}');
    expect(ops[0].text).toBe('line1\nline2');
  });

  it('leaves a lone @ or email-like string alone', () => {
    const ops = parseDaOps('{"ops":[{"op":"grep","path":".","pattern":"a@b.com"}]}');
    expect(ops[0].pattern).toBe('a@b.com');
  });
});

describe('extract', () => {
  it('returns null ops when the turn is pure prose', () => {
    const out = extract('All done — the tests pass.');
    expect(out.ops).toBeNull();
    expect(out.parseError).toBeNull();
    expect(out.prose).toContain('All done');
  });

  it('collects artifacts separately from ops', () => {
    const text = [fence('da_ops', '{"ops":[{"op":"read","path":"a"}]}'), fence('py', 'print(1)')].join('\n');
    const out = extract(text);
    expect(out.ops).toHaveLength(1);
    expect(out.artifacts).toHaveLength(1);
    expect(out.artifacts[0].lang).toBe('py');
  });

  it('merges multiple da_ops blocks in one turn', () => {
    const text = [
      fence('da_ops', '{"ops":[{"op":"read","path":"a"}]}'),
      fence('da_ops', '{"ops":[{"op":"read","path":"b"}]}'),
    ].join('\n');
    expect(extract(text).ops).toHaveLength(2);
  });

  it('reports a truncated block as a parse error, not a crash', () => {
    const out = extract('```da_ops\n{"ops":[{"op":"write"');
    expect(out.ops).toBeNull();
    expect(out.parseError).toMatch(/never closed|cut off/);
  });

  it('surfaces the JSON error message for repair', () => {
    const out = extract(fence('da_ops', '{"ops": [oops]}'));
    expect(out.parseError).toMatch(/not valid JSON/);
  });
});
