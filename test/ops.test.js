import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sandbox } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';
import { Journal } from '../src/agent/journal.js';
import { normalizeBatch, normalizeOp } from '../src/agent/ops/schema.js';
import { executeBatch } from '../src/agent/ops/executor.js';

let root;
let ctx;
let base;

function run(rawOps, extra = {}) {
  const { ops, errors } = normalizeBatch(rawOps);
  if (errors.length) {
    return Promise.resolve({ status: 'plan-failed', results: [], errors });
  }
  return executeBatch(ops, { ...ctx, ...extra });
}

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-ops-'));
  fs.mkdirSync(path.join(base, 'project'), { recursive: true });
  root = fs.realpathSync(path.join(base, 'project'));
  fs.writeFileSync(path.join(root, 'a.js'), 'const a = 1;\nconst b = 2;\nconst a2 = 1;\n');
  fs.writeFileSync(path.join(root, 'dup.js'), 'x\nx\nx\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.js'), 'export const hi = () => "hi";\n');

  const sessionDir = path.join(base, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  ctx = {
    sandbox: new Sandbox({ cwd: root, roDirs: [], ignore: DaIgnore.fromDir(root) }),
    journal: new Journal({ dir: sessionDir }),
    shellTimeout: 15000,
  };
});

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('schema normalization', () => {
  it('accepts the {"op": ...} form', () => {
    expect(normalizeOp({ op: 'read', path: 'a.js' }, 0)).toEqual({ op: 'read', path: 'a.js' });
  });

  it('accepts the repl_agent.md shorthand', () => {
    expect(normalizeOp({ read: 'a.js', lines: [1, 2] }, 0)).toEqual({
      op: 'read',
      path: 'a.js',
      lines: [1, 2],
    });
    expect(normalizeOp({ shell: 'ls' }, 0)).toEqual({ op: 'shell', cmd: 'ls' });
  });

  it('accepts "text" as an alias for grep/glob pattern', () => {
    expect(normalizeOp({ grep: 'src', text: 'hi' }, 0)).toEqual({
      op: 'grep',
      path: 'src',
      pattern: 'hi',
    });
  });

  it('rejects unknown ops and fields', () => {
    expect(() => normalizeOp({ op: 'chmod', path: 'a' }, 0)).toThrow(/unknown op/);
    expect(() => normalizeOp({ op: 'read', path: 'a', bogus: 1 }, 0)).toThrow(/no field "bogus"/);
  });

  it('validates lines as a 1-indexed inclusive pair', () => {
    expect(() => normalizeOp({ op: 'read', path: 'a', lines: [0, 5] }, 0)).toThrow(/1-indexed/);
    expect(() => normalizeOp({ op: 'read', path: 'a', lines: [9, 2] }, 0)).toThrow(
      /min must be <= max/,
    );
  });
});

describe('read-type ops', () => {
  it('reads a line range', async () => {
    const out = await run([{ op: 'read', path: 'a.js', lines: [2, 2] }]);
    expect(out.status).toBe('ok');
    expect(out.results[0].result.content).toBe('const b = 2;');
    expect(out.results[0].result.totalLines).toBe(4);
  });

  it('lists a directory', async () => {
    const out = await run([{ op: 'list', path: '.' }]);
    expect(out.status).toBe('ok');
    expect(out.results[0].result.entries.map((e) => e.name)).toContain('src/');
  });

  it('greps literally by default', async () => {
    const out = await run([{ op: 'grep', path: '.', pattern: 'const a' }]);
    expect(out.status).toBe('ok');
    expect(out.results[0].result.matches).toHaveLength(2);
  });

  it('greps by regex when asked', async () => {
    const out = await run([{ op: 'grep', path: '.', pattern: '^const a\\d', regex: true }]);
    expect(out.results[0].result.matches).toHaveLength(1);
  });

  it('globs, tolerating the **.js typo', async () => {
    const out = await run([{ op: 'glob', path: '.', pattern: '**.js' }]);
    expect(out.status).toBe('ok');
    expect(out.results[0].result.files.sort()).toEqual(['a.js', 'dup.js', 'src/index.js']);
  });

  it('fails the batch when a file is missing', async () => {
    const out = await run([{ op: 'read', path: 'nope.js' }]);
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/does not exist/);
  });
});

describe('write', () => {
  it('creates a new file', async () => {
    const out = await run([{ op: 'write', path: 'new.txt', text: 'hi' }]);
    expect(out.status).toBe('ok');
    expect(read('new.txt')).toBe('hi');
  });

  it('refuses to clobber without overwrite', async () => {
    const out = await run([{ op: 'write', path: 'a.js', text: 'x' }]);
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/overwrite/);
    expect(read('a.js')).toMatch(/const a = 1/);
  });

  it('overwrites when told to', async () => {
    const out = await run([{ op: 'write', path: 'a.js', text: 'x', overwrite: true }]);
    expect(out.status).toBe('ok');
    expect(read('a.js')).toBe('x');
  });
});

