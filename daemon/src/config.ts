import fs from "node:fs";
import path from "node:path";

export interface BridgeConfig {
  verifyCmd: string | null;
  allowedCommands: string[];
  ignoreGlobs: string[];
  maxReadLines: number;
  maxFileChars: number;
  maxBatchChars: number;
  allowEnvRead: boolean;
}

export const DEFAULT_ALLOWED_COMMANDS: string[] = [
  "npm run typecheck",
  "npm run build",
  "npm test",
  "npm run test",
  "npm run lint",
  "npx tsc --noEmit",
  "pnpm typecheck",
  "pnpm build",
  "pnpm test",
  "yarn typecheck",
  "yarn build",
  "yarn test",
  "node --test",
  "pytest",
  "cargo check",
  "cargo test",
  "go test ./..."
];

export const DEFAULT_CONFIG: BridgeConfig = {
  verifyCmd: null,
  allowedCommands: [...DEFAULT_ALLOWED_COMMANDS],
  ignoreGlobs: [],
  maxReadLines: 800,
  maxFileChars: 40_000,
  maxBatchChars: 64_000,
  allowEnvRead: false
};

export const LIMITS = {
  DEFAULT_PORT: 4040,
  MAX_BODY_BYTES: 10 * 1024 * 1024,
  MAX_CHECKPOINTS: 30,
  MAX_REPO_MAP_ENTRIES: 500,
  MAX_LINE_CHARS: 500,
  MAX_GREP_MATCHES: 80,
  MAX_GREP_FILES: 3_000,
  MAX_GREP_MS: 5_000,
  MAX_CMD_LINES: 120,
  MAX_CMD_BUFFER_BYTES: 1_000_000,
  CMD_TIMEOUT_MS: 120_000
} as const;

export const REPO_CONFIG_FILENAME = ".repobridge.json";
export const LEGACY_REPO_CONFIG_FILENAME = ".gemini-bridge.json";

export function loadRepoConfig(
  repoRoot: string,
  overrides: Partial<BridgeConfig> = {}
): { config: BridgeConfig; configPath: string | null } {
  const root = path.resolve(repoRoot);
  const primary = path.join(root, REPO_CONFIG_FILENAME);
  const legacy = path.join(root, LEGACY_REPO_CONFIG_FILENAME);
  const candidate = fs.existsSync(primary) ? primary : fs.existsSync(legacy) ? legacy : null;
  let fileConfig: Partial<BridgeConfig> = {};
  let configPath: string | null = null;

  if (candidate) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        fileConfig = parsed as Partial<BridgeConfig>;
        configPath = candidate;
      }
    } catch (err) {
      console.warn(
        `[RepoBridge] Failed to parse ${path.basename(candidate)}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const clampInt = (val: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  };

  const mergedAllowed = Array.isArray(fileConfig.allowedCommands)
    ? fileConfig.allowedCommands.filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0
      )
    : [...DEFAULT_CONFIG.allowedCommands];

  const verifyCmd =
    overrides.verifyCmd !== undefined
      ? overrides.verifyCmd
      : typeof fileConfig.verifyCmd === "string" && fileConfig.verifyCmd.trim()
        ? fileConfig.verifyCmd.trim()
        : null;

  // Automatically allow the repo's configured verifyCmd so auto-verify / re-verify never stalls
  if (verifyCmd && !mergedAllowed.includes(verifyCmd)) {
    mergedAllowed.push(verifyCmd);
  }

  const config: BridgeConfig = {
    verifyCmd,
    allowedCommands: mergedAllowed,
    ignoreGlobs: Array.isArray(fileConfig.ignoreGlobs)
      ? fileConfig.ignoreGlobs.filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0
        )
      : [],
    maxReadLines: clampInt(
      overrides.maxReadLines ?? fileConfig.maxReadLines,
      DEFAULT_CONFIG.maxReadLines,
      50,
      2000
    ),
    maxFileChars: clampInt(
      overrides.maxFileChars ?? fileConfig.maxFileChars,
      DEFAULT_CONFIG.maxFileChars,
      4_000,
      120_000
    ),
    maxBatchChars: clampInt(
      overrides.maxBatchChars ?? fileConfig.maxBatchChars,
      DEFAULT_CONFIG.maxBatchChars,
      8_000,
      200_000
    ),
    allowEnvRead: Boolean(overrides.allowEnvRead ?? fileConfig.allowEnvRead ?? false)
  };

  return { config, configPath };
}

// Reject shell chaining/subshell operators in allowlist matching so
// "npm test && rm -rf ." can never match "npm test".
const SHELL_METACHAR_RE = /[;&|`$<>()\r\n]/;

export function isCommandAllowlisted(cmd: string, allowedCommands: string[]): boolean {
  const normalized = cmd.trim().replace(/\s+/g, " ");
  if (!normalized || SHELL_METACHAR_RE.test(normalized)) {
    return false;
  }
  return allowedCommands.some((pattern) => {
    const p = pattern.trim().replace(/\s+/g, " ");
    if (!p) return false;
    if (p.endsWith("*")) {
      const prefix = p.slice(0, -1);
      return normalized.startsWith(prefix);
    }
    return normalized === p;
  });
}
