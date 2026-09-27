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
import "../lib/history.js";
import "../lib/workday-select.js";
import "../lib/validate.js";
import "../lib/answerbank.js";
import "../lib/humanizer-rules.js";
import "../lib/humanize.js";
import "../lib/draft.js";
import "../lib/providers.js";
import "../lib/storage.js";

const fw = globalThis.__formwork;

/**
 * Map a scraped form to validated fills, and draft any free-text questions.
 *
 * @param {{schema: object, fullOptions: object}} payload
 */
async function plan({ schema, fullOptions }, sender) {
  const job = await getJobContext({}, sender);
  schema = {...schema, ...(job?.description ? {description:job.description} : {}),
    ...(job?.company ? {company:job.company} : {}), ...(job?.title ? {title:job.title} : {})};
  const [{settings, profile, about, contextWarning}, bank, documents, credentials] = await Promise.all([
    fw.storage.getCandidateContext(),
    fw.storage.getBank(),
    fw.storage.getDocuments(),
    fw.storage.getCredentials(),
  ]);

  if (!profile) {
    return { error: "No profile yet — open formwork's options and add one." };
  }

  const provider = fw.providers.resolve(settings);
  // A mapping call cannot improve values already owned by the saved profile.
  // Only take this fast path when validation supplies EVERY non-file field;
  // custom questions and unresolved fields keep the existing model path.
  const direct = fw.validate.validate({}, schema, profile, fullOptions, credentials);
  const fullyMapped = schema.fields.every(field => field.type === 'file' ||
    Object.prototype.hasOwnProperty.call(direct.fills,field.id));
  const map = async () => {
    if(fullyMapped)return {result:direct,mapError:null};
    const {messages}=fw.prompt.buildMessages(schema,profile);
    try {
      const raw=fw.providers.parseJSON(await provider.chat(messages,{json:true}));
      return {result:fw.validate.validate(raw,schema,profile,fullOptions,credentials),mapError:null};
    } catch(error) {
      return {result:direct,mapError:String(error.message||error)};
    }
  };
  // Drafting and mapping consume the same immutable context; neither uses the
  // other's response. Overlap these two requests without changing their prompts,
  // model, validation or draft approval requirements.
  const [{result,mapError},staged]=await Promise.all([
    map(),
    fw.draft.draftAll({schema,profile,about,bank,
      complete:messages=>provider.chat(messages,{json:false})}),
  ]);

  return {
    ...result,
    staged,
    mapError,
    contextWarning,
    documents,
    jobContext:{company:schema.company,title:schema.title},
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
      injectImmediately: true,
      target: { tabId, allFrames: true },
      files: ["/src/content/job-context.js", "/src/content/scrape.js", "/src/content/fill.js", "/src/content/history-rows.js", "/src/content/index.js"],
    });
  } catch {
    // Some frames (about:blank, sandboxed, cross-origin without permission)
    // cannot be injected. The frames that can be still were.
  }

  let injections = [];
  try {
    injections = await chrome.scripting.executeScript({
      injectImmediately: true,
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
 * Inspect every frame, then open exactly one closed application form.
 *
 * Called only when no fillable field is visible anywhere in the tab, so the
 * control being pressed opens a form rather than sending one; the content
 * script additionally refuses anything submit-shaped.
 */
async function reveal(_payload, sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null) return { revealed: false };
  try {
    const inspected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        visible: window.__formwork?.visibleFieldCount?.() || 0,
        opener: Boolean(window.__formwork?.findOpener?.()),
      }),
    });
    if (inspected.some(frame => frame.result?.visible > 0))
      return { revealed: false, reason: "application fields are already visible" };
    const candidates = inspected.filter(frame => frame.result?.opener);
    if (candidates.length !== 1)
      return { revealed: false, reason: candidates.length ? "multiple application frames" : "no unique Apply control found" };
    const clicks = await chrome.scripting.executeScript({
      // A navigation between inspection and execution invalidates the target;
      // never act on the replacement document merely because its frame ID fits.
      target: { tabId, documentIds: [candidates[0].documentId] },
      func: async () => (window.__formwork?.revealForm ? window.__formwork.revealForm() : false),
    });
    if (!clicks.some((c) => c.result)) return { revealed: false, reason: "no Apply control found" };

    // The opener and the form are usually in DIFFERENT frames: a careers page
    // clicks "Apply", and the ATS iframe below it becomes visible. Success can
    // only be judged across the whole tab, so poll every frame. Dayforce can
    // take more than six seconds to mount its manual form after navigation.
    // Wait up to 30 seconds; never redispatch the opener while waiting.
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      // Apply can replace an embedded document after the initial fanout.
      // Initialize only missing workers; never repeat the application opener.
      const workers = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => typeof window.__formwork?.visibleFieldCount === 'function',
      });
      for (const worker of workers.filter(item => !item.result)) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId, documentIds: [worker.documentId] },
            files: ["/src/content/job-context.js", "/src/content/scrape.js", "/src/content/fill.js", "/src/content/history-rows.js", "/src/content/index.js"],
          });
        } catch { /* Unavailable or replaced documents are checked on the next poll. */ }
      }
      const counts = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => ({visible: window.__formwork?.visibleFieldCount?.() || 0,
          blocked: window.__formwork?.applicationBlocker?.() || null}),
      });
      if (counts.some((c) => c.result?.visible > 0)) return { revealed: true };
      const blocked = counts.find(c => c.result?.blocked)?.result.blocked;
      if (blocked) return { revealed: false, blocked };
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
async function redraft({ question, company, role, previous, instruction }, sender) {
  const job = await getJobContext({}, sender);
  const [{settings, profile, about, contextWarning}, bank] = await Promise.all([
    fw.storage.getCandidateContext(),
    fw.storage.getBank(),
  ]);
  const provider = fw.providers.resolve(settings);
  // Only the question is needed to redraft, so the panel does not have to hold
  // (or ship across a frame boundary) the whole scraped schema.
  const [item] = await fw.draft.draftAll({
    schema: {
      company: job?.company || company,
      title: job?.title || role,
      description: job?.description || "",
      fields: [{ id: "redraft", label: question, type: "textarea", required: true }],
    },
    profile,
    about,
    bank,
    complete: (msgs) => provider.chat(msgs, { json: false }),
    revision: previous || instruction ? { previous, instruction } : null,
  });
  return {...item, contextWarning};
}

