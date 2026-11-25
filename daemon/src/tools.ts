import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import type { BridgeConfig } from "./config.js";
import { DEFAULT_CONFIG, LIMITS } from "./config.js";
import { buildUnifiedDiff } from "./diff.js";
import {
  assertSafeCommand,
  isProtectedEnvFilename,
  resolveSafePath,
  stripAnsi
} from "./security.js";
import type { ParsedToolCall, ToolExecutionResult } from "./types.js";
import type { GitShadowEngine } from "./gitShadow.js";

const execFileAsync = promisify(execFile);
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "dist",
  "build",
  "out",
  ".turbo",
  ".vercel",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".gradle",
  "Pods",
  "target",
  "vendor",
  ".idea"
]);

const GREP_IGNORED_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb"
]);

const GREP_IGNORED_EXTS = new Set([
  ".map",
  ".pkl",
  ".pt",
  ".pth",
  ".onnx",
  ".bin",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".zip",
  ".tar",
  ".gz",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".mp4",
  ".pdf",
  ".woff",
  ".woff2"
]);

const SYMBOL_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"]);

const MAX_REPO_MAP_ENTRIES = LIMITS.MAX_REPO_MAP_ENTRIES;
const MAX_LINE_CHARS = LIMITS.MAX_LINE_CHARS;
const MAX_GREP_MATCHES = LIMITS.MAX_GREP_MATCHES;
const MAX_GREP_FILES = LIMITS.MAX_GREP_FILES;
const MAX_GREP_MS = LIMITS.MAX_GREP_MS;
const MAX_CMD_LINES = LIMITS.MAX_CMD_LINES;
const MAX_CMD_BUFFER_BYTES = LIMITS.MAX_CMD_BUFFER_BYTES;
const CMD_TIMEOUT_MS = LIMITS.CMD_TIMEOUT_MS;

export interface FileReadCacheEntry {
  hash: string;
  turn: number;
}

export class FileReadCache {
  private readonly entries = new Map<string, FileReadCacheEntry>();

  public get(relPath: string, rangeKey: string): FileReadCacheEntry | undefined {
    return this.entries.get(`${relPath}|${rangeKey}`);
  }

  public set(relPath: string, rangeKey: string, hash: string, turn: number): void {
    this.entries.set(`${relPath}|${rangeKey}`, { hash, turn });
  }

  public invalidateFile(relPath: string): void {
    const prefix = `${relPath}|`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  public clear(): void {
    this.entries.clear();
  }
}

export interface ExecutionContext {
  config: BridgeConfig;
  readCache: FileReadCache;
  turn: number;
}

export function hashError(text: string): string {
  const normalized = text
    .trim()
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|min|mins)\b/gi, "<dur>")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<time>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>");
  return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 12);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAnyGlob(relPath: string, globs: string[]): boolean {
  if (!globs.length) return false;
  const norm = relPath.replace(/\\/g, "/");
  const base = path.basename(norm);
  for (const g of globs) {
    const re = globToRegExp(g);
    if (re.test(norm) || (!g.includes("/") && re.test(base))) return true;
  }
  return false;
}

function extractFileSymbols(absPath: string, maxSymbols = 12): string[] {
  const ext = path.extname(absPath).toLowerCase();
  if (!SYMBOL_EXTS.has(ext)) return [];
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return [];
  }
  if (stat.size > 120_000) return [];

  let text: string;
  try {
    text = fs.readFileSync(absPath, "utf8");
  } catch {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const symbols: string[] = [];

  for (let i = 0; i < lines.length && symbols.length < maxSymbols; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null = null;
    if (ext === ".py") {
      m = line.match(/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/);
    } else if (ext === ".go") {
      m = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|^type\s+([A-Za-z_]\w*)/);
    } else if (ext === ".rs") {
      m = line.match(/^(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/);
    } else {
      m = line.match(
        /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type)\s+([A-Za-z_$][\w$]*)|^\s*export\s+(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/
      );
    }
    const name = m ? m[1] || m[2] : null;
    if (name) {
      symbols.push(`${name}:${i + 1}`);
    }
  }
  return symbols;
}

