/**
 * Options must belong to the field they were read from.
 *
 * Workday renders each dropdown's popup in a portal at the end of <body>, so
 * the scraper cannot find "this widget's listbox" by walking the tree. Taking
 * the first open one instead made Country and State both report the phone-code
 * widget's two entries on a Workday application fixture: State could not be
 * answered, and the failure mode in general is worse than that — a value gets
 * chosen from a different question's list.
 *
 * Needs a real browser: the bug is entirely about which element is found among
 * several live, portalled popups.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, lib, profile } from "../helpers/load.mjs";

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

test("portalled dropdowns keep their own options", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const html = readFileSync(join(ROOT, "tests", "fixtures", "portal-select.html"));
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-portal-")), {
    channel: "chromium",
    headless: true,
  });
  t.after(async () => {
    await ctx.close();
    server.close();
  });

  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  for (const f of ["scrape.js", "fill.js"]) {
    await page.addScriptTag({ content: readFileSync(join(ROOT, "extension", "src", "content", f), "utf8") });
  }

  const scraped = await page.evaluate(async () => {
    const ns = globalThis.__formwork;
    const { schema, registry } = await ns.scrapeFull();
    globalThis.__schema = schema;
    globalThis.__registry = registry;
    const byLabel = {};
    for (const f of schema.fields) byLabel[f.label] = ns._options[f.id] || f.options || [];
    return { byLabel, labels: schema.fields.map((f) => f.label), full: ns._options, schema };
  });

  await t.test("button-based dropdowns are seen at all", () => {
    assert.deepEqual(scraped.labels, ["Phone Device Type", "Country", "State"]);
  });

  await t.test("each field reports its own list, not a neighbour's", () => {
    assert.deepEqual(scraped.byLabel["Phone Device Type"], ["Mobile", "Home", "Work"]);
    assert.deepEqual(scraped.byLabel["Country"], ["Canada", "United States of America", "Mexico"]);
    assert.deepEqual(scraped.byLabel["State"], ["Alabama", "North Carolina", "Wyoming"]);
  });

  await t.test("a stale open popup does not leak into every later field", () => {
    // The phone-type popup starts open. Before the fix, Country and State both
    // came back as ["Mobile", "Home", "Work"].
    assert.notDeepEqual(scraped.byLabel["State"], scraped.byLabel["Phone Device Type"]);
    assert.notDeepEqual(scraped.byLabel["Country"], scraped.byLabel["Phone Device Type"]);
  });

  await t.test("and the profile's answers actually reach the widgets", async () => {
    const p = profile();
    const { fills, review } = validate({}, scraped.schema, p, scraped.full, {});
    assert.deepEqual(review, [], "nothing should need review here");

    const shown = await page.evaluate(
      async ([fillMap]) => {
        const ns = globalThis.__formwork;
        await ns.fill(fillMap, globalThis.__schema, globalThis.__registry, {
          review: [],
          files: {},
          keepExisting: true,
        });
        const text = (id) => document.getElementById(id).textContent.trim();
        return { type: text("phone-type"), country: text("country"), state: text("state") };
      },
      [fills]
    );

    assert.equal(shown.type, "Mobile");
    assert.equal(shown.country, "United States of America");
    assert.equal(shown.state, p.identity.location.state);
  });

  await t.test("no popup is left open once filling is done", () => {
    // An open menu covers the rest of the form, so later fields cannot be
    // filled and the page's own "continue" control cannot be reached.
    return page.evaluate(() => {
      const open = [...document.querySelectorAll('[role="listbox"]')].filter((l) => !l.hidden);
      if (open.length) throw new Error(`${open.length} listbox(es) left open: ${open.map((l) => l.id)}`);
    });
  });
});

/**
 * Composite widgets: a control the user never touches directly.
 *
 * A date field is a group of zero-size segment inputs behind a visible
 * stand-in, and its caption sits outside the group. Measuring the input says
 * nothing, and counting its sibling segments as separate controls stops the
 * label search before it reaches the caption — which dropped Workday's "From"
 * and "To" from the schema entirely, the two fields it will not proceed
 * without.
 */
