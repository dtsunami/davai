import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadVideo,
  extractVideoRefs,
  isVideoPath,
  isYouTubeUrl,
  youtubeRef,
  MAX_BYTES,
  DEFAULT_YOUTUBE_MINUTES,
} from '../src/context/video.js';
import { estimateVideo } from '../src/context/tokens.js';
import { videoUnsupported, hasVideo } from '../src/providers/base.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'davai-video-'));
const sandbox = {
  resolveForRead: (p) => {
    const abs = path.resolve(tmp, p);
    if (!fs.existsSync(abs)) throw new Error(`${p}: not found`);
    return abs;
  },
  rel: (abs) => path.relative(tmp, abs).replace(/\\/g, '/'),
};

function write(name, bytes) {
  const abs = path.join(tmp, name);
  fs.writeFileSync(abs, Buffer.alloc(bytes, 1));
  return abs;
}

describe('isVideoPath', () => {
  it('accepts the gemini container types and nothing else', () => {
    expect(isVideoPath('a/b/clip.mp4')).toBe(true);
    expect(isVideoPath('CLIP.MOV')).toBe(true);
    expect(isVideoPath('clip.webm')).toBe(true);
    expect(isVideoPath('shot.png')).toBe(false);
    expect(isVideoPath('notes.md')).toBe(false);
  });
});

describe('loadVideo', () => {
  it('reads a file into a base64 part with a mime type', () => {
    write('clip.mp4', 1024);
    const v = loadVideo('clip.mp4', sandbox);
    expect(v.mediaType).toBe('video/mp4');
    expect(v.bytes).toBe(1024);
    expect(Buffer.from(v.data, 'base64').length).toBe(1024);
    expect(v.name).toBe('clip.mp4');
  });

  it('refuses a file over the inline cap, naming the real size', () => {
    write('big.mp4', MAX_BYTES + 1);
    expect(() => loadVideo('big.mp4', sandbox)).toThrow(/capped at/);
  });

  it('refuses an unsupported extension rather than guessing a mime type', () => {
    write('clip.mkv', 16);
    expect(() => loadVideo('clip.mkv', sandbox)).toThrow(/not a supported video type/);
  });
});

describe('estimateVideo', () => {
  /**
   * The exact number is a guess from file size; what must hold is that it scales with
   * duration and lands in the right order of magnitude. A 10MB clip is tens of thousands
   * of tokens, not the ~1600 an image maxes out at — treating video like an image is the
   * specific failure this guards.
   */
  it('scales with size and dwarfs an image estimate', () => {
    const tenMB = estimateVideo(10 * 1024 * 1024);
    expect(tenMB).toBeGreaterThan(10_000);
    expect(estimateVideo(20 * 1024 * 1024)).toBeGreaterThan(tenMB);
  });

  it('never returns zero for a tiny file', () => {
    expect(estimateVideo(1)).toBeGreaterThan(0);
  });
});

describe('extractVideoRefs', () => {
  it('substitutes a readable ref and reports it', () => {
    write('clip.mp4', 32);
    const { text, videos } = extractVideoRefs('summarize @clip.mp4 please', sandbox);
    expect(videos).toEqual(['clip.mp4']);
    expect(text).toBe('summarize [video: clip.mp4] please');
  });

  it('leaves an unreadable ref as written, for the model to see', () => {
    const { text, videos } = extractVideoRefs('watch @missing.mp4', sandbox);
    expect(videos).toEqual([]);
    expect(text).toBe('watch @missing.mp4');
  });

  it('ignores non-video refs so image handling still owns them', () => {
    const { text, videos } = extractVideoRefs('look at @shot.png', sandbox);
    expect(videos).toEqual([]);
    expect(text).toBe('look at @shot.png');
  });

  it('picks up an @-prefixed YouTube URL separately from local files', () => {
    const { text, videos, youtube } = extractVideoRefs(
      'summarize @https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      sandbox,
    );
    expect(videos).toEqual([]);
    expect(youtube).toEqual(['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
    expect(text).toBe('summarize [video: https://www.youtube.com/watch?v=dQw4w9WgXcQ]');
  });

  /**
   * Attaching a video costs tens of thousands of tokens. A link pasted into a sentence
   * usually means "let us discuss this", so the @ is required for a URL exactly as it is
   * for a path — an expensive attachment must never be triggerable by accident.
   */
  it('leaves a bare URL alone, since attaching is opt-in', () => {
    const { text, youtube } = extractVideoRefs(
      'have you seen https://youtu.be/dQw4w9WgXcQ',
      sandbox,
    );
    expect(youtube).toEqual([]);
    expect(text).toBe('have you seen https://youtu.be/dQw4w9WgXcQ');
  });
});

describe('youtube refs', () => {
  it('recognizes the url forms people actually paste', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeUrl('https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeUrl('https://vimeo.com/12345')).toBe(false);
    expect(isYouTubeUrl('clip.mp4')).toBe(false);
  });

  it('builds a by-reference part with no bytes in it', () => {
    const yt = youtubeRef('https://youtu.be/dQw4w9WgXcQ', { minutes: 5 });
    expect(yt.uri).toBe('https://youtu.be/dQw4w9WgXcQ');
    expect(yt.data).toBeUndefined();
    expect(yt.assumed).toBe(false);
    expect(yt.tokens).toBeGreaterThan(50_000);
  });

  it('flags an assumed duration so the notice can say so', () => {
    const yt = youtubeRef('https://youtu.be/dQw4w9WgXcQ');
    expect(yt.assumed).toBe(true);
    expect(yt.minutes).toBe(DEFAULT_YOUTUBE_MINUTES);
  });

  it('refuses a non-YouTube URL rather than sending one Gemini cannot fetch', () => {
    expect(() => youtubeRef('https://vimeo.com/12345')).toThrow(/not a YouTube URL/);
  });
});

describe('provider refusal', () => {
  it('hasVideo spots a video part', () => {
    expect(hasVideo([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe(false);
    expect(
      hasVideo([{ role: 'user', content: [{ type: 'video', mediaType: 'video/mp4', data: 'AA' }] }]),
    ).toBe(true);
  });

  it('videoUnsupported names the provider and points at the way out', () => {
    const err = videoUnsupported('anthropic');
    expect(err.message).toMatch(/anthropic/);
    expect(err.message).toMatch(/Gemini/);
  });
});