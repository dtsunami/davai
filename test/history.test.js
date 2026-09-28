import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PromptHistory } from '../src/session/history.js';
import { handleCommand } from '../src/ui/commands.js';

let home;

const make = (opts = {}) => new PromptHistory({ home, cwd: 'D:\\proj', ...opts });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-hist-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('PromptHistory', () => {
  it('starts empty and survives a missing file', () => {
    const h = make();
    expect(h.length).toBe(0);
    expect(h.all()).toEqual([]);
    expect(h.at(1)).toBeNull();
  });

  it('persists prompts across instances', () => {
    const a = make();
    a.add('fix the slug helper');
    a.add('now add tests');

    const b = make();
    expect(b.all()).toEqual(['fix the slug helper', 'now add tests']);
  });

  it('keeps multi-line prompts intact', () => {
    const text = 'explain this trace:\n  at foo (a.js:1)\n  at bar (b.js:2)';
    make().add(text);
    expect(make().all()).toEqual([text]);
  });

  it('collapses consecutive duplicates but not repeats further back', () => {
    const h = make();
    h.add('run the tests');
    h.add('run the tests');
    expect(h.length).toBe(1);
    h.add('fix the failure');
    h.add('run the tests');
    expect(h.all()).toEqual(['run the tests', 'fix the failure', 'run the tests']);
  });

  it('ignores blank prompts', () => {
    const h = make();
    h.add('');
    h.add('   \n  ');
    expect(h.length).toBe(0);
  });

  it('trims prompts on the way in', () => {
    const h = make();
    h.add('  spaced out  ');
    expect(h.all()).toEqual(['spaced out']);
  });

  it('caps the file at the limit, keeping the newest', () => {
    const h = make({ limit: 5 });
    for (let i = 1; i <= 12; i++) h.add(`prompt ${i}`);
    expect(h.all()).toEqual(['prompt 8', 'prompt 9', 'prompt 10', 'prompt 11', 'prompt 12']);
    expect(make({ limit: 5 }).length).toBe(5);
  });

  it('skips a truncated final line rather than refusing to load', () => {
    const h = make();
    h.add('good prompt');
    fs.appendFileSync(path.join(home, 'history.jsonl'), '{"text":"cut off mid-writ');
    expect(make().all()).toEqual(['good prompt']);
  });

  it('numbers recent entries with the index /replay takes', () => {
    const h = make();
    for (let i = 1; i <= 6; i++) h.add(`p${i}`);
    const rows = h.recent(3);
    expect(rows.map((r) => r.n)).toEqual([4, 5, 6]);
    expect(rows.map((r) => r.text)).toEqual(['p4', 'p5', 'p6']);
    expect(h.at(4)).toBe('p4');
  });

  it('counts back from the end for a negative index', () => {
    const h = make();
    h.add('first');
    h.add('last');
    expect(h.at(-1)).toBe('last');
    expect(h.at(-2)).toBe('first');
  });

  it('records the working directory alongside the prompt', () => {
    const h = make({ cwd: 'D:\\other' });
    h.add('where am i');
    expect(h.recent(1)[0].cwd).toBe('D:\\other');
  });
});

describe('/history and /replay', () => {
  const deps = (history) => {
    const pushed = [];
    return {
      pushed,
      deps: {
        session: { cfg: { cwd: 'D:\\proj', home }, ledger: {}, log: { event: () => {} }, history },
        push: (e) => pushed.push(e),
        setPane: () => {},
        exit: () => {},
        refresh: () => {},
      },
    };
  };

  it('says so when there is nothing recorded', async () => {
    const { pushed, deps: d } = deps(make());
    await handleCommand('/history', d);
    expect(pushed.at(-1).text).toMatch(/no prompt history yet/);
  });

  it('lists prompts with their replay numbers', async () => {
    const h = make();
    h.add('fix the slug helper');
    h.add('add tests');
    const { pushed, deps: d } = deps(h);

    const res = await handleCommand('/history', d);
    expect(res.handled).toBe(true);
    const text = pushed.at(-1).text;
    expect(text).toContain('1  fix the slug helper');
    expect(text).toContain('2  add tests');
    expect(text).toContain('/replay <n>');
  });

  it('marks prompts from another directory', async () => {
    const h = make({ cwd: 'D:\\elsewhere' });
    h.add('from elsewhere');
    const { pushed, deps: d } = deps(h);
    await handleCommand('/history', d);
    expect(pushed.at(-1).text).toContain('(D:\\elsewhere)');
  });

  it('returns the prompt as input so the caller submits it', async () => {
    const h = make();
    h.add('fix the slug helper');
    h.add('add tests');
    const { deps: d } = deps(h);

    const res = await handleCommand('/replay 1', d);
    expect(res.handled).toBe(false);
    expect(res.input).toBe('fix the slug helper');
  });

  it('replays the last prompt with -1', async () => {
    const h = make();
    h.add('first');
    h.add('most recent');
    const { deps: d } = deps(h);
    expect((await handleCommand('/replay -1', d)).input).toBe('most recent');
  });

  it('rejects a missing or non-numeric index without submitting anything', async () => {
    const h = make();
    h.add('only one');
    const { pushed, deps: d } = deps(h);

    const bad = await handleCommand('/replay nope', d);
    expect(bad).toEqual({ handled: true });
    expect(pushed.at(-1).message).toMatch(/takes a number/);

    const missing = await handleCommand('/replay 9', d);
    expect(missing).toEqual({ handled: true });
    expect(pushed.at(-1).message).toMatch(/no prompt 9 in history/);
  });
});
