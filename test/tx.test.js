import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sandbox } from '../src/agent/sandbox.js';
import { DaIgnore } from '../src/agent/daignore.js';
import { Journal } from '../src/agent/journal.js';
import { normalizeBatch } from '../src/agent/ops/schema.js';
import { executeBatch, formatResults } from '../src/agent/ops/executor.js';
import { buildSystemPrompt, DEFAULT_PROMPTS } from '../src/agent/prompt.js';
import { loadConfig } from '../src/config/env.js';
import { parseArgs } from '../bin/davai.js';

let base;
let root;
let ctx;

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
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-tx-'));
  fs.mkdirSync(path.join(base, 'project'), { recursive: true });
  root = fs.realpathSync(path.join(base, 'project'));
  fs.writeFileSync(path.join(root, '.daignore'), 'secret.txt\n');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'top-secret\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'one.js'),
    'export function oldHelper(x) {\n  return x + 1;\n}\n',
  );
  fs.writeFileSync(
    path.join(root, 'src', 'two.js'),
    'import { oldHelper } from "./one.js";\nexport const v = oldHelper(2);\n',
  );
  fs.writeFileSync(path.join(root, 'src', 'three.js'), 'export const untouched = true;\n');

  const sessionDir = path.join(base, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  ctx = {
    sandbox: new Sandbox({ cwd: root, roDirs: [], ignore: DaIgnore.fromDir(root) }),
    journal: new Journal({ dir: sessionDir }),
    shellTimeout: 5000,
    codeMode: true,
    txState: {},
  };
});

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('DAVAI_CODE_MODE gate and prompt baseline', () => {
  it('defaults codeMode to false and leaves buildSystemPrompt byte-identical when off', () => {
    const savedHome = process.env.DAVAI_HOME;
    const savedMode = process.env.DAVAI_CODE_MODE;
    process.env.DAVAI_HOME = base;
    delete process.env.DAVAI_CODE_MODE;
    try {
      const cfgOff = loadConfig({ cwd: root });
      expect(cfgOff.codeMode).toBe(false);

      const cfgOn = loadConfig({ cwd: root, overrides: { DAVAI_CODE_MODE: 'true' } });
      expect(cfgOn.codeMode).toBe(true);

      const baseline = buildSystemPrompt({ grounding: 'GROUND', prompts: DEFAULT_PROMPTS });
      const explicitOff = buildSystemPrompt({
        grounding: 'GROUND',
        prompts: DEFAULT_PROMPTS,
        codeMode: false,
      });
      const withTx = buildSystemPrompt({
        grounding: 'GROUND',
        prompts: DEFAULT_PROMPTS,
        codeMode: true,
      });
      expect(explicitOff).toBe(baseline);
      expect(baseline).not.toContain('"tx"');
      expect(withTx).toContain('Code Mode (`tx` op — enabled)');
    } finally {
      if (savedHome === undefined) delete process.env.DAVAI_HOME;
      else process.env.DAVAI_HOME = savedHome;
      if (savedMode === undefined) delete process.env.DAVAI_CODE_MODE;
      else process.env.DAVAI_CODE_MODE = savedMode;
    }
  });

  it('supports --code-mode CLI flag', () => {
    expect(parseArgs(['--code-mode', 'refactor']).overrides.DAVAI_CODE_MODE).toBe('true');
  });

  it('refuses tx at plan time when codeMode is disabled', async () => {
    const out = await run([{ op: 'tx', code: 'return 1;' }], { codeMode: false });
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/DAVAI_CODE_MODE/);
  });
});

