/**
 * Provider blocks: the parse, the comment/uncomment switch, and the promise that
 * nothing in the file is ever lost.
 *
 * The last point is the one worth testing hardest. The whole design rests on a switch
 * being a comment/uncomment edit — if any path here deletes an assignment or reflows a
 * line nobody asked about, an operator loses a key with no way to get it back.
 */
import { describe, it, expect } from 'vitest';
import {
  parseBlocks,
  blockState,
  blockValues,
  enableBlock,
  setBlockVar,
  selectBlockVar,
  validateBlockName,
  sentinelFor,
  END_MARKER,
} from '../src/config/profiles.js';
import dotenv from 'dotenv';

const FILE = [
  '## how this file works',
  'DAVAI_EFFORT=high',
  '',
  '#---# mistral',
  'DAVAI_PROVIDER=openai',
  'DAVAI_BASE_URL=https://api.mistral.ai/v1',
  'DAVAI_OPENAI_API_KEY=sk-mistral',
  '#-end-provider-#',
  '',
  '#---# local',
  '## a llama.cpp server on the pi',
  '#DAVAI_PROVIDER=openai',
  '#DAVAI_BASE_URL=http://127.0.0.1:8080/v1',
  '#DAVAI_OPENAI_API_KEY=unused',
  '',
  '#---# gemini',
  '#DAVAI_PROVIDER=gemini',
  '#DAVAI_GEMINI_API_KEY=AIzaOLD',
  '#DAVAI_GEMINI_API_KEY=AIzaNEW',
  '',
].join('\n');

describe('parseBlocks', () => {
  it('separates the preamble from the blocks', () => {
    const { blocks, preamble } = parseBlocks(FILE);
    expect(blocks.map((b) => b.name)).toEqual(['mistral', 'local', 'gemini']);
    expect(preamble.map((v) => v.name)).toEqual(['DAVAI_EFFORT']);
  });

  it('ends a block at #-end-provider-#, at the next sentinel, or at EOF', () => {
    const { blocks } = parseBlocks(FILE);
    expect(blocks[0].closed).toBe(true);
    expect(blocks[0].vars).toHaveLength(3);
    expect(blocks[1].closed).toBe(false);
    expect(blocks[1].vars.map((v) => v.name)).toEqual([
      'DAVAI_PROVIDER',
      'DAVAI_BASE_URL',
      'DAVAI_OPENAI_API_KEY',
    ]);
    // provider + both key assignments: a shadowed duplicate is still a parsed var.
    expect(blocks[2].vars).toHaveLength(3);
  });

  it('reads a commented assignment as a disabled setting, but never a ## line', () => {
    const { blocks } = parseBlocks(FILE);
    expect(blocks[0].enabled).toBe(true);
    expect(blocks[1].enabled).toBe(false);
    // "## a llama.cpp server on the pi" is prose, not a variable.
    expect(blocks[1].vars.map((v) => v.name)).not.toContain('a');
  });

  it('treats only the last assignment of a name in a block as effective', () => {
    expect(blockValues(FILE, 'gemini')).toEqual({
      DAVAI_PROVIDER: 'gemini',
      DAVAI_GEMINI_API_KEY: 'AIzaNEW',
    });
  });
});