export function buildRepoMap(
  repoRoot: string,
  options: { symbols?: boolean; ignoreGlobs?: string[] } = {}
): string {
  const { symbols = false, ignoreGlobs = [] } = options;

  // Prefer `git ls-files` so .gitignore is automatically respected
  let relFiles: string[] | null = null;
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    });
    relFiles = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith(".git/"));
  } catch {
    relFiles = null;
  }

  if (relFiles === null) {
    // Fallback filesystem walk for non-git directories
    const collected: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || collected.length >= MAX_REPO_MAP_ENTRIES + 50) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else {
          collected.push(path.relative(repoRoot, full).replace(/\\/g, "/"));
        }
      }
    };
    walk(repoRoot, 0);
    relFiles = collected;
  }

  const filtered = relFiles
    .filter((rel) => {
      if (matchesAnyGlob(rel, ignoreGlobs)) return false;
      const parts = rel.split("/");
      return !parts.some((p) => IGNORED_DIRS.has(p));
    })
    .sort((a, b) => a.localeCompare(b));

  const truncated = filtered.length > MAX_REPO_MAP_ENTRIES;
  const shown = filtered.slice(0, MAX_REPO_MAP_ENTRIES);

  const lines: string[] = [];
  for (const rel of shown) {
    const abs = path.join(repoRoot, rel);
    let sizeTag = "";
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) sizeTag = ` (${formatBytes(st.size)})`;
    } catch {
      continue; // Deleted tracked file
    }

    let symTag = "";
    if (symbols) {
      const syms = extractFileSymbols(abs);
      if (syms.length > 0) symTag = `  [${syms.join(", ")}]`;
    }
    lines.push(`${rel}${sizeTag}${symTag}`);
  }

  if (truncated) {
    lines.push(`... [${filtered.length - MAX_REPO_MAP_ENTRIES} more files omitted]`);
  }
  return lines.join("\n") || "(empty repository)";
}

export function buildSessionStarter(
  repoRoot: string,
  gitShadow: GitShadowEngine,
  config: BridgeConfig
): string {
  const repoName = path.basename(repoRoot);
  const parts: string[] = [];

  parts.push(`# Session Context: ${repoName}`);
  parts.push(`- Runtime: Node ${process.version} (${process.platform})`);
  parts.push(`- Branch: ${gitShadow.getBranch()}`);
  if (config.verifyCmd) {
    parts.push(`- Auto-verify: \`${config.verifyCmd}\` (runs automatically after write batches)`);
  }

  // Git status
  if (gitShadow.isGitRepo()) {
    try {
      const status = execFileSync("git", ["status", "--short"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
      parts.push(`\n## Git Status\n\`\`\`text\n${status || "(clean working tree)"}\n\`\`\``);
    } catch {
      // ignore
    }
  }

  // Package scripts (root and immediate sub-packages like daemon/ or frontend/)
  const pkgCandidates = [
    "package.json",
    "daemon/package.json",
    "frontend/package.json",
    "backend/package.json"
  ];
  const scriptBlocks: string[] = [];
  for (const rel of pkgCandidates) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(abs, "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
        const list = Object.entries(pkg.scripts)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
        scriptBlocks.push(`${rel}:\n${list}`);
      }
    } catch {
      // ignore invalid json
    }
  }
  if (scriptBlocks.length > 0) {
    parts.push(`\n## Scripts\n\`\`\`text\n${scriptBlocks.join("\n\n")}\n\`\`\``);
  }

  // Repo map with sizes and symbol outline
  const map = buildRepoMap(repoRoot, { symbols: true, ignoreGlobs: config.ignoreGlobs });
  parts.push(`\n## Repository Map (sizes & symbols)\n\`\`\`text\n${map}\n\`\`\``);
  parts.push("\nContext loaded. Wait for my task.");

  return parts.join("\n");
}

