/**
 * formwork dashboard — the browser side.
 *
 * The dashboard is Python; the browser work is here, in one Node process per
 * command, because Playwright's CDP client is the thing that already knows how
 * to talk to the extension. Each command prints one JSON object on stdout.
 *
 * It drives the *user's* browser rather than one of its own. That matters: the
 * whole design assumes a person can watch the fill happen over noVNC, take the
 * keyboard mid-application, and see the same page the dashboard is describing.
 * A headless browser of our own would be easier and would describe a page
 * nobody could look at.
 *
 * Submission lives here and nowhere in extension/. The extension identifies
 * submit controls in order to refuse them, and that invariant is worth keeping
 * exactly as it is — a content script that can submit is one bug away from
 * submitting on its own. The dashboard is a separate program that a person
 * pressed a button in, which is a different thing from a page script deciding.
 *
 * Usage: node drive.mjs <command> [json-arg]
 */
import { markTrustedField, trustedInput, verifyTrustedField, dateParts } from "../../tools/workday-input.mjs";
import { inspectWorkdayStep, enterWorkday, advanceWorkday, isWorkday } from "../../tools/workday-flow.mjs";
import { confirmationOnPage, inspectResume, reviewText } from "./submission.mjs";
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const CDP = process.env.FORMWORK_CDP_URL || "http://localhost:9223";
const PROFILE_DIR = process.env.FORMWORK_CHROME_PROFILE || join(homedir(), ".formwork-chrome");

/* --------------------------------------------------------------- connection */

/**
 * The extension's id.
 *
 * Read from a live target when one exists. An MV3 worker sleeps, though, and a
 * sleeping extension is not an absent one — so the profile's own record of what
 * id the unpacked directory was given is the fallback.
 */
async function extensionId() {
  const targets = await (await fetch(`${CDP}/json/list`)).json();
  const live = targets.find((t) => /^chrome-extension:\/\/[a-p]{32}\/src\//.test(t.url || ""));
  if (live) return new URL(live.url).host;
  const prefs = JSON.parse(readFileSync(`${PROFILE_DIR}/Default/Preferences`, "utf8"));
  for (const [id, value] of Object.entries(prefs.extensions?.settings || {})) {
    if (String(value.path || "").includes("formwork")) return id;
  }
  throw new Error("formwork is not loaded in the browser");
}

async function connect() {
  const browser = await chromium.connectOverCDP(CDP);
  const context = browser.contexts()[0];
  if (!context) throw new Error("browser has no context");
  // A short-lived CDP connection must not auto-dismiss a confirmation dialog
  // owned by the user (including the dashboard's explicit Submit confirmation).
  for (const page of context.pages()) page.on('dialog', () => {});
  context.on('page', page => page.on('dialog', () => {}));
  return { browser, context };
}

/**
 * Whether two addresses are the same posting.
 *
 * Not string equality, and not host equality either: boards.greenhouse.io
 * redirects to job-boards.greenhouse.io, so the tab a posting was opened in
 * reports a different host than the queue holds for it. The path carries the
 * job id and survives that, so it is the stronger signal of the two.
 */
export function sameJob(a, b) {
  try {
    const key = value => {
      const parsed = new URL(value);
      if (!/^https?:$/.test(parsed.protocol)) return null;
      if (/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/i.test(parsed.hostname)) {
        const parts=parsed.pathname.split('/').filter(Boolean);
        const index=parts.indexOf('job');
        const req=index>=1 && parts[index+2]?.match(/_([A-Za-z0-9-]+)$/);
        if(req) return parsed.host.toLowerCase()+'|'+parts[index-1]+'|'+req[1];
      }
      if (/(^|\.)linkedin\.com$/.test(parsed.hostname)) {
        const id = parsed.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/)?.[1] || parsed.searchParams.get('currentJobId');
        if (id && /^\d+$/.test(id)) return 'linkedin:' + id;
      }
      if (/(^|\.)indeed\.com$/.test(parsed.hostname) && parsed.searchParams.get('jk')) return 'indeed:' + parsed.searchParams.get('jk');
      const host = parsed.host.toLowerCase().replace(/^boards\.greenhouse\.io$/, "job-boards.greenhouse.io");
      for (const name of [...parsed.searchParams.keys()]) {
        if (/^(utm_.*|source|ref|referrer|gh_src|lever-source|lever-origin)$/i.test(name)) parsed.searchParams.delete(name);
      }
      parsed.searchParams.sort();
      const path = parsed.pathname.replace(/\/(apply|application)\/?$/i, "").replace(/\/$/, "");
      const hash = /^#(?:\/|!)/.test(parsed.hash) ? parsed.hash : "";
      return host + path + "?" + parsed.searchParams.toString() + hash;
    };
    const first = key(a), second = key(b);
    return first !== null && first === second;
  } catch {
    return false;
  }
}

