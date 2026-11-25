import http from "node:http";
import path from "node:path";
import type { BridgeConfig } from "./config.js";
import { DEFAULT_CONFIG, LIMITS, loadRepoConfig } from "./config.js";
import { GitShadowEngine } from "./gitShadow.js";
import {
  buildRepoMap,
  buildSessionStarter,
  executeTool,
  FileReadCache,
  formatToolResultsBlock,
  hashError,
  previewToolBatch,
  runShellCmd
} from "./tools.js";
import type { ExecuteRequest, ExecuteResponse, ToolExecutionResult } from "./types.js";
import { getDaemonVersion } from "./version.js";

const CHECKPOINT_TOOLS = new Set(["patch_file", "write_file"]);
const MAX_BODY_BYTES = LIMITS.MAX_BODY_BYTES;
export interface BridgeServerOptions {
  port: number;
  repoRoot: string;
  token: string;
  config?: BridgeConfig;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        req.pause();
        reject(new HttpError(413, "Payload exceeds 10MB limit."));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
      } catch {
        reject(new HttpError(400, "Invalid JSON body."));
      }
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

export function startBridgeServer(options: BridgeServerOptions): http.Server {
  const { port, repoRoot, token } = options;
  const resolved = options.config
    ? { config: options.config, configPath: null }
    : loadRepoConfig(repoRoot);
  const config: BridgeConfig = resolved.config ?? DEFAULT_CONFIG;
  const gitShadow = new GitShadowEngine(repoRoot);
  const readCache = new FileReadCache();
  const repoName = path.basename(repoRoot);

  let lastErrorSignature: string | null = null;
  let isExecuting = false;
  let serverTurn = 0;

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin ?? "";
    if (origin.startsWith("chrome-extension://")) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    if (authHeader !== `Bearer ${token}`) {
      sendJson(res, 401, { ok: false, error: "Unauthorized: invalid bridge token." });
      return;
    }

    try {
      let url: URL;
      try {
        url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      } catch {
        sendJson(res, 400, { ok: false, error: "Malformed request URL." });
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          version: getDaemonVersion(),
          port,
          repoName,
          repoRoot,
          isGitRepo: gitShadow.isGitRepo(),
          branch: gitShadow.getBranch(),
          checkpoints: gitShadow.listCheckpoints().length,
          busy: isExecuting,
          verifyCmd: config.verifyCmd,
          allowedCommands: config.allowedCommands,
          maxReadLines: config.maxReadLines
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/repo-map") {
        const withSymbols = url.searchParams.get("symbols") === "1";
        sendJson(res, 200, {
          ok: true,
          repoName,
          map: buildRepoMap(repoRoot, { symbols: withSymbols, ignoreGlobs: config.ignoreGlobs })
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/session-starter") {
        readCache.clear();
        serverTurn = 0;
        sendJson(res, 200, {
          ok: true,
          repoName,
          prompt: buildSessionStarter(repoRoot, gitShadow, config)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/preview") {
        const body = await readJsonBody<ExecuteRequest>(req);
        const tools = Array.isArray(body.tools) ? body.tools : [];
        sendJson(res, 200, {
          ok: true,
          diff: previewToolBatch(repoRoot, tools)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/revert") {
        if (isExecuting) {
          sendJson(res, 409, {
            ok: false,
            error: "Cannot revert while a tool batch is running. Wait for completion."
          });
          return;
        }
        isExecuting = true;
        try {
          const result = gitShadow.revertLastCheckpoint();
          readCache.clear();
          lastErrorSignature = null;
          sendJson(res, result.ok ? 200 : 400, result);
        } finally {
          isExecuting = false;
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/execute") {
        if (isExecuting) {
          sendJson(res, 409, {
            ok: false,
            error: "Another tool batch is already running on this daemon. Please wait."
          });
          return;
        }

        // Acquire execution lock BEFORE awaiting body to eliminate concurrent race
        isExecuting = true;
        const startedAt = Date.now();
        try {
          const body = await readJsonBody<ExecuteRequest>(req);
          if (!Array.isArray(body.tools) || body.tools.length === 0) {
            sendJson(res, 400, { ok: false, error: "No tools provided." });
            return;
          }

          serverTurn = Number.isFinite(body.turn)
            ? Math.max(serverTurn + 1, Math.floor(body.turn!))
            : serverTurn + 1;

          const writePaths = body.tools
            .filter((t) => CHECKPOINT_TOOLS.has(t.tool))
            .map((t) => t.path)
            .filter((p): p is string => Boolean(p));

          let checkpointId: string | null = null;
          if (writePaths.length > 0 && gitShadow.isGitRepo()) {
            const cp = gitShadow.createCheckpoint(writePaths);
            checkpointId = cp?.id ?? null;
          }

          const ctx = { config, readCache, turn: serverTurn };
          const results: ToolExecutionResult[] = [];
          for (const call of body.tools) {
            const resItem = await executeTool(repoRoot, call, gitShadow, checkpointId, ctx);
            results.push(resItem);
            const tag = resItem.ok ? (resItem.deduped ? "CACHE" : "OK") : "ERR";
            console.log(
              `[${new Date().toLocaleTimeString()}] [${tag}] ${call.tool}${call.path ? ` (${call.path})` : ""}${call.cmd ? ` (${call.cmd})` : ""}`
            );
          }

          // Auto-verify after any batch that succeeded on at least one file write
          let autoVerified = false;
          const hadSuccessfulWrite = results.some((r) => CHECKPOINT_TOOLS.has(r.tool) && r.ok);
          const alreadyRanVerify =
            config.verifyCmd &&
            body.tools.some(
              (t) => t.tool === "run_cmd" && (t.cmd ?? "").trim() === config.verifyCmd!.trim()
            );

          if (config.verifyCmd && hadSuccessfulWrite && !alreadyRanVerify) {
            autoVerified = true;
            const verifyRes = await runShellCmd(repoRoot, config.verifyCmd);
            results.push({
              tool: "auto_verify",
              ok: verifyRes.ok,
              targetPath: config.verifyCmd,
              output: `$ ${config.verifyCmd}\n${verifyRes.output}`,
              errorHash: verifyRes.ok ? undefined : hashError(verifyRes.output)
            });
            console.log(
              `[${new Date().toLocaleTimeString()}] [${verifyRes.ok ? "OK" : "ERR"}] auto_verify (${config.verifyCmd})`
            );
          }

          const errorHashes = results
            .map((r) => r.errorHash)
            .filter((h): h is string => Boolean(h));
          const currentSignature = errorHashes.length > 0 ? errorHashes.join("|") : null;

          let loopWarning: string | null = null;
          if (currentSignature && currentSignature === lastErrorSignature) {
            loopWarning =
              "Identical error repeated twice in a row. Loop paused to protect your quota.";
          }
          lastErrorSignature = currentSignature;

          const formatted = formatToolResultsBlock(results, config.maxBatchChars);
          const responsePayload: ExecuteResponse = {
            ok: results.every((r) => r.ok),
            checkpointId,
            results,
            formattedBlock: formatted.text,
            loopWarning,
            durationMs: Date.now() - startedAt,
            payloadBytes: formatted.bytes,
            truncated: formatted.truncated,
            autoVerified
          };

          sendJson(res, 200, responsePayload);
        } finally {
          isExecuting = false;
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: `Unknown endpoint: ${url.pathname}` });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      sendJson(res, status, {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });

  server.listen(port, "127.0.0.1");
  return server;
}
