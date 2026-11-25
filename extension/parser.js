// Safe XML-tag & fenced-body extractor for agent_tools blocks.
// Supports both standard XML tags and safe <<<FILE ... FILE>>> / <<<PATCH ... PATCH>>>
// delimiters so files containing literal closing XML tags never break parsing.

window.RepoBridgeParser = (function () {
  const LT = "<";
  const GT = ">";
  const OPEN_TAG = LT + "agent_tools" + GT;
  const CLOSE_TAG = LT + "/agent_tools" + GT;
  const BLOCK_RE = new RegExp("(?:^|\\n)[ \\t]*" + OPEN_TAG + "([\\s\\S]*?)" + CLOSE_TAG, "g");
  const ANY_BLOCK_RE = new RegExp(OPEN_TAG + "([\\s\\S]*?)" + CLOSE_TAG, "g");
  const LINE_OPEN_RE = new RegExp("(?:^|\\n)[ \\t]*" + OPEN_TAG, "g");

  function decodeEntities(val) {
    return val
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function parseAttrs(attrString) {
    const attrs = {};
    const regex = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = regex.exec(attrString)) !== null) {
      const raw = m[2] !== undefined ? m[2] : m[3];
      attrs[m[1]] = decodeEntities(raw);
    }
    return attrs;
  }

  function parseBool(val) {
    return val === "true" || val === "1" || val === "yes";
  }

  function stripSingleOuterNewline(str) {
    return str.replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
  }

  function extractFenced(text, marker) {
    const open = "<<<" + marker;
    const close = marker + ">>>";
    const startIdx = text.indexOf(open);
    if (startIdx === -1) return null;
    const bodyStart = startIdx + open.length;
    const endIdx = text.lastIndexOf(close);
    if (endIdx === -1 || endIdx < bodyStart) return null;
    return stripSingleOuterNewline(text.slice(bodyStart, endIdx));
  }

  function extractFromText(text) {
    if (!text || !text.includes(OPEN_TAG)) return [];
    const strictMatches = [...text.matchAll(BLOCK_RE)].map((m) => m[1]);
    if (strictMatches.length > 0) return strictMatches;
    return [...text.matchAll(ANY_BLOCK_RE)].map((m) => m[1]);
  }

  function extractAgentToolsPayload(responseEl) {
    if (!responseEl) return null;
    const chunks = [];
    const codeBlocks = Array.from(responseEl.querySelectorAll("code"));
    for (const block of codeBlocks) {
      const text = block.textContent || "";
      const found = extractFromText(text);
      for (const item of found) chunks.push(item);
    }
    if (chunks.length > 0) return chunks.join("\n");

    const fullText = responseEl.textContent || "";
    const fallback = extractFromText(fullText);
    return fallback.length > 0 ? fallback.join("\n") : null;
  }

  function findClosingTagIndex(xml, tagName, fromIdx) {
    const closeToken = LT + "/" + tagName + GT;
    let cursor = fromIdx;
    while (cursor < xml.length) {
      const nextClose = xml.indexOf(closeToken, cursor);
      if (nextClose === -1) return -1;

      const fenceMatch = xml.slice(cursor, nextClose).match(/<<<([A-Z0-9_]+)/);
      if (!fenceMatch) {
        return nextClose;
      }
      const marker = fenceMatch[1];
      const fenceOpenPos = cursor + fenceMatch.index + fenceMatch[0].length;
      const fenceCloseToken = marker + ">>>";
      const fenceClosePos = xml.indexOf(fenceCloseToken, fenceOpenPos);
      if (fenceClosePos === -1) {
        return nextClose;
      }
      cursor = fenceClosePos + fenceCloseToken.length;
    }
    return -1;
  }

  function parseTools(innerXml) {
    if (!innerXml) return [];

    const tools = [];
    const openTagRegex =
      /<(repo_map|grep_search|read_file|run_cmd|patch_file|write_file)\b((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>/g;

    let match;
    while ((match = openTagRegex.exec(innerXml)) !== null) {
      const name = match[1];
      const attrs = parseAttrs(match[2] || "");
      const isSelfClosing = match[3] === "/";

      if (name === "repo_map") {
        tools.push({
          tool: "repo_map",
          symbols: parseBool(attrs.symbols) || undefined
        });
        continue;
      }

      if (name === "grep_search") {
        tools.push({
          tool: "grep_search",
          query: attrs.query || "",
          path: attrs.path || undefined,
          regex: parseBool(attrs.regex) || undefined,
          glob: attrs.glob || undefined,
          context: attrs.context ? Number(attrs.context) : undefined
        });
        continue;
      }

      if (name === "read_file") {
        tools.push({
          tool: "read_file",
          path: attrs.path || "",
          start: attrs.start ? Number(attrs.start) : undefined,
          end: attrs.end ? Number(attrs.end) : undefined,
          ranges: attrs.ranges || undefined,
          force: parseBool(attrs.force) || undefined
        });
        continue;
      }

      if (name === "run_cmd") {
        tools.push({
          tool: "run_cmd",
          cmd: attrs.cmd || ""
        });
        continue;
      }

      if (name === "patch_file" || name === "write_file") {
        if (isSelfClosing) continue;
        const bodyStart = openTagRegex.lastIndex;
        const closeIdx = findClosingTagIndex(innerXml, name, bodyStart);
        if (closeIdx === -1) break;

        const body = innerXml.slice(bodyStart, closeIdx);
        openTagRegex.lastIndex = closeIdx + name.length + 3;

        if (name === "patch_file") {
          const start = attrs.start ? Number(attrs.start) : undefined;
          const end = attrs.end ? Number(attrs.end) : undefined;

          if (Number.isFinite(start) && Number.isFinite(end)) {
            const fencedPatch = extractFenced(body, "PATCH") ?? extractFenced(body, "REPLACE");
            let replaceText;
            if (fencedPatch !== null) {
              replaceText = fencedPatch;
            } else {
              const repTag = body.match(/<replace>([\s\S]*?)<\/replace>/);
              replaceText = repTag
                ? stripSingleOuterNewline(repTag[1])
                : stripSingleOuterNewline(body);
            }
            tools.push({
              tool: "patch_file",
              path: attrs.path || "",
              start,
              end,
              replace: replaceText
            });
          } else {
            const fencedSearch = extractFenced(body, "SEARCH");
            const fencedReplace = extractFenced(body, "REPLACE");
            const searchMatch = body.match(/<search>([\s\S]*?)<\/search>/);
            const replaceMatch = body.match(/<replace>([\s\S]*?)<\/replace>/);
            tools.push({
              tool: "patch_file",
              path: attrs.path || "",
              search:
                fencedSearch !== null
                  ? fencedSearch
                  : searchMatch
                    ? stripSingleOuterNewline(searchMatch[1])
                    : "",
              replace:
                fencedReplace !== null
                  ? fencedReplace
                  : replaceMatch
                    ? stripSingleOuterNewline(replaceMatch[1])
                    : ""
            });
          }
        } else if (name === "write_file") {
          const fencedFile = extractFenced(body, "FILE");
          tools.push({
            tool: "write_file",
            path: attrs.path || "",
            content: fencedFile !== null ? fencedFile : stripSingleOuterNewline(body)
          });
        }
      }
    }

    return tools;
  }

  function hasUnclosedBlockInText(text) {
    if (!text || !text.includes(OPEN_TAG)) return false;
    const trimmed = text.trim();
    LINE_OPEN_RE.lastIndex = 0;
    let lastOpenIdx = -1;
    let m;
    while ((m = LINE_OPEN_RE.exec(trimmed)) !== null) {
      lastOpenIdx = m.index;
    }
    if (lastOpenIdx === -1) return false;
    const lastCloseIdx = trimmed.lastIndexOf(CLOSE_TAG);
    return lastCloseIdx < lastOpenIdx;
  }

  function hasUnclosedAgentBlock(responseEl) {
    if (!responseEl) return false;
    const codeBlocks = Array.from(responseEl.querySelectorAll("code"));
    for (let i = codeBlocks.length - 1; i >= 0; i--) {
      const text = codeBlocks[i].textContent || "";
      if (text.includes(OPEN_TAG)) {
        return hasUnclosedBlockInText(text);
      }
    }
    return hasUnclosedBlockInText(responseEl.textContent || "");
  }

  return {
    extractAgentToolsPayload,
    parseTools,
    hasUnclosedAgentBlock
  };
})();