async function postingRequest(payload, sender, save=false) {
  if (sender?.frameId !== 0 || !sender?.tab?.id) throw new Error("Open the posting in the main browser tab");
  const settings=await fw.storage.getSettings();
  const base=settings.dashboardUrl || settings.homelab?.baseUrl;
  if(!base) throw new Error("Connect the Formwork dashboard in Settings before analyzing or saving postings.");
  const url=new URL(base);
  if(!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Invalid dashboard address");
  const description=String(payload.description || "").slice(0,30000);
  if(!description.trim()) throw new Error("No posting text found. Open the job description first.");
  const body=save ? {url:sender.tab.url,company:String(payload.company || "").slice(0,300),title:String(payload.title || "").slice(0,300),description,source:"extension"}
    : {description,...(Number.isInteger(payload.version_id) ? {version_id:payload.version_id} : {})};
  const response=await fetch(`${base.replace(/\/+$/,"")}/api/${save ? "applications" : "posting-analysis"}`,{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if(!response.ok) throw new Error(`Dashboard returned HTTP ${response.status}. Connect Formwork's dashboard in Settings; its address differs from a standalone AI provider.`);
  return response.json();
}

async function historyRecords() {
  const {profile} = await fw.storage.getCandidateContext();
  if (!profile) return { error: "No saved profile" };
  return Object.fromEntries(["education", "experience", "languages"].map(kind => [kind,
    (profile[kind] || []).map((record, index) => ({ index,
      language: record.language || "", school: record.school || "", degree: record.degree || "",
      employer: record.employer || "", title: record.title || "",
      start: record.start || "", end: record.end || "", current: record.current }))]));
}

async function historyPlan({ schema }) {
  const {profile} = await fw.storage.getCandidateContext();
  if (!profile) return { error: "No saved profile" };
  const fields = (schema?.fields || []).filter(f =>
    ["education", "experience", "languages"].includes(f.history?.kind) && Number.isInteger(f.history?.index));
  return fw.validate.validate({}, { ...schema, fields }, profile);
}

// Only a content-script sender can request automatic display. Detection in an
// embedded application opens the panel in the top document, outside the iframe.
async function applicationDetected(payload, sender) {
  if (!sender.tab?.id || !/^https?:/.test(sender.url || '')) return {shown:false};
  await chrome.scripting.executeScript({target:{tabId:sender.tab.id,allFrames:true},
    files:["/src/content/job-context.js","/src/content/scrape.js","/src/content/fill.js","/src/content/history-rows.js","/src/content/index.js"]});
  return {shown:true};
}

// Keep descriptions scoped to one posting, never just to an employer or tab.
function jobKey(raw) {
  try {
    const url=new URL(raw);
    if(!/^https?:$/.test(url.protocol))return null;
    url.hash="";
    url.pathname=url.pathname.replace(/\/(?:application|apply)(?:\/(?:autofillWithResume|useMyLastApplication|applyManually))?\/?$/i, "").replace(/\/$/, "");
    for(const key of [...url.searchParams.keys()])
      if(!/^(id|gh_jid|job_?id|requisition_?id|jid|jk)$/i.test(key))url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
  }catch{return null;}
}
async function getJobContext(payload, sender) {
  const key=jobKey(sender?.tab?.url);
  if(!key)return {};
  const {jobContexts={}}=await chrome.storage.local.get("jobContexts");
  return jobContexts[key] || {};
}
let contextWrites=Promise.resolve();
function saveJobContext(payload, sender) {
  const operation=contextWrites.then(()=>writeJobContext(payload,sender));
  contextWrites=operation.catch(()=>{});
  return operation;
}
async function writeJobContext(payload, sender) {
  if(sender?.frameId!==0)return {error:"Set the posting context in the main tab"};
  const key=jobKey(sender?.tab?.url);
  if(!key)return {error:"No posting URL"};
  const {jobContexts={}}=await chrome.storage.local.get("jobContexts");
  if(payload.automatic && jobContexts[key]?.manual)return jobContexts[key];
  const next={company:String(payload.company||jobContexts[key]?.company||"").slice(0,300),
    title:String(payload.title||jobContexts[key]?.title||"").slice(0,300),
    description:String(payload.description||"").slice(0,18000),manual:!payload.automatic,updated:Date.now()};
  const entries=Object.entries({...jobContexts,[key]:next}).sort((a,b)=>b[1].updated-a[1].updated).slice(0,30);
  await chrome.storage.local.set({jobContexts:Object.fromEntries(entries)});
  return next;
}

async function workdaySelect(payload,sender) {
  if(!sender.tab || typeof payload.id!=='string' || typeof payload.value!=='string' || payload.value.length>300)return {ok:false,reason:'Invalid Workday request'};
  const results=await chrome.scripting.executeScript({target:{tabId:sender.tab.id,frameIds:[sender.frameId||0]},world:'MAIN',func:fw.workdaySelect,args:[payload.id,payload.value]});
  return results[0]?.result||{ok:false,reason:'Workday page did not respond'};
}

const HANDLERS = { workdaySelect, getJobContext, saveJobContext, applicationDetected, plan, approve, redraft, fanout, approveInFrame, reveal, historyRecords, historyPlan,
  analyzePosting:(payload,sender)=>postingRequest(payload,sender),
  savePosting:(payload,sender)=>postingRequest(payload,sender,true),
  styleReview: async ({text}) => ({tells: fw.humanize.report(String(text || ""))}) };

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
  // A listener left by an older version can still toggle an orphaned panel.
  // Inject the current version first; its singleton guard upgrades old UI.
  const [before] = await chrome.scripting.executeScript({
    target:{tabId:tab.id},func:()=>window.__formwork?._uiVersion || null,
  });
  await chrome.scripting.executeScript({
    target:{tabId:tab.id,allFrames:true},
    files:["/src/content/job-context.js","/src/content/scrape.js","/src/content/fill.js","/src/content/history-rows.js","/src/content/index.js"],
  });
  // A first load or upgrade already opened the panel. Only toggle a panel
  // that was already running this version before the click.
  if (before?.result === chrome.runtime.getManifest().version)
    await chrome.tabs.sendMessage(tab.id,{type:"formwork/toggle-current"},{frameId:0});
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