function isLikelyBinary(buf: Buffer): boolean {
  const sampleLen = Math.min(buf.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

let cachedRgAvailable: boolean | null = null;
async function isRgAvailable(): Promise<boolean> {
  if (cachedRgAvailable !== null) return cachedRgAvailable;
  try {
    await execFileAsync("rg", ["--version"], { timeout: 2_000 });
    cachedRgAvailable = true;
  } catch {
    cachedRgAvailable = false;
  }
  return cachedRgAvailable;
}

function filterSearchOutput(rawOutput: string, repoRoot: string, allowEnvRead: boolean): string[] {
  const outLines: string[] = [];
  const rawLines = rawOutput.split(/\r?\n/);

  for (const line of rawLines) {
    if (!line) continue;
    if (line === "--") {
      outLines.push("--");
      continue;
    }
    // Extract leading file path (ripgrep/git-grep format: path:line:text or path-line-text)
    const m = line.match(/^([^:]+?)([:-])(\d+)\2(.*)$/);
    if (m) {
      let filePath = m[1].replace(/\\/g, "/");
      if (path.isAbsolute(filePath)) {
        filePath = path.relative(repoRoot, filePath).replace(/\\/g, "/");
      }
      if (!allowEnvRead && isProtectedEnvFilename(filePath)) {
        continue;
      }
      const sep = m[2];
      const lineNo = m[3];
      const text = m[4].trim().slice(0, 200);
      outLines.push(`${filePath}${sep}${lineNo}${sep}${text}`);
      if (outLines.length >= MAX_GREP_MATCHES * 3) break;
    } else {
      outLines.push(line.slice(0, 200));
    }
  }
  return outLines;
}

async function runRipgrep(
  repoRoot: string,
  query: string,
  opts: {
    targetPath?: string;
    regex?: boolean;
    glob?: string;
    context?: number;
    allowEnvRead: boolean;
  }
): Promise<string | null> {
  if (!(await isRgAvailable())) return null;

  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--smart-case",
    "--max-count",
    "25"
  ];
  if (!opts.regex) args.push("--fixed-strings");
  if (opts.context && opts.context > 0) {
    args.push("-C", String(Math.min(5, Math.floor(opts.context))));
  }
  if (opts.glob) args.push("--glob", opts.glob);
  if (!opts.allowEnvRead) {
    args.push(
      "--glob",
      "!.env",
      "--glob",
      "!.env.*",
      "--glob",
      ".env.example",
      "--glob",
      ".env.sample"
    );
  }
  for (const lock of GREP_IGNORED_FILES) {
    args.push("--glob", `!${lock}`);
  }
  args.push("--", query);
  if (opts.targetPath) args.push(opts.targetPath);

  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd: repoRoot,
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024
    });
    const filtered = filterSearchOutput(stdout, repoRoot, opts.allowEnvRead);
    if (filtered.length === 0) return `No matches found for "${query}".`;
    return filtered.join("\n");
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string };
    // ripgrep exits 1 when no matches found
    if (e.code === 1) return `No matches found for "${query}".`;
    if (e.stdout) {
      const filtered = filterSearchOutput(e.stdout, repoRoot, opts.allowEnvRead);
      if (filtered.length > 0) return filtered.join("\n");
    }
    return null; // Fall back to git grep or JS walk
  }
}

async function runGitGrep(
  repoRoot: string,
  query: string,
  opts: {
    targetPath?: string;
    regex?: boolean;
    glob?: string;
    context?: number;
    allowEnvRead: boolean;
  }
): Promise<string | null> {
  const args = ["grep", "-n", "-I", "--ignore-case"];
  args.push(opts.regex ? "-E" : "-F");
  if (opts.context && opts.context > 0) {
    args.push(`-C${Math.min(5, Math.floor(opts.context))}`);
  }
  args.push("-e", query, "--");
  if (opts.targetPath) {
    args.push(opts.targetPath);
  } else if (opts.glob) {
    args.push(`:(glob)${opts.glob}`);
  } else {
    args.push(".");
  }
  for (const lock of GREP_IGNORED_FILES) {
    args.push(`:(exclude)${lock}`);
  }

  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024
    });
    const filtered = filterSearchOutput(stdout, repoRoot, opts.allowEnvRead);
    if (filtered.length === 0) return `No matches found for "${query}".`;
    return filtered.join("\n");
  } catch (err: unknown) {
    const e = err as { code?: number | string };
    if (e.code === 1) return `No matches found for "${query}".`;
    return null;
  }
}

