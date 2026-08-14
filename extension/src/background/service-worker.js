/**
 * formwork — background service worker.
 *
 * All network access lives here. Content scripts run in the page's origin, so a
 * provider call made from one would be subject to the job board's CSP and would
 * expose the user's API key to the page. The worker has neither problem.
 *
 * These imports are for their side effects: each module attaches itself to
 * globalThis.__formwork. answerbank must load before draft, which depends on it.
 */
import "../lib/prompt.js";
import "../lib/validate.js";
import "../lib/answerbank.js";
import "../lib/draft.js";
import "../lib/providers.js";
import "../lib/storage.js";

const fw = globalThis.__formwork;

/**
 * Map a scraped form to validated fills, and draft any free-text questions.
 *
 * @param {{schema: object, fullOptions: object}} payload
 */
async function plan({ schema, fullOptions }) {
  const [settings, profile, about, bank, documents, credentials] = await Promise.all([
    fw.storage.getSettings(),
    fw.storage.getProfile(),
    fw.storage.getAbout(),
    fw.storage.getBank(),
    fw.storage.getDocuments(),
    fw.storage.getCredentials(),
  ]);

  if (!profile) {
    return { error: "No profile yet — open formwork's options and add one." };
  }

  const provider = fw.providers.resolve(settings);
  const { messages } = fw.prompt.buildMessages(schema, profile);

  let raw = {};
  let mapError = null;
  try {
    raw = fw.providers.parseJSON(await provider.chat(messages, { json: true }));
  } catch (err) {
    // A failed model call is not a failed run: every pinned field is derived
    // from the profile alone, so validation still produces the deterministic
    // half of the form. Report the failure rather than silently degrading.
    mapError = String(err.message || err);
  }

  // Credentials are passed separately from the profile: only the profile is
  // summarised into the prompt, so a password cannot reach a model.
  const result = fw.validate.validate(raw, schema, profile, fullOptions, credentials);

  const staged = await fw.draft.draftAll({
    schema,
    profile,
    about,
    bank,
    complete: (msgs) => provider.chat(msgs, { json: false }),
  });

  return {
    ...result,
    staged,
    mapError,
    documents,
    autoApprove: Boolean(settings.autoApprove),
  };
}

/** Record an approved draft so future forms can reuse or imitate it. */
async function approve({ question, answer, company, role, companySpecific }) {
  const bank = await fw.storage.getBank();
  await fw.storage.setBank(
    fw.answerbank.record(bank, { question, answer, company, role, companySpecific })
  );
  return { ok: true };
}

/**
 * Run the fill in every embedded frame of the caller's tab.
 *
 * Companies overwhelmingly host the posting on their own domain and embed the
 * ATS form in an iframe, so the top document often has no form at all. Using
 * `chrome.scripting` rather than a broadcast message gets a per-frame result
 * *and* the frameId, which is what lets an approved draft be routed back to
 * the frame its question came from.
 */
async function fanout(_payload, sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null) return [];

  // Ensure the content scripts exist in every frame before calling into them.
  //
  // Declarative injection races the page: an embedded ATS iframe often finishes
  // loading *after* the user opens the panel, so `runFrame` is not yet defined
  // there and the form is silently reported as absent. Observed on careers
  // pages that mount the iframe late — the form was plainly there with 40
  // inputs, and formwork said "no form found".
  //
  // Re-injecting is safe: the content script guards on `_initialized`.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["src/content/scrape.js", "src/content/fill.js", "src/content/index.js"],
    });
  } catch {
    // Some frames (about:blank, sandboxed, cross-origin without permission)
    // cannot be injected. The frames that can be still were.
  }

  let injections = [];
  try {
    injections = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: async () => {
        // The top frame is handled by the panel itself; skip it here.
        if (window.top === window) return null;
        if (!window.__formwork?.runFrame) return null;
        return await window.__formwork.runFrame();
      },
    });
  } catch (err) {
    return [{ frameId: -1, summary: { error: String(err.message || err) } }];
  }

  return injections
    .filter((i) => i.result)
    .map((i) => ({ frameId: i.frameId, summary: i.result }));
}