/** The tab a posting is open in — reused, so the user keeps one window. */
function existingPageFor(context, url) {
  const matches = context.pages().filter(p => sameJob(p.url(), url));
  if (matches.length > 1) throw new Error('This application is open in multiple tabs. Close the duplicate tabs, then retry.');
  return matches[0];
}

async function pageFor(context, url) {
  const existing = existingPageFor(context, url);
  return existing || context.newPage();
}

/**
 * Run something inside the content script's world.
 *
 * Content scripts are isolated from the page, so `page.evaluate` cannot see
 * `window.__formwork` at all — it reads the *page's* window and finds nothing.
 * Going through an extension page gets `chrome.scripting`, which can target
 * that world by name.
 *
 * The injected function's source is spliced into the expression rather than
 * rebuilt with `new Function` on the other side. Extension pages ship a strict
 * `script-src 'self'` and `new Function` is exactly what it forbids; a
 * function *literal* inside the evaluated expression is ordinary code and is
 * not. (The evaluation itself arrives over the DevTools protocol, which is not
 * subject to the page's policy — only what it goes on to construct is.)
 */
async function inContentScript(context, extId, tabUrl, fn, arg) {
  const helper = await context.newPage();
  try {
    await helper.goto(`chrome-extension://${extId}/src/options/options.html`);
    const expression = `(async () => {
      const tabUrl = ${JSON.stringify(tabUrl)};
      const arg = ${JSON.stringify(arg ?? null)};
      const same = ${sameJob.toString()};
      const tabs = await chrome.tabs.query({});
      const matches = tabs.filter((t) => same(t.url || "", tabUrl));
      if (matches.length > 1) throw new Error("This application is open in multiple tabs. Close the duplicate tabs, then retry.");
      const tab = matches[0];
      if (!tab) throw new Error("that posting is not open in the browser");
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "ISOLATED",
        func: ${fn.toString()},
        args: [arg],
      });
      return injection.result;
    })()`;
    return await helper.evaluate(expression);
  } finally {
    await helper.close().catch(() => {});
  }
}

/* -------------------------------------------------------------- the reading */

/**
 * What is on the page, as the panel understands it.
 *
 * Read from the content script rather than from the DOM directly so that the
 * dashboard and the panel can never disagree: both are describing the same
 * `_last`, and the values are re-read from the live controls, so a widget that
 * silently reverted shows as empty here too.
 */
export function collect() {
  const ns = window.__formwork;
  if (!ns) return { ready: false };
  const last = ns._last;
  if (!last) return { ready: true, filled: false };

  const { scraped, result } = last;
  const registry = scraped.registry || [];
  const reviewById = {};
  for (const item of result.review || []) {
    (reviewById[item.id] = reviewById[item.id] || []).push(item.reason);
  }

  for(const failure of last.report?.failed || []) {
    const id=failure.id || failure;
    (reviewById[id]=reviewById[id] || []).push(failure.reason || 'The browser did not retain this answer');
  }
  const fields = (scraped.schema.fields || []).map((field, index) => {
    const els = registry[index] || [];
    const el = els[0];
    let value = "";
    if (el) {
      if (el.type === "radio" || el.type === "checkbox") {
        // A radio's `value` is "on" whether or not it is the one chosen, so
        // reading it reported every EEO question as answered "on" — a form
        // that correctly said "Decline to self-identify" was displayed as
        // "Male". This screen is what a person reads before pressing Submit;
        // it has to say what the form says. The chosen option's label is the
        // answer, read across the whole group rather than off its first member.
        value = els
          .filter((member) => member.checked)
          .map((member) => ns.labelFor(member) || member.value)
          .join(", ");
      } else if (field.type === "date" && els.length>1) {
        value=els.map((member,i)=>`${member.getAttribute('aria-label') || field.parts?.[i] || 'Part '+(i+1)}: ${member.value || ''}`).join(' · ');
        if(els.every(member=>!member.value)) value='';
      } else if (el.type === "file") {
        value = el.files && el.files.length ? el.files[0].name : "";
      } else if (field.type === "combobox") {
        value = ns.readComboboxValue(el) || "";
      } else {
        value = el.value || "";
      }
    }
    return {
      id: field.id,
      label: field.label || "",
      section: field.section || "",
      type: field.type,
      required: Boolean(field.required),
      options: (field.options || []).slice(0, 60),
      optionsPartial: Boolean(field.optionsTruncated || field.optionsPartial),
      planned: result.fills?.[field.id] ?? null,
      value: String(value || ""),
      review: reviewById[field.id] || [],
    };
  });

  return {
    ready: true,
    filled: true,
    actions: last.report?.receipts || [],
    company: scraped.schema.company || "",
    title: scraped.schema.title || "",
    fields,
    staged: (result.staged || []).map((s) => ({
      id: s.id,
      question: s.question,
      text: s.text,
      tells: s.tells || [],
      note: s.note || "",
      needsApproval: s.needsApproval !== false,
    })),
    dropped: result.dropped || [],
    mapError: result.mapError || null,
  };
}

