/**
 * Shell environment inspection for live syntax highlighting and Tab completion.
 *
 * Scans $PATH lazily and caches the executable set until process.env.PATH changes,
 * so per-keystroke highlighting and completion never block the TUI render loop.
 */
import fs from 'node:fs';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';

/** Common POSIX, zsh/bash, and cmd/PowerShell built-in commands and keywords. */
export const SHELL_BUILTINS = new Set([
  'alias', 'bg', 'bind', 'break', 'builtin', 'call', 'case', 'cd', 'chdir', 'cls',
  'command', 'continue', 'copy', 'declare', 'del', 'dir', 'dirs', 'do', 'done',
  'echo', 'elif', 'else', 'enable', 'erase', 'esac', 'eval', 'exec', 'exit',
  'export', 'false', 'fc', 'fg', 'fi', 'for', 'function', 'getopts', 'hash', 'help',
  'history', 'if', 'in', 'jobs', 'kill', 'let', 'local', 'logout', 'md', 'mkdir',
  'mklink', 'move', 'popd', 'printf', 'pushd', 'pwd', 'rd', 'read', 'readonly',
  'ren', 'rename', 'return', 'rmdir', 'select', 'set', 'shift', 'shopt', 'source',
  'start', 'suspend', 'test', 'then', 'time', 'times', 'trap', 'true', 'type',
  'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'until', 'wait', 'where',
  'which', 'while', '.', ':', '[', '[[',
]);

/** Prefix commands whose first non-flag argument is still in command position. */
export const COMMAND_WRAPPERS = new Set([
  'sudo', 'env', 'command', 'builtin', 'nohup', 'time', 'nice', 'xargs', 'npx', 'bunx',
]);

/** Subcommands for ubiquitous developer CLIs, offered when completing word #2. */
export const TOOL_SUBCOMMANDS = {
  git: [
    'add', 'bisect', 'blame', 'branch', 'checkout', 'cherry-pick', 'clean', 'clone',
    'commit', 'config', 'diff', 'fetch', 'grep', 'init', 'log', 'merge', 'mv', 'pull',
    'push', 'rebase', 'reflog', 'remote', 'reset', 'restore', 'revert', 'rm', 'show',
    'stash', 'status', 'submodule', 'switch', 'tag', 'worktree',
  ],
  npm: [
    'audit', 'build', 'ci', 'exec', 'init', 'install', 'lint', 'ls', 'outdated',
    'pack', 'publish', 'run', 'start', 'test', 'uninstall', 'update',
  ],
  pnpm: [
    'add', 'audit', 'build', 'dlx', 'exec', 'init', 'install', 'lint', 'list',
    'outdated', 'pack', 'publish', 'remove', 'run', 'start', 'test', 'update',
  ],
  yarn: [
    'add', 'audit', 'build', 'dlx', 'init', 'install', 'lint', 'outdated', 'pack',
    'publish', 'remove', 'run', 'start', 'test', 'upgrade',
  ],
  cargo: [
    'add', 'bench', 'build', 'check', 'clean', 'clippy', 'doc', 'fix', 'fmt', 'init',
    'install', 'new', 'publish', 'remove', 'run', 'test', 'tree', 'update',
  ],
  docker: [
    'build', 'compose', 'cp', 'exec', 'images', 'inspect', 'kill', 'logs', 'network',
    'ps', 'pull', 'push', 'rm', 'rmi', 'run', 'start', 'stop', 'system', 'tag', 'volume',
  ],
  vitest: ['run', 'watch', 'bench', 'related', 'typecheck'],
};

let pathCache = { key: null, commands: [], set: new Set() };
const MAX_PATH_DIRS = 64;