/**
 * Ask every frame to open a closed application form.
 *
 * Called only when no fillable field is visible anywhere in the tab, so the
 * control being pressed opens a form rather than sending one; the content
 * script additionally refuses anything submit-shaped.
 */
async function reveal(_payload, sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null) return { revealed: false };
  try {
    const clicks = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: async () => (window.__formwork?.revealForm ? window.__formwork.revealForm() : false),
    });
    if (!clicks.some((c) => c.result)) return { revealed: false, reason: "no Apply control found" };

    // The opener and the form are usually in DIFFERENT frames: a careers page
    // clicks "Apply", and the ATS iframe below it becomes visible. Success can
    // only be judged across the whole tab, so poll every frame.
    for (let attempt = 0; attempt < 16; attempt++) {
      await new Promise((r) => setTimeout(r, 400));
      const counts = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => (window.__formwork?.visibleFieldCount ? window.__formwork.visibleFieldCount() : 0),
      });
      if (counts.some((c) => c.result > 0)) return { revealed: true };
    }
    return { revealed: false, reason: "the form did not appear" };
  } catch (err) {
    return { revealed: false, error: String(err.message || err) };
  }
}

/** Write an approved draft into the frame whose form it belongs to. */
async function approveInFrame({ frameId, id, text }, sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null) return { ok: false, reason: "no tab" };
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    args: [id, text],
    func: async (fieldId, value) => window.__formwork?.fillApproved(fieldId, value),
  });
  return injection?.result ?? { ok: false, reason: "frame is gone" };
}

/** Re-draft a single question, e.g. after the user edits their notes. */
async function redraft({ question, company, role }) {
  const [settings, profile, about, bank] = await Promise.all([
    fw.storage.getSettings(),
    fw.storage.getProfile(),
    fw.storage.getAbout(),
    fw.storage.getBank(),
  ]);
  const provider = fw.providers.resolve(settings);
  // Only the question is needed to redraft, so the panel does not have to hold
  // (or ship across a frame boundary) the whole scraped schema.
  const [item] = await fw.draft.draftAll({
    schema: {
      company,
      title: role,
      fields: [{ id: "redraft", label: question, type: "textarea", required: true }],
    },
    profile,
    about,
    bank,
    complete: (msgs) => provider.chat(msgs, { json: false }),
  });
  return item;
}

const HANDLERS = { plan, approve, redraft, fanout, approveInFrame, reveal };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;
  handler(message.payload || {}, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err.message || err) }));
  return true; // keep the channel open for the async reply
});

/**
 * Clicking the toolbar icon opens the panel on the current page.
 *
 * This is the path for the common case the declarative matches cannot cover:
 * a company hosting the posting on its own domain with the ATS form embedded.
 * `activeTab` grants access to that tab on click without asking every user for
 * permission over every site, and `allFrames` reaches the embedded form.
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "formwork/toggle" });
  } catch {
    // No content script here yet (a site outside the declarative matches, or a
    // page loaded before the extension). Inject, then open.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["src/content/scrape.js", "src/content/fill.js", "src/content/index.js"],
    });
    await chrome.tabs.sendMessage(tab.id, { type: "formwork/toggle" });
  }
});

/**
 * Open setup the first time, and only the first time.
 *
 * A fresh install has no profile, so the panel's honest report is "nothing to
 * fill from" — which reads as a broken extension rather than an unconfigured
 * one. `setupComplete` is set when the wizard finishes; the check is on the
 * flag rather than on the profile so that someone who deliberately skips every
 * step is not asked again on the next update.
 */
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "install") return;
  const { setupComplete } = await chrome.storage.local.get("setupComplete");
  if (setupComplete) return;
  await chrome.tabs.create({ url: chrome.runtime.getURL("src/options/setup.html") });
});
