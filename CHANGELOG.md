# Changelog

All notable changes to RepoBridge are documented in this file.

## [1.2.0] - 2026-11-25

### Added
- Rebranded project to **RepoBridge** across the daemon CLI (`repobridge`), Chrome extension HUD, Git shadow refs (`refs/repobridge/*`), and repo config (`.repobridge.json` with fallback to `.gemini-bridge.json`).
- Three HUD approval modes: **Manual Writes**, **Auto Files**, and **Auto All**.
- HTML/XML entity decoding (`&quot;`, `&#39;`, `&apos;`, `&lt;`, `&gt;`, `&amp;`) inside extension attribute parsing.
- Automated Node test suites covering security boundaries, HTTP auth/CORS/concurrency, parser edge cases, file patching/truncation, and Git shadow checkpoints (`tests/*.test.mjs`).
- Root ESLint, Prettier, `.editorconfig`, `.gitattributes`, `.nvmrc`, `.repobridge.example.json`, GitHub Actions CI (Ubuntu + Windows, Node 20 + 22, Gitleaks), Dependabot, and `scripts/pre-commit-check.mjs`.
- Open-source documentation: `README.md`, `LICENSE` (MIT), `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, and `docs/SYSTEM_PROMPT.md`.

### Security
- Hardened symlink escape protection in `resolveSafePath` to inspect both existing and dangling symlinks segment-by-segment.
- Tightened destructive command denylist to catch bare `rmSync` calls in addition to `fs.rm`/`fs.rmSync`.
- Standardized environment read opt-in under `REPOBRIDGE_ALLOW_ENV_READ` (while retaining `BRIDGE_ALLOW_ENV_READ` compatibility) and enforced `0600` token file permissions on POSIX.
- Centralized daemon version reading (`daemon/src/version.ts`) and shared runtime limits (`LIMITS` in `daemon/src/config.ts`).