async function runGrepSearch(
  repoRoot: string,
  call: ParsedToolCall,
  gitShadow: GitShadowEngine
): Promise<string> {
  const query = call.query ?? "";
  if (!query.trim()) {
    throw new Error("grep_search requires a non-empty query.");
  }

  const allowEnvRead =
    process.env.REPOBRIDGE_ALLOW_ENV_READ === "1" || process.env.BRIDGE_ALLOW_ENV_READ === "1";
  let targetRel: string | undefined;
  const startDir = call.path ? resolveSafePath(repoRoot, call.path, false) : repoRoot;
  if (call.path) {
    targetRel = path.relative(repoRoot, startDir).replace(/\\/g, "/") || ".";
  }

  const searchOpts = {
    targetPath: targetRel,
    regex: Boolean(call.regex),
    glob: call.glob,
    context: call.context,
    allowEnvRead
  };

  // 1. Try ripgrep (fastest, respects .gitignore, supports glob + regex + context)
  const rgOut = await runRipgrep(repoRoot, query, searchOpts);
  if (rgOut !== null) return rgOut;

  // 2. Try git grep if inside a Git repo (only if target is not an untracked/ignored dir)
  if (gitShadow.isGitRepo() && (!targetRel || !IGNORED_DIRS.has(path.basename(startDir)))) {
    const gitOut = await runGitGrep(repoRoot, query, searchOpts);
    if (gitOut !== null) return gitOut;
  }

  // 3. Async JS walk fallback (yields to event loop so /health stays responsive)
  const matches: string[] = [];
  const lowerQuery = query.toLowerCase();
  const matcher = call.regex ? new RegExp(query, "i") : null;
  const globRe = call.glob ? globToRegExp(call.glob) : null;
  const ctxLines = call.context ? Math.min(5, Math.max(0, Math.floor(call.context))) : 0;
  const startedAt = Date.now();
  let scannedFiles = 0;
  let stoppedEarlyReason: string | null = null;

  async function walk(target: string): Promise<void> {
    if (matches.length >= MAX_GREP_MATCHES || stoppedEarlyReason) return;
    if (scannedFiles >= MAX_GREP_FILES) {
      stoppedEarlyReason = `scanned ${MAX_GREP_FILES} files`;
      return;
    }
    if (Date.now() - startedAt > MAX_GREP_MS) {
      stoppedEarlyReason = `exceeded ${MAX_GREP_MS / 1000}s scan budget`;
      return;
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(target);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;

    if (stat.isDirectory()) {
      const base = path.basename(target);
      if (IGNORED_DIRS.has(base) && target !== repoRoot && target !== startDir) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(target, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= MAX_GREP_MATCHES || stoppedEarlyReason) return;
        await walk(path.join(target, entry.name));
      }
      return;
    }

    const rawBase = path.basename(target);
    const baseName = rawBase.toLowerCase();
    const ext = path.extname(baseName);
    if (!allowEnvRead && isProtectedEnvFilename(rawBase)) return;
    if (
      GREP_IGNORED_FILES.has(baseName) ||
      GREP_IGNORED_EXTS.has(ext) ||
      baseName.endsWith(".min.js") ||
      baseName.endsWith(".min.css")
    ) {
      return;
    }
    if (stat.size > 512_000) return;

    const rel = path.relative(repoRoot, target).replace(/\\/g, "/");
    if (globRe && !globRe.test(rel) && !globRe.test(rawBase)) return;

    scannedFiles += 1;
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(target);
    } catch {
      return;
    }
    if (isLikelyBinary(buf)) return;

    const fileLines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < fileLines.length; i++) {
      const hit = matcher
        ? matcher.test(fileLines[i])
        : fileLines[i].toLowerCase().includes(lowerQuery);
      if (!hit) continue;

      if (ctxLines > 0) {
        const from = Math.max(0, i - ctxLines);
        const to = Math.min(fileLines.length - 1, i + ctxLines);
        for (let k = from; k <= to; k++) {
          const sep = k === i ? ":" : "-";
          matches.push(`${rel}${sep}${k + 1}${sep}${fileLines[k].trim().slice(0, 180)}`);
        }
        matches.push("--");
      } else {
        matches.push(`${rel}:${i + 1}:${fileLines[i].trim().slice(0, 180)}`);
      }
      if (matches.length >= MAX_GREP_MATCHES) return;
    }
  }

  await walk(startDir);
  if (matches.length === 0) {
    const suffix = stoppedEarlyReason
      ? ` (stopped early: ${stoppedEarlyReason}; narrow "path")`
      : "";
    return `No matches found for "${query}"${suffix}.`;
  }
  const notes: string[] = [];
  if (matches.length >= MAX_GREP_MATCHES) notes.push(`capped at ${MAX_GREP_MATCHES} matches`);
  if (stoppedEarlyReason) notes.push(`stopped early: ${stoppedEarlyReason}`);
  const footer = notes.length > 0 ? `\n... [${notes.join("; ")}]` : "";
  return matches.join("\n") + footer;
}

function parseLineRanges(
  call: ParsedToolCall,
  totalLines: number,
  maxReadLines: number
): Array<[number, number]> {
  if (call.ranges && call.ranges.trim()) {
    const out: Array<[number, number]> = [];
    for (const part of call.ranges.split(",")) {
      const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) continue;
      const s = Math.max(1, Math.min(totalLines, Number(m[1])));
      const e = m[2]
        ? Math.max(s, Math.min(totalLines, Number(m[2])))
        : Math.min(totalLines, s + maxReadLines - 1);
      out.push([s, e]);
    }
    if (out.length > 0) return out;
  }

  const startLine = Math.max(1, Number.isFinite(call.start) ? Math.floor(call.start!) : 1);
  const requestedEnd = Number.isFinite(call.end)
    ? Math.floor(call.end!)
    : startLine + maxReadLines - 1;
  const endLine = Math.min(totalLines, startLine + maxReadLines - 1, requestedEnd);
  return [[startLine, Math.max(startLine, endLine)]];
}

