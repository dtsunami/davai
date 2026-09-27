/**
 * Project grounding for the first prompt (req 4).
 *
 * The directory listing is activity-ranked — subdirectories touched recently are
 * expanded first — which is the useful part of the legacy da_code DirectoryContext.
 * A flat alphabetical listing of a large repo tells the model almost nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_TOP_ENTRIES = 40;
const MAX_PREVIEW_DIRS = 8;
const MAX_PREVIEW_FILES = 6;

export function buildGrounding({ sandbox, cfg }) {
  const root = sandbox.writeRoot;
  const lines = [];

  lines.push('# Project grounding');
  lines.push('');
  lines.push(`Working directory: ${root}`);
  lines.push(`Platform: ${process.platform} (${process.arch}), shell: ${defaultShell()}`);
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);

  if (cfg.roDirs.length) {
    lines.push('');
    lines.push('Readable outside the working directory (DAVAI_RO_DIRS), but NOT writable:');
    for (const d of cfg.roDirs) lines.push(`  ${d}`);
  }

  const git = gitInfo(root);
  if (git) {
    lines.push('');
    lines.push(`Git: branch ${git.branch}, ${git.dirty} uncommitted change(s)`);
    if (git.recent.length) {
      lines.push('Recent commits:');
      for (const c of git.recent) lines.push(`  ${c}`);
    }
  }

  const project = projectInfo(root);
  if (project.length) {
    lines.push('');
    lines.push('Project:');
    for (const p of project) lines.push(`  ${p}`);
  }

  lines.push('');
  lines.push('## Directory');
  lines.push(listing(root, sandbox));

  const agents = readAgentsFile(root);
  if (agents) {
    lines.push('');
    lines.push('## Project instructions (from ' + agents.name + ')');
    lines.push(agents.text);
  }

  return lines.join('\n');
}

function defaultShell() {
  return process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
}

function gitInfo(root) {
  const run = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = run(['status', '--porcelain']);
    const dirty = status ? status.split('\n').filter(Boolean).length : 0;
    let recent = [];
    try {
      recent = run(['log', '-3', '--oneline', '--no-decorate']).split('\n').filter(Boolean);
    } catch {
      /* no commits yet */
    }
    return { branch, dirty, recent };
  } catch {
    return null;
  }
}

function projectInfo(root) {
  const out = [];
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      out.push(`package.json: ${pkg.name || '(unnamed)'}@${pkg.version || '0.0.0'}`);
      const scripts = Object.keys(pkg.scripts || {});
      if (scripts.length) out.push(`npm scripts: ${scripts.join(', ')}`);
      out.push(`package manager: ${detectPackageManager(root)}`);
    } catch {
      out.push('package.json present but unparseable');
    }
  }
  for (const [file, label] of [
    ['pyproject.toml', 'Python (pyproject.toml)'],
    ['requirements.txt', 'Python (requirements.txt)'],
    ['Cargo.toml', 'Rust (Cargo.toml)'],
    ['go.mod', 'Go (go.mod)'],
    ['pom.xml', 'Java (pom.xml)'],
    ['Makefile', 'Makefile present'],
  ]) {
    if (fs.existsSync(path.join(root, file))) out.push(label);
  }
  return out;
}

function detectPackageManager(root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function readAgentsFile(root) {
  for (const name of ['DAVAI.md', 'AGENTS.md', 'CLAUDE.md']) {
    const p = path.join(root, name);
    try {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (text) return { name, text: text.slice(0, 8000) };
    } catch {
      /* next */
    }
  }
  return null;
}

/** Activity-ranked directory listing. */
function listing(root, sandbox) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return `  (cannot read: ${err.message})`;
  }

  const dirs = [];
  const files = [];
  for (const ent of entries) {
    const p = path.join(root, ent.name);
    if (sandbox.isIgnored(p)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (ent.isDirectory()) dirs.push({ name: ent.name, mtime, score: activityScore(p, mtime) });
    else files.push({ name: ent.name, mtime });
  }

  dirs.sort((a, b) => b.score - a.score);
  files.sort((a, b) => b.mtime - a.mtime);

  const out = [];
  for (const f of files.slice(0, MAX_TOP_ENTRIES)) {
    out.push(`  ${f.name}  (${ago(f.mtime)})`);
  }
  if (files.length > MAX_TOP_ENTRIES) out.push(`  … ${files.length - MAX_TOP_ENTRIES} more files`);

  for (const d of dirs) out.push(`  ${d.name}/  (${ago(d.mtime)})`);

  // Expand the most active directories one level.
  for (const d of dirs.slice(0, MAX_PREVIEW_DIRS)) {
    const preview = previewDir(path.join(root, d.name), sandbox);
    if (preview.length) {
      out.push('');
      out.push(`  ${d.name}/`);
      for (const line of preview) out.push(`    ${line}`);
    }
  }

  return out.join('\n');
}

/** Recency plus a shallow child count: a big, recently-touched dir ranks highest. */
function activityScore(dir, mtime) {
  let n = 0;
  try {
    n = fs.readdirSync(dir).length;
  } catch {
    /* unreadable */
  }
  const ageDays = (Date.now() - mtime) / 86400_000;
  return Math.log1p(n) * 2 + 10 / (1 + ageDays);
}

function previewDir(dir, sandbox) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const kept = [];
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (sandbox.isIgnored(p)) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    kept.push({ name: ent.name + (ent.isDirectory() ? '/' : ''), mtime });
  }
  kept.sort((a, b) => b.mtime - a.mtime);
  const out = kept.slice(0, MAX_PREVIEW_FILES).map((e) => e.name);
  if (kept.length > MAX_PREVIEW_FILES) out.push(`… ${kept.length - MAX_PREVIEW_FILES} more`);
  return out;
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
