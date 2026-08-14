/** formwork — settings page. */
(async function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const PROVIDERS = ["homelab", "ollama", "openai-compatible", "anthropic"];
  const FIELDS = {
    homelab: ["baseUrl"],
    ollama: ["baseUrl", "model"],
    "openai-compatible": ["baseUrl", "model", "apiKey"],
    anthropic: ["model", "apiKey"],
  };

  const store = await chrome.storage.local.get([
    "settings",
    "profile",
    "about",
    "bank",
    "documents",
    "credentials",
  ]);
  const settings = store.settings || {
    provider: "homelab",
    autoApprove: false,
    homelab: { baseUrl: "http://localhost:9105" },
    "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "" },
    anthropic: { model: "claude-opus-5", apiKey: "" },
  };

  /* ------------------------------------------------------------------ load */

  $("profile").value = store.profile ? JSON.stringify(store.profile, null, 2) : "";
  $("about").value = store.about || "";
  const creds = store.credentials || {};
  $("cred-email").value = creds.email || "";
  $("cred-username").value = creds.username || "";
  $("cred-password").value = creds.password || "";
  $("provider").value = settings.provider;
  $("autoApprove").checked = Boolean(settings.autoApprove);

  for (const provider of PROVIDERS) {
    for (const field of FIELDS[provider]) {
      const input = $(`${provider}-${field}`);
      if (input) input.value = settings[provider]?.[field] ?? "";
    }
  }

  // The wizard is the friendlier way to edit the same keys; it prefills from
  // whatever is already stored, so it is safe to re-enter at any time.
  $("rerunSetup").addEventListener("click", () => {
    window.location.href = chrome.runtime.getURL("src/options/setup.html");
  });

  function summarizeProfile() {
    try {
      const p = JSON.parse($("profile").value || "null");
      if (!p) return ($("profileSummary").textContent = "No profile yet.");
      const missing = p._needs_input?.length || 0;
      $("profileSummary").textContent =
        `${p.identity?.full_name || "unnamed"} — ${p.experience?.length || 0} roles, ` +
        `${p.projects?.length || 0} projects` +
        (missing ? ` · ${missing} field(s) still need your answer` : "");
    } catch {
      $("profileSummary").textContent = "Not valid JSON yet.";
    }
  }

  function showProvider() {
    for (const node of document.querySelectorAll(".provider")) {
      node.classList.toggle("active", node.dataset.provider === $("provider").value);
    }
  }

  function summarizeBank() {
    const bank = store.bank || [];
    $("bankSummary").textContent = bank.length
      ? `${bank.length} approved answer(s) stored — reused or used as voice samples on future forms.`
      : "Empty. Answers you approve are saved here and reused on similar questions.";
  }

  /* -------------------------------------------------------------- documents */

  const documents = store.documents || {};
  const DOC_INPUTS = { resume: "resumeFile", coverLetter: "coverFile" };

  function summarizeDocs() {
    for (const [key, inputId] of Object.entries(DOC_INPUTS)) {
      const span = document.getElementById(inputId === "resumeFile" ? "resumeCurrent" : "coverCurrent");
      const doc = documents[key];
      span.textContent = doc ? `— stored: ${doc.name}` : "— none stored";
    }
  }

  /** chrome.storage cannot hold a File, so documents are kept as data URLs. */
  const readAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  for (const [key, inputId] of Object.entries(DOC_INPUTS)) {
    $(inputId).addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      // chrome.storage.local caps at ~10MB total; a résumé is far smaller, but
      // a mistaken upload shouldn't silently blow the quota for everything else.
      if (file.size > 4 * 1024 * 1024) {
        $("status").style.color = "#d97070";
        $("status").textContent = `${file.name} is over 4MB — too large to store.`;
        event.target.value = "";
        return;
      }
      documents[key] = { name: file.name, type: file.type, dataUrl: await readAsDataUrl(file) };
      summarizeDocs();
    });
  }

  $("provider").addEventListener("change", showProvider);
  $("profile").addEventListener("input", summarizeProfile);
  showProvider();
  summarizeProfile();
  summarizeBank();
  summarizeDocs();

  /* ------------------------------------------------------------------ save */

  $("save").addEventListener("click", async () => {
    let profile = null;
    const rawProfile = $("profile").value.trim();
    if (rawProfile) {
      try {
        profile = JSON.parse(rawProfile);
      } catch (err) {
        $("status").style.color = "#d97070";
        $("status").textContent = `Profile is not valid JSON: ${err.message}`;
        return;
      }
    }

    const next = {
      provider: $("provider").value,
      autoApprove: $("autoApprove").checked,
    };
    for (const provider of PROVIDERS) {
      next[provider] = {};
      for (const field of FIELDS[provider]) {
        const input = $(`${provider}-${field}`);
        if (input) next[provider][field] = input.value.trim();
      }
    }

    await chrome.storage.local.set({
      settings: next,
      profile,
      about: $("about").value,
      documents,
      credentials: {
        email: $("cred-email").value.trim(),
        username: $("cred-username").value.trim(),
        password: $("cred-password").value,
      },
    });

    // The background worker cannot reach a host the extension has no permission
    // for — fetch fails with a bare "Failed to fetch" and every model-derived
    // field silently goes missing. Ask for it here, where the save click
    // supplies the user gesture Chrome requires.
    const granted = await requestProviderHost(next);

    $("status").style.color = granted ? "#4ea87a" : "#d9a441";
    $("status").textContent = granted
      ? "Saved."
      : "Saved, but access to the model host was declined — only profile-derived fields will fill.";
    setTimeout(() => ($("status").textContent = ""), 6000);
  });

  /** Ensure the selected provider's origin is reachable from the service worker. */
  async function requestProviderHost(settings) {
    const base = settings[settings.provider]?.baseUrl;
    if (!base) return true; // Anthropic's origin ships in the manifest
    let origin;
    try {
      origin = `${new URL(base).origin}/*`;
    } catch {
      return true; // malformed URL — the provider call will report it plainly
    }
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    try {
      return await chrome.permissions.request({ origins: [origin] });
    } catch {
      return false;
    }
  }

  $("clearBank").addEventListener("click", async () => {
    await chrome.storage.local.set({ bank: [] });
    store.bank = [];
    summarizeBank();
  });
})();