test("segmented date widgets are scraped and labelled", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-dates-")), {
    channel: "chromium",
    headless: true,
  });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  await page.setContent(`
    <h3>Education</h3>
    <div data-automation-id="formField-firstYearAttended">
      <label id="lbl-from">From*</label>
      <div role="group" aria-labelledby="lbl-from" style="width:52px;height:40px">
        <span aria-hidden="true">YYYY</span>
        <input role="spinbutton" aria-label="Year" style="position:absolute;width:0.09px;height:0.22px" />
        <span style="position:absolute;width:1px;height:1px">use right and left arrows to navigate</span>
      </div>
    </div>
    <h3>Work Experience</h3>
    <div data-automation-id="formField-jobStart">
      <label id="lbl-job">From*</label>
      <div role="group" aria-labelledby="lbl-job" style="width:52px;height:40px">
        <input role="spinbutton" aria-label="Year" style="position:absolute;width:0.09px;height:0.22px" />
      </div>
    </div>
  `);
  await page.addScriptTag({ content: readFileSync(join(ROOT, "extension", "src", "content", "scrape.js"), "utf8") });

  const fields = await page.evaluate(() => globalThis.__formwork.scrape().schema.fields);

  await t.test("the segment is seen despite being a fraction of a pixel", () => {
    assert.equal(fields.length, 2, `expected both date fields: ${JSON.stringify(fields.map((f) => f.label))}`);
  });

  await t.test("it takes the caption, not the segment name or the placeholder", () => {
    // "Year" names the segment, "YYYY" is the shape of the answer, and the
    // arrow-key text is an instruction. None of them is the question.
    for (const f of fields) assert.equal(f.label, "From", JSON.stringify(fields));
  });

  await t.test("each carries the section that tells the two apart", () => {
    assert.deepEqual(
      fields.map((f) => f.section),
      ["Education", "Work Experience"]
    );
  });
});

/**
 * Mutually exclusive choices that share no `name`.
 *
 * Workday's disability question is three checkboxes with no name attribute at
 * all, so name-based grouping left each option as its own field — labelled
 * with its own text, which makes the answer read as the question, and with no
 * way to express "pick one of these three".
 */
test("choices that share a container are one question", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-choices-")), {
    channel: "chromium",
    headless: true,
  });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  await page.setContent(`
    <h3>Voluntary Self-Identification of Disability</h3>
    <div role="group" data-automation-id="formField-disability">
      <label><input type="checkbox" id="d1" /> Yes, I have a disability</label>
      <label><input type="checkbox" id="d2" /> No, I do not have a disability</label>
      <label><input type="checkbox" id="d3" /> I do not want to answer</label>
    </div>
    <div data-automation-id="formField-terms">
      <label><input type="checkbox" id="terms" /> I agree to the terms</label>
    </div>
  `);
  await page.addScriptTag({ content: readFileSync(join(ROOT, "extension", "src", "content", "scrape.js"), "utf8") });
  const fields = await page.evaluate(() => globalThis.__formwork.scrape().schema.fields);

  await t.test("the three options become one question with three answers", () => {
    const group = fields.find((f) => f.type === "checkbox-group");
    assert.ok(group, `expected a grouped question: ${JSON.stringify(fields.map((f) => [f.label, f.type]))}`);
    assert.equal(group.options.length, 3);
  });

  await t.test("the question is not labelled with its own first answer", () => {
    const group = fields.find((f) => f.type === "checkbox-group");
    assert.equal(group.options.includes(group.label), false, `labelled "${group.label}"`);
    assert.match(group.label, /disability/i);
  });

  await t.test("a lone checkbox stays a question of its own", () => {
    // An agreement is not one option among several, and grouping it away
    // would lose the only field on the form the user must actively accept.
    const terms = fields.find((f) => /agree to the terms/i.test(f.label));
    assert.ok(terms, "the terms box survived as its own field");
    assert.equal(terms.type, "checkbox");
  });
});

/**
 * An autocomplete that resets itself when focused.
 *
 * Lever's location field attaches its place lookup on focus and blanks the
 * input doing so. Focused, the same keystrokes leave it empty with no
 * suggestions; unfocused, they produce a match. It also ignores a value
 * assigned in one go — it watches for keystrokes, not for its value changing.
 *
 * Both together are why this field failed on every Lever form we tried.
 */
