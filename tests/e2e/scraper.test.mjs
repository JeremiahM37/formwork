/**
 * The scraper, in a real browser, against the fixture form.
 *
 * Runs without the extension — the content script is injected directly — so it
 * isolates "does the DOM reading work" from "does the extension wire up". Both
 * matter, and when the full e2e fails it is useful to know which half broke.
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

test("scrapes the fixture form correctly", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const html = readFileSync(join(ROOT, "tests", "fixtures", "form.html"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-scrape-")), {
    channel: "chromium",
    headless: true,
  });
  t.after(async () => {
    await ctx.close();
    server.close();
  });

  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ path: join(ROOT, "extension/src/content/scrape.js") });

  const started = Date.now();
  const { schema, options } = await page.evaluate(async () => {
    const { schema } = await window.__formwork.scrapeFull();
    return { schema, options: window.__formwork._options };
  });
  const elapsed = Date.now() - started;

  const byLabel = Object.fromEntries(schema.fields.map((f) => [f.label, f]));
  const labels = schema.fields.map((f) => f.label);

  await t.test("finds every real question", () => {
    for (const expected of [
      "First Name",
      "Email",
      "Resume/CV",
      "How did you hear about this job?",
      "Gender",
      "Veteran Status",
      "Acknowledge/Confirm",
      "Why are you interested in this role?",
    ]) {
      assert.ok(byLabel[expected], `missing field: ${expected}\nfound: ${labels.join(" | ")}`);
    }
  });

  await t.test("excludes controls that are not questions", () => {
    // Each of these has a distinct reason to be skipped; a regression in any
    // one of them puts junk in the prompt or writes to a field the user cannot
    // see. The CSRF token is the worst case — it is framework state.
    const excluded = {
      "hidden input (CSRF token)": /authenticity_token|s3cr3t/i,
      "disabled input": /Disabled field/i,
      "readonly input": /Readonly field/i,
      "aria-hidden input": /Hidden from assistive tech/i,
      "display:none input": /Not displayed/i,
      "composite widget sub-input": /Search country/i,
    };
    for (const [what, re] of Object.entries(excluded)) {
      assert.equal(labels.some((l) => re.test(l)), false, `${what} should not be offered to the model`);
    }
  });

  await t.test("labels a file input by its question, not its button", () => {
    // Both file slots on a real form say "Attach"; the question above them is
    // what distinguishes a résumé from a cover letter.
    const file = schema.fields.find((f) => f.type === "file");
    assert.equal(file.label, "Resume/CV");
    assert.equal(file.required, true);
  });

  await t.test("captures option lists, including from keyboard-only comboboxes", () => {
    assert.deepEqual(byLabel["How did you hear about this job?"].options, [
      "LinkedIn",
      "Referral",
      "Company website",
      "Other",
    ]);
    // These only exist once the widget is opened — the reason scrapeFull is async.
    assert.deepEqual(byLabel.Gender.options, ["Male", "Female", "Decline To Self Identify"]);
    assert.deepEqual(
      byLabel["Do you now or will you in the future require immigration sponsorship?"].options,
      ["Yes", "No"]
    );
  });

  await t.test("groups radio buttons into one question with its options", () => {
    const veteran = byLabel["Veteran Status"];
    assert.equal(veteran.type, "radio");
    assert.equal(veteran.options.length, 3);
    assert.ok(veteran.options.some((o) => /I am not a protected veteran/.test(o)));
  });

  await t.test("marks required fields and infers control types", () => {
    assert.equal(byLabel["First Name"].required, true);
    assert.equal(byLabel.Gender.required, false);
    assert.equal(byLabel["Why are you interested in this role?"].type, "textarea");
    assert.equal(byLabel["How did you hear about this job?"].type, "select");
    assert.equal(byLabel["Acknowledge/Confirm"].type, "checkbox");
  });

  await t.test("keeps the full option list client-side for later matching", () => {
    const genderId = byLabel.Gender.id;
    assert.deepEqual(options[genderId], ["Male", "Female", "Decline To Self Identify"]);
  });

  await t.test("identifies the posting for context", () => {
    assert.equal(schema.company, "Testcorp", "company is parsed from the page title");
    assert.ok(schema.title.length > 0);
  });

  await t.test("completes fast enough to run on page load", () => {
    // Every combobox is opened and closed, so this scales with widget count;
    // if it ever creeps into seconds the panel will feel broken.
    assert.ok(elapsed < 10000, `scrape took ${elapsed}ms`);
  });
});