/* ------------------------------------------------------------------ commands */

async function status() {
  const { browser, context } = await connect();
  try {
    const extId = await extensionId().catch(() => null);
    return {
      connected: true,
      extension: extId,
      tabs: context.pages().map((p) => p.url()).filter((u) => /^https?:/.test(u)),
    };
  } finally {
    await browser.close();
  }
}

/**
 * Open a posting and fill it.
 *
 * The panel's own button is pressed rather than the internals being called,
 * so what the dashboard reports is the result of the same code path a person
 * clicking would get. Completion is polled for rather than waited out: a form
 * with a virtualised school list takes minutes, and one with six fields takes
 * seconds.
 */
async function fill({ url, timeoutMs = 420000, resume=false, advance=false, fingerprint, expectedResume }) {
  const { browser, context } = await connect();
  try {
    const extId = await extensionId();
    const existing=existingPageFor(context,url);
    if(resume && !existing) throw new Error('The application tab is no longer open. Open it in Browser and retry.');
    const page=existing || await context.newPage();
    await page.bringToFront();
    if(!resume && !(isWorkday(url) && existing && /\/apply(?:\/|$)/.test(new URL(page.url()).pathname))) {
      await page.goto(url, {waitUntil:'domcontentloaded',timeout:90000});
      await page.waitForTimeout(6000);
    }
    let flow=null, advanced=false, previousStep=null;
    if(isWorkday(page.url())) {
      flow=await enterWorkday(page);
      if(advance) {
        previousStep={...await inContentScript(context,extId,page.url(),collect),flow};
        if(previousStep.staged?.length) throw new Error('Approve or remove the drafted answers before continuing.');
        const moved=await advanceWorkday(page,fingerprint); flow=moved.flow;advanced=moved.advanced;
        if(!advanced) {
          const report=await inContentScript(context,extId,page.url(),collect);
          return {...report,flow,advanced:false,url:page.url()};
        }
      }
      if(flow.kind!=='next') return {ready:false,filled:false,fields:[],staged:[],flow,advanced,previousStep,reviewText:flow.kind==='review'?(await page.locator('body').innerText()).slice(0,30000):'',url:page.url()};
    } else if(advance || resume) throw new Error('Step continuation is currently supported only for Workday.');

    const button = page.getByRole("button", { name: /fill this form/i });
    try {
      await button.waitFor({ timeout: 20000 });
    } catch {
      // Not one of the applicant tracking systems the manifest names. Invoke
      // the extension the way its toolbar icon would, then wait again.
      const opened = await openPanel(context, extId, page.url());
      try {
        if (!opened?.ok) throw new Error(opened?.reason || "could not open the panel");
        await button.waitFor({ timeout: 25000 });
      } catch {
      // The panel appears by itself only on the applicant tracking systems the
      // manifest names. Everywhere else the extension waits to be invited —
      // it ships `activeTab` rather than access to every site, so a person
      // clicks its icon. A dashboard has no icon to click.
      const host = new URL(page.url()).host;
      throw new Error(
        `formwork's panel did not appear on ${host}. It opens by itself only on the ` +
          "applicant tracking systems the extension lists; anywhere else it needs the " +
          "browser to have been granted that host. In the container, set " +
          "FORMWORK_ALLOW_ALL_HOSTS=1; in a browser you drive yourself, open the page " +
          "once and click the formwork icon."
      );
      }
    }
    if(flow && !(await inContentScript(context,extId,page.url(),()=>window.__formwork?.visibleFieldCount?.())))
      return {ready:false,filled:false,fields:[],staged:[],flow,advanced,previousStep,url:page.url()};
    await inContentScript(context,extId,page.url(),()=>{if(window.__formwork) window.__formwork._last=null;});
    await button.click();

    const deadline = Date.now() + timeoutMs;
    let report = null;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      report = await inContentScript(context, extId, url, collect).catch(() => null);
      if (report?.filled) break;
    }
    if (!report?.filled) throw new Error("the fill did not finish in time");
    if(!report.fields?.length) throw new Error('No application fields were found. Open the application form in Browser before preparing it.');
    if(flow) {
      const failed=await inContentScript(context,extId,page.url(),()=>window.__formwork?._last?.report?.failed || []);
      const attempts=[];
      for(const failure of failed.slice(0,25)) {
        const field=report.fields.find(field=>field.id===(failure.id || failure));
        if(!field || field.planned==null || !['combobox','radio','checkbox-group','date'].includes(field.type)) continue;
        const target=await inContentScript(context,extId,page.url(),markTrustedField,{id:field.id,token:'wd-'+Date.now()});
        const result=await trustedInput(page,target,field.planned);
        const ok=result.ok && await inContentScript(context,extId,page.url(),verifyTrustedField,{id:field.id,value:field.planned,parts:dateParts(field.planned)});
        attempts.push({id:field.id,label:field.label,ok,reason:ok?'Verified after real input':result.reason || 'The requested value did not remain selected'});
      }
      report={...await inContentScript(context,extId,page.url(),collect),trustedInput:attempts};
      flow=await page.evaluate(inspectWorkdayStep);
      await inContentScript(context,extId,page.url(),value=>{window.__formwork._dashboardStepFingerprint=value;},flow.fingerprint);
    }
    return { ...report, ...(flow ? {flow,advanced,previousStep} : {}), resumeCheck:await inspectResume(page,expectedResume), url: page.url() };
  } finally {
    await browser.close();
  }
}

