/**
 * The answers a model is never allowed to decide, and how they meet an option
 * list that words them differently.
 *
 * Everything here was found by asking the question a real form asks and
 * looking at what came back. A GPA below three produced nothing at all; a
 * graduate GPA question was answered from a bachelor's; a list measured in
 * fifths took a number measured in quarters. None of those fail loudly, which
 * is why they need a test rather than an eye.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lib, schemaOf } from "../helpers/load.mjs";

const { validate } = lib("validate");

const GPA_4 = [
  "Not applicable/Do not recall",
  "4.0 out of 4.0",
  "3.9 out of 4.0",
  "3.8 out of 4.0",
  "3.5 out of 4.0",
  "3.0 out of 4.0",
  "Below 3.0 out of 4.0",
];

const person = ({ gpa = "3.86", education = null, work = null } = {}) => ({
  identity: { full_name: "A B", first_name: "A", last_name: "B", email: "a@b.c" },
  education: education || [
    { school: "State University", degree: "B.S.", field_of_study: "CS", gpa, location: "Exampletown, Exampleland" },
  ],
  work_authorization: work || { authorized_to_work_us: true, requires_sponsorship_now: false },
});

/** Ask one question and return what would go on the form. */
function ask(label, options, profile) {
  const schema = schemaOf({ id: "f0", label, type: "combobox", options, required: true });
  const { fills } = validate({}, schema, profile, { f0: options });
  return fills.f0 ?? null;
}

test("a grade meets a list of bands", async (t) => {
  await t.test("takes the highest band it actually reaches", () => {
    assert.equal(ask("GPA (Undergraduate)", GPA_4, person({ gpa: "3.86" })), "3.8 out of 4.0");
  });

  await t.test("never rounds up", () => {
    // 3.86 is nearer 3.9 than 3.8. Rounding to it overstates a number an
    // employer can check against a transcript.
    assert.notEqual(ask("GPA (Undergraduate)", GPA_4, person({ gpa: "3.86" })), "3.9 out of 4.0");
    assert.equal(ask("GPA (Undergraduate)", GPA_4, person({ gpa: "3.05" })), "3.0 out of 4.0");
  });

  await t.test("an exact grade takes its own band", () => {
    assert.equal(ask("GPA (Undergraduate)", GPA_4, person({ gpa: "4.0" })), "4.0 out of 4.0");
  });

  await t.test("a grade under the lowest band takes the catch-all", () => {
    // Without this every applicant whose GPA starts with a two left a required
    // field blank on every application.
    assert.equal(ask("GPA (Undergraduate)", GPA_4, person({ gpa: "2.5" })), "Below 3.0 out of 4.0");
    assert.equal(ask("GPA (Undergraduate)", GPA_4, person({ gpa: "1.9" })), "Below 3.0 out of 4.0");
  });

  await t.test("refuses a list measured on another scale", () => {
    const fifths = ["5.0 out of 5.0", "4.5 out of 5.0", "4.0 out of 5.0", "3.5 out of 5.0"];
    // 3.86 out of four is not 3.5 out of five; it is about 4.8.
    assert.equal(ask("GPA", fifths, person({ gpa: "3.86" })), null);
  });

  await t.test("refuses a list that is not grades at all", () => {
    const percents = ["90-100%", "80-89%", "70-79%", "Below 70%"];
    // Nothing here is a band a 3.86 belongs in, and "Below 70%" must not
    // become the answer just because 3.86 is a smaller number than 70.
    assert.equal(ask("GPA", percents, person({ gpa: "3.86" })), null);
  });
});

test("a graduate GPA is asked of a graduate degree", async (t) => {
  const bands = ["Other/Not Applicable", "4.0 out of 4.0", "3.9 out of 4.0", "3.5 out of 4.0"];

  await t.test("with no graduate degree, it is not applicable", () => {
    assert.equal(ask("GPA (Graduate)", bands, person()), "Other/Not Applicable");
  });

  await t.test("with one, it answers from that degree and not the first", () => {
    // The pinned path points at education.0. Answering a master's question
    // with a bachelor's number is a claim about a degree at the wrong level.
    const both = [
      { school: "State University", degree: "B.S.", field_of_study: "CS", gpa: "3.5" },
      { school: "Elsewhere", degree: "Master of Science", field_of_study: "CS", gpa: "3.9" },
    ];
    assert.equal(ask("GPA (Graduate)", bands, person({ education: both })), "3.9 out of 4.0");
  });

  await t.test("undergraduate still means the bachelor's", () => {
    const both = [
      { school: "State University", degree: "B.S.", field_of_study: "CS", gpa: "3.5" },
      { school: "Elsewhere", degree: "Master of Science", field_of_study: "CS", gpa: "3.9" },
    ];
    assert.equal(ask("GPA (Undergraduate)", bands, person({ education: both })), "3.5 out of 4.0");
  });
});

