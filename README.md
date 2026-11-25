# RepoBridge

Connects browser LLM chat (`gemini.google.com`) to a local, Git-safe Node.js/TypeScript daemon so you can inspect repositories, apply surgical `SEARCH/REPLACE` or line-range patches, run verification commands, and roll back any write turn cleanly via Git shadow checkpoints.

## Features

- **Localhost-only daemon (`127.0.0.1`)** with Bearer token authentication, strict `chrome-extension://` CORS, payload limits, and concurrency locking (`409` on overlapping write/revert batches).
- **Three HUD approval modes:**
  - **Manual Writes** *(default)*: auto-runs reads and allowlisted commands; prompts with a colorized unified diff preview for file edits and unlisted commands.
  - **Auto Files**: auto-runs reads, allowlisted commands, and file edits; prompts for unlisted shell commands.
  - **Auto All**: auto-runs reads, file edits, and all non-blocked shell commands without prompting.
- **Git shadow checkpoints (`refs/repobridge/*`)**: snapshots touched files before each write batch, survives `git gc`, and reverts modified/created files in one click (**Undo**) without polluting your Git history.
- **Defense-in-depth security**: path traversal and dangling symlink protection, `.git` and `.env` read/write blocking, and a destructive command denylist.

## Quick Start

### 1. Install & Build

Requires Node.js `>=20`.

```bash
git clone https://github.com/Akifali-1/repobridge.git
cd repobridge
npm install
npm --prefix daemon install
npm run build
npm --prefix daemon link
```

### 2. Load the Chrome Extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder inside this repository.

### 3. Configure Your Chat System Prompt

Create a custom Gem (or start a chat) on `https://gemini.google.com` using the instructions in [`docs/SYSTEM_PROMPT.md`](docs/SYSTEM_PROMPT.md).

### 4. Start the Daemon in Any Repository

```bash
cd /path/to/your-repo
repobridge
```

1. Copy the printed bearer token from your terminal.
2. Open your chat tab in Chrome, paste the token into the bottom-right **REPOBRIDGE** HUD, and click **Connect**.
3. Choose an approval mode (**Manual Writes**, **Auto Files**, or **Auto All**) and click **Start Watching**.
4. Click **Start Ctx** to seed the chat with your repo map and scripts, or give a coding task directly. Use **Undo** at any time to revert the last write batch.

## CLI Options & Configuration

```text
repobridge [options]
  -p, --port <number>   Port to bind on 127.0.0.1 (default: 4040)
  -d, --dir <path>      Target repository directory (default: cwd)
  --verify <cmd>        Auto-run verification command after any write batch
  --token <string>      Use an explicit bearer token (or REPOBRIDGE_TOKEN env)
  --rotate-token        Generate and save a new persistent token (~/.repobridge/token)
  --allow-env-read      Allow read_file/grep_search on .env files (blocked by default)
  -h, --help            Show help
```

Copy [`.repobridge.example.json`](.repobridge.example.json) to `.repobridge.json` in your target repository root to customize `verifyCmd`, `allowedCommands`, `ignoreGlobs`, and read/output limits.

## Development & Testing

```bash
npm run check
```

This runs `build`, `typecheck`, `lint`, `format:check`, and the full Node test suite (`tests/*.test.mjs`).

## Security & Contributing

- Security model and vulnerability reporting: [`SECURITY.md`](SECURITY.md)
- Contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Release history: [`CHANGELOG.md`](CHANGELOG.md)
- License: [`LICENSE`](LICENSE) (MIT)
