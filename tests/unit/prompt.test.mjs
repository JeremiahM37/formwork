/**
 * Prompt construction. The load-bearing property is the privacy one: contact
 * details are filled deterministically by the validator, so they must never
 * appear in a request body — including when that body goes to a third-party API.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lib, profile, greenhouse, schemaOf } from "../helpers/load.mjs";

const { buildMessages, condenseProfile, deriveFacts, parseWhen } = lib("prompt");

test("no personally identifying scalar reaches the model", () => {
  const { messages } = buildMessages(greenhouse(), profile());
  const body = messages.map((m) => m.content).join("\n");

  for (const secret of [
    "Dana",
    "Rivera",
    "dana.rivera@example.com",
    "919-555-0142",
    "github.com/danarivera",
    "linkedin.com/in/dana-rivera",
  ]) {
    assert.equal(body.includes(secret), false, `${secret} leaked into the prompt`);
  }
});

test("non-identifying context the model actually needs is still present", () => {
  const { messages } = buildMessages(greenhouse(), profile());
  const body = messages.map((m) => m.content).join("\n");

  assert.match(body, /Northlight Systems/, "employer is needed to answer experience questions");
  assert.match(body, /Computer Science/);
  assert.match(body, /Asheville/, "location drives relocation and city questions");
});

test("date arithmetic is precomputed rather than left to the model", () => {
  const facts = deriveFacts(profile(), new Date("2026-08-11T12:00:00Z"));
  assert.equal(facts.graduated, true);
  assert.equal(facts.currently_enrolled, false);
  assert.equal(facts.currently_employed, true, "an end date of Present means still employed");
  assert.equal(facts.highest_degree, "B.S. in Computer Science");
  assert.ok(facts.years_of_experience > 4, `expected >4 years, got ${facts.years_of_experience}`);
});

test("a candidate still in school is derived as enrolled", () => {
  const student = profile();
  student.education[0].end = "May 2027";
  const facts = deriveFacts(student, new Date("2026-08-11T12:00:00Z"));
  assert.equal(facts.graduated, false);
  assert.equal(facts.currently_enrolled, true);
});

test("parseWhen understands the shapes a resume actually uses", () => {
  assert.equal(parseWhen("May 2026").getFullYear(), 2026);
  assert.equal(parseWhen("May 2026").getMonth(), 4);
  assert.equal(parseWhen("2019").getFullYear(), 2019);
  assert.ok(parseWhen("Present") instanceof Date);
  assert.equal(parseWhen("sometime last spring"), null);
  assert.equal(parseWhen(""), null);
});

test("file fields are withheld from the model entirely", () => {
  const schema = schemaOf(
    { id: "f0", label: "First Name" },
    { id: "f1", label: "Resume/CV", type: "file" }
  );
  const { messages } = buildMessages(schema, profile());
  assert.equal(messages.at(-1).content.includes("Resume/CV"), false);
});

test("bullets are withheld for mapping but included for drafting", () => {
  const bullet = "Cut p99 request latency from 900ms to 120ms";
  assert.equal(JSON.stringify(condenseProfile(profile())).includes(bullet), false);
  assert.equal(
    JSON.stringify(condenseProfile(profile(), { includeBullets: true })).includes(bullet),
    true
  );
});

test("the output example cannot be mistaken for real field ids", () => {
  // An example using f0/f1 caused a model to copy "John Doe" out of it instead
  // of reading the profile. Placeholder ids must not collide with real ones.
  const { messages } = buildMessages(greenhouse(), profile());
  const system = messages[0].content;
  const exampleIds = [...system.matchAll(/"(f\d+)"/g)].map((m) => m[1]);
  const realIds = new Set(greenhouse().fields.map((f) => f.id));
  for (const id of exampleIds) {
    assert.equal(realIds.has(id), false, `example id ${id} collides with a real field id`);
  }
});
