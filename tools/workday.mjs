/**
 * Workday driver — the one applicant tracking system formwork cannot do from a
 * single page.
 *
 * Workday gates the form behind an account, then splits it across five or six
 * screens with a "Save and Continue" between each. The extension fills whatever
 * screen it is on; this harness supplies the two things it cannot: getting past
 * the gate, and turning the page.
 *
 * It reuses the extension's own scrape / validate / fill modules rather than
 * reimplementing them, so anything proved here holds for the extension too.
 *
 * The application is NEVER submitted. Submission controls are identified and
 * refused (see SUBMIT), the run stops at the review screen, and the guard is
 * enforced by a test, not by care.
 *
 * Usage:
 *   node tools/workday.mjs <posting-url> --create-account
 *   node tools/workday.mjs <posting-url>                  # sign in, then fill
 */
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { validate } = require("../extension/src/lib/validate.js");
const { chromium } = require("playwright");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const url = argv.find((a) => /^https?:/.test(a));
if (!url) {
  console.error("usage: node tools/workday.mjs <workday-posting-url> [--create-account] [--shots <dir>]");
  process.exit(2);
}

const profile = JSON.parse(readFileSync(flag("profile", "profile/private/profile.json"), "utf8"));
const credentials = JSON.parse(readFileSync(flag("credentials", "profile/private/credentials.json"), "utf8"));
const shotDir = flag("shots", "");
if (shotDir) mkdirSync(shotDir, { recursive: true });

/** Session cookies live here, so an account is created once and reused. */
const userDataDir = flag("session", "/tmp/formwork-workday-session");

const CONTENT = ["scrape.js", "fill.js"].map((f) =>
  readFileSync(new URL(`../extension/src/content/${f}`, import.meta.url), "utf8")
);

/**
 * Anything that would send the application.
 *
 * Workday's review screen uses data-automation-id="wd-Submit"; the text check
 * catches tenants that relabel it. Checked before every click the harness
 * makes, and a match aborts the run.
 *
 * Matching must be exact. A substring test on "submitButton" also matches
 * `createAccountSubmitButton`, which stops the run at the account gate — the
 * guard has to tell "send my application" apart from "register me".
 */
const SUBMIT = {
  automation: /^(wd-)?submit$|^submitButton$|submitApplication|applicationSubmit/i,
  text: /^\s*submit(\s+application)?\s*$/i,
};

/**
 * Days to shift a generated "today".
 *
 * A signature field is checked against the employer's clock, not this
 * machine's: a correct local date came back as "Enter today's date" because
 * the tenant's day had not turned over. The error only appears once the page
 * is submitted, so it cannot be detected while typing — the step loop bumps
 * this and tries the screen again.
 */
let dateShift = 0;

const log = (...a) => console.log(...a);
const sleep = (page, ms) => page.waitForTimeout(ms);

/**
 * Click a Workday control for real.
 *
 * Workday lays a transparent `click_filter` div over its buttons and marks the
 * underlying <button> aria-hidden with tabindex="-2", so a targeted click is
 * intercepted and a synthetic one lands on an element nothing listens to.
 * Clicking the physical location hits whatever is actually on top, which is the
 * behaviour a person produces.
 */
