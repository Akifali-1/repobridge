import fs from "node:fs";
import path from "node:path";

const BLOCKED_SEGMENTS = new Set([".git"]);
const SAFE_ENV_EXAMPLES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.defaults"
]);
const WIN_SHORT_NAME_RE = /~\d+(?:\.|$)/;

// Defense-in-depth denylist for obvious destructive commands.
// Real security boundary for shell execution is explicit user approval in the HUD.
const BLOCKED_CMD_PATTERNS: RegExp[] = [
  /\brm\s+[^\n]*(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\b[^\n]*--force|--force\b[^\n]*--recursive|-[a-z]*r\b[^\n]*-[a-z]*f\b|-[a-z]*f\b[^\n]*-[a-z]*r\b)/i,
  /\bdel\s+\/[sqf]/i,
  /\brd\s+\/s/i,
  /\brmdir\s+\/s/i,
  /\bformat\s+[a-z]:/i,
  /\bfind\b[^\n]*\s-delete\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+checkout\s+(?:--\s+)?\.\s*$/i,
  /\bgit\s+restore\s+(?:--worktree\s+|--staged\s+)*(?:--\s+)?\.\s*$/i,
  /\bgit\s+push\s+.*(--force|-f)\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bshutdown\b/i,
  /\bremove-item\b.*-recurse/i,
  /\bshutil\.rmtree\b/i,
  /(?:\bfs\.rm(?:Sync)?|\brmSync)\b/i
];

export function normalizeSegmentName(name: string): string {
  // Trim trailing dots/spaces (Windows strips them at the filesystem layer)
  return name.toLowerCase().replace(/[. ]+$/, "");
}

export function isProtectedEnvFilename(filename: string): boolean {
  const base = normalizeSegmentName(path.basename(filename));
  return (base === ".env" || base.startsWith(".env.")) && !SAFE_ENV_EXAMPLES.has(base);
}

export function resolveSafePath(repoRoot: string, rawPath: string, isWrite = false): string {
  if (!rawPath || typeof rawPath !== "string") {
    throw new Error("Path is required.");
  }

  const normalizedRoot = path.resolve(repoRoot);
  const realRoot = fs.existsSync(normalizedRoot) ? fs.realpathSync(normalizedRoot) : normalizedRoot;
  const slashNormalizedRaw = rawPath.replace(/\\/g, "/");
  const resolved = path.resolve(normalizedRoot, rawPath);
  const resolvedFromSlashes = path.resolve(normalizedRoot, slashNormalizedRaw);

  const isInside = (root: string, target: string): boolean => {
    const a = process.platform === "win32" ? root.toLowerCase() : root;
    const b = process.platform === "win32" ? target.toLowerCase() : target;
    return b === a || b.startsWith(a + path.sep);
  };

  if (!isInside(normalizedRoot, resolved) || !isInside(normalizedRoot, resolvedFromSlashes)) {
    throw new Error(`Path escapes repository root: ${rawPath}`);
  }

  // Symlink escape protection (handles both existing and dangling symlinks):
  // Walk each segment from repo root to target and verify every symlink target stays inside realRoot.
  const relFromRoot = path.relative(normalizedRoot, resolved);
  const segs = relFromRoot ? relFromRoot.split(path.sep).filter(Boolean) : [];
  let walkPath = normalizedRoot;
  for (const seg of segs) {
    walkPath = path.join(walkPath, seg);
    let lst: fs.Stats | null = null;
    try {
      lst = fs.lstatSync(walkPath);
    } catch {
      break;
    }
    if (lst.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(walkPath);
      const absTarget = path.resolve(path.dirname(walkPath), linkTarget);
      if (!isInside(normalizedRoot, absTarget) && !isInside(realRoot, absTarget)) {
        throw new Error(`Symlink escapes repository root: ${rawPath}`);
      }
      if (fs.existsSync(walkPath)) {
        const realTarget = fs.realpathSync(walkPath);
        if (!isInside(realRoot, realTarget)) {
          throw new Error(`Symlink escapes repository root: ${rawPath}`);
        }
      } else {
        // Dangling symlink: resolve nearest existing ancestor of the link target
        let targetProbe = absTarget;
        while (!fs.existsSync(targetProbe)) {
          const parent = path.dirname(targetProbe);
          if (parent === targetProbe) break;
          targetProbe = parent;
        }
        if (fs.existsSync(targetProbe)) {
          const realTargetProbe = fs.realpathSync(targetProbe);
          if (!isInside(realRoot, realTargetProbe)) {
            throw new Error(`Symlink escapes repository root: ${rawPath}`);
          }
        }
      }
    }
  }

  let probe = resolved;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (fs.existsSync(probe)) {
    const realProbe = fs.realpathSync(probe);
    if (!isInside(realRoot, realProbe)) {
      throw new Error(`Symlink escapes repository root: ${rawPath}`);
    }
  }

  // On Windows, also inspect realpath-resolved segments so 8.3 short names (e.g. GIT~1) cannot bypass checks
  const effectiveTarget = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
  const relCandidates = [
    path.relative(normalizedRoot, resolved),
    path.relative(realRoot, effectiveTarget)
  ];

  for (const rel of relCandidates) {
    const parts = rel.split(path.sep).filter(Boolean);
    for (const part of parts) {
      const cleanPart = normalizeSegmentName(part);
      if (BLOCKED_SEGMENTS.has(cleanPart)) {
        throw new Error(`Access to protected path "${part}" is blocked.`);
      }
      if (process.platform === "win32" && WIN_SHORT_NAME_RE.test(part)) {
        throw new Error(`Windows 8.3 short path segment "${part}" is blocked for safety.`);
      }
    }
  }

  const base = path.basename(effectiveTarget);
  if (isProtectedEnvFilename(base) || isProtectedEnvFilename(path.basename(resolved))) {
    if (isWrite) {
      throw new Error(`Writing to environment file "${base}" is blocked for safety.`);
    }
    if (
      process.env.REPOBRIDGE_ALLOW_ENV_READ !== "1" &&
      process.env.BRIDGE_ALLOW_ENV_READ !== "1"
    ) {
      throw new Error(
        `Reading secret file "${base}" is blocked by default to prevent leaking secrets to browser chat. Pass --allow-env-read to override.`
      );
    }
  }

  return resolved;
}

export function assertSafeCommand(cmd: string): void {
  if (!cmd || !cmd.trim()) {
    throw new Error("Command cannot be empty.");
  }
  for (const pattern of BLOCKED_CMD_PATTERNS) {
    if (pattern.test(cmd)) {
      throw new Error(`Command blocked by safety policy: ${cmd}`);
    }
  }
}

export function stripAnsi(input: string): string {
  return input.replace(
    // eslint-disable-next-line no-control-regex
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    ""
  );
}