describe('tx Copy-on-Write execution, sandbox, and rollback', () => {
  it('performs bulk fileset queries and refactors in one step with compact output', async () => {
    const out = await run([
      {
        op: 'tx',
        description: 'rename oldHelper to newHelper',
        code: `
          const hits = fileset("src/**/*.js").containing("oldHelper");
          const res = hits.replaceAll("oldHelper", "newHelper");
          return { paths: hits.paths(), ...res };
        `,
      },
    ]);
    expect(out.status).toBe('ok');
    expect(read('src/one.js')).toContain('function newHelper(x)');
    expect(read('src/two.js')).toContain('newHelper(2)');
    expect(read('src/three.js')).toBe('export const untouched = true;\n');

    const formatted = formatResults(out);
    expect(formatted).toContain('src/one.js');
    expect(formatted).toContain('src/two.js');
    expect(formatted).toContain('"occurrences": 3');
  });

  it('supports RegExp literals inside the VM context across realms', async () => {
    const out = await run([
      {
        op: 'tx',
        code: `
          replace("src/one.js", /oldHelper\\((\\w+)\\)/, "newHelper($1)");
          return fileset("src/**/*.js").containing(/newHelper/).paths();
        `,
      },
    ]);
    expect(out.status).toBe('ok');
    expect(read('src/one.js')).toContain('function newHelper(x)');
    expect(JSON.parse(out.results[0].result.output)).toEqual(['src/one.js']);
  });

  it('leaves disk completely untouched if the script throws mid-loop', async () => {
    const out = await run([
      {
        op: 'tx',
        code: `
          write("src/created.js", "export const x = 1;\\n");
          replace("src/one.js", "oldHelper", "halfway");
          // Ambiguous or missing replace on second file aborts the whole CoW staging map:
          replace("src/two.js", "nonexistent_symbol", "boom");
        `,
      },
    ]);
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/not found in src\/two\.js/);
    expect(exists('src/created.js')).toBe(false);
    expect(read('src/one.js')).toContain('oldHelper');
  });

  it('rolls back committed tx changes if a subsequent op in the batch fails at apply time', async () => {
    const out = await run([
      {
        op: 'tx',
        code: `
          replace("src/one.js", "oldHelper", "renamedInTx");
          write("src/added.js", "export const ok = 1;\\n");
        `,
      },
      {
        op: 'write',
        path: 'src/corrupt.js',
        text: 'bad\0nul',
      },
    ]);
    expect(out.status).toBe('apply-failed');
    expect(read('src/one.js')).toContain('oldHelper');
    expect(exists('src/added.js')).toBe(false);
    expect(exists('src/corrupt.js')).toBe(false);
  });

  it('enforces Sandbox write jail, .daignore, and blocks ambient Node globals', async () => {
    const escapeWrite = await run([
      { op: 'tx', code: 'write("../outside.txt", "nope");' },
    ]);
    expect(escapeWrite.status).toBe('plan-failed');
    expect(escapeWrite.errors[0].message).toMatch(/write denied/);

    const ignoredRead = await run([
      { op: 'tx', code: 'return read("secret.txt");' },
    ]);
    expect(ignoredRead.status).toBe('plan-failed');
    expect(ignoredRead.errors[0].message).toMatch(/\.daignore/);

    const ambient = await run([
      {
        op: 'tx',
        code: 'return [typeof process, typeof require, typeof fetch, typeof setTimeout];',
      },
    ]);
    expect(ambient.status).toBe('ok');
    expect(JSON.parse(ambient.results[0].result.output)).toEqual([
      'undefined',
      'undefined',
      'undefined',
      'undefined',
    ]);
  });

  it('terminates infinite loops via V8 timeout without touching disk', async () => {
    const out = await run(
      [
        {
          op: 'tx',
          code: 'write("src/never.js", "x"); while (true) {}',
        },
      ],
      { txTimeoutMs: 60 },
    );
    expect(out.status).toBe('plan-failed');
    expect(out.errors[0].message).toMatch(/timed out/i);
    expect(exists('src/never.js')).toBe(false);
  });

  it('persists state across turns without leaking dry-run mutations on failed batches', async () => {
    const sharedState = {};
    const ok1 = await run(
      [{ op: 'tx', code: 'state.files = glob("src/**/*.js"); return state.files.length;' }],
      { txState: sharedState },
    );
    expect(ok1.status).toBe('ok');
    expect(sharedState.files).toHaveLength(3);

    // Failed batch must not mutate sharedState during planning:
    const bad = await run(
      [
        { op: 'tx', code: 'state.files.push("corrupted");' },
        { op: 'replace', path: 'src/one.js', old: 'missing', new: 'x' },
      ],
      { txState: sharedState },
    );
    expect(bad.status).toBe('plan-failed');
    expect(sharedState.files).toHaveLength(3);
  });

  it('composes cleanly with earlier and later ops on the same file in one batch', async () => {
    const out = await run([
      { op: 'write', path: 'src/generated.js', text: 'export const count = 1;\n' },
      {
        op: 'tx',
        code: 'replace("src/generated.js", "count = 1", "count = 2");',
      },
      { op: 'replace', path: 'src/generated.js', old: 'count = 2', new: 'count = 3' },
    ]);
    expect(out.status).toBe('ok');
    expect(read('src/generated.js')).toBe('export const count = 3;\n');
  });
});