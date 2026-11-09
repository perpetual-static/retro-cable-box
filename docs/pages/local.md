---
num: 5
name: LOCAL
title: Run it on your computer
slug: local
---

# Run it on your computer

You do not need a Raspberry Pi to try the box. The same software runs on a
Mac, a Linux computer or Windows (through WSL). Your computer becomes the box,
and a browser window becomes the TV.

## 1. Install the tools

You need these:

| Tool | Why |
| --- | --- |
| [Node.js 22](https://nodejs.org) | Runs the box's services |
| [pnpm 10](https://pnpm.io) | Installs the packages |
| [Task](https://taskfile.dev) | Starts everything with one command |
| [Temporal CLI](https://docs.temporal.io/cli) | The workflow engine that holds your channels |
| ffmpeg | Reads the length of each video (`ffprobe`) |

**macOS** (with [Homebrew](https://brew.sh)):

```sh
brew install node@22 go-task temporal ffmpeg
brew link --force node@22
corepack enable
```

`corepack` comes with Node and installs the pnpm version that the project
asks for.

**Linux** (Debian or Ubuntu):

```sh
sudo apt install -y ffmpeg git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
sudo corepack enable
sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d -b ~/.local/bin
curl -sSf https://temporal.download/cli.sh | sh
```

**Windows:** install [WSL](https://learn.microsoft.com/windows/wsl/install)
with Ubuntu, then follow the Linux steps in the Ubuntu window.

## 2. Get the code and start it

```sh
git clone https://github.com/rossnelson/myvoiceismypassport.git
cd myvoiceismypassport
task dev
```

The first start installs the packages and loads the starter lineup. That
takes a minute or two. Leave the window open: `task dev` runs everything, and
Ctrl-C stops everything.

| What | Address |
| --- | --- |
| The TV | http://127.0.0.1:5173 |
| The MCP server (for your agent) | http://127.0.0.1:8750/mcp |
| The workflow engine's UI | http://127.0.0.1:8233/namespaces/box |

## 3. Watch

Open http://127.0.0.1:5173 in Chrome. Make it full screen (⌃⌘F on a Mac,
F11 elsewhere) and press any key to turn the TV on. The keys are on
[Set up the software](setup.html#the-keys).

To use a real TV, connect your computer to it with HDMI and put the browser
window on that screen.

## 4. Connect your agent

The MCP server is at `http://127.0.0.1:8750/mcp`. For example, with Claude
Code:

```sh
claude mcp add --transport http retro-cable-box http://127.0.0.1:8750/mcp
```

On your own computer the token is off by default. To turn it on, make a file
named `.env` in the project folder with this line, then start `task dev`
again:

```sh
MCP_TOKEN=pick-a-long-random-value
```

Then send `Authorization: Bearer <token>` from your agent. To reach the box
from other devices, see [Connect your agent](connect.html).

## 5. Watch on your phone

The development TV loads hundreds of small files, which is slow on a phone.
Build the TV once, and the box serves the built version:

```sh
pnpm --filter player build
```

Then open `http://<your-computer's-address>:8760` on the phone. With
[Tailscale](https://tailscale.com), use your computer's tailnet address. Build
again after you change the TV's code.

## Everyday

| Do | Command |
| --- | --- |
| Start everything | `task dev` |
| Run the unit tests | `task test` |
| Check a running box end to end | `task smoke` |
| Start over with the starter lineup | `task reset`, then `task dev` |
| See every task | `task` |

Your channels are kept in `.temporal/dev.db`, so they survive a restart.
