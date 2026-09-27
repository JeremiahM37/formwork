/**
 * Which control the dashboard would press to send an application.
 *
 * The most consequential decision in the project: get it wrong one way and an
 * application is sent by something that was not the Submit button; get it
 * wrong the other and Submit does nothing while claiming to have worked. Every
 * case below is a control that really appears on application forms next to the
 * real one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ROOT } from "../helpers/load.mjs";
import { findSubmitControl } from "../../server/dashboard/drive.mjs";

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
void join, void ROOT;

test("finding the control that sends an application", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();

  const look = async (body) => {
    await page.setContent(`<style>button,input{display:block;width:160px;height:32px}</style>${body}`);
    return page.evaluate(findSubmitControl);
  };

  await t.test("finds a plain submit button", async () => {
    const seen = await look(`<form><button type="submit">Submit application</button></form>`);
    assert.equal(seen.found, true);
    assert.equal(seen.disabled, false);
    assert.equal(seen.text, "Submit application");
  });

  await t.test("finds an input styled as one", async () => {
    const seen = await look(`<form><input type="submit" value="Submit"></form>`);
    assert.equal(seen.found, true);
    assert.equal(seen.text, "Submit");
  });

  await t.test("finds a div that says it is a button", async () => {
    const seen = await look(`<form><div role="button">Apply now</div></form>`);
    assert.equal(seen.found, true);
    assert.equal(seen.text, "Apply now");
  });

  await t.test("marks what it found, so the click cannot land elsewhere", async () => {
    await look(`<form><button>Cancel</button><button type="submit">Submit</button></form>`);
    const marked = await page.locator('[data-formwork-submit="1"]').textContent();
    assert.equal(marked, "Submit");
  });

  await t.test("reports a disabled control rather than pressing it", async () => {
    // A disabled Submit means the form is not complete. Saying so beats
    // clicking nothing and reporting success.
    const seen = await look(`<form><button type="submit" disabled>Submit application</button></form>`);
    assert.equal(seen.found, true);
    assert.equal(seen.disabled, true);
  });

  await t.test("refuses everything that is not a submission", async () => {
    for (const label of [
      "Save for later",
      "Add another",
      "Save draft",
      "Back",
      "Cancel",
      "Sign up for job alerts",
      "Submit a question",
      "Apply with LinkedIn",
      "Upload",
    ]) {
      const seen = await look(`<form><button type="submit">${label}</button></form>`);
      assert.equal(seen.found, false, `pressed "${label}"`);
    }
  });

  await t.test("refuses a control too small to be a real one", async () => {
    const seen = await look(
      `<form><button type="submit" style="width:2px;height:2px">Submit</button></form>`
    );
    assert.equal(seen.found, false);
  });

  await t.test("takes the one inside the form over one outside it", async () => {
    const seen = await look(
      `<button type="submit">Apply</button>
       <form><button type="submit">Submit application</button></form>`
    );
    assert.equal(seen.text, "Submit application");
  });

  await t.test("still looks when a page has no form element at all", async () => {
    const seen = await look(`<div><button type="button">Submit application</button></div>`);
    assert.equal(seen.found, true);
  });

  await t.test("finds nothing on a page that has nothing", async () => {
    const seen = await look(`<form><input type="text" name="q"></form>`);
    assert.equal(seen.found, false);
    assert.equal(seen.disabled, undefined);
  });
});