describe('enableBlock', () => {
  it('uncomments the chosen block and comments every other one', () => {
    const { text } = enableBlock(FILE, 'local');
    const parsed = dotenv.parse(text);
    expect(parsed.DAVAI_BASE_URL).toBe('http://127.0.0.1:8080/v1');
    expect(parsed.DAVAI_OPENAI_API_KEY).toBe('unused');
    expect(parsed.DAVAI_EFFORT).toBe('high');
    const state = blockState(text);
    expect(state.active).toEqual(['local']);
  });

  it('never loses a line: every assignment survives a switch, commented', () => {
    const before = parseBlocks(FILE);
    const { text } = enableBlock(FILE, 'gemini');
    const after = parseBlocks(text);
    expect(after.lines).toHaveLength(before.lines.length);
    for (const b of after.blocks) {
      const was = before.blocks.find((x) => x.name === b.name);
      expect(b.vars.map((v) => `${v.name}=${v.value}`)).toEqual(
        was.vars.map((v) => `${v.name}=${v.value}`),
      );
    }
  });

  it('round-trips: switching away and back restores the original text', () => {
    const toLocal = enableBlock(FILE, 'local').text;
    const back = enableBlock(toLocal, 'mistral').text;
    expect(back).toBe(FILE);
  });

  it('leaves a shadowed duplicate commented in the block it enables', () => {
    const { text } = enableBlock(FILE, 'gemini');
    expect(dotenv.parse(text).DAVAI_GEMINI_API_KEY).toBe('AIzaNEW');
    // Both assignments are still in the file; only one is live.
    expect(text).toContain('#DAVAI_GEMINI_API_KEY=AIzaOLD');
  });

  it('disables everything for null, leaving the preamble alone', () => {
    const { text } = enableBlock(FILE, null);
    const parsed = dotenv.parse(text);
    expect(parsed.DAVAI_EFFORT).toBe('high');
    expect(parsed.DAVAI_PROVIDER).toBeUndefined();
    expect(blockState(text).active).toEqual([]);
  });

  it('is a no-op, byte for byte, when the block is already live', () => {
    expect(enableBlock(FILE, 'mistral').text).toBe(FILE);
  });

  it('refuses a name that is not in the file, naming the ones that are', () => {
    expect(() => enableBlock(FILE, 'nope')).toThrow(/mistral, local, gemini/);
  });

  it('preserves prose, blank lines and ordering', () => {
    const { text } = enableBlock(FILE, 'local');
    expect(text.split('\n')[0]).toBe('## how this file works');
    expect(text).toContain('## a llama.cpp server on the pi');
    expect(text).toContain(END_MARKER);
  });
});

describe('setBlockVar', () => {
  it('writes into an existing block, matching whether that block is live', () => {
    const { text } = setBlockVar(FILE, 'local', 'DAVAI_MODEL', 'qwen3');
    // local is inert, so the new line is parked as a comment rather than taking effect.
    expect(text).toContain('#DAVAI_MODEL=qwen3');
    expect(dotenv.parse(text).DAVAI_MODEL).toBeUndefined();
    expect(blockValues(text, 'local').DAVAI_MODEL).toBe('qwen3');
  });

  it('writes live into the live block', () => {
    const { text } = setBlockVar(FILE, 'mistral', 'DAVAI_MODEL', 'mistral-large-latest');
    expect(dotenv.parse(text).DAVAI_MODEL).toBe('mistral-large-latest');
  });

  it('replaces a value in place rather than appending a second assignment', () => {
    const { text } = setBlockVar(FILE, 'mistral', 'DAVAI_OPENAI_API_KEY', 'sk-new');
    expect(dotenv.parse(text).DAVAI_OPENAI_API_KEY).toBe('sk-new');
    expect(text.match(/DAVAI_OPENAI_API_KEY/g)).toHaveLength(2); // mistral + local
  });

  it('stays inside a closed block', () => {
    const { text } = setBlockVar(FILE, 'mistral', 'DAVAI_MODEL', 'x');
    const lines = text.split('\n');
    expect(lines.indexOf('DAVAI_MODEL=x')).toBeLessThan(lines.indexOf(END_MARKER));
  });

  it('creates a block, inert, when there is none', () => {
    const r = setBlockVar(FILE, 'deepseek', 'DAVAI_OPENAI_API_KEY', 'sk-ds');
    expect(r.created).toBe(true);
    expect(r.enabled).toBe(false);
    expect(r.text).toContain(sentinelFor('deepseek'));
    expect(dotenv.parse(r.text).DAVAI_OPENAI_API_KEY).toBe('sk-mistral');
    expect(blockValues(r.text, 'deepseek')).toEqual({ DAVAI_OPENAI_API_KEY: 'sk-ds' });
  });

  it('quotes a value that needs it', () => {
    const { text } = setBlockVar(FILE, 'mistral', 'DAVAI_MODEL', 'two words');
    expect(dotenv.parse(text).DAVAI_MODEL).toBe('two words');
  });
});

