/**
 * Read-only sweep across live postings.
 *
 * Loads each URL, runs the extension's own scraper and validator over it, and
 * reports what formwork would understand — without filling anything and
 * without touching a submit control. Nothing is typed into any page.
 *
 * It exists to catch regressions the fixture suite cannot: the scraper's rules
 * are about how real applicant tracking systems build forms, and those only
 * break against real ones. A change that helps Workday and quietly breaks
 * Greenhouse looks identical from inside the unit tests.
 *
 * What it flags, per posting:
 *   fields      how many questions were found
 *   answered    how many the profile can answer without a model
 *   review      how many need the user's eye
 *   unlabelled  fields with no question text — invisible to a model
 *   suspicious  labels that are ids, placeholders or instructions
 *
 * Usage:
 *   node tools/sweep.mjs --from queue.json
 *   node tools/sweep.mjs https://boards.greenhouse.io/... https://jobs.lever.co/...
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validate } = require("../extension/src/lib/validate.js");
const { chromium } = require("playwright");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const profile = JSON.parse(readFileSync(flag("profile", "profile/private/profile.json"), "utf8"));
const CONTENT = ["scrape.js", "fill.js"].map((f) =>
  readFileSync(new URL(`../extension/src/content/${f}`, import.meta.url), "utf8")
);

const urls = (() => {
  const direct = argv.filter((a) => /^https?:/.test(a));
  if (direct.length) return direct;
  const from = flag("from");
  if (!from) return [];
  const listings = JSON.parse(readFileSync(from, "utf8"));
  return listings.map((j) => j.url).filter(Boolean);
})();

if (!urls.length) {
  console.error("usage: node tools/sweep.mjs [--from queue.json] [urls...]");
  process.exit(2);
}

/** A label that is not a question: an internal id, a placeholder, an aside. */
const SUSPICIOUS = [
  { name: "internal id", re: /^[0-9a-f]{16,}$/i },
  { name: "placeholder", re: /^(select one|select|choose|--|yyyy|mm|dd)\b/i },
  { name: "instruction", re: /use (right and left )?arrow|press (enter|delete)|indicates a required field/i },
  { name: "punctuation only", re: /^[^a-z0-9]+$/i },
];

const limit = Number(flag("limit", urls.length));
const browser = await chromium.launch({ channel: "chromium", headless: true });
const rows = [];

for (const url of urls.slice(0, limit)) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const row = { url, ats: "", fields: 0, answered: 0, review: 0, unlabelled: 0, suspicious: [], note: "" };
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3500);

    // A posting is usually the advert; the form is one click further on. That
    // click only reveals the form — the harness never fills or submits.
    const apply = page
      .locator('[data-automation-id="adventureButton"], a:has-text("Apply"), button:has-text("Apply")')
      .first();
    if ((await apply.count()) && !/\/(apply|application)/i.test(url)) {
      await apply.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(3500);
    }
    // evaluate(), not addScriptTag(): the latter injects an inline <script>,
    // which a strict Content-Security-Policy refuses — Ashby's does. A real
    // content script is exempt from the page's CSP, so this is a limitation of
    // the harness rather than of the extension, and it must not be one that
    // makes a whole applicant tracking system invisible to the sweep.
    for (const src of CONTENT) await page.evaluate(src);

    const { schema, fullOptions, hidden } = await page.evaluate(async () => {
      const ns = globalThis.__formwork;
      const { schema } = await ns.scrapeFull();
      return { schema, fullOptions: ns._options || {}, hidden: ns.hiddenFieldCount() };
    });

    row.ats = schema.ats || "generic";
    row.fields = schema.fields.length;
    if (!row.fields) {
      row.note = hidden ? `form not open (${hidden} hidden)` : "no form on this page";
    } else {
      const { fills, review } = validate({}, schema, profile, fullOptions, {});
      row.answered = Object.keys(fills).length;
      row.review = review.length;
      row.unlabelled = schema.fields.filter((f) => !f.label).length;
      for (const f of schema.fields) {
        const hit = SUSPICIOUS.find((s) => s.re.test(f.label || ""));
        if (hit) row.suspicious.push(`${hit.name}: ${JSON.stringify(f.label.slice(0, 34))}`);
      }
    }
  } catch (err) {
    row.note = String(err.message || err).split("\n")[0].slice(0, 60);
  }
  await page.close();
  rows.push(row);

  const host = new URL(url).hostname.replace(/^(www|boards|jobs|job-boards)\./, "");
  const problems = row.unlabelled + row.suspicious.length;
  console.log(
    `${host.slice(0, 26).padEnd(27)}${String(row.fields).padStart(3)} fields ` +
      `${String(row.answered).padStart(3)} answered ${String(row.review).padStart(2)} review ` +
      `${problems ? `· ${problems} label problem(s)` : ""}${row.note ? `· ${row.note}` : ""}`
  );
}

await browser.close();

/* ------------------------------------------------------------- summary */

const withForm = rows.filter((r) => r.fields > 0);
const problems = rows.filter((r) => r.unlabelled || r.suspicious.length);
console.log(`\n${rows.length} postings · ${withForm.length} with a readable form`);
if (withForm.length) {
  const total = withForm.reduce((n, r) => n + r.fields, 0);
  const answered = withForm.reduce((n, r) => n + r.answered, 0);
  console.log(`${total} fields seen · ${answered} answerable from the profile alone`);
}
for (const r of problems) {
  console.log(`\n${r.url}`);
  if (r.unlabelled) console.log(`  ${r.unlabelled} field(s) with no question text`);
  for (const s of [...new Set(r.suspicious)]) console.log(`  ${s}`);
}
process.exit(problems.length ? 1 : 0);
