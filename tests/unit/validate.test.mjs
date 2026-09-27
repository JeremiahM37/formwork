/**
 * The validation layer is formwork's only hard guarantee: the model is an
 * untrusted suggester and everything it returns passes through here. These
 * tests pin the behaviours that make that guarantee real.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lib, profile, schemaOf } from "../helpers/load.mjs";

const { validate, bestOption, snapToProfile, pinnedAnswer } = lib("validate");

test("pins demographics to the profile and discards the model's guess", () => {
  const schema = schemaOf(
    { id: "f0", label: "Gender", type: "combobox", options: ["Male", "Female", "Decline To Self Identify"] },
    { id: "f1", label: "Are you Hispanic/Latino?", type: "combobox", options: ["Yes", "No", "Decline To Self Identify"] }
  );
  // The model inferring gender from a name is the exact failure this prevents.
  const { fills, dropped } = validate({ f0: "Male", f1: "No" }, schema, profile(), {});

  assert.equal(fills.f0, "Decline To Self Identify");
  assert.equal(fills.f1, "Decline To Self Identify");
  assert.equal(dropped.length, 2, "both fabrications reported, not silently swapped");
  assert.match(dropped[0].reason, /sensitive field/);
});

test("pins identity even when the model proposed nothing at all", () => {
  const schema = schemaOf(
    { id: "f0", label: "First Name" },
    { id: "f1", label: "Email" },
    { id: "f2", label: "Github Profile URL" }
  );
  const { fills } = validate({}, schema, profile(), {});

  assert.equal(fills.f0, "Dana");
  assert.equal(fills.f1, "dana.rivera@example.com");
  assert.equal(fills.f2, "https://github.com/danarivera");
});

test("corrects a URL the model rewrote from memory", () => {
  // Deliberately a label no pinning rule claims, so this exercises snapping
  // rather than pinning.
  const schema = schemaOf({ id: "f0", label: "Link to your best work" });
  const { fills, dropped } = validate(
    { f0: "https://github.com/dana-rivera-dev" },
    schema,
    profile(),
    {}
  );
  // Same host, wrong path — snapped back to the profile's exact string.
  assert.equal(fills.f0, "https://github.com/danarivera");
  assert.match(dropped[0].reason, /corrected/);
});

test("does not treat a long number as a phone number outside a phone field", () => {
  const known = ["919-555-0142"];
  // Same digits, different formatting — snapped back to the profile's exact text.
  assert.equal(snapToProfile("9195550142", known, { type: "tel", label: "Phone" }), "919-555-0142");
  // The identical digits in a non-phone field must be left alone.
  assert.equal(
    snapToProfile("9195550142", known, { type: "text", label: "Desired salary" }),
    "9195550142"
  );
});

test("never writes a pinned string into a control that cannot take one", () => {
  // "Email me about new roles" matches /e-?mail/ but is a checkbox: filling it
  // with the user's address would be nonsense the page might even accept.
  const schema = schemaOf({ id: "f0", label: "Email me about new roles", type: "checkbox" });
  const { fills } = validate({}, schema, profile(), {});
  assert.equal(fills.f0, undefined);
});

test("resolves work authorisation from the question actually asked", () => {
  const sponsorship = pinnedAnswer(
    { label: "Do you now or will you in the future require immigration sponsorship?" },
    profile()
  );
  const authorised = pinnedAnswer({ label: "Are you legally authorized to work in the US?" }, profile());
  assert.equal(sponsorship.value, "No");
  assert.equal(authorised.value, "Yes");
});

test("drops a sensitive answer the profile cannot vouch for, and flags it", () => {
  const bare = profile();
  bare.compliance.felony_conviction = null;
  const schema = schemaOf({
    id: "f0",
    label: "Have you ever been convicted of a felony?",
    type: "combobox",
    required: true,
    options: ["Yes", "No"],
  });
  const { fills, dropped, review } = validate({ f0: "No" }, schema, bare, {});

  assert.equal(fills.f0, undefined, "an unverifiable legal attestation is never filled");
  assert.equal(dropped.length, 1);
  assert.equal(review.length, 1);
});

test("matches a plain value against the full option list, not the truncated one", () => {
  const schema = schemaOf({
    id: "f0",
    label: "Country",
    type: "combobox",
    options: ["Afghanistan +93"], // what the model saw
    optionsTruncated: true,
    optionCount: 244,
  });
  const full = { f0: ["Afghanistan +93", "United States +1", "Uruguay +598"] };
  const { fills } = validate({ f0: "United States" }, schema, profile(), full);
  assert.equal(fills.f0, "United States +1");
});

test("refuses a value that matches no option rather than filling something wrong", () => {
  const schema = schemaOf({
    id: "f0",
    label: "Interview format",
    type: "select",
    options: ["Video", "In person"],
  });
  const { fills, review } = validate({ f0: "Carrier pigeon" }, schema, profile(), {});
  assert.equal(fills.f0, undefined);
  assert.match(review[0].reason, /matches no available option/);
});

test("never fills file inputs, and reports required fields left empty", () => {
  const schema = schemaOf(
    { id: "f0", label: "Resume/CV", type: "file", required: true },
    { id: "f1", label: "Why do you want this job?", type: "textarea", required: true }
  );
  const { fills, dropped, missingRequired } = validate({ f0: "/tmp/resume.pdf" }, schema, profile(), {});

  assert.equal(fills.f0, undefined);
  assert.match(dropped[0].reason, /file inputs/);
  assert.deepEqual(missingRequired.map((f) => f.id).sort(), ["f0", "f1"]);
});

test("ignores field ids the page does not have", () => {
  const schema = schemaOf({ id: "f0", label: "First Name" });
  const { fills, dropped } = validate({ f99: "ghost" }, schema, profile(), {});
  assert.equal(fills.f99, undefined);
  assert.match(dropped[0].reason, /no such field/);
});

test("bestOption prefers an exact match over an incidental token overlap", () => {
  const options = ["No, I do not have a disability and have not had one in the past", "No"];
  assert.equal(bestOption("No", options), "No");
});

test("location pinning distinguishes where you live from where the job is", () => {
  const home = pinnedAnswer({ label: "Location (City)" }, profile());
  assert.equal(home.value, "Asheville, North Carolina");
  // A question about the office is not a question about the candidate.
  assert.equal(pinnedAnswer({ label: "Preferred office location" }, profile()), null);
});