/**
 * Open the panel on a page the extension does not run on by itself.
 *
 * Declarative content scripts are governed by the manifest's `matches`, not by
 * permissions — so granting a host does not make the panel appear there. What
 * makes it appear is being invoked, which on a normal browser means clicking
 * the toolbar icon. This is that click: inject the content scripts, then send
 * the same toggle the icon sends. It still needs the host to have been granted,
 * which is what the container's FORMWORK_ALLOW_ALL_HOSTS does.
 */
export async function openPanel(context, extId, tabUrl) {
  const helper = await context.newPage();
  try {
    await helper.goto(`chrome-extension://${extId}/src/options/options.html`);
    return await helper.evaluate(`(async () => {
      const tabUrl = ${JSON.stringify(tabUrl)};
      const same = ${sameJob.toString()};
      const tabs = await chrome.tabs.query({});
      const matches = tabs.filter((t) => same(t.url || "", tabUrl));
      if (matches.length > 1) throw new Error("This application is open in multiple tabs. Close the duplicate tabs, then retry.");
      const tab = matches[0];
      if (!tab) return { ok: false, reason: "that posting is not open" };

      // Toggle first. If a content script is already there the panel exists and
      // is merely hidden, and toggling shows it. Only if nothing answers is
      // there something to inject — and injecting mounts the panel on its own,
      // so nothing may be toggled afterwards or it closes again.
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "formwork/toggle-current" }, { frameId: 0 });
        return { ok: true, via: "toggle" };
      } catch {
        /* nothing running there yet */
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ["src/content/job-context.js", "src/content/scrape.js", "src/content/fill.js", "src/content/history-rows.js", "src/content/index.js"],
        });
      } catch (err) {
        return { ok: false, reason: String((err && err.message) || err) };
      }
      return { ok: true, via: "inject" };
    })()`);
  } finally {
    await helper.close().catch(() => {});
  }
}

/**
 * The posting's own words, for drafting against.
 *
 * Taken from the rendered page rather than fetched: most boards render the
 * description client-side, and the browser is already open on it. The form's
 * own text is excluded — a description that ends in forty field labels makes
 * the model tailor a résumé to the words "Preferred First Name".
 */
