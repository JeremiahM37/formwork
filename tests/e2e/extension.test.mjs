/**
 * End-to-end: the real extension, in real Chromium, against a served form.
 *
 * Offline and deterministic — the harness serves both the fixture page and a
 * stub provider endpoint, so the run exercises every shipped layer (content
 * scripts, service worker, storage, panel) without a model or the network.
 *
 * Requires Chromium and Playwright:
 *     npm install --save-dev playwright && npx playwright install chromium
 * The whole file skips cleanly when Playwright is absent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, profile } from "../helpers/load.mjs";

/** Playwright is an optional dev dependency; PW_MODULE allows an out-of-tree install. */
async function loadPlaywright() {
  for (const spec of [process.env.PW_MODULE, "playwright", "playwright-core"].filter(Boolean)) {
    try {
      return (await import(spec)).chromium;
    } catch {
      /* try the next */
    }
  }
  return null;
}

const chromium = await loadPlaywright();

/** What the stub provider claims the model returned, by field label. */
const MODEL_ANSWERS = {
  "How did you hear about this job? *": "LinkedIn",
  "Do you now or will you in the future require immigration sponsorship? *": "Yes", // wrong on purpose
  Gender: "Male", // fabricated on purpose
  "Acknowledge/Confirm": "true",
};

/** Slice the first balanced `[...]` at or after `from`. */
function balancedArray(text, from) {
  const start = text.indexOf("[", from);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("no balanced array in prompt");
}

/**
 * Serve the fixture form and a stub of the homelab provider endpoint.
 * The stub maps by label so it stays correct if field ids shift.
 */
