/**
 * The one path a typed request takes, whichever view typed it.
 *
 * This was the tail of App.jsx's `submit`. It moved here so the web sidecar drives the
 * session through exactly the same steps as the REPL — steering, slash commands, paste
 * expansion, image refs — rather than growing a second, subtly different implementation.
 * The REPL is still the better driver; the point is that both drive the same machine.
 *
 * Ink-free by construction: everything view-shaped arrives through `view`.
 */
import { handleCommand } from '../ui/commands.js';
import { extractImageRefs, loadImage } from '../context/images.js';
import { extractVideoRefs, loadVideo, youtubeRef } from '../context/video.js';

/**
 * @param {object} opts
 * @param {object} opts.session  the session from bootstrap
 * @param {object} opts.view
 *   - `push(entry)`      append to the transcript
 *   - `setPane(name)`    open a pane, or null
 *   - `exit()`           close the session
 *   - `refresh()`        re-read derived state
 *   - `requestSecret(op, extra)` ask for a sudo password
 *   - `onRunStart()`     a model turn is about to begin
 *   - `isBusy()`         whether a turn is in flight
 * @returns {(raw: string) => Promise<void>}
 */
export function createDispatcher({ session, view }) {
  const { agent, cfg, ledger, pastes } = session;
  const {
    push,
    setPane = () => {},
    exit = () => {},
    refresh = () => {},
    requestSecret,
    onRunStart = () => {},
    isBusy = () => false,
  } = view;

  /**
   * Expand paste placeholders and `@media` references into ledger segment specs and the
   * cleaned prompt text. Collected into an array rather than written straight to the
   * ledger so a steer can hold its segments until the step boundary where the steer
   * itself lands — otherwise a paste added mid-stream sits *before* the assistant turn
   * it was meant to correct.
   */
  function collectAttachments(prompt) {
    const segments = [];

    const { text: expanded, referenced } = pastes.expand(prompt);
    for (const p of referenced) {
      segments.push({
        type: 'paste',
        label: `paste#${p.n} (${p.lines} lines)`,
        role: 'user',
        text: `[paste#${p.n}]\n${p.text}`,
      });
    }

    // @path references to images become their own segments (req 9).
    const { text: withoutImages, images } = extractImageRefs(expanded, session.sandbox);
    for (const ref of images) {
      if (!cfg.model.vision) {
        push({
          type: 'warning',
          message: `${cfg.model.id} has no vision support — ${ref} was not attached`,
        });
        continue;
      }
      try {
        const img = loadImage(ref, session.sandbox);
        segments.push({
          type: 'paste',
          label: `image ${img.name} (${Math.round(img.bytes / 1024)}kB)`,
          role: 'user',
          image: img,
        });
        push({ type: 'notice', message: `attached ${img.name} (~${img.tokens} tokens)` });
      } catch (err) {
        push({ type: 'warning', message: err.message });
      }
    }

    // @path references to video, same shape — but gated on a different capability, since
    // a vision model that cannot take video is the common case rather than the exception.
    const { text: withoutMedia, videos, youtube } = extractVideoRefs(
      withoutImages,
      session.sandbox,
    );
    for (const url of youtube) {
      if (!cfg.model.video) {
        push({
          type: 'warning',
          message:
            `${cfg.model.id} does not accept video — ${url} was not attached. ` +
            'Only Gemini models take video natively.',
        });
        continue;
      }
      const yt = youtubeRef(url);
      segments.push({
        type: 'paste',
        label: `youtube ${yt.uri}`,
        role: 'user',
        video: yt,
      });
      push({
        type: 'notice',
        message:
          `attached ${yt.uri} (~${yt.tokens} tokens, assuming ${yt.minutes} minutes — ` +
          `use /youtube <url> <minutes> if that is wrong)`,
      });
    }

    for (const ref of videos) {
      if (!cfg.model.video) {
        push({
          type: 'warning',
          message:
            `${cfg.model.id} does not accept video — ${ref} was not attached. ` +
            'Only Gemini models take video natively.',
        });
        continue;
      }
      try {
        const vid = loadVideo(ref, session.sandbox);
        segments.push({
          type: 'paste',
          label: `video ${vid.name} (${(vid.bytes / 1024 / 1024).toFixed(1)}MB)`,
          role: 'user',
          video: vid,
        });
        push({
          type: 'notice',
          message: `attached ${vid.name} (~${vid.tokens} tokens, estimated from file size)`,
        });
      } catch (err) {
        push({ type: 'warning', message: err.message });
      }
    }

    return { text: withoutMedia, segments };
  }

  return async function submit(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return;

    // Typed while a run is in flight: steer it rather than queueing a second request.
    // Commands still run immediately — /context while it works is the point of them —
    // and sh <cmd> is never intercepted as a steer unless the operator meant prose.
    if (isBusy() && !text.startsWith('/') && text !== 'sh' && !text.startsWith('sh ')) {
      const { text: cleaned, segments } = collectAttachments(text);
      if (agent.steer(cleaned, segments)) {
        session.history?.add(text);
        push({ type: 'user', text: cleaned });
        return;
      }
      // The run finished between isBusy() and agent.steer() — fall through with the
      // already-expanded text and segments so pastes are not expanded twice.
      session.history?.add(text);
      for (const seg of segments) ledger.add(seg);
      push({ type: 'user', text: cleaned });
      onRunStart();
      await agent.run(cleaned);
      return;
    }

    const cmd = await handleCommand(text, {
      session,
      push,
      setPane,
      exit,
      refresh,
      requestSecret,
    });
    if (cmd.handled) return;

    // Recorded after the command check, so /history holds prompts and not commands.
    const prompt = cmd.input ?? text;
    session.history?.add(prompt);

    const { text: withoutMedia, segments } = collectAttachments(prompt);
    for (const seg of segments) ledger.add(seg);

    push({ type: 'user', text: withoutMedia });
    onRunStart();
    await agent.run(withoutMedia);
  };
}