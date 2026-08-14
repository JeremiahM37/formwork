/**
 * First-run setup, driven in a real browser.
 *
 * The wizard's job is to produce a profile good enough to fill a form, from
 * someone who has never seen the schema. So this does not check that inputs
 * exist — it walks the whole flow, then feeds what was stored straight into the
 * validator and asserts a real application form comes out answered.
 *
 * The step that matters most is the voluntary disclosures. Left unset, a model
 * invents them from the candidate's name; the wizard's defaults have to reach
 * storage as real, pinnable answers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, lib, schemaOf } from "../helpers/load.mjs";

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
const { validate } = lib("validate");

const ANSWERS = {
  first_name: "Dana",
  last_name: "Rivera",
  email: "dana@example.test",
  phone: "828-555-0142",
  street: "114 Rosewood Lane",
  city: "Asheville",
  state: "North Carolina",
  postal_code: "28801",
  linkedin: "https://linkedin.com/in/danarivera",
  github: "https://github.com/danarivera",
  "cred-email": "dana@example.test",
  "cred-password": "unique-to-applications",
  about: "I build reliable backend systems and care about developer tooling.",
};

test("first-run setup produces a usable profile", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-setup-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${join(ROOT, "extension")}`, `--load-extension=${join(ROOT, "extension")}`],
  });
  t.after(() => ctx.close());

  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
  const id = sw.url().split("/")[2];

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/src/options/setup.html`, { waitUntil: "domcontentloaded" });

  const visibleStep = () =>
    page.evaluate(() => document.querySelector(".step.active")?.dataset.step ?? null);

  await t.test("it opens on the welcome step, with nowhere to go back to", async () => {
    assert.equal(await visibleStep(), "welcome");
    assert.equal(await page.locator("#back").isDisabled(), true);
  });

  // Walk the whole wizard, answering whatever the current step exposes.
  const seen = [];
  for (let guard = 0; guard < 30; guard++) {
    const step = await visibleStep();
    seen.push(step);
    for (const [field, answer] of Object.entries(ANSWERS)) {
      const input = page.locator(`.step.active #${field}`);
      if (await input.count()) await input.fill(answer);
    }
    if (step === "done") break;
    await page.click("#next");
    await page.waitForTimeout(120);
  }

  await t.test("every step is reachable in order", () => {
    assert.deepEqual(seen, [
      "welcome",
      "identity",
      "address",
      "links",
      "eligibility",
      "demographics",
      "documents",
      "about",
      "credentials",
      "model",
      "done",
    ]);
  });

  await t.test("the final step describes what was actually saved", async () => {
    const summary = await page.locator("#summary").textContent();
    assert.match(summary, /Dana Rivera/);
    assert.match(summary, /Asheville/);
    assert.match(summary, /no résumé stored/, "it admits what is missing rather than implying success");
  });

  // Finish closes its own tab, so the click races the page going away and
  // anything read from the page must already have happened above.
  await page.click("#next").catch(() => {});
  const stored = await sw.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      const out = await chrome.storage.local.get([
        "profile",
        "about",
        "credentials",
        "settings",
        "setupComplete",
      ]);
      if (out.setupComplete) return out;
      await new Promise((r) => setTimeout(r, 50));
    }
    return chrome.storage.local.get(["profile", "about", "credentials", "settings", "setupComplete"]);
  });

  await t.test("contact details are stored as separate address parts", () => {
    const loc = stored.profile.identity.location;
    assert.equal(stored.profile.identity.full_name, "Dana Rivera");
    assert.equal(stored.profile.identity.email, "dana@example.test");
    assert.equal(loc.street, "114 Rosewood Lane");
    assert.equal(loc.city, "Asheville");
    assert.equal(loc.postal_code, "28801");
    assert.equal(loc.country, "United States", "the country default carries through");
  });

  await t.test("voluntary disclosures reach storage as real answers", () => {
    // Not blank: a blank here is what lets a model make one up.
    const d = stored.profile.demographics;
    assert.equal(d.gender, "Prefer not to say");
    assert.equal(d.hispanic_latino, "Prefer not to say");
    assert.equal(d.race_ethnicity, "Prefer not to say");
    assert.ok(d.veteran_status, "veteran status is set");
    assert.ok(d.disability_status, "disability status is set");
  });

  await t.test("credentials are stored apart from the profile", () => {
    assert.equal(stored.credentials.password, "unique-to-applications");
    assert.equal(
      JSON.stringify(stored.profile).includes("unique-to-applications"),
      false,
      "a password inside the profile could be summarised into a prompt"
    );
  });

  await t.test("setup is not offered again", () => {
    assert.equal(stored.setupComplete, true);
  });

  await t.test("the profile it built actually fills an application form", () => {
    // The real measure of the wizard: hand its output to the validator and
    // check a form comes back answered, with the disclosures pinned.
    const schema = schemaOf(
      { id: "f0", label: "First Name", type: "text" },
      { id: "f1", label: "Email Address", type: "text" },
      { id: "f2", label: "Address Line 1", type: "text" },
      { id: "f3", label: "City", type: "text" },
      { id: "f4", label: "Postal Code", type: "text" },
      { id: "f5", label: "Gender", type: "text" },
      { id: "f6", label: "Are you legally authorized to work in the US?", type: "text" },
      { id: "f7", label: "Will you require sponsorship?", type: "text" }
    );
    const { fills } = validate({}, schema, stored.profile, {}, {});
    assert.deepEqual(fills, {
      f0: "Dana",
      f1: "dana@example.test",
      f2: "114 Rosewood Lane",
      f3: "Asheville",
      f4: "28801",
      f5: "Prefer not to say",
      f6: "Yes",
      f7: "No",
    });
  });
});