async function clickButton(page, selector, { optional = false } = {}) {
  const el = page.locator(selector).first();
  if (optional && !(await el.count())) return false;
  // Coordinates are viewport-relative, so a control below the fold must be
  // brought into view first or the click lands on empty space off-screen.
  await el.scrollIntoViewIfNeeded();
  await sleep(page, 300);
  const box = await el.boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

/**
 * Fill a widget that only responds to real input.
 *
 * Workday's "How did you hear about us" ignores synthesised events entirely —
 * not clicks, not keystrokes — and its entries are categories that open a
 * second level ("Website" → "NVIDIA.COM"). A browser extension cannot produce
 * a trusted event, so the extension reports this field as unset and says why;
 * this harness drives a real browser and can simply click it.
 *
 * That difference is worth stating plainly rather than papering over: what
 * runs here is not proof the extension can do the same.
 */
async function realMouseFill(page, field, value) {
  const clickAt = async (locator) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return true;
  };

  // A date is typed, segment by segment, the way a person tabs through it.
  if (field.type === "date") {
    // Find the container by what it holds, not by its text: "Date" appears in
    // several captions on a page, and the first match was a container with no
    // date widget in it at all — so nothing was typed and the field stayed
    // empty while reporting success.
    const box = page
      .locator('[data-automation-id^="formField"]')
      .filter({ has: page.locator('input[role="spinbutton"]') })
      .filter({ hasText: field.label.replace(/[^A-Za-z ]/g, " ").trim().split(/\s+/)[0] || "Date" })
      .first();
    // The segments are a fraction of a pixel wide, so they cannot be clicked
    // individually — aiming at one lands on nothing and the rest stay empty
    // ("Invalid Date: 08//"). The wrapper around them is a real target, and
    // these widgets advance from one segment to the next as digits arrive.
    const wrapper = box.locator('[role="group"], [data-automation-id="dateInputWrapper"]').first();
    if (!(await wrapper.count())) return false;

    // A signature field checks the date against the employer's own clock, not
    // this machine's — an NVIDIA tenant rejected a correct local date with
    // "Enter today's date" because its day had not turned over yet. Rather
    // than guess at the tenant's timezone, offer the neighbouring days: one of
    // them is today wherever the server is.
    const base = new Date(value);
    const candidates = Number.isNaN(base.getTime())
      ? [String(value)]
      : [(() => {
          const day = new Date(base);
          day.setDate(day.getDate() + dateShift);
          return `${day.getMonth() + 1}/${day.getDate()}/${day.getFullYear()}`;
        })()];

    for (const candidate of candidates) {
      // Drive each segment on its own: focus it directly, then type its
      // digits. Clicking cannot reach these — they are a fraction of a pixel
      // wide — and letting the widget auto-advance loses whatever arrives
      // during the hand-off ("Invalid Date: 08/14/", then "08//"). Focus
      // works whatever the size, and typing goes to whatever holds focus.
      // Click the wrapper, then type the parts in order. The segments are a
      // fraction of a pixel wide so they cannot be clicked individually, and
      // driving them one at a time by focus proved less reliable than letting
      // the widget advance itself as the digits arrive.
      if (!(await clickAt(wrapper))) return false;
      for (let k = 0; k < 12; k++) await page.keyboard.press("Backspace");
      for (const part of candidate.split("/")) {
        await page.keyboard.type(part, { delay: 60 });
        await sleep(page, 250);
      }
      await page.keyboard.press("Tab");
      await sleep(page, 700);
      const settled = (await box.textContent()) || "";
      if (!/is required|invalid date|today's date/i.test(settled)) return true;
    }
    return false;
  }

  // A set of choices is answered by clicking the option itself, wherever it
  // sits — there is no menu to open first.
  if (field.type === "radio" || field.type === "checkbox-group") {
    const option = page.getByText(String(value), { exact: false }).first();
    if (!(await option.count())) return false;
    if (!(await clickAt(option))) return false;
    await sleep(page, 600);
    return true;
  }

  // Locate the widget by its visible label, the one thing that is stable.
  const container = page
    .locator('[data-automation-id^="formField"]')
    .filter({ hasText: field.label.slice(0, 30) })
    .first();
  if (!(await container.count())) return false;

  const input = container.locator('input, button[aria-haspopup="listbox"]').first();
  if (!(await input.count()) || !(await clickAt(input))) return false;
  await sleep(page, 1000);

  const option = (text) =>
    page.locator('[role="option"]').filter({ hasText: text }).first();

  const wanted = option(String(value));
  if (await wanted.count()) {
    if (!(await clickAt(wanted))) return false;
    await sleep(page, 1000);
  }

  // A category opens rather than selects; take the first leaf it reveals.
  const settled = (await container.textContent()) || "";
  if (/item selected/.test(settled)) {
    await page.keyboard.press("Escape");
    return true;
  }
  const leaves = page.locator('[role="option"]');
  for (let i = 0; i < (await leaves.count()); i++) {
    const leaf = leaves.nth(i);
    const label = (await leaf.getAttribute("aria-label")) || "";
    if (!/not checked/i.test(label)) continue;
    if (!(await clickAt(leaf))) continue;
    await sleep(page, 1000);
    break;
  }
  await page.keyboard.press("Escape");
  await sleep(page, 500);
  return /item selected/.test((await container.textContent()) || "");
}

async function shot(page, name) {
  if (shotDir) await page.screenshot({ path: join(shotDir, `${name}.png`) });
}

/** Inject the extension's content modules into the current document. */
async function inject(page) {
  for (const src of CONTENT) await page.addScriptTag({ content: src });
}

/**
 * Read the current screen with the extension's scraper, decide every answer
 * with the extension's validator, and fill with the extension's filler.
 *
 * Only pinned and credential answers are used: they are deterministic, which is
 * what makes this harness a regression test rather than a demo. Free-text
 * questions are reported and left for the model in the extension proper.
 */
/**
 * Fill the current screen, then fill it again.
 *
 * Some dropdowns are populated from the answer to another one: Workday's State
 * list is empty of US states until Country is committed, so on a first pass the
 * profile's "Montana" is correctly refused — it genuinely is not on offer yet.
 * Re-reading the options after the first pass lands is what turns that into an
 * answer, and it costs one extra scrape.
 *
 * Two passes, not a loop to exhaustion: a field still unmatched after its
 * dependencies are satisfied is not going to resolve by asking again, and a
 * loop would hide a real failure behind repetition.
 */
async function fillScreen(page, label) {
  const first = await fillOnce(page, label);
  const dependent = first.review.some((r) => /matches none of the offered options/.test(r.reason));
  if (!dependent) return first;

  log(`   … re-reading options that depend on a field just answered`);
  const second = await fillOnce(page, `${label} (second pass)`);
  return second;
}

async function fillOnce(page, label) {
  await inject(page);
  // Scrape once and keep the registry alongside its schema. Scraping again to
  // recover the registry re-reads a page that has moved on, so the two no
  // longer line up and fills land on the wrong control or none at all.
  // The schema carries at most 25 options per field to keep prompts small; the
  // untruncated lists live on the namespace and must be handed to the
  // validator separately, exactly as the extension's content script does. Miss
  // this and a 50-item list silently loses everything past the 25th — which is
  // why "Montana", the 27th state alphabetically, matched nothing.
  const { schema, fullOptions } = await page.evaluate(async () => {
    const ns = globalThis.__formwork;
    const { schema, registry } = await (ns.scrapeFull ? ns.scrapeFull() : ns.scrape());
    globalThis.__wdSchema = schema;
    globalThis.__wdRegistry = registry;
    return { schema, fullOptions: ns._options || {} };
  });

  const { fills, review, missingRequired } = validate({}, schema, profile, fullOptions, credentials);
  const result = await page.evaluate(
    async ([fillMap]) => {
      const ns = globalThis.__formwork;
      return ns.fill(fillMap, globalThis.__wdSchema, globalThis.__wdRegistry, {
        review: [],
        files: {},
        keepExisting: true,
      });
    },
    [fills]
  );

  // --dump-options <regex>: show what a field is actually offering. The
  // difference between "not offered" and "offered under another name" is
  // invisible from the outside, and guessing at it wastes more time than
  // printing it.
  // --unseen: controls the scraper skipped, and why they might matter.
  if (has("unseen")) {
    const missed = await page.evaluate(() => {
      const ns = globalThis.__formwork;
      const seen = new Set(globalThis.__wdRegistry.flat());
      return [...document.querySelectorAll("input, select, textarea, [role=spinbutton], [role=combobox]")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 2 && r.height > 2 && !seen.has(el);
        })
        .map((el) => ({
          tag: el.tagName, type: el.type, role: el.getAttribute("role"),
          auto: el.getAttribute("data-automation-id"),
          label: ns.labelFor ? ns.labelFor(el).slice(0, 40) : "",
          honeypot: ns.isHoneypot ? ns.isHoneypot(el) : null,
        }))
        .slice(0, 12);
    });
    for (const m of missed) log(`   [unseen] ${JSON.stringify(m)}`);
  }

  const dump = flag("dump-options");
  if (dump) {
    const re = new RegExp(dump, "i");
    for (const f of schema.fields) {
      if (!re.test(f.label)) continue;
      const opts = fullOptions[f.id] || f.options || [];
      log(`   [options] ${f.label} (${f.type}) — ${opts.length}: ${JSON.stringify(opts.slice(0, 12))}`);
    }
  }

  // --inspect <regex>: what kind of control is behind a field. Label and type
  // are what the schema shows; when a fill or its verification misbehaves the
  // answer is usually in the element itself.
  const inspect = flag("inspect");
  if (inspect) {
    const found = await page.evaluate(
      (pattern) => {
        const re = new RegExp(pattern, "i");
        const schema = globalThis.__wdSchema;
        const registry = globalThis.__wdRegistry;
        return schema.fields
          .map((f, i) => ({ f, el: registry[i] && registry[i][0] }))
          .filter(({ f, el }) => el && re.test(f.label))
          .map(({ f, el }) => ({
            label: f.label,
            scrapedAs: f.type,
            tag: el.tagName,
            type: el.type,
            role: el.getAttribute("role"),
            haspopup: el.getAttribute("aria-haspopup"),
            controls: el.getAttribute("aria-controls") || el.getAttribute("aria-owns"),
            value: el.value,
            shown: globalThis.__formwork.readComboboxValue
              ? globalThis.__formwork.readComboboxValue(el)
              : undefined,
            id: el.id,
            name: el.name,
            labelledby: el.getAttribute("aria-labelledby"),
            labelledbyText: (el.getAttribute("aria-labelledby") || "")
              .split(/\s+/)
              .filter(Boolean)
              .map((i) => (document.getElementById(i)?.textContent || "").trim().slice(0, 50)),
            labelFor: el.id ? (document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent || "").trim().slice(0, 60) : null,
            siblings: (() => {
              const box = el.closest('[data-automation-id^="formField"]');
              if (!box) return null;
              const CTRL = 'input, select, textarea, button[aria-haspopup="listbox"], [role="combobox"]:not(input)';
              return [...box.querySelectorAll(CTRL)].map(
                (c) => `${c.tagName}[${c.getAttribute("data-automation-id") || ""}] role=${c.getAttribute("role") || ""} self=${c === el}`
              );
            })(),
            boxText: (() => {
              const box = el.closest('[data-automation-id^="formField"]');
              return box ? box.textContent.trim().slice(0, 60) : null;
            })(),
            pageSays: (() => {
              const box = el.closest('[data-automation-id^="formField"]');
              return box ? box.textContent.trim().slice(0, 260) : null;
            })(),
            container: (() => {
              const box =
                el.closest("[data-uxi-widget-type]") ||
                el.closest('[data-automation-id*="Container" i]') ||
                el.parentElement;
              if (!box) return null;
              // Just the elements that hold text, so the pill is findable.
              return [...box.querySelectorAll("*")]
                .filter((n) => n.children.length === 0 && n.textContent.trim())
                .slice(0, 12)
                .map((n) => ({
                  tag: n.tagName,
                  auto: n.getAttribute("data-automation-id"),
                  cls: n.className,
                  text: n.textContent.trim().slice(0, 40),
                }));
            })(),
          }));
      },
      inspect
    );
    for (const f of found) log(`   [inspect] ${JSON.stringify(f)}`);
  }

  const filled = Object.keys(fills).length;
  log(`\n[${label}] ${schema.fields.length} fields · filled ${filled} · review ${review.length}`);
  for (const f of schema.fields) {
    const mark = fills[f.id] !== undefined ? "✓" : "·";
    const value = fills[f.id] === undefined ? "" : ` = ${JSON.stringify(String(fills[f.id]).slice(0, 40))}`;
    log(`   ${mark} ${f.label.slice(0, 58)}${value}`);
  }
  // Anything else the extension could not set gets a second attempt with a
  // real mouse. See realMouseFill for why that is not cheating.
  for (const f of result?.failed || []) {
    const field = schema.fields.find((x) => x.id === (f.id || f));
    if (!field || !["combobox", "radio", "checkbox-group", "date"].includes(field.type)) continue;
    if (await realMouseFill(page, field, fills[field.id])) {
      result.failed = result.failed.filter((x) => (x.id || x) !== field.id);
      result.filled.push(field.id);
      log(`   ↻ ${field.label}: set with a real click`);
    }
  }

  // Dates go last, and always with real keystrokes rather than only on a
  // reported failure. Workday takes the written text into the segments and
  // rejects it on submit, so there is nothing for the extension to detect at
  // the time — and it cannot produce a trusted key anyway. Last, because
  // answering another widget re-renders the page and empties the date again:
  // whatever is filled here has to be the final thing touched.
  for (const field of schema.fields) {
    if (field.type !== "date" || fills[field.id] === undefined) continue;
    if (await realMouseFill(page, field, fills[field.id])) {
      result.failed = (result.failed || []).filter((x) => (x.id || x) !== field.id);
      if (!result.filled.includes(field.id)) result.filled.push(field.id);
    }
  }

  const name = (f) => (typeof f === "string" ? f : f.label || f.id);
  for (const r of review) log(`   ? ${r.label}: ${r.reason}`);
  if (result?.failed?.length) log(`   ! could not set: ${result.failed.map(name).join(", ")}`);
  if (missingRequired.length)
    log(`   ! required but unanswered: ${missingRequired.map(name).join(", ")}`);
  return { schema, fills, review, result, missingRequired };
}

