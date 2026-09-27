/**
 * Transpile .jsx on import, so there is no build step and `davai` starts straight
 * from source. esbuild's transformSync costs ~1ms per file, which is cheaper than
 * maintaining a dist/ directory and the staleness that comes with it.
 *
 * Registered only on the TUI path — headless mode never loads React at all.
 */
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

let registered = false;

export function registerJsx() {
  if (registered) return;
  registered = true;

  registerHooks({
    load(url, context, nextLoad) {
      if (!url.endsWith('.jsx')) return nextLoad(url, context);
      const filename = fileURLToPath(url);
      const source = readFileSync(filename, 'utf8');
      const { code } = transformSync(source, {
        loader: 'jsx',
        format: 'esm',
        jsx: 'automatic',
        target: 'node22',
        sourcefile: filename,
      });
      return { format: 'module', shortCircuit: true, source: code };
    },
  });
}
