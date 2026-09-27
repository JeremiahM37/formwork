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
const { record } = lib("answerbank");

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

test("drafting retains graduation and employment chronology from the saved profile", async () => {
  const candidate=profile();
  candidate.education[0].current=false;
  const provider=fakeProvider({text:"I completed my degree in 2022."});
  await draftAll({schema:essay,profile:candidate,about:"",bank:[],complete:provider.chat});
  const input=provider.calls[0].messages.map(m=>m.content).join('\n');
  assert.match(input,/May 2022/);
  assert.match(input,/"current": false/);
  assert.match(input,/June 2022/);
  assert.match(input,/"current": true/);
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

test("role-fit answers are redrafted even when a legacy bank record is marked portable", async () => {
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
  assert.equal(staged[0].origin, "drafted");
  assert.equal(provider.calls.length, 1, "role-fit answers need the current posting");
  assert.equal(staged[0].needsApproval, true, "even a reused answer is reviewed");
});

test("personal notes reach the prompt but other employers' answers do not", async () => {
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
  assert.doesNotMatch(sent, /voice sample/, "other employers must not leak into role fit");
});

test("drafting instructs against inventing knowledge of the employer", async () => {
  const provider = fakeProvider({ text: "draft" });
  await draftAll({ schema: essay, profile: profile(), about: "", bank: [], complete: provider.chat });
  assert.match(provider.calls[0].messages[0].content, /Otherwise do not invent the employer/);
});

test("asking for the answer again, with a note on what to change", async (t) => {
  const question = schemaOf({
    id: "f0",
    label: "Why are you interested in this role?",
    type: "textarea",
    required: true,
  });

  /** Draft once and report both what came back and what was sent. */
  async function draft(options) {
    const provider = fakeProvider({ text: "a fresh answer" });
    const staged = await draftAll({
      schema: question,
      profile: profile(),
      about: "I like systems.",
      complete: (messages) => provider.chat(messages),
      ...options,
    });
    return { staged: staged[0], sent: provider.calls[0]?.messages?.at(-1)?.content ?? "" };
  }

  await t.test("an ordinary draft is not told about a previous one", async () => {
    const { sent, staged } = await draft({});
    assert.doesNotMatch(sent, /YOUR PREVIOUS ANSWER/);
    assert.equal(staged.origin, "drafted");
  });

  await t.test("a revision carries the answer and the instruction into the prompt", async () => {
    // Both go into the prompt that wrote the draft in the first place. A "make
    // it shorter" answered by a prompt that has forgotten the profile shortens
    // by inventing.
    const { sent, staged } = await draft({
      revision: { previous: "the old answer", instruction: "make it shorter" },
    });
    assert.match(sent, /YOUR PREVIOUS ANSWER[\s\S]*the old answer/);
    assert.match(sent, /WHAT THE CANDIDATE WANTS CHANGED[\s\S]*make it shorter/);
    assert.equal(staged.origin, "revised");
    assert.match(staged.note, /make it shorter/);
  });

  await t.test("without an instruction it is asked for a different angle", async () => {
    // Rather than being asked the identical question and drifting by
    // temperature alone.
    const { sent, staged } = await draft({ revision: { previous: "the old answer", instruction: "" } });
    assert.match(sent, /did not like that answer/);
    assert.equal(staged.origin, "revised");
  });

  await t.test("a revision is still a draft and still needs approving", async () => {
    const { staged } = await draft({ revision: { previous: "x", instruction: "shorter" } });
    assert.equal(staged.needsApproval, true);
  });

  await t.test("a revision does not hand back the banked answer just rejected", async () => {
    const bank = record([], {
      question: "Why are you interested in this role?",
      answer: "the banked answer",
      company: "Testcorp",
      companySpecific: false,
    });
    const reused = await draft({ bank });
    assert.equal(reused.staged.origin, "drafted");
    assert.equal(reused.staged.text, "a fresh answer");

    const revised = await draft({ bank, revision: { previous: "the banked answer", instruction: "shorter" } });
    assert.equal(revised.staged.origin, "revised");
    assert.equal(revised.staged.text, "a fresh answer");
  });

  await t.test("a model that fails mid-revision reports it rather than losing the field", async () => {
    const provider = fakeProvider({ fail: "model down" });
    const [staged] = await draftAll({
      schema: question,
      profile: profile(),
      about: "",
      complete: (messages) => provider.chat(messages),
      revision: { previous: "x", instruction: "y" },
    });
    assert.equal(staged.origin, "error");
    assert.match(staged.note, /model down/);
    assert.equal(staged.needsApproval, true);
  });
});

test('posting requirements reach the writer and employer notes only reach that employer',async()=>{
 const candidate={...profile(),company_notes:[{company:'Tailscale',text:'TAILNET_PERSONAL_PITCH'}]};
 for(const company of ['Device Works','Tailscale']){
  const provider=fakeProvider({text:'draft'});
  await draftAll({schema:{...essay,company,description:'Embedded C device drivers and SPI debugging.'},profile:candidate,about:'General career notes.',bank:[],complete:provider.chat});
  const prompt=provider.calls[0].messages.map(m=>m.content).join('\n');
  assert.match(prompt,/Embedded C device drivers and SPI debugging/);
  assert.equal(prompt.includes('TAILNET_PERSONAL_PITCH'),company==='Tailscale');
 }
});

test('ordinary field mapping never receives employer-specific pitches',()=>{
 const {condenseProfile}=lib('prompt');
 const slim=condenseProfile({...profile(),company_notes:[{company:'Tailscale',text:'PRIVATE_EMPLOYER_PITCH'}]});
 assert.equal(JSON.stringify(slim).includes('PRIVATE_EMPLOYER_PITCH'),false);
});
