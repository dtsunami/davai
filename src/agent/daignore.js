/**
 * .daignore — gitignore-style exclusion for list/grep/glob/read.
 * Patterns are ported from the legacy da_code default set.
 */
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

export const DEFAULT_PATTERNS = [
  'node_modules',
  '.git',
  '.davai',
  '.da',
  '.env',
  '.env.*',
  'dist',
  'build',
  'coverage',
  '.venv',
  '__pycache__',
  '*.pyc',
  '*.egg-info',
  '.pytest_cache',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.vscode',
  '.idea',
  '*.swp',
  '.DS_Store',
];

export class DaIgnore {
  /**
   * @param {{root: string, patterns?: string[], useDefaults?: boolean}} opts
   */
  constructor({ root, patterns = [], useDefaults = true }) {
    this.root = root;
    this.patterns = [...(useDefaults ? DEFAULT_PATTERNS : []), ...patterns];
    this.negations = [];

    const positive = [];
    for (const raw of this.patterns) {
      const p = raw.trim();
      if (!p || p.startsWith('#')) continue;
      if (p.startsWith('!')) this.negations.push(p.slice(1));
      else positive.push(p);
    }
    this.matcher = buildMatcher(positive);
    this.unmatcher = this.negations.length ? buildMatcher(this.negations) : null;
  }

  static fromDir(root) {
    const file = path.join(root, '.daignore');
    let patterns = [];
    try {
      patterns = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    } catch {
      /* no .daignore is fine — defaults still apply */
    }
    return new DaIgnore({ root, patterns });
  }

  /** @param {string} rel POSIX-style path relative to root */
  isIgnored(rel) {
    if (!rel || rel === '.') return false;
    const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    if (this.unmatcher && this.unmatcher(norm)) return false;
    return this.matcher(norm);
  }
}

/**
 * A gitignore-ish pattern matches the path itself and anything under it, at any
 * depth, unless it is anchored with a leading slash.
 */
function buildMatcher(patterns) {
  if (!patterns.length) return () => false;
  const globs = [];
  for (const raw of patterns) {
    let p = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!p) continue;
    if (p.startsWith('/')) {
      p = p.slice(1);
      globs.push(p, `${p}/**`);
    } else if (p.includes('/')) {
      globs.push(p, `${p}/**`);
    } else {
      globs.push(p, `**/${p}`, `**/${p}/**`, `${p}/**`);
    }
  }
  const isMatch = picomatch(globs, { dot: true, nocase: process.platform === 'win32' });
  return (candidate) => isMatch(candidate);
}
