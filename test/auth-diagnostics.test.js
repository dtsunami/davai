import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  describeAuth,
  describeSurface,
  maskKey,
  withAuthDiagnostics,
} from '../src/providers/index.js';
import { ProviderError } from '../src/providers/base.js';
import { loadConfig } from '../src/config/env.js';

const cfg = (over = {}) => ({
  provider: 'openai',
  openaiApi: 'responses',
  baseURL: undefined,
  baseURLOrigin: undefined,
  keys: { openai: 'sk-proj-abcdefghijklmnopqrstuvwxyz1234' },
  keyOrigins: { openai: { name: 'OPENAI_API_KEY', from: '/home/u/.davai/.env' } },
  ...over,
});

async function drain(iter) {
  const out = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('maskKey', () => {
  it('never contains the key body', () => {
    const key = 'sk-proj-SECRETSECRETSECRET1234';
    const m = maskKey(key);
    expect(m).not.toContain('SECRET');
    expect(m).toContain('starts sk-proj-');
    expect(m).toContain('ends …1234');
    expect(m).toContain(`${key.length} chars`);
  });

  it('shows no tail for short keys', () => {
    expect(maskKey('abc123')).toBe('6 chars');
  });

  it('flags characters that break an otherwise correct key', () => {
    expect(maskKey('abcdefghijklmnop1234\r')).toMatch(/control characters/);
    expect(maskKey('"abcdefghijklmnop1234"')).toMatch(/quote characters/);
    expect(maskKey(' abcdefghijklmnop1234')).toMatch(/whitespace/);
  });

  it('reports a missing key', () => {
    expect(maskKey(undefined)).toBe('(none)');
  });
});

describe('describeAuth', () => {
  it('shows the default OpenAI endpoint when no base URL is set', () => {
    const d = describeAuth(cfg(), 'gpt-5');
    expect(d).toContain('https://api.openai.com/v1/responses');
    expect(d).toContain('DAVAI_BASE_URL not set');
    expect(d).toContain('OPENAI_API_KEY from /home/u/.davai/.env');
    expect(d).not.toContain('note');
  });

  it('shows a custom endpoint and where it was set', () => {
    const d = describeAuth(
      cfg({
        openaiApi: 'chat',
        baseURL: 'https://api.mistral.ai/v1',
        baseURLOrigin: { name: 'DAVAI_BASE_URL', from: '/home/u/.davai/.env' },
      }),
      'mistral-large-latest',
    );
    expect(d).toContain('https://api.mistral.ai/v1/chat/completions');
    expect(d).toContain('DAVAI_BASE_URL from /home/u/.davai/.env');
  });

  it('warns when a non-OpenAI-looking key is sent to OpenAI', () => {
    const d = describeAuth(cfg({ keys: { openai: 'abcdefghijklmnopqrstuvwxyz123456' } }), 'm');
    expect(d).toMatch(/no sk- prefix/);
  });
});

describe('describeSurface', () => {
  it('names the setting that moves the request to the other API', () => {
    const d = describeSurface(cfg({ openaiApi: 'chat' }), 'subq-snap-preview');
    expect(d).toContain('DAVAI_OPENAI_API=chat');
    expect(d).toContain('DAVAI_OPENAI_API=responses in $DAVAI_HOME/.env');
  });

  it('explains why a custom base URL ended up on chat completions', () => {
    const d = describeSurface(
      cfg({ openaiApi: 'chat', baseURL: 'https://api.subq.ai/v1' }),
      'subq-snap-preview',
    );
    expect(d).toContain('https://api.subq.ai/v1/chat/completions');
    expect(d).toMatch(/custom DAVAI_BASE_URL defaults to chat/);
  });

  it('points the other way when Responses is the one being refused', () => {
    const d = describeSurface(cfg(), 'gpt-5-chat');
    expect(d).toContain('DAVAI_OPENAI_API=responses');
    expect(d).toContain('DAVAI_OPENAI_API=chat in $DAVAI_HOME/.env');
  });

  // Regression: the advice used to be unfalsifiable. Whichever surface was active it
  // claimed the other one would fix things, so an operator on a server that refuses
  // both just bounced between them. The escape hatch has to be in the message.
  it('says what it means when flipping the surface changes nothing', () => {
    for (const api of ['chat', 'responses']) {
      const d = describeSurface(
        cfg({ openaiApi: api, baseURL: 'https://api.subq.ai/v1' }),
        'subq-snap-preview',
      );
      expect(d).toMatch(/if same/);
      expect(d).toMatch(/the surface is not the problem/);
      expect(d).toContain('subq-snap-preview');
    }
  });
});

describe('withAuthDiagnostics', () => {
  const failing = (status, message) => ({
    name: 'openai',
    model: 'm',
    // eslint-disable-next-line require-yield
    async *send() {
      throw new ProviderError(message || `openai: failed ${status}`, {
        status,
        provider: 'openai',
      });
    },
  });

  it('explains a 400 that may mean the wrong API surface', async () => {
    const wrapped = withAuthDiagnostics(
      failing(400, "openai: 400 Model 'subq-snap-preview' does not support completions requests."),
      cfg({ openaiApi: 'chat', baseURL: 'https://api.subq.ai/v1' }),
      'subq-snap-preview',
    );
    await expect(drain(wrapped.send({}))).rejects.toThrow(/DAVAI_OPENAI_API=responses/);
  });

  it('leaves an unrelated 400 alone', async () => {
    const wrapped = withAuthDiagnostics(
      failing(400, 'openai: 400 Invalid value for max_completion_tokens.'),
      cfg({ openaiApi: 'chat' }),
      'm',
    );
    await expect(drain(wrapped.send({}))).rejects.toThrow(
      /^openai: 400 Invalid value for max_completion_tokens\.$/,
    );
  });

  it('leaves a 400 from another provider alone', async () => {
    const wrapped = withAuthDiagnostics(
      failing(400, 'grok: 400 model does not support completions requests'),
      cfg({ provider: 'grok' }),
      'm',
    );
    await expect(drain(wrapped.send({}))).rejects.toThrow(
      /^grok: 400 model does not support completions requests$/,
    );
  });

  it('appends the resolved context to a 401', async () => {
    const wrapped = withAuthDiagnostics(failing(401), cfg(), 'm');
    await expect(drain(wrapped.send({}))).rejects.toThrow(
      /endpoint\s+https:\/\/api\.openai\.com\/v1\/responses/,
    );
  });

  it('leaves other errors alone', async () => {
    const wrapped = withAuthDiagnostics(failing(500), cfg(), 'm');
    await expect(drain(wrapped.send({}))).rejects.toThrow(/^openai: failed 500$/);
  });

  it('passes events through untouched', async () => {
    const ok = {
      name: 'openai',
      async *send() {
        yield { t: 'text', delta: 'hi' };
      },
    };
    const events = await drain(withAuthDiagnostics(ok, cfg(), 'm').send({}));
    expect(events).toEqual([{ t: 'text', delta: 'hi' }]);
  });
});

describe('loadConfig key origins', () => {
  it('records which file supplied the key and base URL', () => {
    const saved = { ...process.env };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-cwd-'));
    try {
      for (const k of Object.keys(process.env)) {
        if (/^(DAVAI_|OPENAI_)/.test(k)) delete process.env[k];
      }
      process.env.DAVAI_HOME = home;
      fs.writeFileSync(
        path.join(home, '.env'),
        'DAVAI_PROVIDER=openai\nDAVAI_BASE_URL=https://api.mistral.ai/v1\nOPENAI_API_KEY=home-key\n',
      );
      // A project .env may override the key (only the endpoint is protected).
      fs.writeFileSync(path.join(cwd, '.env'), 'OPENAI_API_KEY=project-key\n');

      const c = loadConfig({ cwd });
      expect(c.keyOrigins.openai).toEqual({ name: 'OPENAI_API_KEY', from: path.join(cwd, '.env') });
      expect(c.baseURLOrigin).toEqual({ name: 'DAVAI_BASE_URL', from: path.join(home, '.env') });
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});