function winExtensions() {
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.PS1';
  return new Set(
    raw
      .split(';')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Return cached `$PATH` executables:
 * - `commands`: sorted list of clean command names for Tab completion
 * - `set`: lookup set (lowercased on win32) for O(1) command validation
 */
export function getPathCommands() {
  const rawPath = process.env.PATH || '';
  const rawExt = IS_WIN ? process.env.PATHEXT || '' : '';
  const cacheKey = `${rawPath}\0${rawExt}`;
  if (pathCache.key === cacheKey) return pathCache;

  const set = new Set();
  const displayMap = new Map();
  const exts = IS_WIN ? winExtensions() : null;
  const dirs = rawPath.split(path.delimiter).filter(Boolean).slice(0, MAX_PATH_DIRS);

  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (!name || name.startsWith('.')) continue;
      if (ent.isDirectory()) continue;
      if (IS_WIN) {
        const ext = path.extname(name).toLowerCase();
        if (!exts.has(ext)) continue;
        const stem = name.slice(0, name.length - ext.length);
        if (!stem) continue;
        const lowerStem = stem.toLowerCase();
        set.add(lowerStem);
        set.add(name.toLowerCase());
        if (!displayMap.has(lowerStem)) displayMap.set(lowerStem, stem);
      } else {
        set.add(name);
        if (!displayMap.has(name)) displayMap.set(name, name);
      }
    }
  }

  for (const b of SHELL_BUILTINS) {
    set.add(IS_WIN ? b.toLowerCase() : b);
    if (!displayMap.has(b) && /^[a-z]/.test(b)) displayMap.set(b, b);
  }

  const commands = [...displayMap.values()].sort((a, b) => a.localeCompare(b));
  pathCache = { key: cacheKey, commands, set };
  return pathCache;
}

/** Short-lived stat memo so typing inside a path does not stat disk on every frame. */
const existsCache = new Map();
const EXISTS_TTL_MS = 1500;

/**
 * Resolve the effective working directory for shell path checks/completions.
 * Respects `sandbox` boundaries when available.
 */
export function resolveShellBaseDir(sandbox, cwd) {
  if (cwd && typeof sandbox?.resolveForRead === 'function') {
    try {
      return sandbox.resolveForRead(cwd, { allowIgnored: true });
    } catch {
      /* fall through */
    }
  }
  if (cwd && !sandbox?.resolveForRead) {
    return path.resolve(cwd);
  }
  return sandbox?.writeRoot || process.cwd();
}

/** Check whether `token` resolves to an existing path on disk (within sandbox if set). */
export function pathExistsCached(token, { sandbox, cwd } = {}) {
  if (!token || token.length > 260 || /[*?<>|"\r\n]/.test(token)) return false;
  const baseDir = resolveShellBaseDir(sandbox, cwd);
  const key = `${baseDir}\0${token}`;
  const now = Date.now();
  const hit = existsCache.get(key);
  if (hit && now - hit.t < EXISTS_TTL_MS) return hit.ok;

  let ok = false;
  try {
    const candidate = path.resolve(baseDir, token);
    if (typeof sandbox?.resolveForRead === 'function') {
      const abs = sandbox.resolveForRead(candidate, { allowIgnored: true });
      ok = fs.existsSync(abs);
    } else {
      ok = fs.existsSync(candidate);
    }
  } catch {
    ok = false;
  }

  if (existsCache.size > 512) existsCache.clear();
  existsCache.set(key, { ok, t: now });
  return ok;
}

/** True when `word` is a shell builtin, an executable on $PATH, or a valid local path. */
export function isKnownShellCommand(word, { sandbox, cwd } = {}) {
  if (!word) return false;
  const key = IS_WIN ? word.toLowerCase() : word;
  if (SHELL_BUILTINS.has(key)) return true;
  const { set } = getPathCommands();
  if (set.has(key)) return true;
  if (word.includes('/') || word.includes('\\') || word.startsWith('.')) {
    return pathExistsCached(word, { sandbox, cwd });
  }
  return false;
}

/** Read npm/pnpm/yarn script names from `<baseDir>/package.json`, if present. */
export function readPackageScripts({ sandbox, cwd } = {}) {
  const baseDir = resolveShellBaseDir(sandbox, cwd);
  const pkgFile = path.join(baseDir, 'package.json');
  try {
    if (typeof sandbox?.resolveForRead === 'function') {
      sandbox.resolveForRead(pkgFile, { allowIgnored: true });
    }
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    return Object.keys(pkg?.scripts || {}).sort();
  } catch {
    return [];
  }
}