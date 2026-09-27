/**
 * Image input (req 9).
 *
 * Sources: an @path reference in a prompt, an explicit /image command, and the
 * Windows clipboard. Images become their own context segments so they show up in
 * the context pane with a real token cost — images are expensive and otherwise
 * invisible.
 *
 * No resizing: that would mean a native image dependency. Instead we enforce the
 * provider limits and say plainly when a file is too big, rather than letting the
 * API reject it after the upload.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { estimateImage } from './tokens.js';

const MEDIA = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Anthropic's per-image ceiling; the others are at or above it. */
const MAX_BYTES = 5 * 1024 * 1024;

export function isImagePath(p) {
  return path.extname(p).toLowerCase() in MEDIA;
}

/**
 * Load an image file into a base64 part.
 * @returns {{mediaType: string, data: string, bytes: number, tokens: number, name: string}}
 */
export function loadImage(filePath, sandbox) {
  const abs = sandbox.resolveForRead(filePath);
  const ext = path.extname(abs).toLowerCase();
  const mediaType = MEDIA[ext];
  if (!mediaType) {
    throw new Error(`${sandbox.rel(abs)}: not a supported image type (png, jpg, gif, webp)`);
  }
  const stat = fs.statSync(abs);
  if (stat.size > MAX_BYTES) {
    throw new Error(
      `${sandbox.rel(abs)} is ${(stat.size / 1024 / 1024).toFixed(1)}MB; the limit is 5MB. ` +
        'Resize it before attaching.',
    );
  }
  const data = fs.readFileSync(abs).toString('base64');
  return {
    mediaType,
    data,
    bytes: stat.size,
    tokens: estimateImage(stat.size),
    name: sandbox.rel(abs),
  };
}

/**
 * Pull an image off the Windows clipboard. Returns null when there isn't one, or
 * on any platform that isn't Windows (macOS/Linux clipboard images would each need
 * their own helper; not wired up yet).
 */
export function clipboardImage(tmpDir) {
  if (process.platform !== 'win32') return null;
  const out = path.join(tmpDir, `davai-clip-${Date.now()}.png`);
  const script =
    'Add-Type -AssemblyName System.Windows.Forms;' +
    '$i=[System.Windows.Forms.Clipboard]::GetImage();' +
    `if($i){$i.Save('${out.replace(/\\/g, '\\\\')}');Write-Output 'ok'}else{Write-Output 'none'}`;

  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 10000 },
  );
  if (res.error || !/ok/.test(res.stdout || '')) return null;
  try {
    const stat = fs.statSync(out);
    const data = fs.readFileSync(out).toString('base64');
    fs.rmSync(out, { force: true });
    return {
      mediaType: 'image/png',
      data,
      bytes: stat.size,
      tokens: estimateImage(stat.size),
      name: 'clipboard image',
    };
  } catch {
    return null;
  }
}

/**
 * Find @path references to image files in an input string, so a prompt like
 * "what's wrong with @shots/error.png" just works.
 * @returns {{text: string, images: string[]}}
 */
export function extractImageRefs(input, sandbox) {
  const images = [];
  const text = input.replace(/@([^\s"']+)/g, (match, p) => {
    if (!isImagePath(p)) return match;
    try {
      sandbox.resolveForRead(p);
      images.push(p);
      return `[image: ${p}]`;
    } catch {
      return match; // unreadable: leave the text alone and let the model see it
    }
  });
  return { text, images };
}
