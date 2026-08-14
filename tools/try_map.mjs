/**
 * Dev harness: run a scraped form fixture through a provider, validate the
 * result, and print it as a review table. Uses the same prompt + validation the
 * extension ships, so changes are testable without loading the extension.
 *
 * Usage:
 *   node tools/try_map.mjs tests/fixtures/greenhouse-cloudflare.json \
 *        --profile profile/private/profile.json \
 *        --host http://localhost:11434 --model qwen3.6:35b-a3b [--essays] [--think]
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildMessages } = require("../extension/src/lib/prompt.js");
const { validate } = require("../extension/src/lib/validate.js");

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const fixturePath = argv.find((a) => !a.startsWith("--") && a.endsWith(".json"));
const schema = JSON.parse(readFileSync(fixturePath, "utf8"));
const profile = JSON.parse(readFileSync(flag("profile", "profile/private/profile.json"), "utf8"));
const fullOptions = schema._fullOptions || {};

const host = flag("host", "http://localhost:11434");
const model = flag("model", "qwen3.6:35b-a3b");

const { messages, format } = buildMessages(schema, profile, { allowEssays: has("essays") });
const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
console.log(`model=${model}  fields=${schema.fields.length}  prompt≈${Math.round(promptChars / 4)} tokens\n`);

const t0 = Date.now();
const res = await fetch(`${host}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    messages,
    format,
    stream: false,
    think: has("think"),
    options: { temperature: 0 },
  }),
});
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const body = await res.json();
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

let raw;
try {
  raw = JSON.parse(body.message.content);
} catch {
  console.error("model did not return JSON:\n", body.message?.content?.slice(0, 600));
  process.exit(1);
}

const { fills, review, dropped, missingRequired } = validate(raw, schema, profile, fullOptions);

const byId = Object.fromEntries(schema.fields.map((f) => [f.id, f]));
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
const flagged = new Set(review.map((r) => r.id));

console.log(
  `model proposed ${Object.keys(raw).length} · validated ${Object.keys(fills).length} · ` +
    `dropped ${dropped.length} · needs review ${review.length}   (${elapsed}s)\n`
);

for (const f of schema.fields) {
  if (fills[f.id] === undefined) continue;
  const mark = flagged.has(f.id) ? "~" : " ";
  console.log(`${mark} ${f.id.padEnd(4)} ${trunc(f.label, 50).padEnd(51)} ${trunc(fills[f.id], 44)}`);
}

if (dropped.length) {
  console.log("\nDROPPED:");
  dropped.forEach((d) => console.log(`  ${d.id.padEnd(4)} ${d.reason}`));
}
if (review.length) {
  console.log("\nNEEDS REVIEW:");
  review.forEach((r) => console.log(`  ${r.id.padEnd(4)} ${trunc(r.label ?? "", 40).padEnd(41)} ${r.reason}`));
}
if (missingRequired.length) {
  console.log("\nREQUIRED, UNFILLED:");
  missingRequired.forEach((f) => console.log(`  ${f.id.padEnd(4)} ${trunc(f.label, 70)}`));
}
console.log("\nlegend:  (blank)=clean  ~=flagged for review");

if (has("essays")) {
  const { draftAll, applyApproved } = require("../extension/src/lib/draft.js");
  const read = (p, fallback) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return fallback;
    }
  };
  const about = read(flag("about", "profile/private/about.md"), "");
  const bank = JSON.parse(read(flag("bank", "profile/private/answer-bank.json"), "[]"));

  const complete = async (messages) => {
    const r = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, think: false, options: { temperature: 0.4 } }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).message.content;
  };

  const t1 = Date.now();
  const staged = await draftAll({ schema, profile, about, bank, complete });
  const secs = ((Date.now() - t1) / 1000).toFixed(1);

  console.log(`\n${"=".repeat(78)}\nSTAGING AREA — ${staged.length} draft(s), none written to the page (${secs}s)\n`);
  for (const item of staged) {
    console.log(`  ${item.id}  [${item.origin}] ${item.note}`);
    console.log(`  Q: ${trunc(item.question, 74)}`);
    console.log(
      (item.text || "(empty)")
        .split("\n")
        .map((l) => "   | " + l)
        .join("\n")
    );
    console.log(`   (${item.text.split(/\s+/).filter(Boolean).length} words)\n`);
  }

  const gate = applyApproved(staged, { autoApprove: false });
  console.log(
    `approval gate: ${Object.keys(gate.fills).length} would fill, ${gate.withheld.length} withheld pending approval`
  );
}