function runReadFile(
  repoRoot: string,
  call: ParsedToolCall,
  ctx: ExecutionContext
): { output: string; deduped: boolean } {
  const relPath = call.path ?? "";
  const abs = resolveSafePath(repoRoot, relPath, false);
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${relPath}`);
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${relPath}`);
  }
  if (stat.size > 5_000_000) {
    throw new Error(
      `File is too large (${(stat.size / (1024 * 1024)).toFixed(1)} MB): ${relPath}. Use grep_search instead.`
    );
  }

  const rawBuf = fs.readFileSync(abs);
  if (isLikelyBinary(rawBuf)) {
    throw new Error(`Binary file cannot be displayed as text: ${relPath} (${stat.size} bytes).`);
  }

  const raw = rawBuf.toString("utf8");
  const allLines = raw.split(/\r?\n/);
  const totalLines = allLines.length;
  const ranges = parseLineRanges(call, totalLines, ctx.config.maxReadLines);
  const rangeKey = ranges.map(([s, e]) => `${s}-${e}`).join(",");
  const normRel = path.relative(repoRoot, abs).replace(/\\/g, "/");
  const fileHash = crypto.createHash("sha1").update(rawBuf).digest("hex").slice(0, 16);

  // Unchanged-file dedup: avoid re-pasting identical content across turns
  if (!call.force) {
    const cached = ctx.readCache.get(normRel, rangeKey);
    if (cached && cached.hash === fileHash) {
      return {
        output: `File: ${relPath} (${rangeKey}/${totalLines}) — unchanged since turn ${cached.turn}. Pass force="true" to re-read.`,
        deduped: true
      };
    }
  }

  const blocks: string[] = [];
  let charsUsed = 0;
  let totalEmitted = 0;
  let lastLineShown = 0;
  let charCapped = false;
  let lineCapped = false;

  for (const [s, e] of ranges) {
    if (charCapped || lineCapped) break;
    const sectionLines: string[] = [];
    for (let i = s; i <= e; i++) {
      if (totalEmitted >= ctx.config.maxReadLines) {
        lineCapped = true;
        break;
      }
      let lineText = allLines[i - 1];
      if (lineText.length > MAX_LINE_CHARS) {
        lineText = `${lineText.slice(0, MAX_LINE_CHARS)} ... [+${lineText.length - MAX_LINE_CHARS}c]`;
      }
      // Compact unpadded format: "12|code"
      const formatted = `${i}|${lineText}`;
      if (totalEmitted > 0 && charsUsed + formatted.length + 1 > ctx.config.maxFileChars) {
        charCapped = true;
        break;
      }
      sectionLines.push(formatted);
      charsUsed += formatted.length + 1;
      totalEmitted += 1;
      lastLineShown = i;
    }
    if (sectionLines.length > 0) {
      if (ranges.length > 1) {
        blocks.push(`--- lines ${s}-${lastLineShown} ---\n${sectionLines.join("\n")}`);
      } else {
        blocks.push(sectionLines.join("\n"));
      }
    }
  }

  ctx.readCache.set(normRel, rangeKey, fileHash, ctx.turn);

  const header = `File: ${relPath} (${rangeKey} of ${totalLines})`;
  let moreHint = "";
  if (ranges.length === 1 && lastLineShown < totalLines) {
    const capNote = charCapped
      ? ` (paused at ${Math.round(ctx.config.maxFileChars / 1000)}KB cap)`
      : "";
    moreHint = `\n... [${totalLines - lastLineShown} more lines${capNote}; next: start="${lastLineShown + 1}" end="${Math.min(totalLines, lastLineShown + ctx.config.maxReadLines)}"]`;
  }

  return { output: `${header}\n${blocks.join("\n")}${moreHint}`, deduped: false };
}

