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

function startHarness(lazy = false, ambiguous = false) {
  let html = readFileSync(join(ROOT, "tests", "fixtures", "closed-form.html"), "utf8");
  if (lazy) {
    html = html.replace(/<form id="opener-form"[\s\S]*?<\/form>/,
      '<button type="button" id="applyNow" data-bi-id="careers-site-apply-button">Apply for This Job</button>');
    html = html.replace('</body>', `<script>
      const template = document.getElementById('app-form').outerHTML;
      document.getElementById('app-form').remove();
      document.getElementById('applyNow').onclick = () => {
        document.body.insertAdjacentHTML('beforeend', template); reveal();
      };
    </script></body>`);
  }
  if (lazy === 'dayforce') html = html.replace('data-bi-id="careers-site-apply-button">Apply for This Job', 'test-id="apply-without-account">Apply without an Account')
    .replace("document.body.insertAdjacentHTML('beforeend', template); reveal();",
      "window.guestOpenCount = (window.guestOpenCount || 0) + 1; setTimeout(() => { document.body.insertAdjacentHTML('beforeend', template); reveal(); }, 7000);");
  if (lazy === 'frame-expired') html = html.replace(
    "document.body.insertAdjacentHTML('beforeend', template); reveal();",
    "window.entryClicks = (window.entryClicks || 0) + 1; const frame=document.createElement('iframe'); frame.src='/expired-child'; document.body.append(frame);");
  const server = createServer((req, res) => {
    if (req.url === '/expired-child') {
      res.writeHead(200, {'content-type':'text/html'});
      res.end('<h1>This job has expired</h1>'); return;
    }
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
    res.end(ambiguous && req.url !== '/child.html'
      ? html.replace('</body>','<iframe title="Second application" src="/child.html"></iframe></body>') : html);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: server.address().port })));
}

const panel = () => {
  for (const n of document.documentElement.children) {
    const r = n.shadowRoot;
    if (!r?.querySelector(".panel")) continue;
    return {
      status: r.querySelector("header .sub").textContent,
      note: r.querySelector(".body .note")?.textContent ?? "",
      buttons: [...r.querySelectorAll("button")].map((b) => b.textContent),
    };
  }
  return null;
};

for (const [lazy,ambiguous] of [[false,false],[true,false],[false,true],["dayforce",false],["frame-expired",false]]) test(`${ambiguous ? 'refuses competing frames in a' : 'opens a'} ${lazy === "dayforce" ? "Dayforce guest" : lazy ? "lazily mounted" : "closed"} form`, { skip: chromium ? false : "playwright not installed" }, async (t) => {
  const { server, port } = await startHarness(lazy,ambiguous);
  const extDir = mkdtempSync(join(tmpdir(), "formwork-closed-"));
  cpSync(join(ROOT, "extension"), extDir, { recursive: true });
  const mPath = join(extDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(mPath, "utf8"));
 // These fixtures exercise explicit manual opening, including non-application forms.
 // Automatic detection is tested separately with the unmodified manifest.
 manifest.content_scripts[0].js=["src/content/scrape.js","src/content/fill.js","src/content/history-rows.js","src/content/index.js"];
  if (lazy === 'frame-expired') manifest.content_scripts[0].all_frames=false;
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
    if (!lazy && !ambiguous) assert.match(first.note, /4 field/, "it should say how much is waiting behind the button");
    else assert.doesNotMatch(first.note, /0 field/, "do not invent a field count before the form is mounted");
    assert.ok(first.buttons.some((b) => /Open the form/.test(b)));
  });

  await click("Open the form");
  await page.waitForFunction(
    () =>
      [...document.documentElement.children].some((n) =>
        /filled|failed|could not open|posting expired/.test(n.shadowRoot?.querySelector("header .sub")?.textContent || "")
      ),
    null,
    { timeout: 60000 }
  );

  if (lazy === 'frame-expired') {
    assert.equal((await page.evaluate(panel)).status, 'posting expired');
    assert.equal(await page.evaluate(()=>window.entryClicks), 1);
    return;
  }
  if (ambiguous) {
    assert.equal((await page.evaluate(panel)).status,'could not open');
    assert.match((await page.evaluate(panel)).note,/multiple application frames/);
    for(const frame of page.frames()) {
      assert.equal(await frame.locator('#app-form').getAttribute('hidden'),'');
      assert.equal(await frame.locator('#first').inputValue(),'');
    }
    return;
  }

  if (lazy === "dayforce") {
    assert.match((await page.evaluate(panel)).status, /filled/);
    assert.equal(await page.evaluate(() => window.guestOpenCount), 1);
  }
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
