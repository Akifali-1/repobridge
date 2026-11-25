import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitShadowEngine } from "../daemon/dist/gitShadow.js";
import { executeTool } from "../daemon/dist/tools.js";

describe("GitShadowEngine: checkpoints, revert, non-git, git gc durability", () => {
  let gitRoot;
  let nonGitRoot;

  before(() => {
    gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-git-"));
    execFileSync("git", ["init"], { cwd: gitRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: gitRoot,
      stdio: "ignore"
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: gitRoot, stdio: "ignore" });
    fs.writeFileSync(path.join(gitRoot, "tracked.txt"), "v1\n", "utf8");
    fs.writeFileSync(path.join(gitRoot, "untouched.txt"), "keep\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: gitRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: gitRoot, stdio: "ignore" });

    nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-nogit-"));
    fs.writeFileSync(path.join(nonGitRoot, "plain.txt"), "hello\n", "utf8");
  });

  after(() => {
    fs.rmSync(gitRoot, { recursive: true, force: true });
    fs.rmSync(nonGitRoot, { recursive: true, force: true });
  });

  it("handles non-git directories gracefully", () => {
    const shadow = new GitShadowEngine(nonGitRoot);
    assert.equal(shadow.isGitRepo(), false);
    assert.equal(shadow.getBranch(), "no-git");
    assert.equal(shadow.createCheckpoint(["plain.txt"]), null);
    const rev = shadow.revertLastCheckpoint();
    assert.equal(rev.ok, false);
  });

  it("reverts modified tracked files, removes created files/dirs, survives git gc, and handles double revert", async () => {
    const shadow = new GitShadowEngine(gitRoot);
    const cp = shadow.createCheckpoint(["tracked.txt"]);
    assert.ok(cp && cp.commitSha);

    // Durable under refs/repobridge/head and survives git gc --prune=now
    execFileSync("git", ["gc", "--prune=now", "--quiet"], { cwd: gitRoot, stdio: "ignore" });
    const headSha = execFileSync("git", ["rev-parse", "--verify", "refs/repobridge/head"], {
      cwd: gitRoot,
      encoding: "utf8"
    }).trim();
    assert.equal(headSha, cp.commitSha);

    await executeTool(
      gitRoot,
      { tool: "patch_file", path: "tracked.txt", search: "v1", replace: "v2" },
      shadow,
      cp.id
    );
    await executeTool(
      gitRoot,
      { tool: "write_file", path: "newdir/sub/created.txt", content: "temp\n" },
      shadow,
      cp.id
    );

    // Manual edit to untouched file must survive revert
    fs.writeFileSync(path.join(gitRoot, "untouched.txt"), "manual edit\n", "utf8");

    const rev1 = shadow.revertLastCheckpoint();
    assert.equal(rev1.ok, true);
    assert.equal(fs.readFileSync(path.join(gitRoot, "tracked.txt"), "utf8"), "v1\n");
    assert.equal(fs.readFileSync(path.join(gitRoot, "untouched.txt"), "utf8"), "manual edit\n");
    assert.equal(fs.existsSync(path.join(gitRoot, "newdir/sub/created.txt")), false);
    assert.equal(fs.existsSync(path.join(gitRoot, "newdir")), false);

    // Reverting a second time with empty stack returns ok: false
    const rev2 = shadow.revertLastCheckpoint();
    assert.equal(rev2.ok, false);
    assert.match(rev2.message, /No checkpoints/i);
  });
});