export function computePatchedContent(
  repoRoot: string,
  call: ParsedToolCall
): {
  abs: string;
  rel: string;
  rawOriginal: string;
  finalText: string;
  summary: string;
  diff: string;
} {
  const relPath = call.path ?? "";
  const abs = resolveSafePath(repoRoot, relPath, true);
  if (!fs.existsSync(abs)) {
    throw new Error(`Cannot patch missing file: ${relPath}. Use write_file to create new files.`);
  }

  const rawOriginal = fs.readFileSync(abs, "utf8");
  const usesCRLF = rawOriginal.includes("\r\n");
  const normOriginal = rawOriginal.replace(/\r\n/g, "\n");
  const normReplace = (call.replace ?? call.content ?? "").replace(/\r\n/g, "\n");

  // Mode A: Line-range patch (<patch_file path="..." start="10" end="18">)
  if (Number.isFinite(call.start) && Number.isFinite(call.end)) {
    const origLines = normOriginal.split("\n");
    const startLine = Math.floor(call.start!);
    const endLine = Math.floor(call.end!);
    if (startLine < 1 || endLine < startLine || endLine > origLines.length) {
      throw new Error(
        `Invalid line range ${startLine}-${endLine} for ${relPath} (file has ${origLines.length} lines).`
      );
    }

    const replaceLines = normReplace === "" ? [] : normReplace.split("\n");
    const updatedLines = [
      ...origLines.slice(0, startLine - 1),
      ...replaceLines,
      ...origLines.slice(endLine)
    ];
    const updatedNorm = updatedLines.join("\n");
    const finalText = usesCRLF ? updatedNorm.replace(/\n/g, "\r\n") : updatedNorm;
    const oldCount = endLine - startLine + 1;
    const diff = buildUnifiedDiff(relPath, normOriginal, updatedNorm);
    return {
      abs,
      rel: path.relative(repoRoot, abs).replace(/\\/g, "/"),
      rawOriginal,
      finalText,
      summary: `Patched ${relPath} lines ${startLine}-${endLine} (-${oldCount} / +${replaceLines.length} lines).`,
      diff
    };
  }

  // Mode B: Exact / whitespace-tolerant SEARCH & REPLACE
  const searchBlock = call.search ?? "";
  if (!searchBlock) {
    throw new Error(
      "patch_file requires either start/end line numbers or a non-empty <search> block."
    );
  }
  const normSearch = searchBlock.replace(/\r\n/g, "\n");

  const occurrences: number[] = [];
  let idx = normOriginal.indexOf(normSearch);
  while (idx !== -1) {
    occurrences.push(idx);
    idx = normOriginal.indexOf(normSearch, idx + 1);
  }

  if (occurrences.length === 0) {
    const origLines = normOriginal.split("\n");
    const searchLines = normSearch.split("\n");
    const trimmedSearch = searchLines.map((l) => l.trim());
    const fuzzyMatches: number[] = [];

    for (let i = 0; i <= origLines.length - searchLines.length; i++) {
      let allMatch = true;
      for (let j = 0; j < searchLines.length; j++) {
        if (origLines[i + j].trim() !== trimmedSearch[j]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) fuzzyMatches.push(i);
    }

    if (fuzzyMatches.length === 1) {
      const startIdx = fuzzyMatches[0];
      const rawReplaceLines = normReplace.split("\n");

      const firstNonEmptyOffset = searchLines.findIndex((l) => l.trim().length > 0);
      let adjustedReplaceLines = rawReplaceLines;
      if (firstNonEmptyOffset !== -1) {
        const origIndent = origLines[startIdx + firstNonEmptyOffset].match(/^[ \t]*/)?.[0] ?? "";
        const searchIndent = searchLines[firstNonEmptyOffset].match(/^[ \t]*/)?.[0] ?? "";
        if (origIndent !== searchIndent) {
          adjustedReplaceLines = rawReplaceLines.map((line) => {
            if (!line.trim()) return "";
            if (searchIndent && line.startsWith(searchIndent)) {
              return origIndent + line.slice(searchIndent.length);
            }
            return origIndent + line.replace(/^[ \t]*/, "");
          });
        }
      }

      const updatedLines = [
        ...origLines.slice(0, startIdx),
        ...adjustedReplaceLines,
        ...origLines.slice(startIdx + searchLines.length)
      ];
      const updatedNorm = updatedLines.join("\n");
      const finalText = usesCRLF ? updatedNorm.replace(/\n/g, "\r\n") : updatedNorm;
      const diff = buildUnifiedDiff(relPath, normOriginal, updatedNorm);
      return {
        abs,
        rel: path.relative(repoRoot, abs).replace(/\\/g, "/"),
        rawOriginal,
        finalText,
        summary: `Patched ${relPath} at line ${startIdx + 1} (whitespace-tolerant: -${searchLines.length} / +${adjustedReplaceLines.length} lines).`,
        diff
      };
    }

    const firstLine = normSearch
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    let hint = "Re-read with read_file or use start/end line-range patch mode.";
    if (firstLine) {
      const foundLineIdx = origLines.findIndex((l) => l.includes(firstLine));
      if (foundLineIdx !== -1) {
        const from = Math.max(0, foundLineIdx - 2);
        const to = Math.min(origLines.length, foundLineIdx + 8);
        const excerpt = origLines
          .slice(from, to)
          .map((l, i) => `${from + i + 1}|${l}`)
          .join("\n");
        hint = `First search line matched near line ${foundLineIdx + 1}:\n${excerpt}`;
      }
    }
    throw new Error(`SEARCH block not found in ${relPath}. ${hint}`);
  }

  if (occurrences.length > 1) {
    const lineNumbers = occurrences.map((pos) => normOriginal.slice(0, pos).split("\n").length);
    throw new Error(
      `SEARCH block is ambiguous in ${relPath} (matched ${occurrences.length} times at lines ${lineNumbers.join(", ")}). Use start/end line numbers or add surrounding lines.`
    );
  }

  const matchPos = occurrences[0];
  const updatedNorm =
    normOriginal.slice(0, matchPos) +
    normReplace +
    normOriginal.slice(matchPos + normSearch.length);
  const finalText = usesCRLF ? updatedNorm.replace(/\n/g, "\r\n") : updatedNorm;
  const startLine = normOriginal.slice(0, matchPos).split("\n").length;
  const oldCount = normSearch.split("\n").length;
  const newCount = normReplace.split("\n").length;
  const diff = buildUnifiedDiff(relPath, normOriginal, updatedNorm);

  return {
    abs,
    rel: path.relative(repoRoot, abs).replace(/\\/g, "/"),
    rawOriginal,
    finalText,
    summary: `Patched ${relPath} at line ${startLine} (-${oldCount} / +${newCount} lines).`,
    diff
  };
}

function runPatchFile(repoRoot: string, call: ParsedToolCall, ctx: ExecutionContext): string {
  const computed = computePatchedContent(repoRoot, call);
  fs.writeFileSync(computed.abs, computed.finalText, "utf8");
  ctx.readCache.invalidateFile(computed.rel);
  return `${computed.summary}\n${computed.diff}`;
}

export function previewToolBatch(repoRoot: string, tools: ParsedToolCall[]): string {
  const sections: string[] = [];
  for (const call of tools) {
    if (call.tool === "patch_file") {
      try {
        const computed = computePatchedContent(repoRoot, call);
        sections.push(computed.diff);
      } catch (err) {
        sections.push(
          `! PATCH ${call.path} (preview warning: ${err instanceof Error ? err.message : String(err)})`
        );
      }
    } else if (call.tool === "write_file") {
      const content = call.content ?? "";
      const lines = content.split(/\r?\n/);
      const preview = lines
        .slice(0, 25)
        .map((l) => `+${l}`)
        .join("\n");
      const more = lines.length > 25 ? `\n... [+${lines.length - 25} more lines]` : "";
      sections.push(`@@ CREATE ${call.path} (${lines.length} lines) @@\n${preview}${more}`);
    } else if (call.tool === "run_cmd") {
      sections.push(`$ ${call.cmd}`);
    } else {
      sections.push(`${call.tool.toUpperCase()} ${call.path || call.query || ""}`);
    }
  }
  return sections.join("\n\n");
}

function runWriteFile(
  repoRoot: string,
  relPath: string,
  content: string,
  gitShadow: GitShadowEngine,
  checkpointId: string | null,
  ctx: ExecutionContext
): string {
  const abs = resolveSafePath(repoRoot, relPath, true);
  if (fs.existsSync(abs)) {
    throw new Error(
      `File already exists: ${relPath}. write_file is create-only; use patch_file to modify existing files.`
    );
  }

  const normalizedRoot = path.resolve(repoRoot);
  const createdDirs: string[] = [];
  let dirCursor = path.dirname(abs);
  while (dirCursor !== normalizedRoot && dirCursor !== path.dirname(dirCursor)) {
    if (fs.existsSync(dirCursor)) break;
    createdDirs.push(path.relative(normalizedRoot, dirCursor).replace(/\\/g, "/"));
    dirCursor = path.dirname(dirCursor);
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content ?? "", "utf8");
  const normRel = path.relative(normalizedRoot, abs).replace(/\\/g, "/");
  gitShadow.recordCreatedFile(checkpointId, normRel, createdDirs);
  ctx.readCache.invalidateFile(normRel);

  const lineCount = (content ?? "").split(/\r?\n/).length;
  return `Created ${relPath} (${lineCount} lines).`;
}

export function runShellCmd(
  repoRoot: string,
  cmd: string
): Promise<{ ok: boolean; output: string }> {
  assertSafeCommand(cmd);

  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(cmd, {
      cwd: repoRoot,
      shell: true,
      detached: !isWin,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" }
    });

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let combined = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        if (isWin) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    }, CMD_TIMEOUT_MS);

    const appendText = (text: string) => {
      if (!text) return;
      combined += text;
      if (combined.length > MAX_CMD_BUFFER_BYTES) {
        combined = combined.slice(-MAX_CMD_BUFFER_BYTES);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => appendText(stdoutDecoder.write(chunk)));
    child.stderr.on("data", (chunk: Buffer) => appendText(stderrDecoder.write(chunk)));

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Failed to spawn command: ${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      appendText(stdoutDecoder.end());
      appendText(stderrDecoder.end());
      const clean = stripAnsi(combined).trim();
      const lines = clean.split(/\r?\n/);
      const tail =
        lines.length > MAX_CMD_LINES
          ? `... [${lines.length - MAX_CMD_LINES} earlier lines omitted]\n` +
            lines.slice(-MAX_CMD_LINES).join("\n")
          : clean;

      if (timedOut) {
        resolve({
          ok: false,
          output: `Command timed out after ${CMD_TIMEOUT_MS / 1000}s:\n${tail}`
        });
        return;
      }

      const exitCode = code ?? 1;
      resolve({
        ok: exitCode === 0,
        output: `Exit code: ${exitCode}\n${tail || "(no output)"}`
      });
    });
  });
}

