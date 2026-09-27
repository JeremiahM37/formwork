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

test(
  "a field scrolled above the fold is not a bot trap",
  { skip: chromium ? false : "playwright not installed" },
  async (t) => {
    // getBoundingClientRect is viewport-relative, so a question above the
    // current scroll position reports a negative bottom. Reading that as
    // "parked off the canvas" — which is a real trap technique — dropped the
    // applicant's name, email and phone from a Greenhouse form the second time
    // it was filled, because the page was still scrolled where the first fill
    // left it. Off the canvas has to mean off the document.
    const html = `<!doctype html><meta charset="utf-8"><body>
      <form>
        <label for="first_name">First Name</label><input id="first_name" type="text">
        <label for="email">Email</label><input id="email" type="email">
        <div style="height: 3000px"></div>
        <label for="why">Why here?</label><input id="why" type="text">
        <label for="parked">Website</label>
        <input id="parked" type="text" style="position:absolute; left:-9999px; top:-9999px">
      </form></body>`;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

    const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-scrolled-")), {
      channel: "chromium",
      headless: true,
    });
    t.after(async () => {
      await ctx.close();
      server.close();
    });

    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({
      content: readFileSync(join(ROOT, "extension", "src", "content", "scrape.js"), "utf8"),
    });
    // Put the top of the form well above the viewport, as a second fill would.
    await page.evaluate(() => window.scrollTo(0, 2500));

    const seen = await page.evaluate(() => {
      const { schema } = globalThis.__formwork.scrape();
      return {
        labels: schema.fields.map((f) => f.label),
        parkedIsTrap: globalThis.__formwork.isHoneypot(document.getElementById("parked")),
        firstNameIsTrap: globalThis.__formwork.isHoneypot(document.getElementById("first_name")),
      };
    });

    assert.equal(seen.firstNameIsTrap, false, "a scrolled-past field is not a trap");
    assert.ok(seen.labels.includes("First Name"), `First Name missing from ${seen.labels.join(", ")}`);
    assert.ok(seen.labels.includes("Email"), "Email missing");
    assert.equal(seen.parkedIsTrap, true, "a field parked off the document is still a trap");
    assert.ok(!seen.labels.includes("Website"), "the parked field was scraped");
  }
);

test(
  "a trap cannot escape by dressing as a combobox",
  { skip: chromium ? false : "playwright not installed" },
  async (t) => {
    // Combobox libraries size their input to the text being typed — Greenhouse's
    // is under four pixels wide — so those inputs had to stop being judged on
    // width. That is a real widening of the exemption, and what still has to
    // catch a trap is what it says and what it is called.
    const html = `<!doctype html><meta charset="utf-8"><body><form>
      <label for="real">Country</label>
      <div style="width:300px;height:34px"><input id="real" role="combobox" style="width:4px" type="text"></div>

      <label for="worded">Enter website. This input is for robots only.</label>
      <div style="width:300px;height:34px"><input id="worded" role="combobox" style="width:4px" type="text"></div>

      <label for="named">Website</label>
      <div style="width:300px;height:34px"><input id="named" name="beecatcher" role="combobox" style="width:4px" type="text"></div>

      <label for="askedto">Leave this blank</label>
      <div style="width:300px;height:34px"><input id="askedto" role="combobox" style="width:4px" type="text"></div>
      </form></body>`;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

    const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-combotrap-")), {
      channel: "chromium",
      headless: true,
    });
    t.after(async () => {
      await ctx.close();
      server.close();
    });

    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.addScriptTag({
      content: readFileSync(join(ROOT, "extension", "src", "content", "scrape.js"), "utf8"),
    });

    const seen = await page.evaluate(() => {
      const ns = globalThis.__formwork;
      const verdict = (id) => ns.isHoneypot(document.getElementById(id));
      return {
        real: verdict("real"),
        worded: verdict("worded"),
        named: verdict("named"),
        askedto: verdict("askedto"),
        labels: ns.scrape().schema.fields.map((f) => f.label),
      };
    });

    assert.equal(seen.real, false, "an ordinary combobox was called a trap");
    assert.equal(seen.worded, true, "a trap that says so was scraped");
    assert.equal(seen.named, true, "a trap named beecatcher was scraped");
    assert.equal(seen.askedto, true, "a field asking to be left blank was scraped");
    assert.deepEqual(seen.labels, ["Country"]);
  }
);