/**
 * The button that turns the page — and never the one that sends the form.
 * Returns null at the review screen, which is where the run is meant to end.
 */
async function advance(page) {
  const found = await page.evaluate(
    ([subAuto, subText]) => {
      const auto = new RegExp(subAuto, "i");
      const text = new RegExp(subText, "i");
      const vis = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      };
      const buttons = [...document.querySelectorAll("button,a[role=button],[data-automation-id]")].filter(
        (el) => (el.tagName === "BUTTON" || el.getAttribute("role") === "button") && vis(el)
      );
      const id = (el) => el.getAttribute("data-automation-id") || "";
      // Refuse first: a submit control anywhere on the screen is reported, not clicked.
      const submits = buttons.filter((b) => auto.test(id(b)) || text.test(b.textContent || ""));
      const next = buttons.find(
        (b) =>
          !auto.test(id(b)) &&
          !text.test(b.textContent || "") &&
          (/bottom-navigation-next-button|pageFooterNext|wd-Next/i.test(id(b)) ||
            /^\s*(save and continue|continue|next)\s*$/i.test(b.textContent || ""))
      );
      if (next) {
        next.setAttribute("data-formwork-next", "1");
        return { kind: "next", label: next.textContent.trim().slice(0, 40) };
      }
      if (submits.length) return { kind: "submit", label: submits.map((b) => b.textContent.trim()).join(", ") };
      return { kind: "none" };
    },
    [SUBMIT.automation.source, SUBMIT.text.source]
  );

  if (found.kind === "submit") {
    log(`\n>>> review screen reached — refusing to click "${found.label}". Stopping.`);
    return null;
  }
  if (found.kind === "none") return null;
  log(`\n--> ${found.label}`);
  await clickButton(page, '[data-formwork-next="1"]');
  await sleep(page, 4000);
  return found.label;
}