describe('replace', () => {
  it('replaces a unique occurrence', async () => {
    const out = await run([{ op: 'replace', path: 'a.js', old: 'const b = 2;', new: 'const b = 3;' }]);
    expect(out.status).toBe('ok');
    expect(read('a.js')).toContain('const b = 3;');
  });

  it('refuses an ambiguous match', async () => {
    const out = await run([{ op: 'replace', path: 'dup.js', old: 'x', new: 'y' }]);
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/occurs 3 times/);
    expect(read('dup.js')).toBe('x\nx\nx\n');
  });

  it('replaces all when opted in', async () => {
    const out = await run([{ op: 'replace', path: 'dup.js', old: 'x', new: 'y', all: true }]);
    expect(out.status).toBe('ok');
    expect(read('dup.js')).toBe('y\ny\ny\n');
  });

  it('refuses when the old text is absent', async () => {
    const out = await run([{ op: 'replace', path: 'a.js', old: 'nonexistent', new: 'y' }]);
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/not found/);
  });
});

describe('delete', () => {
  it('deletes a file', async () => {
    const out = await run([{ op: 'delete', path: 'a.js' }]);
    expect(out.status).toBe('ok');
    expect(exists('a.js')).toBe(false);
  });

  it('refuses a directory without recursive', async () => {
    const out = await run([{ op: 'delete', path: 'src' }]);
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/recursive/);
    expect(exists('src')).toBe(true);
  });

  it('deletes a tree with recursive', async () => {
    const out = await run([{ op: 'delete', path: 'src', recursive: true }]);
    expect(out.status).toBe('ok');
    expect(exists('src')).toBe(false);
  });

  it('refuses to delete the working directory', async () => {
    const out = await run([{ op: 'delete', path: '.', recursive: true }]);
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/working directory/);
  });
});

describe('move', () => {
  it('renames a file', async () => {
    const out = await run([{ op: 'move', from: 'a.js', to: 'src/moved.js' }]);
    expect(out.status).toBe('ok');
    expect(exists('a.js')).toBe(false);
    expect(read('src/moved.js')).toMatch(/const a = 1/);
  });

  it('refuses to clobber the destination without overwrite', async () => {
    const out = await run([{ op: 'move', from: 'a.js', to: 'dup.js' }]);
    expect(out.status).toBe('plan-failed');
    expect(exists('a.js')).toBe(true);
    expect(read('dup.js')).toBe('x\nx\nx\n');
  });

  it('overwrites the destination when told to', async () => {
    const out = await run([{ op: 'move', from: 'a.js', to: 'dup.js', overwrite: true }]);
    expect(out.status).toBe('ok');
    expect(read('dup.js')).toMatch(/const a = 1/);
  });
});

describe('batch atomicity', () => {
  it('rolls back earlier writes when a later op fails at apply time', async () => {
    // Both ops pass planning; the second fails during apply because the planner
    // could not pre-verify uniqueness after the first op rewrote the file.
    const out = await run([
      { op: 'write', path: 'a.js', text: 'q\nq\n', overwrite: true },
      { op: 'replace', path: 'a.js', old: 'q', new: 'z' },
    ]);
    expect(out.status).toBe('apply-failed');
    expect(read('a.js')).toBe('const a = 1;\nconst b = 2;\nconst a2 = 1;\n');
  });

  it('applies nothing when any op fails planning', async () => {
    const out = await run([
      { op: 'write', path: 'first.txt', text: 'yes' },
      { op: 'read', path: 'missing.js' },
    ]);
    expect(out.status).toBe('plan-failed');
    expect(exists('first.txt')).toBe(false);
  });

  it('restores a deleted tree on rollback', async () => {
    const out = await run([
      { op: 'delete', path: 'src', recursive: true },
      { op: 'replace', path: 'dup.js', old: 'nope', new: 'x' },
    ]);
    expect(out.status).toBe('plan-failed');
    expect(read('src/index.js')).toMatch(/export const hi/);
  });

  it('detects self-conflicts within a batch', async () => {
    const out = await run([
      { op: 'delete', path: 'a.js' },
      { op: 'read', path: 'a.js' },
    ]);
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/removed earlier in this batch/);
    expect(exists('a.js')).toBe(true);
  });
});

describe('shell segregation', () => {
  const echo = process.platform === 'win32' ? 'echo hello' : 'echo hello';

  it('runs after file ops and requires approval', async () => {
    const asked = [];
    const out = await run(
      [
        { op: 'write', path: 'before.txt', text: 'x' },
        { op: 'shell', cmd: echo },
      ],
      {
        approve: async (op) => {
          asked.push(op.cmd);
          return { allow: true };
        },
      },
    );
    expect(out.status).toBe('ok');
    expect(asked).toEqual([echo]);
    expect(read('before.txt')).toBe('x');
    expect(out.results.find((r) => r.op === 'shell').result.stdout).toMatch(/hello/);
  });

  it('kills the batch when denied, keeping committed file ops', async () => {
    const out = await run(
      [
        { op: 'write', path: 'kept.txt', text: 'x' },
        { op: 'shell', cmd: echo },
      ],
      { approve: async () => ({ allow: false, reason: 'no thanks' }) },
    );
    expect(out.status).toBe('denied');
    expect(exists('kept.txt')).toBe(true);
  });

  it('reports a non-zero exit as a failed batch', async () => {
    const out = await run([{ op: 'shell', cmd: 'exit 3' }], {
      approve: async () => ({ allow: true }),
    });
    expect(out.status).toBe('apply-failed');
    expect(out.errors[0].message).toMatch(/exited 3/);
  });
});
