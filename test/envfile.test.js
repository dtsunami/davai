/**
 * A .env is a file an operator hand-wrote, and on Windows they hand-wrote it with CRLF.
 *
 * Every regex in config/profiles.js is anchored with `$`, and `.` does not match `\r`,
 * so a CRLF file matched no sentinel and no assignment: provider blocks were simply
 * invisible. The fix normalizes on read and restores the file's own ending on write, so
 * the promise that switching back leaves the file byte for byte identical still holds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  toLines,
  joinLines,
  detectEol,
  toEol,
  editEnvFile,
  setEnvVars,
  readEnvText,
} from '../src/config/envfile.js';
import { blockState, enableBlock, blockValues } from '../src/config/profiles.js';

const BLOCKS = [
  'DAVAI_EFFORT=high',
  '',
  '#---# mistral',
  'DAVAI_PROVIDER=openai',
  'DAVAI_BASE_URL=https://api.mistral.ai/v1',
  'DAVAI_OPENAI_API_KEY=sk-mistral',
  '#-end-provider-#',
  '',
  '#---# local',
  '#DAVAI_PROVIDER=openai',
  '#DAVAI_BASE_URL=http://127.0.0.1:8080/v1',
  '',
].join('\n');

const crlf = (s) => s.replace(/\n/g, '\r\n');

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-envfile-'));
  file = path.join(dir, '.env');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('toLines', () => {
  it('strips the carriage return a CRLF file leaves on every line', () => {
    expect(toLines('A=1\r\nB=2\r\n')).toEqual(['A=1', 'B=2']);
  });

  it('is unchanged for LF', () => {
    expect(toLines('A=1\nB=2\n')).toEqual(['A=1', 'B=2']);
  });
});

describe('detectEol / toEol', () => {
  it('reports the file own ending', () => {
    expect(detectEol('A=1\r\nB=2\r\n')).toBe('\r\n');
    expect(detectEol('A=1\nB=2\n')).toBe('\n');
    expect(detectEol('')).toBe('\n');
  });

  it('is idempotent, so re-converting already-CRLF text cannot make \\r\\r\\n', () => {
    expect(toEol(toEol('A=1\nB=2\n', '\r\n'), '\r\n')).toBe('A=1\r\nB=2\r\n');
    expect(toEol('A=1\r\nB=2\r\n', '\n')).toBe('A=1\nB=2\n');
  });
});

describe('provider blocks in a CRLF file', () => {
  it('parses the blocks at all', () => {
    const state = blockState(crlf(BLOCKS));
    expect(state.blocks.map((b) => b.name)).toEqual(['mistral', 'local']);
    expect(state.active).toEqual(['mistral']);
    expect(blockValues(crlf(BLOCKS), 'mistral').DAVAI_BASE_URL).toBe(
      'https://api.mistral.ai/v1',
    );
  });

  it('switches a block and writes the file back as CRLF', () => {
    fs.writeFileSync(file, crlf(BLOCKS));
    editEnvFile(file, (text) => enableBlock(text, 'local').text);
    const after = readEnvText(file);
    expect(after.includes('\r\n')).toBe(true);
    expect(/[^\r]\n/.test(after)).toBe(false);
    expect(after.includes('\r\r')).toBe(false);
    expect(blockState(after).active).toEqual(['local']);
    expect(blockValues(after, 'local').DAVAI_BASE_URL).toBe('http://127.0.0.1:8080/v1');
  });

  it('leaves a CRLF file byte for byte identical on a no-op switch', () => {
    fs.writeFileSync(file, crlf(BLOCKS));
    const r = editEnvFile(file, (text) => enableBlock(text, 'mistral').text);
    expect(r.changed).toBe(false);
    expect(readEnvText(file)).toBe(crlf(BLOCKS));
  });

  it('round-trips: switch away and back restores the original bytes', () => {
    fs.writeFileSync(file, crlf(BLOCKS));
    editEnvFile(file, (text) => enableBlock(text, 'local').text);
    editEnvFile(file, (text) => enableBlock(text, 'mistral').text);
    expect(readEnvText(file)).toBe(crlf(BLOCKS));
  });

  it('survives a rollback that writes raw file text straight back', () => {
    fs.writeFileSync(file, crlf(BLOCKS));
    const before = readEnvText(file);
    editEnvFile(file, (text) => enableBlock(text, 'local').text);
    editEnvFile(file, () => before);
    expect(readEnvText(file)).toBe(crlf(BLOCKS));
  });

  it('keeps CRLF when setEnvVars edits a key in place', () => {
    fs.writeFileSync(file, 'DAVAI_EFFORT=high\r\nDAVAI_MODEL=old\r\n');
    setEnvVars(file, { DAVAI_MODEL: 'new' });
    expect(readEnvText(file)).toBe('DAVAI_EFFORT=high\r\nDAVAI_MODEL=new\r\n');
  });

  it('keeps LF when the file has it', () => {
    fs.writeFileSync(file, 'DAVAI_MODEL=old\n');
    setEnvVars(file, { DAVAI_MODEL: 'new' });
    expect(readEnvText(file)).toBe('DAVAI_MODEL=new\n');
  });
});

describe('joinLines', () => {
  it('ends with exactly one newline, or nothing', () => {
    expect(joinLines(['A=1'])).toBe('A=1\n');
    expect(joinLines([])).toBe('');
  });
});