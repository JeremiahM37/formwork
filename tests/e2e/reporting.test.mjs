/**
 * What the review screen says is on the form.
 *
 * This is the screen a person reads before pressing Submit, so its whole job is
 * to be trusted. It once reported every equal-opportunity question as answered
 * "on" — because that is a radio's `value` attribute whether or not it is the
 * one chosen — so a Crusoe application correctly set to "Decline to
 * self-identify" was displayed as "Male", and one saying "I am not a protected
 * veteran" was displayed as claiming the opposite. Nothing was wrong with the
 * form; everything was wrong with the description of it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/load.mjs";
import { collect } from "../../server/dashboard/drive.mjs";

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

const FORM = `
  <form>
    <label for="name">Full Name</label><input id="name" type="text" value="Dana Rivera">
    <fieldset>
      <label>Gender</label>
      <div><input type="radio" id="g0" name="gender"><label for="g0">Male</label></div>
      <div><input type="radio" id="g1" name="gender"><label for="g1">Female</label></div>
      <div><input type="radio" id="g2" name="gender" checked><label for="g2">Decline to self-identify</label></div>
    </fieldset>
    <fieldset>
      <label>Veteran Status</label>
      <div><input type="radio" id="v0" name="vet"><label for="v0">I identify as a protected veteran</label></div>
      <div><input type="radio" id="v1" name="vet" checked><label for="v1">I am not a protected veteran</label></div>
    </fieldset>
    <fieldset>
      <label>Consent</label>
      <div><input type="radio" id="c0" name="consent"><label for="c0">Yes</label></div>
      <div><input type="radio" id="c1" name="consent"><label for="c1">No</label></div>
    </fieldset>
    <fieldset>
      <label>Interests</label>
      <div><input type="checkbox" id="i0" name="interest" checked><label for="i0">Backend</label></div>
      <div><input type="checkbox" id="i1" name="interest" checked><label for="i1">Infrastructure</label></div>
      <div><input type="checkbox" id="i2" name="interest"><label for="i2">Frontend</label></div>
    </fieldset>
  </form>`;

test("reporting what a form actually says", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(FORM);
  for (const file of ["scrape.js", "fill.js"]) {
    await page.addScriptTag({
      content: readFileSync(join(ROOT, "extension", "src", "content", file), "utf8"),
    });
  }
  // Stand in for a fill having happened: collect() describes whatever the last
  // scrape found, so a scrape is all it needs.
  await page.evaluate(() => {
    const ns = window.__formwork;
    ns._last = { scraped: ns.scrape(), result: { fills: {}, review: [], staged: [], dropped: [] } };
  });

  const report = await page.evaluate(collect);
  const say = (label) => report.fields.find((f) => f.label === label);

  await t.test("a chosen radio reads as the option it chose", () => {
    assert.equal(say("Gender").value, "Decline to self-identify");
    assert.equal(say("Veteran Status").value, "I am not a protected veteran");
  });

  await t.test("never the word 'on'", () => {
    // A radio's value attribute is "on" whether or not it is the chosen one.
    for (const field of report.fields) {
      assert.notEqual(field.value, "on", `${field.label} reported as "on"`);
    }
  });

  await t.test("a group with nothing chosen reads as blank", () => {
    assert.equal(say("Consent").value, "");
  });

  await t.test("several ticked boxes are all reported", () => {
    assert.equal(say("Interests").value, "Backend, Infrastructure");
  });

  await t.test("a text field still reads as its text", () => {
    assert.equal(say("Full Name").value, "Dana Rivera");
  });

  await t.test("the report is serialisable, since it crosses a process boundary", () => {
    assert.doesNotThrow(() => JSON.stringify(report));
    assert.equal(report.ready, true);
    assert.equal(report.filled, true);
  });
});

test("reporting a page that has not been filled", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(FORM);
  for (const file of ["scrape.js", "fill.js"]) {
    await page.addScriptTag({
      content: readFileSync(join(ROOT, "extension", "src", "content", file), "utf8"),
    });
  }
  const report = await page.evaluate(collect);
  // Not the same thing as an empty form, and the dashboard has to tell them
  // apart: one is waiting for a fill, the other is a fill that found nothing.
  assert.equal(report.ready, true);
  assert.equal(report.filled, false);
});