/**
 * A block that collects candidates for the same setting, each under its note. This is a
 * normal block — the one the pane used to summarise as "shadowed: DAVAI_MODEL ×3".
 */
const DUPS = [
  '#---# openrouter',
  '',
  '# works, fast',
  '#DAVAI_MODEL=deepseek/deepseek-v4.1-flash',
  '',
  '# bad model',
  '#DAVAI_MODEL=z-ai/glm-5.3-flash',
  '#DAVAI_MODEL=inclusionai/ring-2.6-1t',
  '#OPENROUTER_API_KEY=sk-or-1',
  '#DAVAI_PROVIDER=openrouter',
  '',
].join('\n');

const LIVE_DUPS = ['#---# openrouter', 'DAVAI_PROVIDER=openrouter', '#DAVAI_MODEL=a/one', 'DAVAI_MODEL=b/two', ''].join('\n');

describe('duplicate assignments', () => {
  it('reports every candidate, not just the effective one', () => {
    const block = blockState(DUPS).blocks[0];
    const model = block.vars.find((v) => v.name === 'DAVAI_MODEL');
    expect(model.choices.map((c) => c.value)).toEqual([
      'deepseek/deepseek-v4.1-flash',
      'z-ai/glm-5.3-flash',
      'inclusionai/ring-2.6-1t',
    ]);
    expect(model.choices.filter((c) => c.chosen).map((c) => c.value)).toEqual([
      'inclusionai/ring-2.6-1t',
    ]);
    // A name assigned once has no choice to offer.
    expect(block.vars.find((v) => v.name === 'OPENROUTER_API_KEY').choices).toEqual([]);
  });

  it('prefers a live assignment over a later commented one', () => {
    const block = blockState(LIVE_DUPS).blocks[0];
    expect(block.enabled).toBe(true);
    expect(blockValues(LIVE_DUPS, 'openrouter').DAVAI_MODEL).toBe('b/two');
    const live = ['#---# x', 'DAVAI_MODEL=live', '#DAVAI_MODEL=parked'].join('\n');
    expect(blockValues(live, 'x').DAVAI_MODEL).toBe('live');
    expect(blockState(live).blocks[0].enabled).toBe(true);
  });
});

describe('a remark on the header line', () => {
  // "#---# mistral sucks" used not to parse as a sentinel at all, so the block below it
  // was absorbed into the previous one and every setting in both looked like a duplicate.
  const NOTED = [
    '#---# openai',
    'DAVAI_PROVIDER=openai',
    'DAVAI_MODEL=gpt-5',
    '',
    '#---# mistral sucks',
    '#DAVAI_PROVIDER=openai',
    '#DAVAI_BASE_URL=https://api.mistral.ai/v1',
    '',
  ].join('\n');

  it('opens a block, with the remark kept beside the name', () => {
    const { blocks } = blockState(NOTED);
    expect(blocks.map((b) => b.name)).toEqual(['openai', 'mistral']);
    expect(blocks[1].note).toBe('sucks');
    expect(blocks[0].vars.map((v) => v.name)).toEqual(['DAVAI_PROVIDER', 'DAVAI_MODEL']);
    expect(blocks[0].vars.every((v) => !v.choices.length)).toBe(true);
  });

  it('switches to it by name and leaves the header untouched', () => {
    const { text } = enableBlock(NOTED, 'mistral');
    expect(dotenv.parse(text).DAVAI_BASE_URL).toBe('https://api.mistral.ai/v1');
    expect(text).toContain('#---# mistral sucks');
    expect(enableBlock(text, 'openai').text).toBe(NOTED);
  });
});

