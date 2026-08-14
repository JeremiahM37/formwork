/**
 * formwork — persistence.
 *
 * Everything lives in chrome.storage.local and never leaves the browser except
 * as part of a model request the user configured. There is no formwork server,
 * no account, and no telemetry.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.__formwork = root.__formwork || {}).storage = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULTS = {
    settings: {
      provider: "homelab",
      autoApprove: false,
      autoFillOnLoad: false,
      homelab: { baseUrl: "http://localhost:9105" },
      ollama: { baseUrl: "http://localhost:11434", model: "qwen3.6:35b-a3b" },
      "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "" },
      anthropic: { model: "claude-opus-5", apiKey: "", effort: "low" },
    },
    profile: null,
    about: "",
    bank: [],
    // Documents are kept as data URLs: chrome.storage cannot hold a File, and
    // the background worker has no document context to rebuild one anyway.
    documents: {},
    // Account-creation details for sites that make you register before
    // applying. Stored apart from the profile so they can never be summarised
    // into a model prompt.
    credentials: { email: "", password: "", username: "" },
  };

  const clone = (v) => JSON.parse(JSON.stringify(v));

  async function get(key) {
    const out = await chrome.storage.local.get(key);
    if (out[key] === undefined) return clone(DEFAULTS[key]);
    // Merge settings so a new option added in an update has its default.
    if (key === "settings") {
      const stored = out.settings;
      const merged = { ...clone(DEFAULTS.settings), ...stored };
      for (const provider of ["homelab", "ollama", "openai-compatible", "anthropic"]) {
        merged[provider] = { ...DEFAULTS.settings[provider], ...(stored[provider] || {}) };
      }
      return merged;
    }
    return out[key];
  }

  const set = (key, value) => chrome.storage.local.set({ [key]: value });

  return {
    DEFAULTS,
    getSettings: () => get("settings"),
    setSettings: (v) => set("settings", v),
    getProfile: () => get("profile"),
    setProfile: (v) => set("profile", v),
    getAbout: () => get("about"),
    setAbout: (v) => set("about", v),
    getBank: () => get("bank"),
    setBank: (v) => set("bank", v),
    getDocuments: () => get("documents"),
    setDocuments: (v) => set("documents", v),
    getCredentials: () => get("credentials"),
    setCredentials: (v) => set("credentials", v),
  };
});
