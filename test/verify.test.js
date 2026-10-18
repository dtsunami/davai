import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sandbox } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';
import { Journal } from '../src/agent/journal.js';
import { normalizeBatch } from '../src/agent/ops/schema.js';
import { executeBatch } from '../src/agent/ops/executor.js';
import { verifyWritten } from '../src/agent/ops/verify.js';

let root;
let base;
let ctx;

const CLEAN = 'const a = 1;\nconst b = 2;\n';

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-verify-'));
  fs.mkdirSync(path.join(base, 'project'), { recursive: true });
  root = fs.realpathSync(path.join(base, 'project'));
  fs.writeFileSync(path.join(root, 'a.js'), CLEAN);

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
    /* windows handle */
  }
});

const abs = (p) => path.join(root, p);
const write = (p, data) => {
  fs.writeFileSync(abs(p), data);
  return abs(p);
};

function run(rawOps) {
  const { ops, errors } = normalizeBatch(rawOps);
  if (errors.length) {
    return Promise.resolve({ status: 'plan-failed', results: [], errors });
  }
  return executeBatch(ops, ctx);
}

describe('verifyWritten', () => {
  it('passes an ordinary source file', () => {
    expect(verifyWritten(write('ok.js', CLEAN))).toBe(null);
  });

  it('flags a git conflict marker in a file that was previously clean', () => {
    const p = write('conflict.js', 'const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n');
    const reason = verifyWritten(p);
    expect(reason).toMatch(/conflict marker/);
  });

  it('flags the closing marker too', () => {
    const p = write('conflict2.js', 'const a = 1;\n>>>>>>> theirs\n');
    expect(verifyWritten(p)).toMatch(/conflict marker/);
  });

  it('skips the conflict check on a file the op created', () => {
    // A doc that quotes a diff is legitimate content, not damage.
    const p = write('doc.md', '# Resolving\n\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n');
    expect(verifyWritten(p, { created: true })).toBe(null);
    expect(verifyWritten(p, { created: false })).toMatch(/conflict marker/);
  });

  it('does not flag a bare ======= divider', () => {
    // Valid setext underline, and common in comment banners.
    const p = write('readme.md', 'Heading\n=======\n\nbody text\n');
    expect(verifyWritten(p)).toBe(null);
  });

  it('does not flag fewer than seven angle brackets', () => {
    const p = write('arrows.js', 'const shift = a >>> 2;\nconst tag = "<<<<<<";\n');
    expect(verifyWritten(p)).toBe(null);
  });

  it('flags NUL bytes even in a file the op created', () => {
    const p = write('binary.js', Buffer.from([0x61, 0x00, 0x62]));
    expect(verifyWritten(p)).toMatch(/NUL bytes/);
    expect(verifyWritten(p, { created: true })).toMatch(/NUL bytes/);
  });

  it('returns null for an unreadable path', () => {
    // The op's own error handling owns this case; the check has nothing to say.
    expect(verifyWritten(path.join(root, 'does-not-exist.js'))).toBe(null);
  });
});

describe('verify integration with executeBatch', () => {
  it('rolls the whole batch back when a replace introduces a conflict marker', async () => {
    const out = await run([
      { op: 'write', path: 'new.js', text: 'export const hi = 1;\n' },
      { op: 'replace', path: 'a.js', old: 'const b = 2;', new: '<<<<<<< HEAD\nconst b = 3;' },
    ]);

    expect(out.status).toBe('apply-failed');
    expect(out.errors[0].op).toBe('replace');
    expect(out.errors[0].message).toMatch(/conflict marker/);
    // The earlier write is undone too: the batch is atomic.
    expect(fs.existsSync(abs('new.js'))).toBe(false);
    expect(fs.readFileSync(abs('a.js'), 'utf8')).toBe(CLEAN);
  });

  it('lets a created file containing a conflict marker through', async () => {
    const out = await run([
      { op: 'write', path: 'notes.md', text: '<<<<<<< HEAD\nours\n>>>>>>> theirs\n' },
    ]);

    expect(out.status).toBe('ok');
    expect(fs.existsSync(abs('notes.md'))).toBe(true);
  });

  it('allows an ordinary replace to proceed', async () => {
    const out = await run([{ op: 'replace', path: 'a.js', old: 'const b = 2;', new: 'const b = 3;' }]);

    expect(out.status).toBe('ok');
    expect(fs.readFileSync(abs('a.js'), 'utf8')).toBe('const a = 1;\nconst b = 3;\n');
  });
});