export async function executeTool(
  repoRoot: string,
  call: ParsedToolCall,
  gitShadow: GitShadowEngine,
  checkpointId: string | null,
  ctx: ExecutionContext = { config: DEFAULT_CONFIG, readCache: new FileReadCache(), turn: 1 }
): Promise<ToolExecutionResult> {
  try {
    switch (call.tool) {
      case "repo_map":
        return {
          tool: "repo_map",
          ok: true,
          output: buildRepoMap(repoRoot, {
            symbols: Boolean(call.symbols),
            ignoreGlobs: ctx.config.ignoreGlobs
          })
        };

      case "grep_search":
        return {
          tool: "grep_search",
          ok: true,
          output: await runGrepSearch(repoRoot, call, gitShadow)
        };

      case "read_file": {
        const res = runReadFile(repoRoot, call, ctx);
        return {
          tool: "read_file",
          ok: true,
          targetPath: call.path,
          output: res.output,
          deduped: res.deduped
        };
      }

      case "patch_file":
        return {
          tool: "patch_file",
          ok: true,
          targetPath: call.path,
          output: runPatchFile(repoRoot, call, ctx)
        };

      case "write_file":
        return {
          tool: "write_file",
          ok: true,
          targetPath: call.path,
          output: runWriteFile(
            repoRoot,
            call.path ?? "",
            call.content ?? "",
            gitShadow,
            checkpointId,
            ctx
          )
        };

      case "run_cmd": {
        const res = await runShellCmd(repoRoot, call.cmd ?? "");
        return {
          tool: "run_cmd",
          ok: res.ok,
          output: res.output,
          errorHash: res.ok ? undefined : hashError(res.output)
        };
      }

      default:
        throw new Error(`Unknown tool: ${String((call as { tool?: unknown }).tool)}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      tool: call.tool,
      ok: false,
      targetPath: call.path,
      output: `ERROR: ${msg}`,
      errorHash: hashError(msg)
    };
  }
}

export function formatToolResultsBlock(
  results: ToolExecutionResult[],
  maxBatchChars = DEFAULT_CONFIG.maxBatchChars
): {
  text: string;
  truncated: boolean;
  bytes: number;
} {
  let truncated = false;
  let remainingBudget = maxBatchChars;
  const count = Math.max(1, results.length);

  const parts = results.map((r, idx) => {
    const status = r.ok ? "ok" : "error";
    const pathAttr = r.targetPath ? ` path="${r.targetPath}"` : "";
    const remainingItems = count - idx;
    const fairShare = Math.max(3_000, Math.floor(remainingBudget / remainingItems));
    let output = r.output;

    if (output.length > fairShare) {
      truncated = true;
      const keep = Math.max(1_500, fairShare - 180);
      output =
        output.slice(0, keep) +
        `\n... [clipped ${r.output.length}->${keep}c for UI speed; request smaller start/end]`;
    }
    remainingBudget = Math.max(0, remainingBudget - output.length);

    return `<result tool="${r.tool}" status="${status}"${pathAttr}>\n${output}\n</result>`;
  });

  // Compact format: no repeated boilerplate suffix
  const text = `<tool_results>\n${parts.join("\n\n")}\n</tool_results>`;
  return { text, truncated, bytes: Buffer.byteLength(text, "utf8") };
}
