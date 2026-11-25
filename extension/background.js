// Service worker proxy: routes all localhost HTTP calls out of the page origin
// so Chrome never blocks https://gemini.google.com -> http://127.0.0.1:4040.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;
  if (message.type === "BRIDGE_PING") {
    sendResponse({ ok: true });
    return;
  }
  if (message.type !== "BRIDGE_REQUEST") return;

  const { url, method = "GET", token = "", body, timeoutMs = 135_000 } = message;

  // Enforce localhost-only targets for defense-in-depth
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    sendResponse({ ok: false, status: 0, error: "Invalid bridge URL." });
    return;
  }
  if (parsedUrl.hostname !== "127.0.0.1" && parsedUrl.hostname !== "localhost") {
    sendResponse({ ok: false, status: 0, error: "Blocked non-localhost bridge target." });
    return;
  }

  (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        Authorization: `Bearer ${token}`
      };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      const text = await res.text();
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      sendResponse({ ok: res.ok, status: res.status, data });
    } catch (err) {
      const isAbort = err && err.name === "AbortError";
      sendResponse({
        ok: false,
        status: 0,
        error: isAbort
          ? `Bridge request timed out after ${Math.round(timeoutMs / 1000)}s.`
          : err instanceof Error
            ? err.message
            : String(err)
      });
    } finally {
      clearTimeout(timer);
    }
  })();

  return true; // keep channel open for async response
});
