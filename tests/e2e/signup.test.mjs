/**
 * Account creation, end to end in a real browser.
 *
 * Applicant tracking systems routinely require registering before you can
 * apply. formwork fills those forms from stored credentials — and, critically,
 * a password is never taken from the model and never leaves for one.
 *
 * The stub provider deliberately *tries* to supply a password, so the run
 * proves the guard holds against a hostile or confused model rather than
 * merely against an absent one. Nothing is submitted.
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
/** What a model might return if it decided to be helpful about passwords. */
const HOSTILE = { requests: [] };

function startHarness(fixture = "signup.html") {
  const html = readFileSync(join(ROOT, "tests", "fixtures", fixture));
  const server = createServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        HOSTILE.requests.push(parsed.messages.map((m) => m.content).join("\n"));
        let content = "A drafted answer.";
        if (parsed.json) {
          // Recover the field ids and try to fill the password fields.
          const prompt = parsed.messages.map((m) => m.content).join("\n");
          const start = prompt.indexOf("[", prompt.indexOf("FORM FIELDS"));
          let depth = 0;
          let end = start;
          for (let i = start; i < prompt.length; i++) {
            if (prompt[i] === "[") depth++;
            else if (prompt[i] === "]" && --depth === 0) { end = i + 1; break; }
          }
          const fields = JSON.parse(prompt.slice(start, end));
          const map = {};
          for (const f of fields) if (/password/i.test(f.label)) map[f.id] = "hunter2";
          content = JSON.stringify(map);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

test("fills an account-creation form", { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const { server, port } = await startHarness();
  const extDir = mkdtempSync(join(tmpdir(), "formwork-signup-"));
  cpSync(join(ROOT, "extension"), extDir, { recursive: true });
  const mPath = join(extDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(mPath, "utf8"));
  manifest.host_permissions.push("http://localhost/*", "http://127.0.0.1/*");
  manifest.content_scripts[0].matches.push("http://localhost/*", "http://127.0.0.1/*");
  writeFileSync(mPath, JSON.stringify(manifest, null, 2));

  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-signup-p-")), {
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
  await page.goto(`http://localhost:${port}/signup.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => [...document.documentElement.children].some((n) => n.shadowRoot?.querySelector(".panel")),
    null,
    { timeout: 15000 }
  );
  await page.evaluate(() => {
    for (const n of document.documentElement.children) {
      const b = n.shadowRoot?.querySelector("button");
      if (b && /Fill this form/.test(b.textContent)) b.click();
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

  const form = await page.evaluate(() => ({
    email: document.getElementById("email").value,
    pw: document.getElementById("pw").value,
    pw2: document.getElementById("pw2").value,
    first: document.getElementById("first").value,
    last: document.getElementById("last").value,
  }));

  await t.test("the account email and password are filled from credentials", () => {
    assert.equal(form.email, "apply@example.com");
    assert.equal(form.pw, "correct-horse-battery");
    assert.equal(form.pw2, "correct-horse-battery", "confirmation must match or signup fails");
  });

  await t.test("profile fields on the same form still fill", () => {
    assert.equal(form.first, "Dana");
    assert.equal(form.last, "Rivera");
  });

  await t.test("the model's attempt to supply a password is rejected", () => {
    assert.notEqual(form.pw, "hunter2", "a model-supplied password must never be used");
  });

  await t.test("no credential was ever sent to the provider", () => {
    const sent = HOSTILE.requests.join("\n");
    assert.ok(sent.length > 0, "the provider was called at all");
    for (const secret of [CREDS.password, CREDS.email]) {
      assert.equal(sent.includes(secret), false, `${secret} was sent to the model`);
    }
  });

  await t.test("nothing was submitted", async () => {
    assert.equal(await page.evaluate(() => location.pathname), "/signup.html");
  });
});
