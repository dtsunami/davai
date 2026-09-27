/**
 * Artifact registry (req 7). Every non-da_ops fenced block the model emits is
 * captured, numbered, and made available to copy to the clipboard or save to a file.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { Journal } from '../agent/journal.js';

export class Artifacts {
  constructor() {
    this.items = [];
  }

  /** @param {{lang: string, body: string}} block */
  add(block) {
    const item = {
      n: this.items.length + 1,
      lang: block.lang || 'text',
      text: block.body,
      lines: block.body.split('\n').length,
      bytes: Buffer.byteLength(block.body, 'utf8'),
      createdAt: Date.now(),
    };
    this.items.push(item);
    return item;
  }

  get(n) {
    return this.items[Number(n) - 1];
  }

  get latest() {
    return this.items[this.items.length - 1];
  }

  /** Save an artifact through the write jail and the journal, like any other write. */
  save(n, destPath, ctx) {
    const item = this.get(n);
    if (!item) throw new Error(`no artifact #${n}`);
    const abs = ctx.sandbox.resolveForWrite(destPath);
    const existed = fs.existsSync(abs);
    const pre = ctx.journal.snapshot(abs);
    ctx.journal.record({ op: 'write', path: abs, pre, existed });
    Journal.atomicWrite(abs, Buffer.from(item.text, 'utf8'));
    return { path: ctx.sandbox.rel(abs), bytes: item.bytes, overwrote: existed };
  }

  async copy(n) {
    const item = this.get(n);
    if (!item) throw new Error(`no artifact #${n}`);
    await writeClipboard(item.text);
    return item;
  }
}

/** Clipboard with no dependency: one native helper per platform. */
export function writeClipboard(text) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['clip.exe', []]
      : process.platform === 'darwin'
        ? ['pbcopy', []]
        : process.env.WAYLAND_DISPLAY
          ? ['wl-copy', []]
          : ['xclip', ['-selection', 'clipboard']];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (err) {
      return reject(new Error(`clipboard unavailable (${cmd}): ${err.message}`));
    }
    child.on('error', (err) =>
      reject(new Error(`clipboard unavailable (${cmd}): ${err.message}`)),
    );
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
    child.stdin.end(text, 'utf8');
  });
}
