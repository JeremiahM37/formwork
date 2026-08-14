/**
 * Integration: the path the background worker runs — prompt, provider, parse,
 * validate, draft — against the real Greenhouse schema captured from a live
 * Cloudflare posting.
 *
 * The provider is faked so the suite is deterministic and offline; every other
 * layer is the shipped code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lib, profile, greenhouse, fakeProvider } from "../helpers/load.mjs";

const { buildMessages } = lib("prompt");
const { validate } = lib("validate");
const { draftAll } = lib("draft");
const { parseJSON } = lib("providers");

/** Mirrors service-worker.js plan(), which cannot be imported (it is an ES module worker). */
async function plan({ schema, provider, profile: p, about = "", bank = [], fullOptions = {} }) {
  const { messages } = buildMessages(schema, p);
  let raw = {};
  let mapError = null;
  try {
    raw = parseJSON(await provider.chat(messages, { json: true }));
  } catch (err) {
    mapError = String(err.message || err);
  }
  const result = validate(raw, schema, p, fullOptions);
  const staged = await draftAll({
    schema,
    profile: p,
    about,
    bank,
    complete: (m) => provider.chat(m, { json: false }),
  });
  return { ...result, staged, mapError };
}

const GOOD_MAP = {
  f10: "Linkedin",
  f11: "Yes", // wrong: the candidate needs no sponsorship
  f13: "No",
  f14: "June 2026",
  f15: "Bachelor's",
  f19: "Backend/Systems",
  f22: "Male", // fabricated
  f24: "I don't wish to answer", // contradicts the profile
};

test("a normal run fills, corrects, and stages", async () => {
  const provider = fakeProvider({ json: GOOD_MAP, text: "A drafted answer about systems work." });
  const out = await plan({ schema: greenhouse(), provider, profile: profile() });

  assert.equal(out.mapError, null);
  // Identity comes from the profile even though the model never proposed it.
  assert.equal(out.fills.f0, "Dana");
  assert.equal(out.fills.f2, "dana.rivera@example.com");
  // Fabricated and contradicting demographics are replaced, not accepted.
  assert.equal(out.fills.f22, "Decline To Self Identify");
  assert.equal(out.fills.f24, "I am not a protected veteran");
  // Sponsorship is pinned from work authorisation, overriding the model's "Yes".
  assert.equal(out.fills.f11, "No");
  assert.ok(out.dropped.length >= 3, "each override is reported to the user");
  // The essay is staged, never filled.
  assert.equal(out.staged.length, 1);
  assert.equal(out.staged[0].needsApproval, true);
  assert.equal(out.fills.f21, undefined);
});

test("an unreachable model still yields every profile-derived field", async () => {
  const provider = fakeProvider({ fail: "Failed to fetch (check the model host is reachable)" });
  const out = await plan({ schema: greenhouse(), provider, profile: profile() });

  assert.match(out.mapError, /Failed to fetch/, "the failure is surfaced, not swallowed");
  assert.ok(Object.keys(out.fills).length >= 10, "pinned fields do not depend on the model");
  assert.equal(out.fills.f0, "Dana");
  assert.equal(out.fills.f22, "Decline To Self Identify");
  // Nothing invented to paper over the outage.
  assert.equal(out.staged[0].text, "");
  assert.equal(out.staged[0].origin, "error");
});

test("malformed model output degrades the same way as an outage", async () => {
  const provider = {
    name: "broken",
    chat: async (_m, opts) => (opts.json ? "I'm afraid I can't help with that." : "draft"),
  };
  const out = await plan({ schema: greenhouse(), provider, profile: profile() });
  assert.match(out.mapError, /no JSON/);
  assert.equal(out.fills.f0, "Dana");
});

test("a model that invents field ids cannot reach the page", async () => {
  const provider = fakeProvider({ json: { f0: "Hacker", f999: "x", "../etc/passwd": "y" } });
  const out = await plan({ schema: greenhouse(), provider, profile: profile() });

  assert.equal(out.fills.f999, undefined);
  assert.equal(out.fills["../etc/passwd"], undefined);
  // f0 is pinned, so even a plausible-looking value is replaced.
  assert.equal(out.fills.f0, "Dana");
});

test("every filled id corresponds to a real field on the page", async () => {
  const provider = fakeProvider({ json: GOOD_MAP });
  const out = await plan({ schema: greenhouse(), provider, profile: profile() });
  const ids = new Set(greenhouse().fields.map((f) => f.id));
  for (const id of Object.keys(out.fills)) {
    assert.ok(ids.has(id), `${id} is not a field on this form`);
  }
});

test("no file field is ever assigned a value by the planner", async () => {
  const provider = fakeProvider({ json: { ...GOOD_MAP, f5: "/home/me/resume.pdf" } });
  const out = await plan({ schema: greenhouse(), provider, profile: profile() });
  const files = greenhouse().fields.filter((f) => f.type === "file");
  for (const f of files) assert.equal(out.fills[f.id], undefined);
});

test("a banked answer removes the model call for that question", async () => {
  const provider = fakeProvider({ json: GOOD_MAP, text: "fresh draft" });
  // Verbatim reuse requires the question itself to line up, so the stored entry
  // is the field's exact wording — a paraphrase would (correctly) be treated as
  // a voice sample instead.
  const essayLabel = greenhouse().fields.find((f) => f.type === "textarea").label;
  const bank = [
    {
      question: essayLabel,
      answer: "A previously approved answer.",
      company: "Cloudflare",
      company_specific: true,
      used_count: 1,
    },
  ];
  const out = await plan({ schema: greenhouse(), provider, profile: profile(), bank });

  assert.equal(out.staged[0].origin, "answer-bank");
  assert.equal(out.staged[0].text, "A previously approved answer.");
  // One call for mapping; drafting was served from the bank.
  assert.equal(provider.calls.length, 1);
});

test("the request body carries no contact details on any provider", async () => {
  const provider = fakeProvider({ json: GOOD_MAP });
  await plan({ schema: greenhouse(), provider, profile: profile() });
  const body = provider.calls.map((c) => JSON.stringify(c.messages)).join("\n");
  for (const secret of ["dana.rivera@example.com", "919-555-0142", "danarivera"]) {
    assert.equal(body.includes(secret), false, `${secret} was sent to the provider`);
  }
});
