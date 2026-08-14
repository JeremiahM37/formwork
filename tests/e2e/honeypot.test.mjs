/**
 * Bot traps must never be filled.
 *
 * Workday's create-account form carries a field named "website", labelled
 * "Enter website. This input is for robots only", rendered 1px by 0.01px and
 * clipped to nothing — while reporting display:block and visibility:visible.
 * A model handed that label fills it with the candidate's portfolio URL, and
 * the account is flagged as a robot on a site the user needs.
 *
 * This has to run in a real browser: the whole trick is computed geometry, so
 * a DOM stub would prove nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../helpers/load.mjs";

async function loadPlaywright() {
  for (const spec of [process.env.PW_MODULE, "playwright", "playwright-core"].filter(Boolean)) {
    try {
      return (await import(spec)).chromium;
    } catch {
      /* next */
    }
  }
  return null;
}
const chromium = await loadPlaywright();

test("bot traps are never scraped", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const html = readFileSync(join(ROOT, "tests", "fixtures", "honeypot.html"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-honeypot-")), {
    channel: "chromium",
    headless: true,
  });
  t.after(async () => {
    await ctx.close();
    server.close();
  });

  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ content: readFileSync(join(ROOT, "extension", "src", "content", "scrape.js"), "utf8") });

  const seen = await page.evaluate(() => {
    const { schema } = globalThis.__formwork.scrape();
    return {
      labels: schema.fields.map((f) => f.label),
      honeypots: globalThis.__formwork._honeypots,
      // Which elements the scraper would classify as traps, by id.
      flagged: [...document.querySelectorAll("input")]
        .filter((el) => globalThis.__formwork.isHoneypot(el))
        .map((el) => el.id),
    };
  });

  await t.test("Workday's beecatcher is not offered to the model", () => {
    assert.equal(
      seen.labels.some((l) => /robots? only|enter website/i.test(l)),
      false,
      `the trap reached the schema: ${JSON.stringify(seen.labels)}`
    );
  });

  await t.test("every disguise is caught", () => {
    // Sub-pixel + clipped, parked offscreen, named as a trap, labelled as one.
    assert.deepEqual(seen.flagged.sort(), ["beecatcher", "hp2", "hp3", "hp4"]);
    assert.equal(seen.honeypots, 4, "and each one is counted");
  });

  await t.test("real fields on the same form are untouched by the check", () => {
    // Over-eager trap detection would quietly stop the form being filled at
    // all, which is its own failure — so pin the fields that must survive.
    assert.deepEqual(seen.labels, [
      "Email Address",
      "Password",
      "Verify New Password",
      "Personal Website",
      "I agree to the terms",
    ]);
  });

  await t.test('a genuine "Personal Website" field is not mistaken for the trap', () => {
    // The trap's label mentions a website; so does a legitimate question.
    // Wording alone must not condemn a normal, visible, sensibly-sized field.
    assert.equal(seen.flagged.includes("site"), false);
  });
});

test("styled radios and checkboxes are not mistaken for traps", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  // Applicant tracking systems shrink the real input to a pixel and draw their
  // own control on top — Workday's radios are 1px `radioBtn` inputs. Judging
  // those by size skips real questions silently, which is the failure mode
  // trap-detection exists to prevent, aimed at the wrong target.
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-styled-")), {
    channel: "chromium",
    headless: true,
  });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  await page.setContent(`
    <style>.hidden-input { position: absolute; width: 1px; height: 1px; opacity: 0; }</style>
    <label for="yes">Are you legally authorised to work?</label>
    <span><input class="hidden-input" type="radio" id="yes" name="auth" value="Yes" /><i>Yes</i></span>
    <span><input class="hidden-input" type="radio" id="no" name="auth" value="No" /><i>No</i></span>
    <label><input class="hidden-input" type="checkbox" id="agree" /> I agree to the terms</label>
    <label for="trap">Enter website. This input is for robots only.</label>
    <input class="hidden-input" id="trap" name="website" type="text" />
  `);
  await page.addScriptTag({ content: readFileSync(join(ROOT, "extension", "src", "content", "scrape.js"), "utf8") });

  const seen = await page.evaluate(() => {
    const ns = globalThis.__formwork;
    return {
      flagged: [...document.querySelectorAll("input")].filter((el) => ns.isHoneypot(el)).map((el) => el.id),
      labels: ns.scrape().schema.fields.map((f) => f.label),
    };
  });

  assert.deepEqual(seen.flagged, ["trap"], "only the trap is a trap");
  assert.ok(
    seen.labels.some((l) => /legally authorised/i.test(l)),
    `the radio question survived: ${JSON.stringify(seen.labels)}`
  );
  assert.ok(seen.labels.some((l) => /agree to the terms/i.test(l)), "the checkbox survived");
});
