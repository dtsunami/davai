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

  return async function submit(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return;

    // Typed while a run is in flight: steer it rather than queueing a second request.
    // Commands still run immediately — /context while it works is the point of them.
    if (isBusy() && !text.startsWith('/') && agent.steer(text)) {
      session.history?.add(text);
      push({ type: 'user', text });
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

    const { text: expanded, referenced } = pastes.expand(prompt);
    for (const p of referenced) {
      ledger.add({
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
        ledger.add({
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

    push({ type: 'user', text: withoutImages });
    onRunStart();
    await agent.run(withoutImages);
  };
}