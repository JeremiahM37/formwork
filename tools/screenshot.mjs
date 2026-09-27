/**
 * Regenerate the README screenshot.
 *
 * Uses the example profile and the fixture form, never real data — the image
 * ships in a public repository and a screenshot of a real application is a
 * screenshot of someone's contact details.
 *
 *   PW_MODULE=<path> node tools/screenshot.mjs
 */
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/profile.example.json"), "utf8"));

const chromium = await (async () => {
  for (const spec of [process.env.PW_MODULE, "playwright", "playwright-core"].filter(Boolean)) {
    try {
      return (await import(spec)).chromium;
    } catch {}
  }
  throw new Error("playwright not available");
})();

const ANSWERS = {
  "How did you hear about this job? *": "LinkedIn",
  "Do you now or will you in the future require immigration sponsorship? *": "Yes",
  Gender: "Male",
  "Acknowledge/Confirm": "true",
};

const balanced = (t, from) => {
  const s = t.indexOf("[", from);
  let d = 0;
  for (let i = s; i < t.length; i++) {
    if (t[i] === "[") d++;
    else if (t[i] === "]" && --d === 0) return t.slice(s, i + 1);
  }
};

const form = readFileSync(join(ROOT, "tests/fixtures/form.html"));
const server = createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { messages, json } = JSON.parse(body);
      const prompt = messages.map((m) => m.content).join("\n");
      let content =
        "I built a small service to organize sample records and simplified a recurring preparation task. " +
        "I enjoy making tools clear and dependable, collaborating with users, and improving everyday workflows.";
      if (json) {
        const fields = JSON.parse(balanced(prompt, prompt.indexOf("FORM FIELDS")));
        content = JSON.stringify(
          Object.fromEntries(
            fields.filter((f) => ANSWERS[f.label] !== undefined).map((f) => [f.id, ANSWERS[f.label]])
          )
        );
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content }));
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(form);
});
const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

const extDir = mkdtempSync(join(tmpdir(), "formwork-shot-"));
cpSync(join(ROOT, "extension"), extDir, { recursive: true });
const mPath = join(extDir, "manifest.json");
const manifest = JSON.parse(readFileSync(mPath, "utf8"));
manifest.host_permissions.push("http://localhost/*", "http://127.0.0.1/*");
manifest.content_scripts[0].matches.push("http://localhost/*", "http://127.0.0.1/*");
writeFileSync(mPath, JSON.stringify(manifest, null, 2));

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "formwork-shot-prof-")), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 860 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 20000 }));
await sw.evaluate(
  async ([prof, base]) => {
    await chrome.storage.local.set({
      profile: prof,
      about: "",
      bank: [],
      documents: {
        resume: { name: "dana-rivera-resume.pdf", type: "application/pdf", dataUrl: "data:application/pdf;base64,JVBERi0xLjQK" },
      },
      settings: { provider: "homelab", autoApprove: false, homelab: { baseUrl: base } },
    });
  },
  [profile, `http://127.0.0.1:${port}`]
);

const page = await ctx.newPage();
await page.goto(`http://localhost:${port}/form.html`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => [...document.documentElement.children].some((n) => n.shadowRoot?.querySelector(".panel")),
  { timeout: 15000 }
);
await page.evaluate(() => {
  for (const n of document.documentElement.children) {
    const b = [...(n.shadowRoot?.querySelectorAll("button") || [])].find(b => b.textContent === "Fill this form");
    if (b && /Fill this form/.test(b.textContent)) b.click();
  }
});
await page.waitForFunction(
  () =>
    [...document.documentElement.children].some((n) =>
      /filled/.test(n.shadowRoot?.querySelector("header .sub")?.textContent || "")
    ),
  { timeout: 60000 }
);
await page.waitForTimeout(600);

const out = join(ROOT, "docs", "panel.png");
await page.screenshot({ path: out });
console.log(`wrote ${out}`);
await ctx.close();
server.close();
