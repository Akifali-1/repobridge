import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const parserSrc = fs.readFileSync(path.resolve(process.cwd(), "extension/parser.js"), "utf8");
const ctx = { window: {} };
vm.runInNewContext(parserSrc, ctx);
const parser = ctx.window.RepoBridgeParser;

const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const tag = (name, attrs = "") => `${LT}${name}${attrs ? " " + attrs : ""}${GT}`;
const close = (name) => `${LT}/${name}${GT}`;
const selfTag = (name, attrs = "") => `${LT}${name}${attrs ? " " + attrs : ""} /${GT}`;
const fenceOpen = (m) => `${LT}${LT}${LT}${m}`;
const fenceClose = (m) => `${m}${GT}${GT}${GT}`;

describe("RepoBridgeParser", () => {
  it("parses '>' inside attributes, single quotes, and HTML entities", () => {
    const t1 = parser.parseTools(selfTag("run_cmd", `cmd="echo hi ${GT} out.txt"`));
    assert.equal(t1.length, 1);
    assert.equal(t1[0].cmd, `echo hi ${GT} out.txt`);

    const t2 = parser.parseTools(
      selfTag("read_file", `path='src/index.ts' ranges='1-20,50-80' force='true'`)
    );
    assert.equal(t2[0].path, "src/index.ts");
    assert.equal(t2[0].ranges, "1-20,50-80");
    assert.equal(t2[0].force, true);

    const t3 = parser.parseTools(selfTag("run_cmd", `cmd="node -e &quot;console.log(1)&quot;"`));
    assert.equal(t3[0].cmd, 'node -e "console.log(1)"');
  });

  it("handles indented closing tags and CRLF line endings", () => {
    const patchXml = [
      `  ${tag("patch_file", `path="src/App.tsx"`)}`,
      `    ${tag("search")}`,
      `const title = "Old";`,
      `    ${close("search")}`,
      `    ${tag("replace")}`,
      `const title = "New";`,
      `    ${close("replace")}`,
      `  ${close("patch_file")}`
    ].join("\r\n");

    const parsed = parser.parseTools(patchXml);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].search, 'const title = "Old";');
    assert.equal(parsed[0].replace, 'const title = "New";');
  });

  it("extracts multiple agent_tools blocks from code elements", () => {
    const open = tag("agent_tools");
    const end = close("agent_tools");
    const mockEl = {
      querySelectorAll: () => [
        { textContent: `${open}\n  ${selfTag("repo_map")}\n${end}` },
        {
          textContent: `${open}\n  ${selfTag("read_file", `path="a.ts" start="1" end="10"`)}\n${end}`
        }
      ],
      textContent: ""
    };
    const payload = parser.extractAgentToolsPayload(mockEl);
    const tools = parser.parseTools(payload);
    assert.equal(tools.length, 2);
    assert.equal(tools[0].tool, "repo_map");
    assert.equal(tools[1].tool, "read_file");
  });

  it("handles literal closing tag text inside FILE and PATCH fences", () => {
    const inner = `const s = "${close("write_file")} ${close("patch_file")}";`;
    const writeXml = [
      tag("write_file", `path="docs/example.ts"`),
      fenceOpen("FILE"),
      inner,
      fenceClose("FILE"),
      close("write_file")
    ].join("\n");
    const w = parser.parseTools(writeXml);
    assert.equal(w.length, 1);
    assert.equal(w[0].content, inner);

    const patchXml = [
      tag("patch_file", `path="docs/example.ts" start="1" end="1"`),
      fenceOpen("PATCH"),
      inner,
      fenceClose("PATCH"),
      close("patch_file")
    ].join("\n");
    const p = parser.parseTools(patchXml);
    assert.equal(p.length, 1);
    assert.equal(p[0].replace, inner);
  });

  it("detects streaming unclosed blocks without false positives on inline prose", () => {
    const open = tag("agent_tools");
    const end = close("agent_tools");
    assert.equal(
      parser.hasUnclosedAgentBlock({
        querySelectorAll: () => [],
        textContent: `Mentions ${open} inline.`
      }),
      false
    );
    assert.equal(
      parser.hasUnclosedAgentBlock({
        querySelectorAll: () => [{ textContent: `${open}\n  ${selfTag("repo_map")}\n` }],
        textContent: ""
      }),
      true
    );
    assert.equal(
      parser.hasUnclosedAgentBlock({
        querySelectorAll: () => [{ textContent: `${open}\n  ${selfTag("repo_map")}\n${end}` }],
        textContent: ""
      }),
      false
    );
  });
});
