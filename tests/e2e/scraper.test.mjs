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

test("a dropdown class on the caption does not hide the university question", {skip:!chromium}, async t=>{
  const browser=await chromium.launch({channel:'chromium',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent('<div><div class="application-label full-width dropdown"><div class="text">Which university are you currently attending or did you last attend?</div></div><div class="application-field"><div class="application-dropdown"><select name="cards[abc][field0]" required><option value="">Choose</option><option>Other (School Not Listed)</option></select></div></div></div>');
  await page.addScriptTag({path:join(ROOT,'extension/src/content/scrape.js')});
  const fields=await page.evaluate(()=>window.__formwork.scrape().schema.fields);
  assert.equal(fields[0].label,'Which university are you currently attending or did you last attend?');
});

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

test(
  "a radio group is named by its question, not by its first choice",
  { skip: chromium ? false : "playwright not installed" },
  async (t) => {
    // Ashby marks the EEO questions up as a fieldset with no legend, holding a
    // <label> for the question and one <label> per choice. Searching up the
    // tree for the nearest label finds the choice, so the gender question came
    // back called "Male" and the veteran question came back called "I identify
    // as one or more of the classifications of protected veteran listed above".
    // The answers were still right — they match against the option list — but
    // the panel and the review screen both showed a question that was not the
    // question, on the one part of a form where that is most alarming.
    const html = `<!doctype html><meta charset="utf-8"><body><form>
      <fieldset>
        <label class="heading">Gender</label>
        <div class="description">Input gender</div>
        <div class="option"><span><input type="radio" id="g0" name="eeoc_gender"></span><label for="g0">Male</label></div>
        <div class="option"><span><input type="radio" id="g1" name="eeoc_gender"></span><label for="g1">Female</label></div>
        <div class="option"><span><input type="radio" id="g2" name="eeoc_gender"></span><label for="g2">Decline to self-identify</label></div>
      </fieldset>
    </form></body>`;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    });
    const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

    const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-radio-")), {
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
      const { schema } = globalThis.__formwork.scrape();
      return schema.fields.filter((f) => f.type === "radio");
    });

    assert.equal(seen.length, 1, "the three radios are one question");
    assert.equal(seen[0].label, "Gender");
    assert.deepEqual(seen[0].options, ["Male", "Female", "Decline to self-identify"]);
  }
);

test(
  "a list read only in part says so",
  { skip: chromium ? false : "playwright not installed" },
  async (t) => {
    // The difference between a list we have all of and a list we have the top
    // of decides whether a value may be matched against it at all. Without it,
    // "Example State University" was placed in a school list that had only been
    // read as far as the A's, and came back "Alabama State University".
    const menu = (total, windowRows) => `
      <label for="c">School</label>
      <input id="c" role="combobox" aria-controls="menu" aria-expanded="false" type="text">
      <div id="menu" role="listbox" hidden style="height:60px;overflow:auto;position:relative"></div>
      <script>
        const ALL = Array.from({length: ${total}}, (_, i) => "School " + String(i).padStart(4,"0"));
        const input = document.getElementById("c"), box = document.getElementById("menu");
        const inner = document.createElement("div");
        inner.style.height = (ALL.length * 20) + "px";
        inner.style.position = "relative";
        box.append(inner);
        function draw() {
          const first = Math.floor(box.scrollTop / 20);
          inner.innerHTML = "";
          for (let i = first; i < Math.min(first + ${windowRows}, ALL.length); i++) {
            const n = document.createElement("div");
            n.setAttribute("role", "option");
            n.textContent = ALL[i];
            n.style.position = "absolute";
            n.style.top = (i * 20) + "px";
            n.style.height = "20px";
            inner.append(n);
          }
        }
        box.addEventListener("scroll", draw);
        input.addEventListener("mousedown", () => {
          box.hidden = false;
          input.setAttribute("aria-expanded", "true");
          draw();
        });
      </script>`;

    const browser = await chromium.launch();
    t.after(() => browser.close());
    const scrapeSource = readFileSync(join(ROOT, "extension", "src", "content", "scrape.js"), "utf8");

    const read = async (total, windowRows) => {
      // A fresh page each time: the content script initialises once, and a
      // reused one would report the previous page's options.
      const page = await browser.newPage();
      await page.setContent(menu(total, windowRows));
      await page.addScriptTag({ content: scrapeSource });
      const seen = await page.evaluate(async () => {
        const ns = window.__formwork;
        const { schema, registry } = ns.scrape();
        await ns.expandOptions(schema, registry);
        const field = schema.fields.find((f) => f.label === "School");
        return {
          inline: (field.options || []).length,
          truncated: Boolean(field.optionsTruncated),
          partial: Boolean(field.optionsPartial),
          read: (ns._options[field.id] || []).length,
        };
      });
      await page.close();
      return seen;
    };

    await t.test("a short list is read whole and flagged as neither", async () => {
      const seen = await read(12, 12);
      assert.equal(seen.read, 12);
      assert.equal(seen.truncated, false);
      assert.equal(seen.partial, false);
    });

    await t.test("a long list read to the end is truncated but not partial", async () => {
      // Truncated is about what the *model* was shown; partial is about what
      // could be read off the page. Only the second forbids matching.
      const seen = await read(60, 60);
      assert.equal(seen.read, 60);
      assert.equal(seen.truncated, true);
      assert.equal(seen.partial, false);
    });

    await t.test("a virtualised list that could not be read to the end is partial", async () => {
      const seen = await read(5000, 4);
      assert.ok(seen.read > 0 && seen.read < 5000, `read ${seen.read} of 5000`);
      assert.equal(seen.partial, true);
    });
  }
);