describe('selectBlockVar', () => {
  it('makes a candidate effective in an inert block by moving it last', () => {
    const { text, value, enabled } = selectBlockVar(DUPS, 'openrouter', 'DAVAI_MODEL', {
      value: 'deepseek/deepseek-v4.1-flash',
    });
    expect(value).toBe('deepseek/deepseek-v4.1-flash');
    // An inert block stays inert: choosing is not switching.
    expect(enabled).toBe(false);
    expect(dotenv.parse(text).DAVAI_MODEL).toBeUndefined();
    expect(blockValues(text, 'openrouter').DAVAI_MODEL).toBe('deepseek/deepseek-v4.1-flash');
    // ...and enabling the block then uses it.
    expect(dotenv.parse(enableBlock(text, 'openrouter').text).DAVAI_MODEL).toBe(
      'deepseek/deepseek-v4.1-flash',
    );
  });

  it('carries the note above the line it moves, and loses no line', () => {
    const { text } = selectBlockVar(DUPS, 'openrouter', 'DAVAI_MODEL', {
      value: 'deepseek/deepseek-v4.1-flash',
    });
    const lines = text.split('\n');
    expect(lines).toHaveLength(DUPS.split('\n').length);
    expect(lines[lines.indexOf('#DAVAI_MODEL=deepseek/deepseek-v4.1-flash') - 1]).toBe(
      '# works, fast',
    );
    expect(text).toContain('# bad model');
    expect(text).toContain('#DAVAI_MODEL=z-ai/glm-5.3-flash');
  });

  it('uncomments the pick and comments the rest in a live block', () => {
    const { text, enabled } = selectBlockVar(LIVE_DUPS, 'openrouter', 'DAVAI_MODEL', {
      value: 'a/one',
    });
    expect(enabled).toBe(true);
    expect(dotenv.parse(text).DAVAI_MODEL).toBe('a/one');
    expect(text).toContain('#DAVAI_MODEL=b/two');
    expect(text.match(/^DAVAI_MODEL=/gm)).toHaveLength(1);
  });

  it('selects by line as well as by value', () => {
    const block = blockState(DUPS).blocks[0];
    const glm = block.vars
      .find((v) => v.name === 'DAVAI_MODEL')
      .choices.find((c) => c.value === 'z-ai/glm-5.3-flash');
    const { text } = selectBlockVar(DUPS, 'openrouter', 'DAVAI_MODEL', { line: glm.line });
    expect(blockValues(text, 'openrouter').DAVAI_MODEL).toBe('z-ai/glm-5.3-flash');
  });

  it('names the candidates when asked for one that is not there', () => {
    expect(() =>
      selectBlockVar(DUPS, 'openrouter', 'DAVAI_MODEL', { value: 'nope' }),
    ).toThrow(/ring-2.6-1t/);
    expect(() => selectBlockVar(DUPS, 'openrouter', 'DAVAI_EFFORT', { value: 'high' })).toThrow(
      /does not set DAVAI_EFFORT/,
    );
  });

  it('is a no-op on the assignment already in effect', () => {
    const { text } = selectBlockVar(DUPS, 'openrouter', 'DAVAI_MODEL', {
      value: 'inclusionai/ring-2.6-1t',
    });
    expect(text).toBe(DUPS);
  });
});

describe('validateBlockName', () => {
  it('refuses whitespace, since the header is one line', () => {
    expect(() => validateBlockName('two words')).toThrow(/no spaces/);
  });
  it('refuses the reserved closing name', () => {
    expect(() => validateBlockName('end')).toThrow(/reserved/);
  });
  it('accepts the usual shapes', () => {
    expect(validateBlockName(' gpt-4.1_local ')).toBe('gpt-4.1_local');
  });
});