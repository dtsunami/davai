import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PROMPTS,
  PROMPT_SPECS,
  buildSystemPrompt,
  opsResultPrompt,
  repairPrompt,
  resolvePrompts,
} from '../src/agent/prompt.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-prompts-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolvePrompts', () => {
  it('returns the defaults when nothing is set', () => {
    const { values, sources } = resolvePrompts({});
    expect(values).toEqual(DEFAULT_PROMPTS);
    expect(Object.values(sources).every((s) => s === 'default')).toBe(true);
  });

  it('ignores unrelated environment variables', () => {
    const { values } = resolvePrompts({ PATH: '/usr/bin', DAVAI_MODEL: 'x' });
    expect(values).toEqual(DEFAULT_PROMPTS);
  });

  it('overrides every prompt from an inline variable', () => {
    const env = {};
    for (const spec of PROMPT_SPECS) {
      env[spec.env] = `custom ${spec.key} ${spec.placeholder || ''}`.trim();
    }
    const { values, sources } = resolvePrompts(env);
    for (const spec of PROMPT_SPECS) {
      expect(values[spec.key]).toContain(`custom ${spec.key}`);
      expect(sources[spec.key]).toBe(spec.env);
    }
  });

  it('reads an override from a file', () => {
    const file = path.join(dir, 'preamble.txt');
    fs.writeFileSync(file, 'You are a terse file robot.\n');
    const { values, sources } = resolvePrompts({ DAVAI_PROMPT_PREAMBLE_FILE: file });
    expect(values.preamble).toBe('You are a terse file robot.\n');
    expect(sources.preamble).toContain(file);
    // Untouched prompts keep their defaults.
    expect(values.protocol).toBe(DEFAULT_PROMPTS.protocol);
  });

  it('prefers the inline value when both are set', () => {
    const file = path.join(dir, 'preamble.txt');
    fs.writeFileSync(file, 'from the file');
    const { values, sources } = resolvePrompts({
      DAVAI_PROMPT_PREAMBLE: 'from the variable',
      DAVAI_PROMPT_PREAMBLE_FILE: file,
    });
    expect(values.preamble).toBe('from the variable');
    expect(sources.preamble).toBe('DAVAI_PROMPT_PREAMBLE');
  });

  it('treats an empty variable as unset rather than as an empty prompt', () => {
    const { values, sources } = resolvePrompts({ DAVAI_PROMPT_NUDGE: '' });
    expect(values.nudge).toBe(DEFAULT_PROMPTS.nudge);
    expect(sources.nudge).toBe('default');
  });

  it('rejects a whitespace-only override', () => {
    expect(() => resolvePrompts({ DAVAI_PROMPT_NUDGE: '   \n' })).toThrow(/is empty/);
  });

  it('rejects an unreadable file', () => {
    expect(() =>
      resolvePrompts({ DAVAI_PROMPT_NUDGE_FILE: path.join(dir, 'missing.txt') }),
    ).toThrow(/could not be read/);
  });

  it('rejects a template that drops its placeholder', () => {
    expect(() => resolvePrompts({ DAVAI_PROMPT_OPS_RESULT: 'here are the results' })).toThrow(
      /must contain \{results\}/,
    );
    expect(() => resolvePrompts({ DAVAI_PROMPT_REPAIR: 'that did not parse' })).toThrow(
      /must contain \{error\}/,
    );
  });

  it('accepts a template that keeps its placeholder', () => {
    const { values } = resolvePrompts({ DAVAI_PROMPT_OPS_RESULT: 'out:\n{results}' });
    expect(opsResultPrompt('```da_results\nok\n```', values)).toBe('out:\n```da_results\nok\n```');
  });
});

describe('prompt assembly', () => {
  it('builds the system prompt from preamble, protocol and grounding in order', () => {
    const prompts = { ...DEFAULT_PROMPTS, preamble: 'PRE', protocol: 'PROTO' };
    const out = buildSystemPrompt({ grounding: 'GROUND', prompts });
    expect(out).toBe('PRE\n\nPROTO\n\nGROUND');
  });

  it('falls back to the defaults when no prompts are passed', () => {
    const out = buildSystemPrompt({ grounding: 'GROUND' });
    expect(out).toContain('da_ops protocol');
    expect(out.endsWith('GROUND')).toBe(true);
  });

  it('wraps results and substitutes the error', () => {
    expect(opsResultPrompt('BLOCK')).toContain('BLOCK');
    expect(repairPrompt('unexpected token')).toContain('unexpected token');
  });

  it('does not treat $ patterns in substituted text as replacement syntax', () => {
    // A shell result or a parser complaint can easily contain $& or $1.
    expect(opsResultPrompt('cost is $& and $1')).toContain('cost is $& and $1');
    expect(repairPrompt('bad $& at $1')).toContain('bad $& at $1');
  });

  it('substitutes every occurrence of a placeholder', () => {
    const prompts = { ...DEFAULT_PROMPTS, opsResult: '{results}\n---\n{results}' };
    expect(opsResultPrompt('X', prompts)).toBe('X\n---\nX');
  });
});
