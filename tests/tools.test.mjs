import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitShadowEngine } from "../daemon/dist/gitShadow.js";
import { executeTool, formatToolResultsBlock } from "../daemon/dist/tools.js";

describe("Functional tools: patch_file, write_file, result truncation", () => {
  let tmpRoot;
  let shadow;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-tools-"));
    fs.writeFileSync(
      path.join(tmpRoot, "sample.ts"),
      "function run() {\n    const a = 1;\n    const b = 2;\n    return a + b;\n}\n",
      "utf8"
    );
    fs.writeFileSync(path.join(tmpRoot, "dup.txt"), "item\nitem\n", "utf8");
    fs.writeFileSync(path.join(tmpRoot, "crlf.txt"), "line1\r\nline2\r\nline3\r\n", "utf8");
    shadow = new GitShadowEngine(tmpRoot);
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("patches exact matches, whitespace-tolerant matches, and rejects ambiguous/missing", async () => {
    // Exact patch
    const exact = await executeTool(
      tmpRoot,
      {
        tool: "patch_file",
        path: "sample.ts",
        search: "    const a = 1;",
        replace: "    const a = 10;"
      },
      shadow,
      null
    );
    assert.equal(exact.ok, true);
    assert.match(fs.readFileSync(path.join(tmpRoot, "sample.ts"), "utf8"), /const a = 10;/);

    // Whitespace-tolerant patch (different indentation in multi-line search)
    const fuzzy = await executeTool(
      tmpRoot,
      {
        tool: "patch_file",
        path: "sample.ts",
        search: "  const a = 10;\n  const b = 2;",
        replace: "  const a = 10;\n  const b = 20;"
      },
      shadow,
      null
    );
    assert.equal(fuzzy.ok, true);
    assert.match(fuzzy.output, /whitespace-tolerant/i);
    assert.match(fs.readFileSync(path.join(tmpRoot, "sample.ts"), "utf8"), / {4}const b = 20;/);

    // Ambiguous match fails
    const ambig = await executeTool(
      tmpRoot,
      { tool: "patch_file", path: "dup.txt", search: "item", replace: "changed" },
      shadow,
      null
    );
    assert.equal(ambig.ok, false);
    assert.match(ambig.output, /matched 2 times/i);

    // Missing match fails
    const missing = await executeTool(
      tmpRoot,
      { tool: "patch_file", path: "sample.ts", search: "nonexistent_line", replace: "x" },
      shadow,
      null
    );
    assert.equal(missing.ok, false);
    assert.match(missing.output, /not found/i);
  });

  it("preserves CRLF line endings on patch_file", async () => {
    const res = await executeTool(
      tmpRoot,
      { tool: "patch_file", path: "crlf.txt", search: "line2", replace: "line2_updated" },
      shadow,
      null
    );
    assert.equal(res.ok, true);
    const updated = fs.readFileSync(path.join(tmpRoot, "crlf.txt"), "utf8");
    assert.equal(updated, "line1\r\nline2_updated\r\nline3\r\n");
  });

  it("enforces write_file is create-only", async () => {
    const created = await executeTool(
      tmpRoot,
      { tool: "write_file", path: "brand-new.txt", content: "hello\n" },
      shadow,
      null
    );
    assert.equal(created.ok, true);

    const overwrite = await executeTool(
      tmpRoot,
      { tool: "write_file", path: "brand-new.txt", content: "overwrite\n" },
      shadow,
      null
    );
    assert.equal(overwrite.ok, false);
    assert.match(overwrite.output, /already exists/i);
  });

  it("truncates oversized formatted tool result blocks cleanly", () => {
    const bigOutput = "A".repeat(20_000);
    const formatted = formatToolResultsBlock(
      [{ tool: "read_file", ok: true, targetPath: "big.ts", output: bigOutput }],
      8_000
    );
    assert.equal(formatted.truncated, true);
    assert.match(formatted.text, /clipped/i);
    assert.ok(formatted.text.length < 10_000);
  });
});