/* ------------------------------------------------------------------- run */

const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  headless: !has("headed"),
  viewport: { width: 1280, height: 1000 },
});
const page = ctx.pages()[0] || (await ctx.newPage());

try {
  log(`opening ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(page, 3000);
  await shot(page, "01-posting");

  // Two ways in: "Apply" on a fresh posting, "Continue Application" once one
  // is already under way — which is what a returning candidate sees, and what
  // every run after the first sees here.
  const ENTRY = '[data-automation-id="adventureButton"], [data-automation-id="continueButton"]';
  await page.waitForSelector(ENTRY, { timeout: 45000 }).catch(() => {
    throw new Error("the posting offered neither Apply nor Continue Application — reload and retry");
  });
  const entry = page.locator(ENTRY).first();
  log(`entering via "${(await entry.textContent())?.trim()}"`);
  await clickButton(page, ENTRY);
  await sleep(page, 4000);
  const manual = page.locator('[data-automation-id="applyManually"]').first();
  if (await manual.count()) {
    await clickButton(page, '[data-automation-id="applyManually"]');
    await sleep(page, 5000);
  }
  await shot(page, "02-gate");

  // The gate: sign in, or create the account first.
  const emailBtn = page.locator('[data-automation-id="SignInWithEmailButton"]').first();
  if (await emailBtn.count()) {
    await clickButton(page, '[data-automation-id="SignInWithEmailButton"]');
    await sleep(page, 3000);
  }

  if (has("create-account")) {
    const link = page.locator('[data-automation-id="createAccountLink"]').first();
    if (await link.count()) {
      await clickButton(page, '[data-automation-id="createAccountLink"]');
      await sleep(page, 4000);
    }
    log("\n=== create account ===");
    await fillScreen(page, "create-account");
    await shot(page, "03-create-account-filled");
    await clickButton(page, '[data-automation-id="createAccountSubmitButton"]');
    await sleep(page, 8000);
    await shot(page, "04-after-create");
    log(`after create-account: ${page.url()}`);
    const err = await page.evaluate(() =>
      [...document.querySelectorAll('[data-automation-id*="error"], [role="alert"]')]
        .map((e) => e.textContent.trim())
        .filter(Boolean)
        .slice(0, 5)
    );
    if (err.length) log("errors:", JSON.stringify(err));
  } else if (await page.locator('[data-automation-id="signInSubmitButton"]').count()) {
    log("\n=== sign in ===");
    await fillScreen(page, "sign-in");
    await clickButton(page, '[data-automation-id="signInSubmitButton"]');
    await sleep(page, 8000);
    await shot(page, "04-after-signin");
    log(`after sign-in: ${page.url()}`);
  }

  // The multi-step application. Fill, turn the page, repeat — stop at review.
  //
  // "Save and Continue" fails silently when a required field is empty: Workday
  // redraws the same screen with an error banner. Without a stuck check the
  // harness cheerfully refills the same page until it runs out of steps and
  // reports success, so the screen is fingerprinted and a repeat is fatal.
  const maxSteps = Number(flag("steps", 8));
  // A set, not the previous value: a rejected screen can alternate between two
  // renderings (an open dropdown changes which fields are visible), which a
  // one-step memory reads as progress forever.
  const seen = new Map();
  let repeats = 0;
  for (let step = 1; step <= maxSteps; step++) {
    const { schema, result } = await fillScreen(page, `step ${step}`);
    await shot(page, `1${step}-step-${step}`);
    if (!schema.fields.length) log("   (no fillable fields on this screen)");

    const fingerprint = `${page.url()}|${schema.fields.map((f) => f.label).join("|")}`;
    const progress = (result?.filled || []).length;
    // A repeated screen is only stuck if this pass achieved no more than the
    // last one. Some screens legitimately need two passes — a field the first
    // pass could not set may be answerable once the rest of the page has
    // settled — and calling that stuck abandons a form that was about to turn.
    if (seen.has(fingerprint) && progress <= seen.get(fingerprint)) {
      const errors = await page.evaluate(() =>
        [...document.querySelectorAll('[data-automation-id*="error"], [role="alert"], .css-error')]
          .map((e) => e.textContent.trim())
          .filter(Boolean)
          .slice(0, 10)
      );
      const complaint = errors.join(" ");
      // A screen that repeats while reporting nothing wrong has not rejected
      // anything — it is mid-render, or waiting on a save. Give it one more
      // turn rather than abandoning a form that is not actually stuck.
      if (!errors.length && repeats < 2) {
        repeats++;
        seen.delete(fingerprint);
        if (!(await advance(page))) break;
        continue;
      }
      if (/today's date/i.test(complaint) && dateShift < 1) {
        dateShift = dateShift === 0 ? -1 : 1;
        log(`\n    the employer's clock disagrees about today — retrying with a ${dateShift > 0 ? "later" : "earlier"} date`);
        seen.delete(fingerprint);
        continue;
      }
      log(`\n!!! stuck on the same screen — the form rejected it.`);
      log(errors.length ? `    ${errors.join("\n    ")}` : "    (no error text on the page)");
      break;
    }
    seen.set(fingerprint, Math.max(progress, seen.get(fingerprint) ?? 0));

    if (!(await advance(page))) break;
  }
  log(`\nfinished at ${page.url()}`);
} finally {
  await ctx.close();
}
