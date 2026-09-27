#!/usr/bin/env node
/**
 * davai entry point. Parses argv, then either runs headless or starts the TUI.
 */
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

const HELP = `davai ${pkg.version} — agentic CLI REPL

USAGE
  davai                          start the interactive REPL
  davai "do the thing"           one-shot, then exit
  echo "do the thing" | davai    read the request from stdin

OPTIONS
  -p, --print            one-shot, stream plain text to stdout (no TUI)
      --json             one-shot, emit newline-delimited JSON events
  -y, --yes              auto-approve shell commands (headless only)
  -m, --model <id>       override the model for this run
      --provider <name>  anthropic | openai | gemini | grok
      --effort <level>   low | medium | high | xhigh | max
  -C, --cwd <dir>        run against a different working directory
      --models [prov]    list models the provider actually serves
      --sessions         list recent sessions
      --config           show resolved configuration
  -h, --help             this text
  -v, --version

CONFIG
  Reads $DAVAI_HOME/.env, then ./.env, then the real environment.
  DAVAI_HOME defaults to ~/.davai
`;

function parseArgs(argv) {
  const out = { overrides: {}, words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '-v':
      case '--version':
        out.version = true;
        break;
      case '-p':
      case '--print':
        out.print = true;
        break;
      case '--json':
        out.json = true;
        out.print = true;
        break;
      case '-y':
      case '--yes':
        out.yes = true;
        break;
      case '-m':
      case '--model':
        out.overrides.DAVAI_MODEL = next();
        break;
      case '--provider':
        out.overrides.DAVAI_PROVIDER = next();
        break;
      case '--effort':
        out.overrides.DAVAI_EFFORT = next();
        break;
      case '-C':
      case '--cwd':
        out.cwd = next();
        break;
      case '--models':
        out.listModels = true;
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) out.overrides.DAVAI_PROVIDER = next();
        break;
      case '--sessions':
        out.listSessions = true;
        break;
      case '--config':
        out.showConfig = true;
        break;
      default:
        if (a.startsWith('-')) {
          console.error(`unknown option: ${a}\n`);
          console.error(HELP);
          process.exit(2);
        }
        out.words.push(a);
    }
  }
  out.input = out.words.join(' ');
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  if (args.listSessions) {
    const { listSessions } = await import('../src/session/log.js');
    const { resolveHome } = await import('../src/config/env.js');
    const rows = listSessions(resolveHome());
    if (!rows.length) {
      process.stdout.write('no sessions yet\n');
      return 0;
    }
    for (const s of rows) {
      const t = s.totals || {};
      process.stdout.write(
        `${s.id}  ${s.startedAt}  ${s.model}  ${t.turns || 0} turns  $${(t.cost || 0).toFixed(4)}  ${s.cwd}\n`,
      );
    }
    return 0;
  }

  if (args.showConfig) {
    const { loadConfig } = await import('../src/config/env.js');
    const cfg = loadConfig({ cwd: args.cwd, overrides: args.overrides });
    const keys = Object.fromEntries(
      Object.entries(cfg.keys).map(([k, v]) => [k, v ? 'set' : '—']),
    );
    process.stdout.write(
      JSON.stringify({ ...cfg, keys, model: cfg.model.id }, null, 2) + '\n',
    );
    return 0;
  }

  if (args.listModels) {
    const { loadConfig } = await import('../src/config/env.js');
    const { listRemoteModels } = await import('../src/providers/index.js');
    const cfg = loadConfig({ cwd: args.cwd, overrides: args.overrides });
    const ids = await listRemoteModels(cfg);
    process.stdout.write(ids.join('\n') + '\n');
    return 0;
  }

  const { readStdin } = await import('../src/headless.js');
  const piped = await readStdin();
  const input = [args.input, piped].filter(Boolean).join('\n');

  // No TTY means no interactive REPL is possible, so fall back to headless.
  const interactive = !args.print && process.stdout.isTTY && process.stdin.isTTY;

  if (!interactive) {
    if (!input) {
      process.stderr.write('nothing to do: pass a request or pipe one in\n');
      return 2;
    }
    const { runHeadless } = await import('../src/headless.js');
    return runHeadless(input, {
      json: args.json,
      yes: args.yes,
      cwd: args.cwd,
      overrides: args.overrides,
    });
  }

  const { startTui } = await import('../src/ui/start.js');
  return startTui({ input, cwd: args.cwd, overrides: args.overrides });
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`\n${err?.message || err}\n`);
    if (process.env.DAVAI_DEBUG) process.stderr.write(`${err?.stack}\n`);
    process.exit(1);
  });
