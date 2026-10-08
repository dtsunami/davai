import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveNativeCalls, toFencedBlock, nativeCallPrompt } from '../src/agent/native.js';
import { extract } from '../src/agent/parser.js';
import { replaySegments } from '../src/session/resume.js';

const call = (name, args, id) => ({
  id,
  name,
  args: typeof args === 'string' ? args : JSON.stringify(args),
});
const READ = { ops: [{ op: 'read', path: 'a.js' }] };

describe('resolveNativeCalls', () => {
  it('is a no-op without calls', () => {
    for (const calls of [undefined, []]) {
      expect(resolveNativeCalls(calls, 'text')).toEqual({
        ops: null,
        parseError: null,
        block: null,
        report: [],
        unusable: [],
      });
    }
  });

  it('runs a da_ops call as the envelope it carries, with a fenced equivalent', () => {
    const r = resolveNativeCalls([call('da_ops', READ, 'c1')], 'Reading.');
    expect(r.ops).toEqual(READ.ops);
    expect(r.parseError).toBeNull();
    expect(r.report).toEqual([{ id: 'c1', name: 'da_ops', disposition: 'executed' }]);
    expect(extract(r.block).ops).toEqual(READ.ops);
  });

  it('tolerates name variants, double-encoded arguments and a bare array', () => {
    const doubled = JSON.stringify(JSON.stringify(READ));
    for (const name of ['DA_OPS', 'da-ops', 'daops', 'functions.da_ops']) {
      expect(resolveNativeCalls([call(name, doubled)], '').ops).toEqual(READ.ops);
    }
    expect(resolveNativeCalls([call('da_ops', READ.ops)], '').ops).toEqual(READ.ops);
  });

  it('accepts payload sections inside the arguments', () => {
    const args =
      '{"ops": [{"op": "write", "path": "a.txt", "text": "@1"}]}\n' +
      '--davai:1--\nline one\nline two\n--davai:end--';
    const r = resolveNativeCalls([call('da_ops', args)], '');
    expect(r.ops[0].text).toBe('line one\nline two');
  });

  it('resolves references against payload blocks in the reply text', () => {
    const text = 'Writing it.\n--davai:1--\nhello\n  world\n--davai:end--';
    const r = resolveNativeCalls(
      [call('da_ops', { ops: [{ op: 'write', path: 'a.txt', text: '@1' }] })],
      text,
    );
    expect(r.ops[0].text).toBe('hello\n  world');
  });

  it('points a missing payload at the fenced form', () => {
    const r = resolveNativeCalls(
      [call('da_ops', { ops: [{ op: 'write', path: 'a.txt', text: '@9' }] })],
      'no payloads here',
    );
    expect(r.ops).toBeNull();
    expect(r.parseError).toMatch(/^native da_ops tool call: .*@9/);
    expect(r.parseError).toMatch(/fenced block/);
    expect(r.report[0].disposition).toBe('malformed');
  });

  it('maps a call named after an op, op first', () => {
    const r = resolveNativeCalls([call('replace', { path: 'a.js', old: 'x', new: 'y' })], '');
    expect(r.ops).toEqual([{ op: 'replace', path: 'a.js', old: 'x', new: 'y' }]);
    expect(Object.keys(r.ops[0])[0]).toBe('op');
  });

  it('reports an op-named call whose arguments are not an object', () => {
    const r = resolveNativeCalls([call('read', '"a.js"')], '');
    expect(r.ops).toBeNull();
    expect(r.parseError).toMatch(/JSON object/);
  });

  it('recognises an envelope under an unknown name', () => {
    const r = resolveNativeCalls([call('execute', READ)], '');
    expect(r.ops).toEqual(READ.ops);
  });

  it('leaves other tools unusable, and runs nothing', () => {
    const r = resolveNativeCalls([call('web_search', { q: 'bluetooth hfp' })], '');
    expect(r).toMatchObject({ ops: null, parseError: null, block: null, unusable: ['web_search'] });
    expect(r.report[0].disposition).toBe('unusable');
  });

  it('merges several calls in order, and lists the unusable ones', () => {
    const r = resolveNativeCalls(
      [call('da_ops', READ), call('list', { path: '.' }), call('web_search', { q: 'x' })],
      '',
    );
    expect(r.ops.map((o) => o.op)).toEqual(['read', 'list']);
    expect(r.unusable).toEqual(['web_search']);
  });

  it('holds the whole batch back when one call is malformed', () => {
    const r = resolveNativeCalls([call('da_ops', READ), call('da_ops', '{"ops": [')], '');
    expect(r.ops).toBeNull();
    expect(r.parseError).toMatch(/not valid JSON/);
    expect(r.report.map((c) => c.disposition)).toEqual(['held', 'malformed']);
  });

  it('defers to a fenced block', () => {
    const r = resolveNativeCalls([call('da_ops', READ)], '', { fenced: true });
    expect(r.ops).toBeNull();
    expect(r.parseError).toBeNull();
    expect(r.report[0].disposition).toBe('shadowed');
  });
});

describe('toFencedBlock', () => {
  it('round-trips through the parser, lifting multi-line strings into payloads', () => {
    const ops = [
      { op: 'write', path: 'a.md', text: '# T\n\n```js\nx()\n```\n' },
      { op: 'replace', path: 'b.js', old: 'a', new: 'b' },
    ];
    const block = toFencedBlock(ops);
    expect(block).toContain('--davai:p1--');
    expect(extract(block).ops).toEqual(ops);
  });

  it('keeps a string inline when it holds a payload marker line', () => {
    const ops = [{ op: 'write', path: 'a.txt', text: 'a\n--davai:end--\nb' }];
    const block = toFencedBlock(ops);
    expect(block).not.toContain('--davai:p1--');
    expect(extract(block).ops).toEqual(ops);
  });
});

describe('nativeCallPrompt', () => {
  it('names the calls and the way out', () => {
    const text = nativeCallPrompt(['read_file', 'web_search']);
    expect(text).toContain('read_file, web_search');
    expect(text).toMatch(/da_ops fenced block/);
  });
});

describe('resume of a salvaged turn', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-native-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const transcript = (events) =>
    fs.writeFileSync(
      path.join(dir, 'transcript.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  const BLOCK = '```da_ops\n{"ops": [\n  {"op":"read","path":"a.js"}\n]}\n```';

  it('appends the fenced equivalent to the turn it came from', () => {
    transcript([
      { type: 'user', text: 'look' },
      { type: 'assistant', text: 'Reading.' },
      { type: 'native-calls', calls: [], block: BLOCK },
      { type: 'ops-result', label: '1 op ok', text: 'R' },
    ]);
    const specs = replaySegments(dir);
    expect(specs.map((s) => s.type)).toEqual(['user', 'assistant', 'op-result']);
    expect(specs[1].text).toBe(`Reading.\n\n${BLOCK}`);
  });

  it('restores a text-less turn as the block alone', () => {
    transcript([
      { type: 'user', text: 'look' },
      { type: 'assistant', text: '' },
      { type: 'native-calls', calls: [], block: BLOCK },
      { type: 'ops-result', label: '1 op ok', text: 'R' },
    ]);
    const specs = replaySegments(dir);
    expect(specs.map((s) => s.type)).toEqual(['user', 'assistant', 'op-result']);
    expect(specs[1].text).toBe(BLOCK);
  });
});