/**
 * Drafting and the approval gate.
 *
 * The gate is the product's central promise: a generated answer cannot reach
 * the page without an explicit decision. It is enforced in the data, not by a
 * prompt or a UI convention, which is what these tests hold in place.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lib, profile, schemaOf, fakeProvider } from "../helpers/load.mjs";

const { draftAll, applyApproved, isEssayField } = lib("draft");

const essay = schemaOf({
  id: "f0",
  label: "Why are you interested in this role?",
  type: "textarea",
  required: true,
});

test("essay fields are recognised; ordinary inputs are not", () => {
  assert.equal(isEssayField({ type: "textarea", label: "Anything else?" }), true);
  assert.equal(isEssayField({ type: "text", label: "First Name", maxLength: 255 }), false);
  assert.equal(isEssayField({ type: "text", label: "Describe your experience", maxLength: 255 }), true);
  assert.equal(isEssayField({ type: "text", label: "Notes", maxLength: 4000 }), true);
  assert.equal(isEssayField({ type: "file", label: "Describe" }), false);
});

test("every draft is staged pending approval", async () => {
  const staged = await draftAll({
    schema: essay,
    profile: profile(),
    about: "",
    bank: [],
    complete: fakeProvider({ text: "a drafted answer" }).chat,
  });
  assert.equal(staged.length, 1);
  assert.equal(staged[0].needsApproval, true);
  assert.equal(staged[0].origin, "drafted");
});

test("the gate withholds anything not explicitly approved", () => {
  const staged = [
    { id: "f0", text: "unapproved" },
    { id: "f1", text: "approved", approved: true },
  ];
  const { fills, withheld } = applyApproved(staged);
  assert.deepEqual(fills, { f1: "approved" }, "only the approved item may be filled");
  assert.equal(withheld.length, 1);
});

test("auto-approve is the only bypass, and it is opt-in", () => {
  const staged = [{ id: "f0", text: "drafted" }];
  assert.deepEqual(applyApproved(staged).fills, {}, "default must withhold");
  assert.deepEqual(applyApproved(staged, { autoApprove: true }).fills, { f0: "drafted" });
});

test("an empty draft is never filled even if approved", () => {
  const { fills } = applyApproved([{ id: "f0", text: "", approved: true }]);
  assert.deepEqual(fills, {}, "an empty answer is worse than no answer");
});

test("a provider failure degrades to an empty staged item, not a thrown run", async () => {
  const staged = await draftAll({
    schema: essay,
    profile: profile(),
    about: "",
    bank: [],
    complete: fakeProvider({ fail: "model offline" }).chat,
  });
  assert.equal(staged.length, 1);
  assert.equal(staged[0].origin, "error");
  assert.match(staged[0].note, /model offline/);
  assert.equal(staged[0].needsApproval, true, "a failed draft still cannot auto-fill");
});

test("a reusable banked answer skips the model entirely", async () => {
  const provider = fakeProvider({ text: "should not be called" });
  const bank = [
    {
      question: "Why are you interested in this role?",
      answer: "Because of the systems work.",
      company: "Testcorp",
      company_specific: false,
      used_count: 1,
    },
  ];
  const staged = await draftAll({
    schema: essay,
    profile: profile(),
    about: "",
    bank,
    complete: provider.chat,
  });
  assert.equal(staged[0].origin, "answer-bank");
  assert.equal(staged[0].text, "Because of the systems work.");
  assert.equal(provider.calls.length, 0, "a bank hit must not cost a model call");
  assert.equal(staged[0].needsApproval, true, "even a reused answer is reviewed");
});

test("the about-me notes and prior answers reach the drafting prompt", async () => {
  const provider = fakeProvider({ text: "draft" });
  await draftAll({
    schema: essay,
    profile: profile(),
    about: "I maintain a 400-mile mountain bike trail map.",
    bank: [
      {
        // Similar enough to be found, company-specific so it guides voice
        // rather than being resubmitted verbatim.
        question: "Why are you interested in working here?",
        answer: "voice sample",
        company: "Other",
        company_specific: true,
      },
    ],
    complete: provider.chat,
  });
  const sent = provider.calls[0].messages.map((m) => m.content).join("\n");
  assert.match(sent, /mountain bike trail map/, "personal notes are the point of drafting");
  assert.match(sent, /voice sample/, "prior approved answers steer the voice");
});

test("drafting instructs against inventing knowledge of the employer", async () => {
  const provider = fakeProvider({ text: "draft" });
  await draftAll({ schema: essay, profile: profile(), about: "", bank: [], complete: provider.chat });
  assert.match(provider.calls[0].messages[0].content, /NEVER CHARACTERIZE THE COMPANY/);
});
