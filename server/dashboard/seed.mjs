/**
 * Put a profile into the extension's storage, over the debugging protocol.
 *
 * The Options page and the first-run wizard write exactly these keys. Doing it
 * from here means the profile lives in one place on disk — regenerated from
 * resume.tex by tools/parse_resume.py — rather than being pasted into a
 * textarea again every time a browser profile is rebuilt. The container calls
 * this on every start, which is what makes it work with no setup.
 *
 * Usage: node seed.mjs
 *   FORMWORK_PROFILE_DIR   where profile.json, about.md, credentials.json live
 *   FORMWORK_RESUME_PDF    the résumé to attach (default: the only PDF there)
 *   FORMWORK_MODEL_URL     the provider endpoint the extension should call
 *   FORMWORK_CDP_URL       the browser (default http://localhost:9223)
 */
import { chromium } from "playwright";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const PROFILE_DIR = resolve(
  process.env.FORMWORK_PROFILE_DIR || join(HERE, "..", "..", "profile", "private")
);
const CDP = process.env.FORMWORK_CDP_URL || "http://localhost:9223";
const MODEL_URL =
  process.env.FORMWORK_MODEL_URL || "http://localhost:9105/api/jobfill/complete";

const readIf = (name, fallback = "") => {
  const path = join(PROFILE_DIR, name);
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
};
const jsonIf = (name, fallback) => {
  try {
    return JSON.parse(readIf(name, ""));
  } catch {
    return fallback;
  }
};

const profile = jsonIf("profile.json", null);
if (!profile) {
  console.error(`no profile.json in ${PROFILE_DIR} — nothing to seed`);
  process.exit(0); // Not an error: an empty mount is a valid first run.
}

/** The résumé to attach: named, or the only PDF sitting in the profile. */
function resumeFile() {
  if (process.env.FORMWORK_RESUME_PDF) return resolve(process.env.FORMWORK_RESUME_PDF);
  const pdfs = readdirSync(PROFILE_DIR).filter((f) => f.toLowerCase().endsWith(".pdf"));
  return pdfs.length ? join(PROFILE_DIR, pdfs[0]) : null;
}

const documents = {};
const resume = resumeFile();
if (resume && existsSync(resume)) {
  documents.resume = {
    name: basename(resume),
    type: "application/pdf",
    dataUrl: `data:application/pdf;base64,${readFileSync(resume).toString("base64")}`,
  };
}

// The extension's "homelab" provider is this endpoint minus its path, because
// that provider appends the path itself. Deriving it keeps one address in the
// environment rather than two that can disagree.
const providerBase = MODEL_URL.replace(/\/api\/jobfill\/complete\/?$/, "");

const settings = {
  provider: "homelab",
  autoApprove: false,
  autoFillOnLoad: false,
  homelab: { baseUrl: providerBase },
  ollama: { baseUrl: "http://localhost:11434", model: "qwen3.6:35b-a3b" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "" },
  anthropic: { model: "claude-opus-5", apiKey: "", effort: "low" },
};

const targets = await (await fetch(`${CDP}/json/list`)).json();
const live = targets.find((t) => /^chrome-extension:\/\/[a-p]{32}\/src\//.test(t.url || ""));
if (!live) {
  console.error("formwork is not loaded in that browser — nothing to seed");
  process.exit(1);
}
const extId = new URL(live.url).host;

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];
const page = await context.newPage();
await page.goto(`chrome-extension://${extId}/src/options/options.html`);
const written = await page.evaluate(
  async (payload) => {
    // Environment defaults initialize a new browser. A restart must preserve
    // the model the user selected, including the dashboard connection.
    const existing = await chrome.storage.local.get("settings");
    if (existing.settings?.provider) payload.settings = existing.settings;
    await chrome.storage.local.set(payload);
    const back = await chrome.storage.local.get(["profile", "documents", "settings"]);
    return {
      name: back.profile?.identity?.full_name || "(unnamed)",
      needsInput: back.profile?._needs_input ?? [],
      resume: back.documents?.resume?.name || "(none)",
      provider: back.settings?.homelab?.baseUrl,
    };
  },
  {
    profile,
    about: readIf("about.md"),
    documents,
    settings,
    credentials: jsonIf("credentials.json", { email: "", password: "", username: "" }),
    // The wizard is for someone with nothing; a seeded profile has been set up
    // already, and being asked to set it up again on every container start is
    // the kind of thing that makes a tool feel broken.
    setupComplete: true,
  }
);
await page.close();
await browser.close();

console.log(`seeded ${extId}: ${written.name}, résumé ${written.resume}, model ${written.provider}`);
if (written.needsInput.length) {
  console.log(`  still unanswered: ${written.needsInput.join(", ")}`);
}
