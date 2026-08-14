/**
 * The answer bank is what makes formwork improve with use: approved answers are
 * reused outright where they still apply, and used as voice samples where they
 * do not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lib } from "../helpers/load.mjs";

const { lookup, record, tokenize, similarity, archetype } = lib("answerbank");

const CTX = { company: "Cloudflare", role: "Software Engineer Intern" };

test("the same question at two companies is the same question", () => {
  const a = tokenize("Why do you want to work at Cloudflare?", { company: "Cloudflare" });
  const b = tokenize("Why do you want to work at Stripe?", { company: "Stripe" });
  assert.equal(similarity(a, b), 1, "company names must not make questions look different");
});

test("genuinely different questions stay different", () => {
  const a = tokenize("Describe a project you are proud of", {});
  const b = tokenize("What is your expected salary", {});
  assert.ok(similarity(a, b) < 0.2, `expected low similarity, got ${similarity(a, b)}`);
});

test("a company-neutral answer is reused verbatim", () => {
  const bank = record([], {
    question: "Tell us about a project you are proud of.",
    answer: "I built tilebase, an offline-first map tile server.",
    company: "Stripe",
    companySpecific: false,
  });
  const { reuse } = lookup(bank, "Tell us about a project you are proud of.", CTX);
  assert.ok(reuse, "a portable answer should be reused rather than redrafted");
  assert.match(reuse.answer, /tilebase/);
});

test("a company-specific answer becomes a voice sample, not a reused answer", () => {
  const bank = record([], {
    question: "Why do you want to work here?",
    answer: "Because of the edge networking work.",
    company: "Stripe",
    companySpecific: true,
  });
  const { reuse, references } = lookup(bank, "Why do you want to work here?", CTX);
  assert.equal(reuse, null, "an answer written for another company must not be resubmitted");
  assert.equal(references.length, 1, "but it should still guide the new draft's voice");
});

test("the same company's own answer is reused even when company-specific", () => {
  const bank = record([], {
    question: "Why do you want to work here?",
    answer: "Because of the edge networking work.",
    company: "Cloudflare",
    companySpecific: true,
  });
  assert.ok(lookup(bank, "Why do you want to work here?", CTX).reuse);
});

test("re-approving the same question updates in place and counts usage", () => {
  let bank = record([], { question: "Q", answer: "first", company: "Acme" });
  bank = record(bank, { question: "Q", answer: "second", company: "Acme" });
  assert.equal(bank.length, 1, "no duplicate entry for the same question and company");
  assert.equal(bank[0].answer, "second");
  assert.equal(bank[0].used_count, 2);
});

test("an unrelated question finds nothing", () => {
  const bank = record([], { question: "Why do you want to work here?", answer: "x", company: "Acme" });
  const { reuse, references } = lookup(bank, "What is your desired salary?", CTX);
  assert.equal(reuse, null);
  assert.equal(references.length, 0);
});

test("an empty bank is handled without special-casing at the call site", () => {
  assert.deepEqual(lookup([], "anything", CTX), { reuse: null, references: [] });
  assert.deepEqual(lookup(undefined, "anything", CTX), { reuse: null, references: [] });
});

test("paraphrases of the same question are recognised by intent", () => {
  // These share no tokens after stop-word removal, yet are the same question —
  // the case pure token overlap cannot see.
  assert.equal(archetype("Why do you want to work at Cloudflare?"), "why-this-employer");
  assert.equal(archetype("Why are you interested in this role?"), "why-this-employer");
  assert.equal(archetype("Tell us about a project you are proud of"), "proud-project");
  assert.equal(archetype("What is your expected salary?"), "salary");
  assert.equal(archetype("What is your favourite colour?"), null);
});

test("a shared archetype qualifies as a voice sample but never as a reuse", () => {
  const bank = record([], {
    question: "Why do you want to work at Stripe?",
    answer: "Because of the payments infrastructure.",
    company: "Stripe",
    companySpecific: true,
  });
  const { reuse, references } = lookup(bank, "Why are you interested in this role?", CTX);
  assert.equal(reuse, null, "different wording must not be resubmitted verbatim");
  assert.equal(references.length, 1, "but it should still steer the new draft");
});

test("an archetype match does not pull in unrelated questions", () => {
  const bank = record([], { question: "What is your expected salary?", answer: "x", company: "A" });
  assert.equal(lookup(bank, "Why are you interested in this role?", CTX).references.length, 0);
});
