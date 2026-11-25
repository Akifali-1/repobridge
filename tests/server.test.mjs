import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBridgeServer } from "../daemon/dist/server.js";

describe("HTTP Server: auth, CORS, limits, invalid JSON, concurrency 409", () => {
  const TOKEN = "test_secret_token_1234567890abcdef";
  let tmpRoot;
  let server;
  let baseUrl;

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-srv-"));
    fs.writeFileSync(path.join(tmpRoot, "a.txt"), "alpha\n", "utf8");

    server = startBridgeServer({ port: 0, repoRoot: tmpRoot, token: TOKEN });
    await new Promise((resolve) => server.once("listening", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("enforces missing, wrong, and valid Bearer token", async () => {
    const rMissing = await fetch(`${baseUrl}/health`);
    assert.equal(rMissing.status, 401);

    const rWrong = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: "Bearer wrong_token" }
    });
    assert.equal(rWrong.status, 401);

    const rOk = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    assert.equal(rOk.status, 200);
    const body = await rOk.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, "1.2.0");
  });

  it("sets CORS headers only for chrome-extension origins", async () => {
    const extOrigin = "chrome-extension://abcdefghijklmnop";
    const rExt = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: extOrigin }
    });
    assert.equal(rExt.headers.get("access-control-allow-origin"), extOrigin);

    const rEvil = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "https://evil.example.com" }
    });
    assert.equal(rEvil.headers.get("access-control-allow-origin"), null);
  });

  it("rejects invalid JSON with 400 and oversized payloads with 413", async () => {
    const rBad = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      },
      body: "{not valid json"
    });
    assert.equal(rBad.status, 400);

    const bigPayload = JSON.stringify({ tools: [], pad: "x".repeat(10 * 1024 * 1024 + 1024) });
    const rBig = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      },
      body: bigPayload
    });
    assert.equal(rBig.status, 413);
  });

  it("returns 409 on concurrent /execute and on /revert during /execute", async () => {
    const slowCmd = "node -e \"setTimeout(() => console.log('done'), 600)\"";
    const firstReq = fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ tools: [{ tool: "run_cmd", cmd: slowCmd }] })
    });

    await new Promise((r) => setTimeout(r, 120));

    const [secondExec, duringRevert] = await Promise.all([
      fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tools: [{ tool: "repo_map" }] })
      }),
      fetch(`${baseUrl}/revert`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` }
      })
    ]);

    assert.equal(secondExec.status, 409);
    assert.equal(duringRevert.status, 409);

    const firstRes = await firstReq;
    assert.equal(firstRes.status, 200);
  });

  it("never prints the bearer token to stdout/stderr logs during HTTP handling", async () => {
    const logged = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origErr = console.error;
    console.log = (...args) => logged.push(args.join(" "));
    console.warn = (...args) => logged.push(args.join(" "));
    console.error = (...args) => logged.push(args.join(" "));
    try {
      await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      await fetch(`${baseUrl}/execute`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tools: [{ tool: "repo_map" }] })
      });
      await fetch(`${baseUrl}/health`, {
        headers: { Authorization: "Bearer wrong_token" }
      });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origErr;
    }
    assert.equal(
      logged.some((line) => line.includes(TOKEN)),
      false
    );
  });
});
