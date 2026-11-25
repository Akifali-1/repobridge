# Contributing to RepoBridge

Contributions are welcome. Before submitting a pull request, please ensure your changes follow the repository conventions and pass the full verification suite.

## Development Setup

Requirements:
- Node.js `>=20` (see `.nvmrc`)
- Git
- Google Chrome or Chromium-based browser for loading the MV3 extension

Install dependencies at both the root and daemon level:

```bash
npm install
npm --prefix daemon install
```

## Verification Commands

Run the full check suite before pushing:

```bash
npm run check
```

Individual commands:
- `npm run build` - compile TypeScript daemon to `daemon/dist`
- `npm run typecheck` - strict TypeScript check (`tsc --noEmit`)
- `npm run lint` - ESLint across `daemon/src`, `extension`, `tests`, and `scripts`
- `npm run format` / `npm run format:check` - Prettier formatting
- `npm test` - Node built-in test runner across `tests/*.test.mjs`

## Optional Pre-Commit Secret Check

You can run the staged-file secret guard manually or wire it into `.git/hooks/pre-commit`:

```bash
node scripts/pre-commit-check.mjs
```

## Pull Request Guidelines

1. Keep changes focused and modular.
2. Add or update unit tests under `tests/` for any bug fix, security rule, or new feature.
3. Never commit secrets, bearer tokens, `.env` files, or machine-specific absolute paths.
4. Keep `daemon/package.json`, root `package.json`, and `extension/manifest.json` versions in sync for release bumps.
