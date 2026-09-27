/**
 * Path jail (req 5).
 *
 *   Write root  = process.cwd() subtree. No exceptions.
 *   Read allow  = write root + every entry of DAVAI_RO_DIRS.
 *
 * Containment is checked against the *realpath* so symlinks, NTFS junctions and ..
 * cannot escape. Every op routes through resolveForRead/resolveForWrite; no op does
 * its own path math.
 */
import fs from 'node:fs';
import path from 'node:path';

const WIN = process.platform === 'win32';

export class SandboxError extends Error {
  constructor(message, code = 'EJAIL') {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }
}

/** Strip the \\?\ long-path prefix and normalize case/separators on win32. */
function canonical(p) {
  let out = path.resolve(p);
  if (WIN) {
    out = out.replace(/^\\\\\?\\(UNC\\)?/, (_, unc) => (unc ? '\\\\' : ''));
    out = out.toLowerCase();
  }
  return out;
}

/**
 * True when `child` is `parent` or lives beneath it. Compares canonical forms and
 * requires a separator boundary, so /foo/barbaz is not inside /foo/bar.
 */
export function isInside(parent, child) {
  const p = canonical(parent);
  const c = canonical(child);
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

/**
 * Resolve the realpath of a target that may not exist yet, by walking up to the
 * nearest existing ancestor and re-appending the missing tail. Without this, a write
 * to a new file inside a symlinked directory would skip the symlink check.
 */
function realpathAllowingMissing(target) {
  let current = path.resolve(target);
  const tail = [];
  // Bounded: a path has finite depth, but guard anyway.
  for (let i = 0; i < 4096; i++) {
    try {
      const real = fs.realpathSync(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // hit the root
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(target);
}

export class Sandbox {
  /**
   * @param {{cwd: string, roDirs?: string[], ignore?: {isIgnored(p: string): boolean}}} opts
   */
  constructor({ cwd, roDirs = [], ignore = null }) {
    this.writeRoot = fs.existsSync(cwd) ? fs.realpathSync(path.resolve(cwd)) : path.resolve(cwd);
    this.roDirs = roDirs.map((d) => path.resolve(d));
    this.ignore = ignore;
  }

  /** Every root a read may land in. */
  get readRoots() {
    return [this.writeRoot, ...this.roDirs];
  }

  /** Display a path relative to the write root when possible. */
  rel(p) {
    const abs = path.resolve(p);
    if (isInside(this.writeRoot, abs)) {
      const r = path.relative(this.writeRoot, abs);
      return r === '' ? '.' : r.split(path.sep).join('/');
    }
    return abs;
  }

  /**
   * Resolve a path for reading. Must land inside the write root or a DAVAI_RO_DIRS
   * entry, and must not be excluded by .daignore.
   * @returns {string} absolute real path
   */
  resolveForRead(p, { allowIgnored = false } = {}) {
    if (typeof p !== 'string' || !p.trim()) {
      throw new SandboxError('path must be a non-empty string', 'EPATH');
    }
    const abs = realpathAllowingMissing(path.resolve(this.writeRoot, p));
    const ok = this.readRoots.some((root) => isInside(root, abs));
    if (!ok) {
      throw new SandboxError(
        `read denied: ${this.rel(abs)} is outside the working directory and DAVAI_RO_DIRS`,
      );
    }
    if (!allowIgnored && this.isIgnored(abs)) {
      throw new SandboxError(`read denied: ${this.rel(abs)} is excluded by .daignore`, 'EIGNORED');
    }
    return abs;
  }

  /**
   * Resolve a path for writing. Must land inside the write root — read-only dirs are
   * never writable, by definition.
   * @returns {string} absolute real path
   */
  resolveForWrite(p) {
    if (typeof p !== 'string' || !p.trim()) {
      throw new SandboxError('path must be a non-empty string', 'EPATH');
    }
    const abs = realpathAllowingMissing(path.resolve(this.writeRoot, p));
    if (!isInside(this.writeRoot, abs)) {
      const why = this.roDirs.some((root) => isInside(root, abs))
        ? 'DAVAI_RO_DIRS entries are read-only'
        : 'writes are confined to the working directory';
      throw new SandboxError(`write denied: ${this.rel(abs)} — ${why}`);
    }
    if (this.isIgnored(abs)) {
      throw new SandboxError(`write denied: ${this.rel(abs)} is excluded by .daignore`, 'EIGNORED');
    }
    return abs;
  }

  isIgnored(abs) {
    if (!this.ignore) return false;
    if (!isInside(this.writeRoot, abs)) return false; // .daignore is project-scoped
    const rel = path.relative(this.writeRoot, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return false;
    return this.ignore.isIgnored(rel);
  }
}