test("an autocomplete that resets on focus is still filled", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-autocomplete-")), {
    channel: "chromium",
    headless: true,
  });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  await page.setContent(`
    <label for="loc">Current location</label>
    <input id="loc" name="location" type="text" />
    <div id="menu"></div>
    <script>
      const input = document.getElementById("loc");
      const menu = document.getElementById("menu");
      // Blanks itself on focus, as Lever's does when its lookup attaches.
      input.addEventListener("focus", () => { input.value = ""; menu.innerHTML = ""; });
      // Only reacts to keystrokes, never to a value simply appearing.
      let typed = 0;
      input.addEventListener("keyup", () => { typed++; });
      input.addEventListener("input", () => {
        if (!typed) { input.value = ""; return; }
        menu.innerHTML = input.value.length > 3
          ? '<div class="suggestion">' + input.value + ", MT, USA</div>"
          : "";
      });
      menu.addEventListener("click", (e) => {
        if (!e.target.classList.contains("suggestion")) return;
        input.value = e.target.textContent;
      });
    </script>
  `);
  for (const f of ["scrape.js", "fill.js"]) {
    await page.addScriptTag({ content: readFileSync(join(ROOT, "extension", "src", "content", f), "utf8") });
  }

  const result = await page.evaluate(async () => {
    const ns = globalThis.__formwork;
    const { schema, registry } = await ns.scrapeFull();
    const field = schema.fields.find((f) => /current location/i.test(f.label));
    const out = await ns.fill({ [field.id]: "Asheville, North Carolina" }, schema, registry, {
      review: [],
      files: {},
      keepExisting: true,
    });
    return { filled: out.filled.length, failed: out.failed, value: document.getElementById("loc").value };
  });

  await t.test("the value lands despite the widget fighting it", () => {
    assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
    assert.equal(result.filled, 1);
  });

  await t.test("and it is the suggestion, not raw text the widget would discard", () => {
    assert.match(result.value, /Asheville/);
  });
});

/**
 * A date split across segments.
 *
 * The widget holds month, day and year in separate zero-size inputs behind a
 * visible stand-in, and reports "Invalid Date: 08//" if only some are set —
 * an error it keeps showing even after the value is corrected. So the write
 * is all-or-nothing.
 */
test("a segmented date is written whole or not at all", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-datefill-")), {
    channel: "chromium",
    headless: true,
  });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const markup = (labels) => `
    <h3>Self Identify</h3>
    <div data-automation-id="formField-signed">
      <label id="lbl">Date</label>
      <div role="group" aria-labelledby="lbl" style="width:120px;height:40px">
        ${labels
          .map((l) => `<input role="spinbutton" aria-label="${l}" style="position:absolute;width:0.09px;height:0.22px" />`)
          .join("")}
      </div>
    </div>`;

  await page.setContent(markup(["Month", "Day", "Year"]));
  for (const f of ["scrape.js", "fill.js"]) {
    await page.addScriptTag({ content: readFileSync(join(ROOT, "extension", "src", "content", f), "utf8") });
  }
  const whole = await page.evaluate(async () => {
    const ns = globalThis.__formwork;
    const { schema, registry } = await ns.scrapeFull();
    const f = schema.fields.find((x) => x.type === "date");
    const out = await ns.fill({ [f.id]: "8/14/2026" }, schema, registry, { review: [], files: {}, keepExisting: true });
    return { failed: out.failed.length, values: [...document.querySelectorAll("input")].map((i) => i.value) };
  });

  await t.test("every segment gets its own part", () => {
    assert.equal(whole.failed, 0);
    assert.deepEqual(whole.values, ["08", "14", "2026"]);
  });

  // A widget whose segments announce nothing recognisable cannot be split up.
  await page.setContent(markup(["Part A", "Part B", "Part C"]));
  for (const f of ["scrape.js", "fill.js"]) {
    await page.addScriptTag({ content: readFileSync(join(ROOT, "extension", "src", "content", f), "utf8") });
  }
  const partial = await page.evaluate(async () => {
    const ns = globalThis.__formwork;
    const { schema, registry } = await ns.scrapeFull();
    const f = schema.fields.find((x) => x.type === "date");
    const out = await ns.fill({ [f.id]: "8/14/2026" }, schema, registry, { review: [], files: {}, keepExisting: true });
    return { failed: out.failed.length, values: [...document.querySelectorAll("input")].map((i) => i.value) };
  });

  await t.test("an undecipherable widget is left untouched, not half-filled", () => {
    assert.equal(partial.failed, 1, "it reports the failure");
    assert.deepEqual(partial.values, ["", "", ""], "and writes nothing at all");
  });
});
