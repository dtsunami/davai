/**
 * Video input.
 *
 * Gemini is the only provider davai talks to that takes video natively, and it rides the
 * same `inlineData` envelope as an image — which is why the gemini adapter has no video
 * branch of its own. Everywhere else a video part is refused rather than silently
 * dropped: the frame-extraction fallback the other providers would need means an ffmpeg
 * dependency, and it throws away exactly the cross-frame continuity that makes sending
 * video worth doing.
 *
 * Two limits matter here and both differ from an image's:
 *
 *   - Inline data caps the *whole request* at 20MB. Bigger files are the Files API's job,
 *     which is a separate upload-and-poll flow this does not implement.
 *   - Video is billed by duration, not by pixels. A 50MB file is a rejected upload; a
 *     10MB one can quietly be 40k tokens. See estimateVideo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { estimateVideo, VIDEO_TOKENS_PER_SECOND } from './tokens.js';

/**
 * A YouTube watch/share/embed URL. Gemini takes these by *reference* — nothing is
 * uploaded, the model's backend fetches the video itself — so none of the inline byte
 * limits above apply to one, and neither does any size-derived token estimate.
 *
 * Only public and unlisted videos work; a private one fails at the API with a permission
 * error rather than here, because davai cannot tell them apart without fetching.
 */
const YOUTUBE_RE =
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^&\s]*&)*v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/;

/** Minutes assumed for a YouTube video whose duration the operator did not state. */
export const DEFAULT_YOUTUBE_MINUTES = 10;

export function isYouTubeUrl(s) {
  return YOUTUBE_RE.test(String(s || ''));
}

/**
 * Build a by-reference video part for a YouTube URL.
 *
 * Duration is unknowable from here — there is no file to measure and davai does not call
 * YouTube's API — so the token figure is the operator's stated minutes, or an assumption.
 * It is wrong more often than the file-size estimate is, which is why `/youtube` accepts
 * a duration and the notice says which number it used.
 *
 * @param {string} url
 * @param {{minutes?: number}} [opts]
 * @returns {{uri: string, tokens: number, minutes: number, assumed: boolean, name: string}}
 */
export function youtubeRef(url, { minutes } = {}) {
  if (!isYouTubeUrl(url)) throw new Error(`${url}: not a YouTube URL`);
  const assumed = !Number.isFinite(minutes) || minutes <= 0;
  const mins = assumed ? DEFAULT_YOUTUBE_MINUTES : Number(minutes);
  return {
    uri: url,
    tokens: Math.round(mins * 60 * VIDEO_TOKENS_PER_SECOND),
    minutes: mins,
    assumed,
    name: url,
  };
}

/** Gemini's accepted video mime types. */
const MEDIA = {
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpg',
  '.mov': 'video/mov',
  '.avi': 'video/avi',
  '.webm': 'video/webm',
  '.wmv': 'video/wmv',
  '.3gp': 'video/3gpp',
  '.flv': 'video/x-flv',
};

/**
 * Inline data caps the entire request — prompt, history and all — at 20MB. The file is
 * checked against a lower ceiling so a video that only just fits on its own does not
 * push the request over the moment there is a conversation attached to it.
 */
export const MAX_BYTES = 18 * 1024 * 1024;

export function isVideoPath(p) {
  return path.extname(p).toLowerCase() in MEDIA;
}

/** The extensions we accept, for error messages and completion. */
export const VIDEO_EXTENSIONS = Object.keys(MEDIA);

/**
 * Load a video file into a base64 part.
 * @returns {{mediaType: string, data: string, bytes: number, tokens: number, name: string}}
 */
export function loadVideo(filePath, sandbox) {
  const abs = sandbox.resolveForRead(filePath);
  const ext = path.extname(abs).toLowerCase();
  const mediaType = MEDIA[ext];
  if (!mediaType) {
    throw new Error(
      `${sandbox.rel(abs)}: not a supported video type (${VIDEO_EXTENSIONS.join(', ')})`,
    );
  }
  const stat = fs.statSync(abs);
  if (stat.size > MAX_BYTES) {
    throw new Error(
      `${sandbox.rel(abs)} is ${(stat.size / 1024 / 1024).toFixed(1)}MB; inline video is ` +
        `capped at ${MAX_BYTES / 1024 / 1024}MB. Trim or downscale it first — davai does ` +
        'not use the Files API, which is what larger uploads would need.',
    );
  }
  const data = fs.readFileSync(abs).toString('base64');
  return {
    mediaType,
    data,
    bytes: stat.size,
    tokens: estimateVideo(stat.size),
    name: sandbox.rel(abs),
  };
}

/**
 * Find @ references to video in an input string: a local path, the same way images work,
 * or a YouTube URL.
 *
 * The `@` is required for a URL too, even though a bare one is easy to spot. Pasting a
 * link into a sentence usually means "let us talk about this", not "watch this and bill
 * me for an hour of footage" — and an attachment that costs tens of thousands of tokens
 * should never be something you can trigger by accident. Same opt-in rule as a path.
 *
 * @returns {{text: string, videos: string[], youtube: string[]}}
 */
export function extractVideoRefs(input, sandbox) {
  const videos = [];
  const youtube = [];
  const text = input.replace(/@([^\s"']+)/g, (match, p) => {
    if (isYouTubeUrl(p)) {
      youtube.push(p);
      return `[video: ${p}]`;
    }
    if (!isVideoPath(p)) return match;
    try {
      sandbox.resolveForRead(p);
      videos.push(p);
      return `[video: ${p}]`;
    } catch {
      return match; // unreadable: leave the text alone and let the model see it
    }
  });
  return { text, videos, youtube };
}