#!/usr/bin/env node
/**
 * davai entry point. Parses argv, then either runs headless or starts the TUI.
 */
import process from 'node:process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

const HELP = `davai ${pkg.version} — agentic CLI REPL

USAGE
  davai                          start the interactive REPL
  davai "do the thing"           one-shot, then exit
  echo "do the thing" | davai    read the request from stdin
  davai --resume [id]            reopen a past session (default: the most recent)

OPTIONS
  -p, --print            one-shot, stream plain text to stdout (no TUI)
      --json             one-shot, emit newline-delimited JSON events
  -y, --yes              auto-approve shell commands (headless only)
      --yolo             auto-approve shell commands in the REPL too (/yolo toggles)
  -m, --model <id>       override the model for this run
      --provider <name>  anthropic | openai | gemini | grok | openrouter
      --effort <level>   low | medium | high | xhigh | max
  -C, --cwd <dir>        run against a different working directory
      --web              also serve the session over http (default localhost:7878)
      --port <n>         port for --web; 0 picks a free one
      --host <addr>      bind address for --web; refuses to combine with --yolo
      --models [prov]    list models the provider actually serves
      --sessions         list recent sessions
      --resume [id]      rebuild context from a past session; id may be a prefix
      --config           show resolved configuration
  -h, --help             this text
  -v, --version

CONFIG
  Reads $DAVAI_HOME/.env, then ./.env, then the real environment.
  DAVAI_HOME defaults to ~/.davai
`;

/**
 * Argument parsing, exported for the tests.
 *
 * Bad input throws a `UsageError` rather than calling process.exit, so the behaviour can
 * be asserted; main() catches it, prints, and exits 2.
 */
export class UsageError extends Error {}

export function parseArgs(argv) {
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
      case '--yolo':
        // Same intent in both modes, so it implies --yes rather than being a second
        // thing to remember when the request is piped in.
        out.overrides.DAVAI_YOLO = 'true';
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
      case '--web':
        // Takes no value. The earlier `--web 9000` form would now leave 9000 in argv to
        // be swept up as part of the prompt, so catch it and name the replacement rather
        // than silently sending the model a request that begins "9000".
        if (/^\d+$/.test(argv[i + 1] || '')) {
          throw new UsageError(`--web no longer takes a port. Use: --web --port ${argv[i + 1]}`);
        }
        out.web = true;
        break;
      case '--port': {
        const v = next();
        if (!/^\d+$/.test(v || '') || Number(v) > 65535) {
          throw new UsageError(`--port must be a number between 0 and 65535 (got "${v ?? ''}")`);
        }
        out.port = Number(v);
        break;
      }
      case '--host':
        out.host = next();
        break;
      case '--web-host':
        throw new UsageError('--web-host is now --host');
      case '--models':
        out.listModels = true;
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) out.overrides.DAVAI_PROVIDER = next();
        break;
      case '--sessions':
        out.listSessions = true;
        break;
      case '--resume':
        // An optional value: `--resume` alone means the most recent session.
        out.resume = argv[i + 1] && !argv[i + 1].startsWith('-') ? next() : true;
        break;
      case '--config':
        out.showConfig = true;
        break;
      default:
        if (a.startsWith('-')) {
          throw new UsageError(`unknown option: ${a}\n\n${HELP}`);
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
    // `prompts` holds the whole protocol text; report where each came from instead.
    process.stdout.write(
      JSON.stringify(
        { ...cfg, keys, model: cfg.model.id, prompts: cfg.promptSources, promptSources: undefined },
        null,
        2,
      ) + '\n',
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
  // With no prompt in argv, stdin is the only thing that can carry the request, so wait
  // for the producer instead of sampling it.
  const piped = await readStdin({ required: !args.input });
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
      resume: args.resume,
    });
  }

  const { startTui } = await import('../src/ui/start.js');
  // --port or --host alone implies --web: asking for a port and not getting a server is
  // not a thing anyone means. Undefined fields fall through to DAVAI_WEB_* and then to
  // the defaults, resolved in startTui, which is the only place that has read the .env.
  const web =
    args.web || args.port !== undefined || args.host !== undefined
      ? { port: args.port, host: args.host }
      : null;
  return startTui({ input, cwd: args.cwd, overrides: args.overrides, resume: args.resume, web });
}

// Only when run as a program. Importing this file — which test/cli.test.js does, to get
// at parseArgs — must not start a session: it happened to exit quietly under vitest
// because argv carried no prompt, which is luck rather than a guarantee.
//
// Older checks compared the raw paths and could fail when the executable was a symlink
// (npm/yarn linking or global installs). Compare real paths when possible so both
// direct invocation and symlinked installs behave the same.
let isMain = false;
if (process.argv[1]) {
  try {
    const scriptPath = path.resolve(process.argv[1]);
    const modulePath = path.resolve(fileURLToPath(import.meta.url));
    const realScript = realpathSync(scriptPath);
    const realModule = realpathSync(modulePath);
    isMain = realScript === realModule || scriptPath === modulePath;
  } catch (e) {
    // If realpathSync fails for any reason, fall back to the original conservative check.
    isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}

if (isMain) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      // Bad usage is the operator's typo, not a crash: print it plainly without a stack
      // and exit 2, the same code the unknown-option path has always used.
      if (err instanceof UsageError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(2);
      }
      process.stderr.write(`\n${err?.message || err}\n`);
      if (process.env.DAVAI_DEBUG) process.stderr.write(`${err?.stack}\n`);
      process.exit(1);
    });
}