async function describe({ url }) {
  const { browser, context } = await connect();
  let temporary;
  try {
    let page = await pageFor(context, url);
    if(isWorkday(url) && /\/apply(?:\/|$)/.test(new URL(page.url().startsWith('http')?page.url():url).pathname)) {
      temporary=await context.newPage();page=temporary;
      url=url.replace(/\/apply(?:\/.*)?$/, '');
    }
    if (!page.url().startsWith("http")) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(4000);
    }
    const text = await page.evaluate(() => {
      const form = document.querySelector("form");
      const clone = document.body.cloneNode(true);
      for (const drop of clone.querySelectorAll("form, script, style, nav, footer, #formwork-panel")) {
        drop.remove();
      }
      const body = (clone.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
      return { text: body.slice(0, 12000), hadForm: Boolean(form), title: document.title };
    });
    return { ...text, url: page.url() };
  } finally {
    if(temporary) await temporary.close();
    await browser.close();
  }
}

/** Read the current state without filling — used after an edit or a submit. */
async function read({ url, expectedResume }) {
  const { browser, context } = await connect();
  try {
    const page=existingPageFor(context,url);
    if (!page) return {browserUnavailable:true, reviewText:'', resumeCheck:{status:'unknown',files:[],expected:expectedResume,reason:'Application tab is not open. Open the employer application and re-read it before sending.'}};
    const extId = await extensionId();
    const report={...await inContentScript(context, extId, url, collect), browserUnavailable:false};
    report.resumeCheck = await inspectResume(page, expectedResume);
    report.reviewText = await reviewText(page);
    if(!isWorkday(page.url())) return report;
    const flow=await page.evaluate(inspectWorkdayStep);
    const previous=await inContentScript(context,extId,page.url(),()=>window.__formwork?._dashboardStepFingerprint);
    const needsFill=flow.kind==='next' && previous!==flow.fingerprint;
    return {...report,...(flow.kind!=='next' || needsFill ? {fields:[],staged:[],filled:false} : {}),flow:{...flow,needsFill},url:page.url(),
      reviewText:flow.kind==='review'?(await page.locator('body').innerText()).slice(0,30000):''};
  } finally {
    await browser.close();
  }
}

/**
 * Write a corrected value into one field.
 *
 * Goes through the extension's own filler, not through Playwright's typing: a
 * react-select needs the keyboard commit dance, a date needs all three
 * segments at once, and reimplementing any of that here is how the two halves
 * drift apart.
 */
async function edit({ url, fieldId, value }) {
  const { browser, context } = await connect();
  try {
    const extId = await extensionId();
    return await inContentScript(
      context,
      extId,
      url,
      async ({ fieldId, value }) => {
        const ns = window.__formwork;
        const last = ns?._last;
        if (!last) return { ok: false, reason: "this page has not been filled yet" };
        const { scraped } = last;
        const report = await ns.fill({ [fieldId]: value }, scraped.schema, scraped.registry, {
          keepExisting: true,
          hints: last.result?.hints || {},
        });
        return { ok: (report.filled || []).some((f) => f.id === fieldId), report };
      },
      { fieldId, value }
    );
  } finally {
    await browser.close();
  }
}

/** Put an approved draft on the page, and record it in the answer bank. */
async function approve({ url, fieldId, text, company, role, companySpecific }) {
  const { browser, context } = await connect();
  try {
    const extId = await extensionId();
    const written = await inContentScript(
      context,
      extId,
      url,
      async ({ fieldId, text }) => {
        const ns = window.__formwork;
        const last = ns?._last;
        if (!last) return { ok: false, reason: "this page has not been filled yet" };
        const { scraped } = last;
        const report = await ns.fill({ [fieldId]: text }, scraped.schema, scraped.registry, {
          keepExisting: true,
        });
        return { ok: (report.filled || []).some((f) => f.id === fieldId) };
      },
      { fieldId, text }
    );

    const helper = await context.newPage();
    try {
      await helper.goto(`chrome-extension://${extId}/src/options/options.html`);
      await helper.evaluate(
        (payload) => chrome.runtime.sendMessage({ type: "approve", payload }),
        { question: fieldId, answer: text, company, role, companySpecific }
      );
    } finally {
      await helper.close().catch(() => {});
    }
    return written;
  } finally {
    await browser.close();
  }
}

