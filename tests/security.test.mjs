import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCommandAllowlisted } from "../daemon/dist/config.js";
import { GitShadowEngine } from "../daemon/dist/gitShadow.js";
import { loadOrCreatePersistentToken } from "../daemon/dist/index.js";
import { assertSafeCommand, resolveSafePath } from "../daemon/dist/security.js";
import { executeTool } from "../daemon/dist/tools.js";

describe("Security: path traversal, symlinks, .git, .env, command blocklist, token file", () => {
  let tmpRoot;
  let outsideDir;
  let outsideFile;
  let symlinkSupported = true;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-sec-repo-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-sec-out-"));
    outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "OUTSIDE_SECRET\n", "utf8");
    fs.mkdirSync(path.join(tmpRoot, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, ".git", "config"), "[core]\n", "utf8");
    fs.writeFileSync(path.join(tmpRoot, ".env"), "API_SECRET=top_secret_value\n", "utf8");
    fs.writeFileSync(path.join(tmpRoot, ".env.local"), "LOCAL_SECRET=local_val\n", "utf8");
    fs.writeFileSync(path.join(tmpRoot, ".env.example"), "API_SECRET=changeme\n", "utf8");
    fs.writeFileSync(path.join(tmpRoot, "ok.txt"), "hello\n", "utf8");

    try {
      fs.symlinkSync(outsideFile, path.join(tmpRoot, "escape-existing.txt"));
      fs.symlinkSync(
        path.join(outsideDir, "dangling-target.txt"),
        path.join(tmpRoot, "escape-dangling.txt")
      );
      fs.symlinkSync(outsideDir, path.join(tmpRoot, "escape-dir"), "junction");
    } catch {
      symlinkSupported = false;
    }
  });

  after(() => {
    delete process.env.REPOBRIDGE_ALLOW_ENV_READ;
    delete process.env.BRIDGE_ALLOW_ENV_READ;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("blocks path traversal (../, absolute paths, mixed separators)", () => {
    assert.throws(() => resolveSafePath(tmpRoot, "../outside.txt", false), /escapes/i);
    assert.throws(() => resolveSafePath(tmpRoot, "sub/../../outside.txt", false), /escapes/i);
    assert.throws(() => resolveSafePath(tmpRoot, "sub\\..\\..\\outside.txt", false), /escapes/i);
    assert.throws(() => resolveSafePath(tmpRoot, outsideFile, false), /escapes/i);
    assert.throws(() => resolveSafePath(tmpRoot, path.resolve("/etc/passwd"), false), /escapes/i);
  });

  it("blocks existing and dangling symlink escapes", (t) => {
    if (!symlinkSupported) {
      t.skip("Symlink creation requires elevated privileges on this Windows host");
      return;
    }
    assert.throws(() => resolveSafePath(tmpRoot, "escape-existing.txt", false), /symlink escapes/i);
    assert.throws(() => resolveSafePath(tmpRoot, "escape-dangling.txt", true), /symlink escapes/i);
    assert.throws(() => resolveSafePath(tmpRoot, "escape-dir/new.txt", true), /symlink escapes/i);
  });

  it("blocks reads and writes inside .git", () => {
    assert.throws(() => resolveSafePath(tmpRoot, ".git/config", false), /protected path/i);
    assert.throws(() => resolveSafePath(tmpRoot, ".git/hooks/pre-commit", true), /protected path/i);
    assert.throws(() => resolveSafePath(tmpRoot, ".git /config", false), /protected path/i);
  });

  it("blocks .env read and write by default, allows read with override flag, never allows write", async () => {
    delete process.env.REPOBRIDGE_ALLOW_ENV_READ;
    delete process.env.BRIDGE_ALLOW_ENV_READ;

    assert.throws(() => resolveSafePath(tmpRoot, ".env", false), /secret file/i);
    assert.throws(() => resolveSafePath(tmpRoot, ".env.local", false), /secret file/i);
    assert.throws(() => resolveSafePath(tmpRoot, ".env ", false), /secret file/i);
    assert.throws(() => resolveSafePath(tmpRoot, ".env", true), /blocked for safety/i);
    assert.ok(resolveSafePath(tmpRoot, ".env.example", false).endsWith(".env.example"));

    // grep_search must never return .env content by default
    const shadow = new GitShadowEngine(tmpRoot);
    const grepRes = await executeTool(
      tmpRoot,
      { tool: "grep_search", query: "top_secret_value" },
      shadow,
      null
    );
    assert.equal(grepRes.ok, true);
    assert.match(grepRes.output, /No matches found/);

    // Override flag allows reading .env, still blocks writing
    process.env.REPOBRIDGE_ALLOW_ENV_READ = "1";
    assert.ok(resolveSafePath(tmpRoot, ".env", false).endsWith(".env"));
    assert.throws(() => resolveSafePath(tmpRoot, ".env", true), /blocked for safety/i);
    delete process.env.REPOBRIDGE_ALLOW_ENV_READ;
  });

  it("blocks every destructive command pattern and bypass variants while allowing normal commands", () => {
    const blocked = [
      "rm -rf ./src",
      "rm -fr ./src",
      "rm -r -f ./src",
      "rm --recursive --force ./src",
      "del /s /q dist",
      "del /f file.txt",
      "rd /s /q build",
      "rmdir /s /q build",
      "format c:",
      "find . -name '*.js' -delete",
      "git reset --hard HEAD~1",
      "git checkout .",
      "git checkout -- .",
      "git restore .",
      "git restore --worktree -- .",
      "git push origin main --force",
      "git push -f origin main",
      "git clean -fd",
      "shutdown /s /t 0",
      "Remove-Item -Recurse -Force ./src",
      "python -c \"import shutil; shutil.rmtree('src')\"",
      "node -e \"require('fs').rmSync('src', {recursive:true})\""
    ];

    for (const cmd of blocked) {
      assert.throws(
        () => assertSafeCommand(cmd),
        /blocked by safety policy/i,
        `Expected block: ${cmd}`
      );
    }

    const allowed = [
      "npm run build",
      "npm run typecheck",
      "npm test",
      "git status",
      "git diff --stat",
      "node --test"
    ];
    for (const cmd of allowed) {
      assert.doesNotThrow(() => assertSafeCommand(cmd), `Expected allow: ${cmd}`);
    }

    assert.equal(isCommandAllowlisted("npm test", ["npm test"]), true);
    assert.equal(isCommandAllowlisted("npm test && echo pwn", ["npm test"]), false);
    assert.equal(isCommandAllowlisted("npm test; echo pwn", ["npm test"]), false);
    assert.equal(isCommandAllowlisted("npm test | cat", ["npm test"]), false);
  });

  it("creates persistent token file with mode 0600 on POSIX and reuses it", () => {
    const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-tok-"));
    try {
      const first = loadOrCreatePersistentToken(false, tokenDir);
      assert.equal(first.token.length, 32);
      const tokenPath = path.join(tokenDir, "token");
      assert.equal(fs.existsSync(tokenPath), true);
      if (process.platform !== "win32") {
        const mode = fs.statSync(tokenPath).mode & 0o777;
        assert.equal(mode, 0o600);
      }
      const second = loadOrCreatePersistentToken(false, tokenDir);
      assert.equal(second.token, first.token);

      const rotated = loadOrCreatePersistentToken(true, tokenDir);
      assert.notEqual(rotated.token, first.token);
    } finally {
      fs.rmSync(tokenDir, { recursive: true, force: true });
    }
  });
});
