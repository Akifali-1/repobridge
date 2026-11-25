# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.2.x   | Yes       |
| < 1.2.0 | No        |

## Threat Model & Protections

RepoBridge bridges a browser chat session (`https://gemini.google.com`) to a local Node.js daemon bound strictly to `127.0.0.1`. Because model outputs can be influenced by prompt injection in repository files or web content, RepoBridge enforces multiple defense-in-depth layers:

1. **Loopback-only HTTP & Bearer Auth:** The daemon binds only to `127.0.0.1` and requires an `Authorization: Bearer <token>` header on every route. CORS is restricted exclusively to `chrome-extension://` origins.
2. **Persistent Token Storage:** Persistent tokens are stored under `~/.repobridge/token` with `0600` file permissions on POSIX systems and are never logged during HTTP handling. Use `--rotate-token` to regenerate at any time.
3. **Filesystem Containment:** `resolveSafePath` rejects `..` traversal, out-of-root absolute paths, existing and dangling symlink escapes, Windows short-name/trailing-dot tricks, and all reads/writes under `.git`.
4. **Secret File Blocking:** `.env` and `.env.*` files (excluding `.env.example`, `.env.sample`, `.env.template`, and `.env.defaults`) cannot be written and are blocked from `read_file` and `grep_search` by default. Explicit opt-in for reads requires `--allow-env-read` or `REPOBRIDGE_ALLOW_ENV_READ=1`.
5. **Approval Modes & Command Blocklist:**
   - **Manual Writes** (default): auto-runs read tools and allowlisted commands without shell metacharacters; prompts with a unified diff preview for file edits and unlisted commands.
   - **Auto Files**: auto-runs reads, allowlisted commands, and file edits; prompts for unlisted shell commands.
   - **Auto All**: auto-runs reads, file edits, and all non-blocked shell commands without prompting (use only in trusted local repositories).
   - Destructive shell patterns (`rm -rf`, `del /s /f`, `git reset --hard`, `git push --force`, `shutil.rmtree`, `fs.rmSync`, etc.) are rejected in `daemon/src/security.ts` regardless of approval mode.
6. **Git Shadow Checkpoints:** Every write batch creates a shadow commit under `refs/repobridge/head` and `refs/repobridge/cp/<id>` (surviving `git gc`) so the last batch can be cleanly reverted via **Undo** without touching your working branch history or untouched files.

## Reporting a Vulnerability

Do not open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately via GitHub Security Advisories at:
`https://github.com/Akifali-1/repobridge/security/advisories/new`

Please include:
- A clear description of the vulnerability and impact.
- Minimal reproduction steps or proof-of-concept.
- Affected OS, Node.js version, and RepoBridge version.

You will receive an acknowledgment within 72 hours and updates as a fix is prepared.