/**
 * Lend the extension a document for the next fill, and take it back after.
 *
 * The obvious way to attach a tailored résumé is to set the file input after
 * the fill. It does not work: an applicant tracking system that has taken a
 * file replaces the input with a filename and a remove button, so by the time
 * there is something to override there is no input left to override it on.
 * Greenhouse does exactly this, and the tailored PDF was silently never used.
 *
 * So the document is handed to the extension *before* the fill instead, in the
 * same storage slot the user's own résumé lives in, and the extension attaches
 * it the way it already knows how — one attachment path, working on every
 * applicant tracking system rather than on the ones whose markup we guessed.
 * The previous contents are stashed and restored, because that slot is the
 * user's own setting and a crashed run must not eat it.
 */
async function documents({ set, restore }) {
  const { browser, context } = await connect();
  try {
    const extId = await extensionId();
    const helper = await context.newPage();
    try {
      await helper.goto(`chrome-extension://${extId}/src/options/options.html`);
      const payload = {};
      for (const [kind, file] of Object.entries(set || {})) {
        payload[kind] = {
          name: file.name || file.path.split("/").pop(),
          type: "application/pdf",
          dataUrl: `data:application/pdf;base64,${readFileSync(file.path).toString("base64")}`,
        };
      }
      return await helper.evaluate(
        async ({ payload, restore }) => {
          const store = await chrome.storage.local.get(["documents", "documentsBackup"]);
          if (restore) {
            if (!store.documentsBackup) return { ok: true, restored: false };
            await chrome.storage.local.set({ documents: store.documentsBackup });
            await chrome.storage.local.remove("documentsBackup");
            return { ok: true, restored: true };
          }
          const current = store.documents || {};
          // Only stash once: a second set before a restore must not overwrite
          // the user's own documents with the previous job's.
          if (!store.documentsBackup) {
            await chrome.storage.local.set({ documentsBackup: current });
          }
          await chrome.storage.local.set({ documents: { ...current, ...payload } });
          return { ok: true, lent: Object.keys(payload) };
        },
        { payload, restore: Boolean(restore) }
      );
    } finally {
      await helper.close().catch(() => {});
    }
  } finally {
    await browser.close();
  }
}

/**
 * Ask for the same answer again, with a note on what to change.
 *
 * Goes through the extension's own drafting prompt rather than a second one
 * here. A "make it shorter" written against a prompt that has forgotten the
 * candidate's profile shortens by inventing, which is the failure this whole
 * project exists to prevent — and two prompts is two places for that to be
 * true. Nothing is written to the page: a revision is still a draft, and still
 * has to be approved.
 */
async function redraft({ url, question, previous, instruction, company, role }) {
  const { browser, context } = await connect();
  try {
    const extId = await extensionId();
    const helper = await context.newPage();
    try {
      await helper.goto(`chrome-extension://${extId}/src/options/options.html`);
      return await helper.evaluate(
        (payload) => chrome.runtime.sendMessage({ type: "redraft", payload }),
        { question, previous, instruction, company, role }
      );
    } finally {
      await helper.close().catch(() => {});
    }
  } finally {
    await browser.close();
  }
}

/**
 * Attach a document to a file field.
 *
 * Playwright sets the input directly, which is the one place not going through
 * the extension is simpler *and* more reliable: a real file on disk beats
 * rebuilding a File from a data URL, and a tailored résumé only exists on disk.
 */