test("work authorisation, however the question is worded", async (t) => {
  const SENTENCES = [
    "I am authorized to work in the United States for any employer",
    "I am authorized to work in the United States for my present employer only",
    "I require sponsorship to work in the United States",
    "I am not authorized to work in the United States",
  ];
  const authorized = { authorized_to_work_us: true, requires_sponsorship_now: false, requires_sponsorship_future: false };

  await t.test("answers 'are you authorized' with the unrestricted option", () => {
    assert.equal(
      ask("Are you legally authorized to work in the United States?", SENTENCES, person({ work: authorized })),
      "I am authorized to work in the United States for any employer"
    );
  });

  await t.test("refuses to answer 'will you need sponsorship' from the same list", () => {
    // "Yes" means opposite things across the two questions, and a list phrased
    // as sentences cannot be told apart by the value alone. Answering here
    // once produced "I require sponsorship" for a citizen.
    for (const wording of [
      "Will you now or in the future require sponsorship for employment visa status?",
      "Do you require employer support to obtain work authorization?",
    ]) {
      assert.equal(ask(wording, SENTENCES, person({ work: authorized })), null, wording);
    }
  });

  await t.test("still answers the sponsorship question when it offers yes and no", () => {
    assert.equal(
      ask("Will you now or in the future require sponsorship?", ["Yes", "No"], person({ work: authorized })),
      "No"
    );
    assert.equal(
      ask("Are you legally authorized to work in the United States?", ["Yes", "No"], person({ work: authorized })),
      "Yes"
    );
  });

  await t.test("refuses when more than one option could be the answer", () => {
    // Somebody not authorised might be awaiting sponsorship or might not be;
    // two options fit and only they can say which.
    const unauthorized = { authorized_to_work_us: false, requires_sponsorship_now: true };
    assert.equal(
      ask("Are you legally authorized to work in the United States?", SENTENCES, person({ work: unauthorized })),
      null
    );
  });
});

test("a campus is chosen with the profile's own location", () => {
  const schema = schemaOf({
    id: "f0",
    label: "School",
    type: "combobox",
    options: ["Example State University - East Campus", "Example State University - Exampletown"],
    optionsTruncated: true,
    required: true,
  });
  const { hints } = validate({}, schema, person(), { f0: schema.fields[0].options });
  // Not an answer — a tiebreak the filler may use between options that already
  // matched. The school list has no plain "Example State University".
  assert.deepEqual(hints.f0, ["Exampletown", "Exampleland"]);
});

test("a question about somebody else is not answered with the candidate", async (t) => {
  const me = {
    identity: {
      full_name: "Dana Rivera",
      first_name: "Dana",
      last_name: "Rivera",
      email: "dana.rivera@example.com",
      phone: "919-555-0142",
    },
  };
  const answer = (label) => {
    const schema = schemaOf({ id: "f0", label, type: "text" });
    return validate({}, schema, me, {}).fills.f0 ?? null;
  };

  await t.test("the candidate's own contact details still fill", () => {
    assert.equal(answer("Email"), "dana.rivera@example.com");
    assert.equal(answer("Your email"), "dana.rivera@example.com");
    assert.equal(answer("Phone"), "919-555-0142");
    assert.equal(answer("Full name"), "Dana Rivera");
  });

  await t.test("a field naming a third party is left alone", () => {
    // "Reference's email" matches /e-?mail/ and would otherwise be filled with
    // the candidate's own address — confidently wrong, and the kind of error a
    // reviewer skims past because the field is not empty.
    for (const label of [
      "Reference's email",
      "Referee email",
      "Manager's email",
      "Supervisor name",
      "Emergency contact phone",
      "Next of kin name",
      "Spouse's name",
      "Parent/Guardian email",
      "Who referred you?",
      "Referrer email",
      "Contact person name",
      "Colleague's email",
      "Recruiter name",
      "Previous manager phone",
    ]) {
      assert.equal(answer(label), null, `filled "${label}" with the candidate`);
    }
  });
});
