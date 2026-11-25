// Isolated semantic selectors for gemini.google.com.
// If the UI changes, only this file needs adjustment.

window.REPOBRIDGE_SELECTORS = {
  promptInput: [
    'rich-textarea div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][role="textbox"]',
    'div.ql-editor[contenteditable="true"]'
  ],
  sendButton: [
    'button[aria-label*="Send message"]',
    'button[aria-label*="Send"]',
    "button.send-button",
    'button[data-test-id="send-button"]'
  ],
  stopButton: [
    'button[aria-label*="Stop generating"]',
    'button[aria-label*="Stop response"]',
    'button[aria-label="Stop"]',
    'button[data-test-id="stop-button"]'
  ],
  modelResponses: [
    "model-response .markdown",
    "model-response message-content",
    "message-content .markdown",
    "model-response"
  ]
};

window.queryFirstVisible = function queryFirstVisible(selectorList) {
  for (const sel of selectorList) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return el;
      }
    }
  }
  return null;
};

window.isElementClickable = function isElementClickable(el) {
  if (!el) return false;
  if (el.disabled) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  return true;
};

window.getLatestModelResponseEl = function getLatestModelResponseEl() {
  for (const sel of window.REPOBRIDGE_SELECTORS.modelResponses) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      return els[els.length - 1];
    }
  }
  return null;
};
