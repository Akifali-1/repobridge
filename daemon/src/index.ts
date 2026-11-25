#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LIMITS, loadRepoConfig, REPO_CONFIG_FILENAME } from "./config.js";
import { GitShadowEngine } from "./gitShadow.js";
import { startBridgeServer } from "./server.js";
import { getDaemonVersion } from "./version.js";

interface CliArgs {
  port: number;
  dir: string;
  token?: string;
  verifyCmd?: string;
  rotateToken: boolean;
  allowEnvRead: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let port: number = LIMITS.DEFAULT_PORT;
  let dir = process.cwd();
  let token: string | undefined;
  let verifyCmd: string | undefined;
  let rotateToken = false;
  let allowEnvRead = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--port" || arg === "-p") && argv[i + 1]) {
      port = Number(argv[++i]) || LIMITS.DEFAULT_PORT;
    } else if ((arg === "--dir" || arg === "-d") && argv[i + 1]) {
      dir = path.resolve(argv[++i]);
    } else if (arg === "--token" && argv[i + 1]) {
      token = argv[++i];
    } else if (arg === "--verify" && argv[i + 1]) {
      verifyCmd = argv[++i];
    } else if (arg === "--rotate-token") {
      rotateToken = true;
    } else if (arg === "--allow-env-read") {
      allowEnvRead = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { port, dir, token, verifyCmd, rotateToken, allowEnvRead, help };
}

export function loadOrCreatePersistentToken(
  rotate: boolean,
  configDir = path.join(os.homedir(), ".repobridge")
): { token: string; source: string } {
  const tokenFile = path.join(configDir, "token");

  if (!rotate && fs.existsSync(tokenFile)) {
    const saved = fs.readFileSync(tokenFile, "utf8").trim();
    if (saved.length >= 16) {
      return { token: saved, source: tokenFile };
    }
  }

  const fresh = crypto.randomBytes(16).toString("hex");
  try {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenFile, fresh + "\n", { encoding: "utf8", mode: 0o600 });
    return { token: fresh, source: tokenFile };
  } catch {
    return { token: fresh, source: "ephemeral" };
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isDirectRun) {
  const version = getDaemonVersion();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`
RepoBridge Daemon v${version}

Usage:
  repobridge [options]

Options:
  -p, --port <number>   Port to bind on 127.0.0.1 (default: ${LIMITS.DEFAULT_PORT})
  -d, --dir <path>      Target repository directory (default: cwd)
  --verify <cmd>        Auto-run verification command after any write batch
  --token <string>      Use an explicit bearer token
  --rotate-token        Generate and save a new persistent token
  --allow-env-read      Allow read_file/grep_search on .env files (blocked by default)
  -h, --help            Show this help message

Config file:
  Place ${REPO_CONFIG_FILENAME} in your repo root to configure verifyCmd,
  allowedCommands, ignoreGlobs, maxReadLines, maxFileChars, and maxBatchChars.
`);
    process.exit(0);
  }

  const { config, configPath } = loadRepoConfig(args.dir, {
    verifyCmd: args.verifyCmd,
    allowEnvRead: args.allowEnvRead || undefined
  });

  if (config.allowEnvRead) {
    process.env.REPOBRIDGE_ALLOW_ENV_READ = "1";
    process.env.BRIDGE_ALLOW_ENV_READ = "1";
  }

  const resolvedToken = args.token
    ? { token: args.token, source: "--token flag" }
    : process.env.REPOBRIDGE_TOKEN
      ? { token: process.env.REPOBRIDGE_TOKEN, source: "REPOBRIDGE_TOKEN env" }
      : process.env.BRIDGE_TOKEN
        ? { token: process.env.BRIDGE_TOKEN, source: "BRIDGE_TOKEN env" }
        : loadOrCreatePersistentToken(args.rotateToken);

  const git = new GitShadowEngine(args.dir);

  const server = startBridgeServer({
    port: args.port,
    repoRoot: args.dir,
    token: resolvedToken.token,
    config
  });

  server.on("listening", () => {
    console.log("");
    console.log("============================================================");
    console.log(`  REPOBRIDGE DAEMON v${version} - READY`);
    console.log("============================================================");
    console.log(`  Endpoint : http://127.0.0.1:${args.port}`);
    console.log(`  Repo     : ${args.dir}`);
    console.log(
      `  Git      : ${git.isGitRepo() ? git.getBranch() : "NOT A GIT REPO (Undo disabled)"}`
    );
    console.log(`  Config   : ${configPath ?? `defaults (${REPO_CONFIG_FILENAME} not found)`}`);
    console.log(`  Verify   : ${config.verifyCmd ?? "disabled (pass --verify or set verifyCmd)"}`);
    console.log(`  Token    : ${resolvedToken.token} (${resolvedToken.source})`);
    console.log("============================================================");
    console.log("  Token persists across restarts (use --rotate-token to reset).");
    console.log("  Press Ctrl+C to stop.");
    console.log("");
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${args.port} is already in use. Run with: repobridge --port ${args.port + 1}`
      );
    } else {
      console.error("Failed to start daemon:", err.message);
    }
    process.exit(1);
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log("\nShutting down RepoBridge daemon...");
      server.close(() => process.exit(0));
    });
  }
}
