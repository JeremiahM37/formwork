/**
 * "Filled" has to mean confirmed present on the page.
 *
 * The panel's counts and the dashboard's review screen are both read by
 * somebody deciding whether to send an application, so a field reported as
 * filled and actually empty is the worst kind of wrong: it is the one nobody
 * checks. Widgets revert what is written to them for all sorts of reasons —
 * a controlled React input rejecting a synthetic event, a field with a length
 * cap, a page still hydrating — and some of them do it a moment later rather
 * than immediately.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("a field that did not take the value is not reported as filled", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <label for="ok">Normal</label><input id="ok" type="text">
      <label for="revert">Reverts immediately</label><input id="revert" type="text">
      <label for="late">Reverts a moment later</label><input id="late" type="text">
      <label for="trim">Trims what you type</label><input id="trim" type="text">
      <label for="replace">Rejects everything</label><input id="replace" type="text">
    </form>
    <script>
      const on = (id, fn) => document.getElementById(id).addEventListener("input", fn);
      on("revert", (e) => { e.target.value = ""; });
      on("late", (e) => { setTimeout(() => { e.target.value = ""; }, 120); });
      on("trim", (e) => { e.target.value = e.target.value.slice(0, 5); });
      on("replace", (e) => { e.target.value = "NOPE"; });
    </script>`);
  for (const file of ["scrape.js", "fill.js"]) {
    await page.addScriptTag({
      content: readFileSync(join(ROOT, "extension", "src", "content", file), "utf8"),
    });
  }

  const seen = await page.evaluate(async () => {
    const ns = window.__formwork;
    const { schema, registry } = ns.scrape();
    const byId = Object.fromEntries(schema.fields.map((f) => [f.id, f.label]));
    const value = "Exampletown, Exampleland";
    const report = await ns.fill(
      Object.fromEntries(schema.fields.map((f) => [f.id, value])),
      schema,
      registry,
      {}
    );
    return {
      filled: (report.filled || []).map((id) => byId[id]),
      failed: (report.failed || []).map((f) => byId[f.id]),
      reasons: Object.fromEntries((report.failed || []).map((f) => [byId[f.id], String(f.reason)])),
      onPage: Object.fromEntries(
        ["ok", "revert", "late", "trim", "replace"].map((id) => [id, document.getElementById(id).value])
      ),
    };
  });

  await t.test("an ordinary field is filled and says so", () => {
    assert.deepEqual(seen.filled, ["Normal"]);
    assert.equal(seen.onPage.ok, "Exampletown, Exampleland");
  });

  await t.test("a field that threw the value away is reported failed", () => {
    assert.ok(seen.failed.includes("Reverts immediately"));
    assert.equal(seen.onPage.revert, "");
  });

  await t.test("a field that kept only part of it is reported failed", () => {
    // Half a value is not a value. "Examp" is not a complete location.
    assert.ok(seen.failed.includes("Trims what you type"));
    assert.equal(seen.onPage.trim, "Examp");
  });

  await t.test("a field that substituted its own value is reported failed", () => {
    assert.ok(seen.failed.includes("Rejects everything"));
  });

  await t.test("a field that reverted after the write is caught too", () => {
    // The page is re-read once it has settled, because widgets revert
    // asynchronously and a check that ran immediately would believe them.
    assert.ok(seen.failed.includes("Reverts a moment later"), "an async revert passed as filled");
    assert.match(seen.reasons["Reverts a moment later"], /did not survive/);
    assert.equal(seen.onPage.late, "");
  });

  await t.test("nothing is both filled and failed", () => {
    for (const label of seen.filled) {
      assert.ok(!seen.failed.includes(label), `${label} appears in both`);
    }
  });
});
