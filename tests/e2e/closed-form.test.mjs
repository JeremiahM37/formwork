/**
 * Forms that are not open yet.
 *
 * Many careers pages mount the application form collapsed behind an Apply
 * button — present in the DOM, none of it rendered. Reporting that as "no form
 * found" is both wrong and useless, so formwork distinguishes the two and can
 * open the form itself.
 *
 * The safety property under test: revealing must never send an application.
 * The fixture's opener is a `type="submit"` button (as Airbnb's "Apply Now"
 * is), and the revealed form has a real "Submit application" button that sets
 * document.title if it ever fires. It must not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, profile } from "../helpers/load.mjs";

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

const CREDS = { email: "apply@example.com", password: "correct-horse-battery", username: "" };

function startHarness() {
  const html = readFileSync(join(ROOT, "tests", "fixtures", "closed-form.html"));
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const json = (() => {
          try {
            return JSON.parse(body).json;
          } catch {
            return false;
          }
        })();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: json ? "{}" : "draft" }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

const panel = () => {
  for (const n of document.documentElement.children) {
    const r = n.shadowRoot;
    if (!r?.querySelector(".panel")) continue;
    return {
      status: r.querySelector("header .sub").textContent,
      note: r.querySelector(".note")?.textContent ?? "",
      buttons: [...r.querySelectorAll("button")].map((b) => b.textContent),
    };
  }
  return null;
};

test("opens a closed form and fills it", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const { server, port } = await startHarness();
  const extDir = mkdtempSync(join(tmpdir(), "formwork-closed-"));
  cpSync(join(ROOT, "extension"), extDir, { recursive: true });
  const mPath = join(extDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(mPath, "utf8"));
  manifest.host_permissions.push("http://localhost/*", "http://127.0.0.1/*");
  manifest.content_scripts[0].matches.push("http://localhost/*", "http://127.0.0.1/*");
  writeFileSync(mPath, JSON.stringify(manifest, null, 2));

  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-closed-p-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  t.after(async () => {
    await ctx.close();
    server.close();
  });

  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
  await sw.evaluate(
    async ([prof, creds, base]) => {
      await chrome.storage.local.set({
        profile: prof,
        credentials: creds,
        about: "",
        bank: [],
        documents: {},
        settings: { provider: "homelab", autoApprove: false, homelab: { baseUrl: base } },
      });
    },
    [profile(), CREDS, `http://127.0.0.1:${port}`]
  );

  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/closed-form.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => [...document.documentElement.children].some((n) => n.shadowRoot?.querySelector(".panel")),
    null,
    { timeout: 15000 }
  );

  const click = (re) =>
    page.evaluate((pattern) => {
      for (const n of document.documentElement.children) {
        const b = [...(n.shadowRoot?.querySelectorAll("button") || [])].find((x) =>
          new RegExp(pattern).test(x.textContent)
        );
        if (b) b.click();
      }
    }, re);

  await click("Fill this form");
  await page.waitForFunction(
    () =>
      [...document.documentElement.children].some((n) =>
        /filled|failed|no form|not open/.test(n.shadowRoot?.querySelector("header .sub")?.textContent || "")
      ),
    null,
    { timeout: 30000 }
  );
  const first = await page.evaluate(panel);

  await t.test("a closed form is reported as closed, not as absent", () => {
    assert.match(first.status, /not open/);
    assert.match(first.note, /not open yet/);
    assert.match(first.note, /4 field/, "it should say how much is waiting behind the button");
    assert.ok(first.buttons.some((b) => /Open the form/.test(b)));
  });

  await click("Open the form");
  await page.waitForFunction(
    () =>
      [...document.documentElement.children].some((n) =>
        /filled|failed|could not open/.test(n.shadowRoot?.querySelector("header .sub")?.textContent || "")
      ),
    null,
    { timeout: 60000 }
  );

  const form = await page.evaluate(() => ({
    revealed: !document.getElementById("app-form").hidden,
    first: document.getElementById("first").value,
    email: document.getElementById("email").value,
    pw: document.getElementById("pw").value,
    title: document.title,
  }));

  await t.test("the form is opened and filled", () => {
    assert.equal(form.revealed, true);
    assert.equal(form.first, "Dana");
    assert.equal(form.email, "apply@example.com", "signup email comes from credentials");
    assert.equal(form.pw, "correct-horse-battery");
  });

  await t.test("revealing never submits the application", () => {
    // The fixture's real submit sets the title. A submit-type opener must not
    // be confused for it, and nothing else may fire it either.
    assert.notEqual(form.title, "SUBMITTED");
    assert.equal(form.title, "Senior Engineer at Testcorp");
  });
});
