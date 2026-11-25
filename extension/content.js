(function () {
  if (window.__REPOBRIDGE_LOADED__) return;
  window.__REPOBRIDGE_LOADED__ = true;

  const DEFAULT_PORT = 4040;
  const FAST_QUIET_MS = 90;
  const FALLBACK_QUIET_MS = 350;
  const PACING_DELAY_MS = 80;
  const POLL_INTERVAL_MS = 150;
  const SEND_POLL_MS = 60;
  const SEND_TIMEOUT_MS = 2_500;

  const WRITE_TOOLS = new Set(["patch_file", "write_file"]);
  const SHELL_TOOLS = new Set(["run_cmd"]);
  const SHELL_METACHAR_RE = /[;&|`$<>()\r\n]/;
  const AGENT_TAG_LABEL = "<" + "agent_tools>";
  const RESULT_TAG_LABEL = "<" + "tool_results>";

  const processedElHashes = new WeakMap();

  const state = {
    port: DEFAULT_PORT,
    token: "",
    connected: false,
    repoName: "",
    branch: "",
    checkpoints: 0,
    verifyCmd: null,
    allowedCommands: [],
    // "approve" (Manual Writes) | "autofiles" (Auto Files) | "autoall" (Auto All)
    mode: "approve",
    active: false,
    maxTurns: 30,
    turnCount: 0,
    minimized: false,
    pendingTools: null,
    pendingDiffText: "",
    busy: false,
    sending: false,
    busyStartedAt: 0,
    generatingSince: 0,
    sawStopButton: false,
    stopClearedAt: 0,
    lastTimingSummary: "",
    lastResultBlock: "",
    lastMutationTs: Date.now()
  };

  function getBaseUrl() {
    const p = Number(state.port) || DEFAULT_PORT;
    return `http://127.0.0.1:${p}`;
  }

  function simpleHash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function isCommandAllowlisted(cmd) {
    const normalized = (cmd || "").trim().replace(/\s+/g, " ");
    if (!normalized || SHELL_METACHAR_RE.test(normalized)) return false;
    return state.allowedCommands.some((pattern) => {
      const p = (pattern || "").trim().replace(/\s+/g, " ");
      if (!p) return false;
      if (p.endsWith("*")) return normalized.startsWith(p.slice(0, -1));
      return normalized === p;
    });
  }

  function bridgeFetch(path, method = "GET", body, timeoutMs = 135_000) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "BRIDGE_REQUEST",
          url: `${getBaseUrl()}${path}`,
          method,
          token: state.token,
          body,
          timeoutMs
        },
        (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp || { ok: false, error: "No response from background worker" });
          }
        }
      );
    });
  }

  function seedExistingResponses() {
    for (const sel of window.REPOBRIDGE_SELECTORS.modelResponses) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        els.forEach((el) => {
          const text = (el.textContent || "").trim();
          if (text) processedElHashes.set(el, simpleHash(text));
        });
        return;
      }
    }
  }

  function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function clearPromptBox(input) {
    input.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      document.execCommand("delete", false);
    } catch {
      input.textContent = "";
    }
  }

  async function injectAndSendPrompt(text) {
    if (state.sending) return { ok: false, pasteMs: 0 };
    state.sending = true;
    state.lastResultBlock = text;
    renderHud();
    const pasteStart = performance.now();

    try {
      const input = window.queryFirstVisible(window.REPOBRIDGE_SELECTORS.promptInput);
      if (!input) {
        logStatus("Could not find prompt input box. Run Test UI or Copy Last.", true);
        return { ok: false, pasteMs: Math.round(performance.now() - pasteStart) };
      }

      clearPromptBox(input);

      let pasteDispatched = false;
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        input.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
        );
        pasteDispatched = true;
      } catch {
        pasteDispatched = false;
      }

      if (pasteDispatched) {
        await waitMs(65);
      }

      if (!(input.textContent || "").trim()) {
        input.focus();
        let inserted = false;
        try {
          inserted = document.execCommand("insertText", false, text);
        } catch {
          inserted = false;
        }
        if (!inserted && !(input.textContent || "").trim()) {
          input.textContent = text;
          input.dispatchEvent(
            new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
          );
        }
        await waitMs(50);
      }

      if (!(input.textContent || "").trim()) {
        try {
          await navigator.clipboard.writeText(text);
          logStatus(`Prompt box blocked input - copied ${RESULT_TAG_LABEL} to clipboard.`, true);
        } catch {
          logStatus("Prompt injection failed - click Copy Last and paste manually.", true);
        }
        return { ok: false, pasteMs: Math.round(performance.now() - pasteStart) };
      }

      const deadline = Date.now() + SEND_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const sendBtn = window.queryFirstVisible(window.REPOBRIDGE_SELECTORS.sendButton);
        if (sendBtn && window.isElementClickable(sendBtn)) {
          sendBtn.click();
          return { ok: true, pasteMs: Math.round(performance.now() - pasteStart) };
        }
        await waitMs(SEND_POLL_MS);
      }

      logStatus("Send button stayed disabled - press Enter manually.", true);
      return { ok: false, pasteMs: Math.round(performance.now() - pasteStart) };
    } finally {
      state.sending = false;
      renderHud();
    }
  }

  // ---------------- Shadow DOM HUD ----------------
  const host = document.createElement("div");
  host.id = "repobridge-hud";
  host.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:2147483647;";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .panel {
        width: 372px;
        background: #0a0a0a;
        color: #f4f4f5;
        border: 1px solid #262626;
        border-radius: 8px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.65);
        font-size: 12px;
        overflow: hidden;
      }
      .panel.minimized { width: auto; }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 10px;
        border-bottom: 1px solid #262626;
        background: #111111;
        cursor: pointer;
        user-select: none;
      }
      .title { display: flex; align-items: center; gap: 7px; font-weight: 600; letter-spacing: 0.02em; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; }
      .dot.on { background: #22c55e; }
      .dot.busy { background: #f59e0b; }
      .body { padding: 10px; display: flex; flex-direction: column; gap: 7px; }
      .panel.minimized .body { display: none; }
      .row { display: flex; gap: 6px; align-items: center; }
      input {
        flex: 1;
        min-width: 0;
        background: #141414;
        color: #fafafa;
        border: 1px solid #2e2e2e;
        border-radius: 4px;
        padding: 5px 7px;
        font-size: 11px;
        outline: none;
      }
      input.port { flex: 0 0 58px; text-align: center; }
      input:focus { border-color: #71717a; }
      button {
        background: #1c1c1c;
        color: #f4f4f5;
        border: 1px solid #333333;
        border-radius: 4px;
        padding: 5px 7px;
        font-size: 11px;
        cursor: pointer;
        transition: background 0.12s;
        white-space: nowrap;
      }
      button:hover { background: #2a2a2a; }
      button.primary { background: #fafafa; color: #09090b; border-color: #fafafa; font-weight: 600; }
      button.primary:hover { background: #e4e4e7; }
      button.danger { border-color: #7f1d1d; color: #fca5a5; }
      button.active-pill { background: #27272a; border-color: #a1a1aa; color: #fff; }
      button.active-warn { background: #3f1d1d; border-color: #ef4444; color: #fecaca; }
      .meta {
        font-size: 11px;
        color: #a1a1aa;
        border: 1px solid #1f1f1f;
        padding: 6px 8px;
        border-radius: 4px;
        background: #0f0f0f;
        line-height: 1.45;
        white-space: pre-line;
      }
      .timing {
        font-size: 10px;
        color: #71717a;
        padding: 2px 4px;
        display: none;
      }
      .timing.show { display: block; }
      .log {
        font-size: 11px;
        color: #d4d4d8;
        background: #050505;
        border: 1px solid #1f1f1f;
        border-radius: 4px;
        padding: 6px 8px;
        max-height: 96px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .log.err { border-color: #7f1d1d; color: #fca5a5; }
      .pending {
        border: 1px solid #52525b;
        background: #111111;
        border-radius: 4px;
        padding: 8px;
        display: none;
        flex-direction: column;
        gap: 6px;
      }
      .pending.show { display: flex; }
      .diff {
        max-height: 170px;
        overflow: auto;
        background: #050505;
        border: 1px solid #262626;
        padding: 6px;
        font-size: 10px;
        line-height: 1.4;
        white-space: pre;
        color: #d4d4d8;
      }
      .diff-add { color: #4ade80; background: rgba(34, 197, 94, 0.12); display: block; }
      .diff-del { color: #f87171; background: rgba(239, 68, 68, 0.14); display: block; }
      .diff-hdr { color: #38bdf8; font-weight: 600; display: block; }
      .diff-cmd { color: #fbbf24; font-weight: 600; display: block; }
      .diff-ctx { color: #a1a1aa; display: block; }
    </style>
    <div class="panel" id="panel">
      <div class="header" id="toggleMin">
        <div class="title">
          <span class="dot" id="dot"></span>
          <span>REPOBRIDGE</span>
        </div>
        <span id="turnBadge" style="color:#a1a1aa;font-size:11px;">IDLE</span>
      </div>
      <div class="body">
        <div class="row" id="authRow">
          <input id="portInput" class="port" type="text" value="4040" title="Daemon Port" />
          <input id="tokenInput" type="password" placeholder="Paste REPOBRIDGE_TOKEN..." />
          <button class="primary" id="connectBtn">Connect</button>
        </div>

        <div class="meta" id="metaBox">Not connected to 127.0.0.1:4040</div>

        <div class="row">
          <button id="modeApprove" class="active-pill" style="flex:1;" title="Auto-runs reads and allowlisted commands; prompts for file edits and unlisted commands">Manual Writes</button>
          <button id="modeAutoFiles" style="flex:1;" title="Auto-runs reads, allowlisted commands, and file edits; prompts for unlisted commands">Auto Files</button>
          <button id="modeAutoAll" style="flex:1;" title="Auto-runs reads, file edits, and all non-blocked shell commands without prompting">Auto All</button>
        </div>

        <div class="row">
          <button id="armBtn" class="primary" style="flex:1;">Start Watching</button>
          <button id="starterBtn" title="Insert repo map, symbols, git status, scripts, and Node version">Start Ctx</button>
          <button id="runLastBtn" title="Run tools in latest reply">Run Last</button>
          <button id="undoBtn" class="danger" title="Revert last write checkpoint">Undo</button>
        </div>

        <div class="row">
          <button id="resetBtn" style="flex:1;" title="Clear stuck busy/pending lock without reloading tab">Reset Lock</button>
          <button id="copyLastBtn" style="flex:1;" title="Copy last tool results payload">Copy Last</button>
          <button id="selftestBtn" style="flex:1;" title="Verify chat DOM selectors">Test UI</button>
        </div>

        <div class="pending" id="pendingBox">
          <div style="font-weight:600;color:#fafafa;" id="pendingTitle">Pending Approval</div>
          <div class="diff" id="pendingDiff"></div>
          <div class="row">
            <button id="approveBtn" class="primary" style="flex:1;">Approve & Run</button>
            <button id="rejectBtn" class="danger" style="flex:1;">Reject</button>
          </div>
        </div>

        <div class="timing" id="timingBar"></div>
        <div class="log" id="statusLog">Ready. Start repobridge in repo root and click Connect.</div>
      </div>
    </div>
  `;

  const $ = (id) => shadow.getElementById(id);

  [
    "keydown",
    "keyup",
    "keypress",
    "paste",
    "copy",
    "cut",
    "input",
    "beforeinput",
    "mousedown"
  ].forEach((evt) => {
    $("panel").addEventListener(evt, (e) => e.stopPropagation());
  });

  function logStatus(msg, isErr = false) {
    const el = $("statusLog");
    el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    el.classList.toggle("err", isErr);
  }

  function renderColoredDiff(container, diffText) {
    container.textContent = "";
    const lines = (diffText || "").split("\n");
    for (const line of lines) {
      const span = document.createElement("span");
      if (line.startsWith("+") && !line.startsWith("+++")) {
        span.className = "diff-add";
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        span.className = "diff-del";
      } else if (line.startsWith("@@")) {
        span.className = "diff-hdr";
      } else if (line.startsWith("$ ") || line.startsWith("! ")) {
        span.className = "diff-cmd";
      } else {
        span.className = "diff-ctx";
      }
      span.textContent = line;
      container.appendChild(span);
    }
  }

  function formatBadge() {
    if (state.busy && state.busyStartedAt) {
      const secs = Math.max(0, Math.floor((Date.now() - state.busyStartedAt) / 1000));
      return `RUN ${secs}s | ${state.turnCount}/${state.maxTurns}`;
    }
    if (state.sending) return `SENDING | ${state.turnCount}/${state.maxTurns}`;
    if (state.pendingTools) return `APPROVE | ${state.turnCount}/${state.maxTurns}`;
    if (state.active) {
      if (state.generatingSince) {
        const secs = Math.max(0, Math.floor((Date.now() - state.generatingSince) / 1000));
        return secs >= 2
          ? `GEN ${secs}s | ${state.turnCount}/${state.maxTurns}`
          : `ON | ${state.turnCount}/${state.maxTurns}`;
      }
      return `ON | ${state.turnCount}/${state.maxTurns}`;
    }
    return "PAUSED";
  }

  function renderHud() {
    const dot = $("dot");
    dot.classList.toggle("on", state.connected && !state.busy);
    dot.classList.toggle("busy", state.busy || state.sending);

    $("panel").classList.toggle("minimized", state.minimized);
    $("turnBadge").textContent = formatBadge();
    $("armBtn").textContent = state.active ? "Stop Loop" : "Start Watching";
    $("armBtn").className = state.active ? "danger" : "primary";

    $("modeApprove").classList.toggle("active-pill", state.mode === "approve");
    $("modeAutoFiles").classList.toggle("active-pill", state.mode === "autofiles");
    $("modeAutoAll").classList.toggle("active-warn", state.mode === "autoall");

    if (state.connected) {
      const vNote = state.verifyCmd ? `\nAuto-verify: ${state.verifyCmd}` : "";
      $("metaBox").textContent =
        `Repo: ${state.repoName} (:${state.port})\nBranch: ${state.branch} | Checkpoints: ${state.checkpoints}${vNote}`;
    } else {
      $("metaBox").textContent = `Disconnected from ${getBaseUrl()}`;
    }

    const timingEl = $("timingBar");
    if (state.lastTimingSummary) {
      timingEl.textContent = state.lastTimingSummary;
      timingEl.classList.add("show");
    } else {
      timingEl.classList.remove("show");
    }

    if (state.pendingTools) {
      $("pendingBox").classList.add("show");
      renderColoredDiff($("pendingDiff"), state.pendingDiffText);
    } else {
      $("pendingBox").classList.remove("show");
    }
  }

  async function refreshHealth() {
    if (!state.token) {
      state.connected = false;
      renderHud();
      return false;
    }
    const resp = await bridgeFetch("/health", "GET", undefined, 5_000);
    if (resp.ok && resp.data?.ok) {
      state.connected = true;
      state.repoName = resp.data.repoName;
      state.branch = resp.data.branch;
      state.checkpoints = resp.data.checkpoints;
      state.verifyCmd = resp.data.verifyCmd || null;
      state.allowedCommands = Array.isArray(resp.data.allowedCommands)
        ? resp.data.allowedCommands
        : [];
      renderHud();
      return true;
    }
    state.connected = false;
    renderHud();
    logStatus(resp.data?.error || resp.error || "Connection failed.", true);
    return false;
  }

  async function openApprovalPreview(tools, reason) {
    state.pendingTools = tools;
    state.pendingDiffText = "Loading unified diff preview...";
    $("pendingTitle").textContent = `Pending: ${reason}`;
    renderHud();
    logStatus(`Paused: ${reason} (${tools.length} tool call(s)).`);

    const resp = await bridgeFetch("/preview", "POST", { tools }, 8_000);
    if (state.pendingTools !== tools) return;
    if (resp.ok && resp.data?.diff) {
      state.pendingDiffText = resp.data.diff;
    } else {
      state.pendingDiffText = tools
        .map((t) =>
          t.tool === "run_cmd" ? `$ ${t.cmd}` : `${t.tool.toUpperCase()} ${t.path || t.query || ""}`
        )
        .join("\n");
    }
    renderHud();
  }

  async function runToolBatch(tools, detectMs = 0) {
    if (state.busy || state.sending) return;
    state.busy = true;
    state.busyStartedAt = Date.now();
    state.pendingTools = null;
    state.pendingDiffText = "";
    renderHud();
    logStatus(`Executing ${tools.length} tool(s)...`);

    const cmdCount =
      tools.filter((t) => SHELL_TOOLS.has(t.tool)).length +
      (state.verifyCmd && tools.some((t) => WRITE_TOOLS.has(t.tool)) ? 1 : 0);
    const batchTimeoutMs = Math.max(60_000, cmdCount * 125_000 + 30_000);

    let tickCount = 0;
    const keepAlive = setInterval(() => {
      tickCount += 1;
      renderHud();
      if (tickCount % 15 === 0) {
        try {
          chrome.runtime.sendMessage({ type: "BRIDGE_PING" });
        } catch {
          // ignore
        }
      }
    }, 1_000);

    try {
      const nextTurn = state.turnCount + 1;
      const resp = await bridgeFetch("/execute", "POST", { tools, turn: nextTurn }, batchTimeoutMs);
      if (!resp.ok || !resp.data) {
        logStatus(resp.data?.error || resp.error || "Daemon execution failed.", true);
        return;
      }
      state.turnCount = nextTurn;
      state.lastResultBlock = resp.data.formattedBlock || "";
      await refreshHealth();

      if (resp.data.loopWarning) {
        state.active = false;
        logStatus(resp.data.loopWarning, true);
        return;
      }
      if (state.turnCount >= state.maxTurns) {
        state.active = false;
        logStatus(`Reached max turn cap (${state.maxTurns}). Loop paused.`, true);
        return;
      }

      const execMs = resp.data.durationMs || 0;
      const kb = ((resp.data.payloadBytes || state.lastResultBlock.length) / 1024).toFixed(1);
      const flags = [];
      if (resp.data.autoVerified) flags.push("auto-verified");
      if (resp.data.truncated) flags.push("clipped");
      const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";

      await waitMs(PACING_DELAY_MS);
      if (!state.active) return;

      const sendRes = await injectAndSendPrompt(resp.data.formattedBlock);
      state.lastTimingSummary = `Turn ${state.turnCount}: detect ${detectMs}ms | exec ${execMs}ms | send ${sendRes.pasteMs}ms | ${kb} KB`;
      if (sendRes.ok) {
        logStatus(`Sent ${RESULT_TAG_LABEL} (${kb} KB${flagStr}).`);
      }
    } finally {
      clearInterval(keepAlive);
      state.busy = false;
      state.busyStartedAt = 0;
      renderHud();
    }
  }

  let lastObservedEl = null;
  let lastObservedHash = "";

  const responseObserver = new MutationObserver(() => {
    state.lastMutationTs = Date.now();
  });

  function attachObserverTo(el) {
    if (el === lastObservedEl) return;
    responseObserver.disconnect();
    lastObservedEl = el;
    lastObservedHash = "";
    state.lastMutationTs = Date.now();
    if (el) {
      responseObserver.observe(el, { childList: true, subtree: true, characterData: true });
    }
  }

  function checkLatestResponse() {
    if (!state.active || !state.connected || state.busy || state.sending || state.pendingTools)
      return;

    const stopBtn = window.queryFirstVisible(window.REPOBRIDGE_SELECTORS.stopButton);
    if (stopBtn) {
      if (!state.generatingSince) state.generatingSince = Date.now();
      state.sawStopButton = true;
      state.stopClearedAt = 0;
      state.lastMutationTs = Date.now();
      renderHud();
      return;
    }

    if (state.generatingSince) {
      state.generatingSince = 0;
      state.stopClearedAt = Date.now();
      renderHud();
    }

    const latestEl = window.getLatestModelResponseEl();
    if (!latestEl) return;

    attachObserverTo(latestEl);

    const fullText = (latestEl.textContent || "").trim();
    if (!fullText) return;

    const hash = simpleHash(fullText);
    if (hash !== lastObservedHash) {
      lastObservedHash = hash;
      state.lastMutationTs = Date.now();
      return;
    }

    const sendBtn = window.queryFirstVisible(window.REPOBRIDGE_SELECTORS.sendButton);
    const fastReady = state.sawStopButton && Boolean(sendBtn);
    const requiredQuiet = fastReady ? FAST_QUIET_MS : FALLBACK_QUIET_MS;
    if (Date.now() - state.lastMutationTs < requiredQuiet) return;

    if (window.RepoBridgeParser.hasUnclosedAgentBlock(latestEl)) return;

    if (processedElHashes.get(latestEl) === hash) return;

    const payload = window.RepoBridgeParser.extractAgentToolsPayload(latestEl);
    if (!payload) return;

    const tools = window.RepoBridgeParser.parseTools(payload);
    if (tools.length === 0) return;

    const detectMs = state.stopClearedAt
      ? Math.max(0, Date.now() - state.stopClearedAt)
      : requiredQuiet;
    state.sawStopButton = false;
    state.stopClearedAt = 0;
    processedElHashes.set(latestEl, hash);

    if (state.mode !== "autoall") {
      const unapprovedShell = tools.some(
        (t) => SHELL_TOOLS.has(t.tool) && !isCommandAllowlisted(t.cmd)
      );
      const hasEdits = tools.some((t) => WRITE_TOOLS.has(t.tool));

      if (unapprovedShell) {
        openApprovalPreview(tools, "unlisted shell command");
        return;
      }
      if (hasEdits && state.mode === "approve") {
        openApprovalPreview(tools, "file edits");
        return;
      }
    }

    runToolBatch(tools, detectMs);
  }

  setInterval(checkLatestResponse, POLL_INTERVAL_MS);

  function runSelectorSelfTest() {
    const s = window.REPOBRIDGE_SELECTORS;
    const check = (name, list, allowHidden = false) => {
      for (const sel of list) {
        const els = Array.from(document.querySelectorAll(sel));
        if (els.length === 0) continue;
        const vis = els.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (vis.length > 0 || allowHidden) {
          return `${name}: OK (${sel} -> ${vis.length}/${els.length} visible)`;
        }
      }
      return `${name}: MISSING`;
    };

    const report = [
      check("input", s.promptInput),
      check("send", s.sendButton, true),
      check("stop", s.stopButton),
      check("replies", s.modelResponses, true)
    ].join("\n");
    const hasMissing = report.includes("input: MISSING") || report.includes("replies: MISSING");
    logStatus(`Selector Self-Test:\n${report}`, hasMissing);
  }

  $("toggleMin").addEventListener("click", () => {
    state.minimized = !state.minimized;
    renderHud();
  });

  $("connectBtn").addEventListener("click", async () => {
    state.port = Number($("portInput").value.trim()) || DEFAULT_PORT;
    state.token = $("tokenInput").value.trim();
    chrome.storage.local.set({ bridgeToken: state.token, bridgePort: state.port });
    const ok = await refreshHealth();
    if (ok) {
      logStatus(
        `Connected to ${state.repoName} (${state.branch}) on :${state.port}. ${state.allowedCommands.length} safe cmd(s) allowlisted.`
      );
    }
  });

  $("modeApprove").addEventListener("click", () => {
    state.mode = "approve";
    chrome.storage.local.set({ bridgeMode: state.mode });
    renderHud();
  });

  $("modeAutoFiles").addEventListener("click", () => {
    state.mode = "autofiles";
    chrome.storage.local.set({ bridgeMode: state.mode });
    renderHud();
  });

  $("modeAutoAll").addEventListener("click", () => {
    state.mode = "autoall";
    chrome.storage.local.set({ bridgeMode: state.mode });
    logStatus("Auto All enabled: edits and non-blocked shell commands run without prompting.");
    renderHud();
  });

  $("armBtn").addEventListener("click", async () => {
    if (!state.connected) {
      logStatus("Connect to local daemon first.", true);
      return;
    }
    state.active = !state.active;
    if (state.active) {
      state.turnCount = 0;
      state.generatingSince = 0;
      state.sawStopButton = false;
      seedExistingResponses();
      logStatus(`Watching responses for ${AGENT_TAG_LABEL}...`);
    } else {
      state.pendingTools = null;
      state.pendingDiffText = "";
      state.generatingSince = 0;
      logStatus("Loop stopped.");
    }
    renderHud();
  });

  $("starterBtn").addEventListener("click", async () => {
    if (!state.connected) {
      logStatus("Connect to local daemon first.", true);
      return;
    }
    logStatus("Building session starter context...");
    const resp = await bridgeFetch("/session-starter", "GET", undefined, 15_000);
    if (!resp.ok || !resp.data?.prompt) {
      logStatus(resp.data?.error || resp.error || "Failed to load session starter.", true);
      return;
    }
    const input = window.queryFirstVisible(window.REPOBRIDGE_SELECTORS.promptInput);
    if (!input) {
      logStatus("Could not find prompt box. Run Test UI.", true);
      return;
    }
    clearPromptBox(input);
    const dt = new DataTransfer();
    dt.setData("text/plain", resp.data.prompt);
    input.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
    );
    await waitMs(70);
    if (!(input.textContent || "").trim()) {
      document.execCommand("insertText", false, resp.data.prompt);
    }
    const kb = (resp.data.prompt.length / 1024).toFixed(1);
    logStatus(`Inserted Session Starter (${kb} KB). Add your task and hit Send.`);
  });

  $("runLastBtn").addEventListener("click", () => {
    if (!state.connected) {
      logStatus("Connect to local daemon first.", true);
      return;
    }
    const latestEl = window.getLatestModelResponseEl();
    const payload = window.RepoBridgeParser.extractAgentToolsPayload(latestEl);
    const tools = window.RepoBridgeParser.parseTools(payload);
    if (!tools.length) {
      logStatus(`No ${AGENT_TAG_LABEL} found in latest response.`, true);
      return;
    }
    state.active = true;
    runToolBatch(tools, 0);
  });

  $("undoBtn").addEventListener("click", async () => {
    if (!state.connected) return;
    const resp = await bridgeFetch("/revert", "POST", undefined, 15_000);
    await refreshHealth();
    logStatus(resp.data?.message || resp.error || "Revert complete.", !resp.ok);
  });

  $("resetBtn").addEventListener("click", () => {
    state.busy = false;
    state.sending = false;
    state.busyStartedAt = 0;
    state.generatingSince = 0;
    state.sawStopButton = false;
    state.stopClearedAt = 0;
    state.pendingTools = null;
    state.pendingDiffText = "";
    responseObserver.disconnect();
    lastObservedEl = null;
    lastObservedHash = "";
    renderHud();
    logStatus("Cleared locks. Ready (click Run Last to retry latest reply).");
  });

  $("copyLastBtn").addEventListener("click", async () => {
    if (!state.lastResultBlock) {
      logStatus("No cached tool results yet.", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(state.lastResultBlock);
      logStatus(
        `Copied last ${RESULT_TAG_LABEL} (${(state.lastResultBlock.length / 1024).toFixed(1)} KB).`
      );
    } catch {
      logStatus("Clipboard write denied by browser.", true);
    }
  });

  $("selftestBtn").addEventListener("click", runSelectorSelfTest);

  $("approveBtn").addEventListener("click", () => {
    if (state.pendingTools) runToolBatch(state.pendingTools, 0);
  });

  $("rejectBtn").addEventListener("click", () => {
    state.pendingTools = null;
    state.pendingDiffText = "";
    renderHud();
    logStatus("Rejected tool batch. Reply manually in chat.");
  });

  chrome.storage.local.get(["bridgeToken", "bridgePort", "bridgeMode"], async (items) => {
    seedExistingResponses();
    if (items.bridgePort) {
      state.port = Number(items.bridgePort) || DEFAULT_PORT;
      $("portInput").value = String(state.port);
    }
    if (
      items.bridgeMode === "approve" ||
      items.bridgeMode === "autofiles" ||
      items.bridgeMode === "autoall"
    ) {
      state.mode = items.bridgeMode;
    }
    if (items.bridgeToken) {
      state.token = items.bridgeToken;
      $("tokenInput").value = state.token;
      await refreshHealth();
    } else {
      renderHud();
    }
  });
})();