function startHarness() {
  const form = readFileSync(join(ROOT, "tests", "fixtures", "form.html"));
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/jobfill/complete") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { messages, json } = JSON.parse(body);
        const prompt = messages.map((m) => m.content).join("\n");
        let content = "A short drafted answer about distributed systems work.";
        if (json) {
          // Recover each field's id from the prompt the extension built. The
          // array is followed by more instructions, so take only the balanced
          // brackets rather than everything after the heading.
          const fields = JSON.parse(balancedArray(prompt, prompt.indexOf("FORM FIELDS")));
          const map = {};
          for (const f of fields) {
            if (MODEL_ANSWERS[f.label] !== undefined) map[f.id] = MODEL_ANSWERS[f.label];
          }
          content = JSON.stringify(map);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content, model: "stub" }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(form);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Copy the extension and widen it to the test origin.
 *
 * Chrome match patterns ignore ports, so `http://localhost/*` covers whatever
 * ephemeral port the harness lands on. Only the origin is added — everything
 * else is the shipped manifest.
 */
function stageExtension() {
  const dir = mkdtempSync(join(tmpdir(), "formwork-ext-"));
  cpSync(join(ROOT, "extension"), dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions.push("http://localhost/*", "http://127.0.0.1/*");
  manifest.content_scripts[0].matches.push("http://localhost/*", "http://127.0.0.1/*");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

/** Read the panel's shadow DOM from the page's main world. */
const readPanel = () => {
  for (const node of document.documentElement.children) {
    const root = node.shadowRoot;
    if (!root?.querySelector(".panel")) continue;
    return {
      status: root.querySelector("header .sub").textContent,
      stats: [...root.querySelectorAll(".stat span")].map((s) => s.textContent.trim()),
      sections: [...root.querySelectorAll(".sect h4")].map((h) => h.textContent),
      corrections: [...root.querySelectorAll(".sect")]
        .filter((s) => /CORRECTED/i.test(s.querySelector("h4")?.textContent || ""))
        .flatMap((s) => [...s.querySelectorAll("li")].map((li) => li.textContent)),
      drafts: [...root.querySelectorAll(".draft")].map((d) => ({
        question: d.querySelector(".q").textContent,
        words: d.querySelector("textarea").value.split(/\s+/).filter(Boolean).length,
        state: d.querySelector(".pending, .ok, .err")?.textContent ?? null,
      })),
    };
  }
  return null;
};

test("extension fills a real form end to end", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const { server, port } = await startHarness();
  const extDir = stageExtension();
  const userDir = mkdtempSync(join(tmpdir(), "formwork-profile-"));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  t.after(async () => {
    await ctx.close();
    server.close();
  });

  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));

  // Seed exactly what the options page would have saved, including a résumé.
  await sw.evaluate(
    async ([prof, base]) => {
      await chrome.storage.local.set({
        profile: prof,
        about: "I maintain an offline-first map tile server in my spare time.",
        bank: [],
        documents: {
          resume: {
            name: "dana-rivera-resume.pdf",
            type: "application/pdf",
            dataUrl: "data:application/pdf;base64,JVBERi0xLjQKJUZvcm13b3JrIHRlc3QK",
          },
        },
        settings: { provider: "homelab", autoApprove: false, homelab: { baseUrl: base } },
      });
    },
    [profile(), `http://127.0.0.1:${port}`]
  );

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`http://localhost:${port}/form.html`, { waitUntil: "domcontentloaded" });

  await page.waitForFunction(
    () => [...document.documentElement.children].some((n) => n.shadowRoot?.querySelector(".panel")),
    null,
    { timeout: 15000 }
  );

  await page.evaluate(() => {
    for (const node of document.documentElement.children) {
      const btn = node.shadowRoot?.querySelector("button");
      if (btn && /Fill this form/.test(btn.textContent)) btn.click();
    }
  });
  await page.waitForFunction(
    () =>
      [...document.documentElement.children].some((n) =>
        /filled|failed/.test(n.shadowRoot?.querySelector("header .sub")?.textContent || "")
      ),
    null,
    { timeout: 60000 }
  );

  const panel = await page.evaluate(readPanel);
  const form = await page.evaluate(() => ({
    first: document.getElementById("first").value,
    last: document.getElementById("last").value,
    email: document.getElementById("email").value,
    phone: document.getElementById("phone").value,
    linkedin: document.getElementById("linkedin").value,
    github: document.getElementById("github").value,
    hear: document.getElementById("hear").value,
    loc: document.getElementById("loc").value,
    // Combobox selections render into a sibling node, not the input.
    sponsorship: document.querySelector('[data-combobox="sponsorship"] .select__single-value')?.textContent ?? "",
    gender: document.querySelector('[data-combobox="gender"] .select__single-value')?.textContent ?? "",
    veteran: document.querySelector('input[name="veteran"]:checked')?.value ?? null,
    ack: document.getElementById("ack").checked,
    why: document.getElementById("why").value,
    resumeFile: document.getElementById("resume").files[0]?.name ?? null,
    highlights: document.querySelectorAll("[data-formwork]").length,
  }));

  await t.test("no page errors were introduced", () => {
    assert.deepEqual(pageErrors, []);
  });

  await t.test("identity is filled verbatim from the profile", () => {
    assert.equal(form.first, "Dana");
    assert.equal(form.last, "Rivera");
    assert.equal(form.email, "dana.rivera@example.com");
    assert.equal(form.phone, "919-555-0142");
    assert.equal(form.github, "https://github.com/danarivera");
    assert.match(form.linkedin, /linkedin\.com/);
  });

  await t.test("a native select is set", () => {
    assert.equal(form.hear, "LinkedIn");
  });

  await t.test("an autocomplete-backed text input keeps its value", () => {
    // The fixture discards anything not committed through its suggestion list,
    // exactly as Lever's location field does — where assigning .value silently
    // dropped the location on 21 of 21 live forms.
    assert.equal(form.loc, "Asheville, North Carolina");
  });

  await t.test("a keyboard-only combobox is selected", () => {
    // The fixture ignores synthetic clicks on options, exactly as react-select
    // does. A regression to click-based selection reports success and leaves
    // this empty, so this assertion is the guard for that whole class of bug.
    assert.equal(form.sponsorship, "No", "pinned from work authorisation, overriding the model's 'Yes'");
  });

  await t.test("a fabricated demographic is replaced by the profile's answer", () => {
    assert.equal(form.gender, "Decline To Self Identify");
    assert.ok(
      panel.corrections.some((c) => /Male/.test(c)),
      "the override is explained to the user rather than done silently"
    );
  });

  await t.test("a radio group is selected from the profile", () => {
    assert.equal(form.veteran, "not");
  });

  await t.test("the highlight marks the chosen option, not the first one", async () => {
    // Ringing the first radio implies formwork picked an answer it did not.
    const marked = await page.evaluate(() => {
      const node = document.querySelector('fieldset [data-formwork], [data-formwork] input[name="veteran"]');
      const scope = node?.closest("label") || node;
      return scope?.textContent?.trim() ?? null;
    });
    assert.ok(marked, "the veteran answer should be highlighted somewhere");
    assert.match(marked, /I am not a protected veteran/);
  });

  await t.test("a required acknowledgement checkbox is ticked", () => {
    assert.equal(form.ack, true);
  });

  await t.test("the stored résumé is attached to the upload field", () => {
    assert.equal(form.resumeFile, "dana-rivera-resume.pdf");
  });

  await t.test("the essay is staged, not written to the page", () => {
    assert.equal(form.why, "", "a drafted answer must not reach the form unapproved");
    assert.equal(panel.drafts.length, 1);
    assert.ok(panel.drafts[0].words > 0);
    assert.match(panel.drafts[0].state, /awaiting approval/);
  });

  await t.test("filled fields are highlighted for review", () => {
    assert.ok(form.highlights >= 10, `expected highlights, got ${form.highlights}`);
    assert.match(panel.status, /filled/);
  });

  await t.test("approving a draft fills it and banks the answer", async () => {
    await page.evaluate(() => {
      for (const node of document.documentElement.children) {
        const btn = node.shadowRoot?.querySelector(".draft button.primary");
        if (btn) btn.click();
      }
    });
    await page.waitForFunction(() => document.getElementById("why").value.length > 0, { timeout: 15000 });

    const why = await page.evaluate(() => document.getElementById("why").value);
    assert.ok(why.length > 10, "the approved text is what lands in the field");

    // Approval is also what teaches the bank. The record is written after the
    // fill lands, so poll rather than assuming both finished together.
    let bank = [];
    for (let i = 0; i < 40 && bank.length === 0; i++) {
      bank = await sw.evaluate(async () => (await chrome.storage.local.get("bank")).bank || []);
      if (!bank.length) await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(bank.length, 1);
    assert.equal(bank[0].company, "Testcorp");

    const after = await page.evaluate(readPanel);
    assert.match(after.drafts[0].state, /approved/);
  });

  await t.test("approving does not clear the earlier highlights", async () => {
    const highlights = await page.evaluate(() => document.querySelectorAll("[data-formwork]").length);
    assert.ok(highlights >= 10, `highlights from the main run were wiped: ${highlights}`);
  });

  await t.test("a second fill replaces highlights rather than accumulating", async () => {
    const before = await page.evaluate(() => document.querySelectorAll("[data-formwork]").length);
    await page.evaluate(() => {
      for (const node of document.documentElement.children) {
        const btn = node.shadowRoot?.querySelector("button");
        if (btn && /Fill this form/.test(btn.textContent)) btn.click();
      }
    });
    // Wait for the run to finish rather than for a fixed budget: filling a
    // combobox now involves opening its menu for real, which is slower than a
    // synthetic event and varies with the widget.
    await page.waitForFunction(
      () =>
        [...document.documentElement.children].some((n) =>
          /filled|failed|no form/.test(n.shadowRoot?.querySelector("header .sub")?.textContent || "")
        ),
      null,
      { timeout: 30000 }
    );
    const after = await page.evaluate(() => document.querySelectorAll("[data-formwork]").length);
    // Marks used to accumulate across runs, so a second pass repainted rings on
    // fields it had not touched.
    assert.ok(after <= before, `highlights grew across runs: ${before} → ${after}`);
    assert.ok(after > 0, "the second run should still highlight what it filled");
  });

  await t.test("nothing was submitted", async () => {
    assert.equal(await page.evaluate(() => location.pathname), "/form.html");
  });
});
