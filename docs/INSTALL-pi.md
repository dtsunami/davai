# Installing davai on a Raspberry Pi

Happy path: Pi 4 or 5 running 64-bit Raspberry Pi OS. Check with `uname -m` —
this document assumes `aarch64`.

## 1. Node 22+

Pi OS ships Node 18/20 from apt, which is too old.

    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    node --version        # v22.x or newer

## 2. Install

    git clone <your-remote> ~/davai
    cd ~/davai
    npm install

No build step. npm pulls the matching `@esbuild/linux-arm64` binary automatically.

## 3. Verify offline

    npm test          # no network, no model calls
    npm run lint

## 4. Configure

    mkdir -p ~/.davai
    echo 'ANTHROPIC_API_KEY=sk-ant-...' > ~/.davai/.env
    chmod 600 ~/.davai/.env

    node bin/davai.js --config     # keys.anthropic should read "set"

`DAVAI_HOME` defaults to `~/.davai` and holds sessions, snapshots and history.

## 5. Smoke test

    node bin/davai.js --models
    node bin/davai.js --print "list the files in src/agent and say what each does"
    node bin/davai.js

`--print` loads no React, so it isolates the agent loop from the terminal.

## 6. Put it on PATH

    npm config set prefix ~/.local
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
    exec $SHELL -l
    npm link
    davai --version

## Optional

- `sudo apt-get install -y xclip` — `/artifacts` copy needs it, or `wl-clipboard`
  under Wayland. Not needed over ssh; save to file instead.
- Locale must be UTF-8 or the glyphs render as boxes: `sudo raspi-config` →
  Localisation → Locale.

## Differences from Windows

- `/image` with no path reads the Windows clipboard only. Pass a path instead:
  `/image ~/shot.png`.
- Shell ops run under `/bin/sh -c`, not bash.