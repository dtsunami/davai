import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sandbox, SandboxError, isInside } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';

let root;
let outside;
let sb;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-sb-'));
  fs.mkdirSync(path.join(base, 'project'), { recursive: true });
  fs.mkdirSync(path.join(base, 'elsewhere'), { recursive: true });
  root = fs.realpathSync(path.join(base, 'project'));
  outside = fs.realpathSync(path.join(base, 'elsewhere'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), 'x');
  fs.writeFileSync(path.join(root, '.env'), 'KEY=1');
  sb = new Sandbox({ cwd: root, roDirs: [outside], ignore: DaIgnore.fromDir(root) });
});

afterEach(() => {
  try {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  } catch {
    /* windows may hold a handle briefly */
  }
});

describe('isInside', () => {
  it('requires a separator boundary', () => {
    expect(isInside('/foo/bar', '/foo/bar/baz')).toBe(true);
    expect(isInside('/foo/bar', '/foo/bar')).toBe(true);
    expect(isInside('/foo/bar', '/foo/barbaz')).toBe(false);
  });
});

describe('write jail', () => {
  it('allows paths inside the root', () => {
    expect(sb.resolveForWrite('new.txt')).toBe(path.join(root, 'new.txt'));
    expect(sb.resolveForWrite('deep/nested/new.txt')).toBe(
      path.join(root, 'deep', 'nested', 'new.txt'),
    );
  });

  it('rejects .. traversal', () => {
    expect(() => sb.resolveForWrite('../escape.txt')).toThrow(SandboxError);
    expect(() => sb.resolveForWrite('a/../../escape.txt')).toThrow(SandboxError);
  });

  it('rejects absolute paths outside the root', () => {
    expect(() => sb.resolveForWrite(path.join(outside, 'x.txt'))).toThrow(/read-only|confined/);
  });

  it('rejects writes into read-only dirs', () => {
    expect(() => sb.resolveForWrite(path.join(outside, 'x.txt'))).toThrow(/read-only/);
  });

  it('rejects ignored paths', () => {
    expect(() => sb.resolveForWrite('.env')).toThrow(/daignore/);
    expect(() => sb.resolveForWrite('node_modules/x.js')).toThrow(/daignore/);
  });

  it('rejects empty paths', () => {
    expect(() => sb.resolveForWrite('')).toThrow(SandboxError);
    expect(() => sb.resolveForWrite('   ')).toThrow(SandboxError);
  });
});

describe('read allowlist', () => {
  it('allows the write root', () => {
    expect(sb.resolveForRead('a.txt')).toBe(path.join(root, 'a.txt'));
  });

  it('allows DAVAI_RO_DIRS entries', () => {
    expect(sb.resolveForRead(path.join(outside, 'secret.txt'))).toBe(
      path.join(outside, 'secret.txt'),
    );
  });

  it('rejects paths in neither', () => {
    const far = path.join(os.tmpdir(), 'definitely-not-allowed.txt');
    expect(() => sb.resolveForRead(far)).toThrow(SandboxError);
  });

  it('rejects ignored files', () => {
    expect(() => sb.resolveForRead('.env')).toThrow(/daignore/);
  });
});

describe('symlink escape', () => {
  const canSymlink = (() => {
    try {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-ln-'));
      fs.symlinkSync(os.tmpdir(), path.join(d, 'l'), 'junction');
      fs.rmSync(d, { recursive: true, force: true });
      return true;
    } catch {
      return false; // Windows without developer mode / admin
    }
  })();

  it.runIf(canSymlink)('resolves through a symlinked directory before checking', () => {
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    // Reading is fine: the target is a configured read-only dir.
    expect(sb.resolveForRead('link/secret.txt')).toBe(path.join(outside, 'secret.txt'));
    // Writing through the link must be refused.
    expect(() => sb.resolveForWrite('link/evil.txt')).toThrow(SandboxError);
  });

  it.runIf(canSymlink)('refuses a new file under a symlink pointing outside', () => {
    fs.symlinkSync(outside, path.join(root, 'link2'), 'junction');
    expect(() => sb.resolveForWrite('link2/deep/new.txt')).toThrow(SandboxError);
  });
});

describe('daignore', () => {
  it('matches bare names at any depth', () => {
    const ig = new DaIgnore({ root, patterns: [] });
    expect(ig.isIgnored('node_modules')).toBe(true);
    expect(ig.isIgnored('node_modules/foo/bar.js')).toBe(true);
    expect(ig.isIgnored('src/node_modules/x.js')).toBe(true);
    expect(ig.isIgnored('src/index.js')).toBe(false);
  });

  it('supports negation', () => {
    const ig = new DaIgnore({ root, patterns: ['*.log', '!keep.log'] });
    expect(ig.isIgnored('a.log')).toBe(true);
    expect(ig.isIgnored('keep.log')).toBe(false);
  });

  it('honours anchored patterns', () => {
    const ig = new DaIgnore({ root, patterns: ['/build'], useDefaults: false });
    expect(ig.isIgnored('build/x.js')).toBe(true);
    expect(ig.isIgnored('src/build/x.js')).toBe(false);
  });
});