export async function attachToPage(page, path, match = "resume") {
  const filename = path.split('/').pop();
  const expected = {filename, sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
  const wanted = new RegExp(match === 'resume' ? 'resume|résumé|cv\\b' : match, 'i');
  const locate = async () => {
    const candidates=[];
    for(const frame of page.frames()) for(const input of await frame.locator('input[type="file"]').all()) {
      const label=await input.evaluate(node=>[node.id,node.name,node.getAttribute('aria-label'),
        ...Array.from(node.labels || [], l=>l.textContent),
        ...String(node.getAttribute('aria-labelledby') || '').split(/\s+/).map(id=>document.getElementById(id)?.textContent || '')].filter(Boolean).join(' '));
      if(wanted.test(label)) candidates.push({input,label});
    }
    return candidates;
  };
  let candidates=await locate();
  if (!candidates.length && match==='resume') {
    // Use only explicit résumé replacement controls. A generic Upload button
    // could attach to a cover letter or another required document.
    // Indeed exposes its replacement upload in a menu, including from the
    // embedded review. Each step is uniquely named and never submits.
    if (/(^|\.)indeed\.com$/.test(new URL(page.url()).hostname)) {
      const edits=[];
      for(const frame of page.frames()) {
        const edit=frame.getByRole('button',{name:'Edit resume',exact:true}).filter({visible:true});
        if(await edit.count()===1) edits.push(edit);
      }
      if(edits.length===1) {await edits[0].click();await page.waitForTimeout(500);}
      const options=page.getByRole('button',{name:'Resume options',exact:true}).filter({visible:true});
      if(await options.count()===1) await options.click();
    }
    const replace=page.getByRole('button',{name:/^(replace (?:resume|résumé)|upload a different file)$/i}).filter({visible:true});
    if(await replace.count()===1) {
      const chooserPromise=page.waitForEvent('filechooser',{timeout:3000}).catch(()=>null);
      await replace.click();
      const chooser=await chooserPromise;
      if(chooser) {
        await chooser.setFiles(path);
        await page.waitForTimeout(500);
        const resumeCheck=await inspectResume(page,expected);
        return {ok:resumeCheck.status==='matched',filename,resumeCheck,reason:resumeCheck.reason};
      }
      candidates=await locate();
    }
  }
  if(candidates.length!==1) return {ok:false,reason:candidates.length?'Multiple matching upload controls. Open the résumé editor first.':`Open the form's ${match} replacement control, then try again.`};
  const {input,label}=candidates[0];
  await input.setInputFiles(path);
  await page.waitForTimeout(500);
  const retained=await input.evaluate((node,expected)=>Array.from(node.files || []).some(f=>f.name===expected),filename,{timeout:1000}).catch(()=>false);
  const resumeCheck=match==='resume'?await inspectResume(page,expected):null;
  return {ok:resumeCheck ? resumeCheck.status==='matched' : retained,field:label.trim(),filename,resumeCheck,
    reason:resumeCheck?.reason || (retained?'File selected.':'Upload was not retained. Check the employer preview.')};
}

async function attach({ url, path, match = "resume" }) {
  const { browser, context } = await connect();
  try {
    const page = existingPageFor(context, url);
    if (!page) return {ok:false,reason:'Application tab is not open.'};
    return await attachToPage(page, path, match);
  } finally {
    await browser.close();
  }
}

/**
 * The control that sends this application, marked so it can be clicked.
 *
 * Runs in the page. Deliberately narrow: it has to sit inside the application
 * form, be submit-shaped, and read like a submission. "Save for later" is not
 * one, "Add another" is not one, and neither is the newsletter signup further
 * down a careers page. Exported so the suite can show it refusing each of
 * those, because getting this wrong sends an application or fails to.
 */
export function findSubmitControl() {
  document.querySelectorAll('[data-formwork-submit]').forEach(el=>el.removeAttribute('data-formwork-submit'));
  const pattern = /^(submit|submit (?:your )?application|send application|apply now|apply|finish|complete application)$/i;
  const forms = [...document.querySelectorAll('form')];
  const matches = [...(forms.length ? forms : [document.body])].flatMap(form=>[...form.querySelectorAll('button, input[type="submit"], [role="button"]')])
    .filter(el=>pattern.test((el.value || el.textContent || '').replace(/\s+/g,' ').trim()) && el.getBoundingClientRect().width>=8 && el.getBoundingClientRect().height>=8);
  if (matches.length !== 1) return {found:false, reason:matches.length?'Multiple submission controls; open the application review first.':'No submit control found.'};
  const el=matches[0], text=(el.value || el.textContent || '').trim();
  el.setAttribute('data-formwork-submit','1');
  return {found:true, disabled:el.disabled || el.getAttribute('aria-disabled')==='true', text};
}

/**
 * Press the form's own submit control.
 *
 * Deliberately narrow: the control has to be inside the application form, be
 * submit-shaped by role or type, and read like a submission. A "Save for
 * later" or "Add another" is not one, and neither is a newsletter signup
 * further down a careers page.
 */
async function submit({ url, dryRun = false, expectedResume }) {
  const { browser, context } = await connect();
  try {
    const page = existingPageFor(context, url);
    if (!page) return {ok:false, clicked:false, reason:'Application tab is not open.'};
    await page.bringToFront();
    const before = page.url();

    if(isWorkday(page.url()) && (await page.evaluate(inspectWorkdayStep)).kind!=='review')
      return {ok:false,clicked:false,reason:'Workday has not reached its final review step.'};
    if ((await page.evaluate(confirmationOnPage)).confirmation) return {ok:false,clicked:false,reason:'This page already shows a submission confirmation. Check the employer record instead of sending again.'};
    const resumeCheck = expectedResume ? await inspectResume(page, expectedResume) : null;
    if (resumeCheck && resumeCheck.status !== 'matched') return {ok:false, clicked:false, resumeCheck, reason:resumeCheck.reason};
    const found = await page.evaluate(findSubmitControl);

    if (!found.found) return { ok: false, clicked:false, reason: found.reason || "no submit control found on this form" };
    if (found.disabled) return { ok: false, clicked:false, reason: `"${found.text}" is disabled — the form is not complete` };
    if (dryRun) return { ok: true, dryRun: true, control: found.text };

    await page.locator('[data-formwork-submit="1"]').click();
    // Applicant tracking systems answer a submission with a new page or a
    // confirmation panel; either takes a moment, and neither is instant.
    await page.waitForTimeout(6000);
    const after = page.url();
    const receipt = await page.evaluate(confirmationOnPage);
    return {
      ok: receipt.confirmation,
      clicked: true,
      control: found.text,
      navigated: after !== before,
      ...receipt,
      resumeCheck,
      url: after,
    };
  } finally {
    await browser.close();
  }
}

async function receipt({url}) {
  const {browser,context}=await connect();
  try {
    const page=existingPageFor(context,url);
    if(!page) return {confirmation:false,reason:'The original application tab is not identifiable. Check the employer record manually.'};
    return {...await page.evaluate(confirmationOnPage),url:page.url()};
  } finally {await browser.close();}
}

/* --------------------------------------------------------------------- main */

async function profile({profile, about}) {
  const {browser, context} = await connect();
  try {
    const extId = await extensionId();
    const helper = await context.newPage();
    try {
      await helper.goto(`chrome-extension://${extId}/src/options/options.html`);
      const saved = await helper.evaluate(async data => {
        await chrome.storage.local.set({profile:data.profile, about:data.about});
        return await chrome.storage.local.get(['profile','about']);
      }, {profile, about});
      // Chrome can reorder object keys during storage serialization.
      return {ok:isDeepStrictEqual(saved.profile, profile) && saved.about === about};
    } finally {await helper.close().catch(()=>{});}
  } finally {await browser.close();}
}

async function modelConnection({baseUrl,testOnly=false}) {
  const parsed = new URL(baseUrl);
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("Use a dashboard HTTP(S) address without embedded credentials, a query or a fragment.");
  const {browser,context} = await connect();
  let helper, keepOpen=false;
  try {
    const extId = await extensionId();
    const url = `chrome-extension://${extId}/src/options/connect.html?base=${encodeURIComponent(baseUrl)}`;
    helper = context.pages().find(p=>p.url() === url) || await context.newPage();
    await helper.goto(url);
    await helper.waitForFunction(()=>typeof window.connectDashboard === "function");
    if (testOnly) {
      const matches = await helper.evaluate(async base=>{
        const {settings={}} = await chrome.storage.local.get("settings");
        return settings.provider === "homelab" && settings.homelab?.baseUrl?.replace(/\/+$/,"") === base.replace(/\/+$/,"");
      },baseUrl);
      if (!matches) return {ok:false,message:"The extension is not connected to this dashboard yet. Use Connect extension."};
    }
    const receipt = await helper.evaluate(options=>window.connectDashboard(options),{testOnly});
    if (receipt.needsPermission) {keepOpen=true;await helper.bringToFront();}
    return receipt;
  } finally {
    if (helper && !keepOpen) await helper.close().catch(()=>{});
    await browser.close();
  }
}

const COMMANDS = { status, describe, documents, fill, read, receipt, edit, approve, redraft, attach, submit, profile, modelConnection };

// Only when run as a program. Imported — which the suite does, to get at the
// submit-control finder — this file must define things and do nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , name, rawArg] = process.argv;
  const command = COMMANDS[name];
  if (!command) {
    process.stdout.write(JSON.stringify({ error: `unknown command ${name}` }));
    process.exit(1);
  }
  try {
    const arg = rawArg ? JSON.parse(rawArg) : {};
    process.stdout.write(JSON.stringify(await command(arg)));
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: String(err?.message || err) }));
    process.exit(1);
  }
}
