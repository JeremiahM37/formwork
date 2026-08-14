/**
 * Field shapes seen on Workday's real multi-step application.
 *
 * Every case here is a mistake formwork actually made against a live NVIDIA
 * posting, caught by running the extension's own modules over the real DOM.
 * The pattern in all of them is the same: a label that contains a keyword
 * ("phone", "city") but asks for something narrower than the profile value
 * matched against it. Filling those confidently wrong is worse than leaving
 * them empty, because the form accepts the value and the user never looks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lib, profile, schemaOf } from "../helpers/load.mjs";

const { validate } = lib("validate");
const p = profile();

const answer = (label, type = "text", extra = {}) => {
  const schema = schemaOf({ id: "f0", label, type, ...extra });
  return validate({}, schema, p, {}, {}).fills.f0;
};

test("the phone number goes only in the phone field", () => {
  assert.equal(answer("Phone Number"), p.identity.phone);
  assert.equal(answer("Mobile Phone"), p.identity.phone);
});

test("phone sub-widgets are not filled with the whole number", () => {
  // Workday renders these either side of the number. A dialling-code dropdown
  // holding the full phone number is not merely useless — it is a validation
  // error that blocks "Save and Continue", stranding the applicant on page one.
  const wrong = [];
  for (const label of ["Country Phone Code", "Phone Code", "Phone Extension", "Extension", "Phone Ext.", "Phone Device Type", "Phone Type"]) {
    const got = answer(label);
    if (got === p.identity.phone) wrong.push(`"${label}" → ${JSON.stringify(got)}`);
  }
  assert.deepEqual(wrong, [], `these are not the phone number:\n  ${wrong.join("\n  ")}`);
});

test("an extension box is left empty rather than guessed", () => {
  // An extension is a few digits that only the candidate knows; there is
  // nothing in a profile that could answer it.
  for (const label of ["Phone Extension", "Extension", "Phone Ext."])
    assert.equal(answer(label), undefined, label);
});

test("the phone type is answered from the profile, not from the number", () => {
  for (const label of ["Phone Device Type", "Phone Type", "Type of Phone"])
    assert.equal(answer(label), p.identity.phone_type, label);
});

test("a phone type is matched across vocabularies, but never ambiguously", () => {
  // Workday tenants label these differently: NVIDIA offers "Home Cellular"
  // where the profile says "Mobile". No token in common, so ordinary matching
  // refuses — correctly on its evidence, and uselessly for the applicant.
  const withOptions = (options) => {
    const schema = schemaOf({ id: "f0", label: "Phone Device Type", type: "combobox", options });
    return validate({}, schema, p, { f0: options }, {}).fills.f0;
  };
  assert.equal(withOptions(["Select One", "Home", "Home Cellular"]), "Home Cellular");
  assert.equal(withOptions(["Mobile", "Landline"]), "Mobile");
  assert.equal(withOptions(["Cell Phone", "Home Phone"]), "Cell Phone");
  // Two plausible fits is not a match — a wrong phone type is still wrong.
  assert.equal(withOptions(["Personal Cell", "Work Cell"]), undefined);
  // And an option set for a different question is still refused outright.
  assert.equal(withOptions(["Full-time", "Part-time"]), undefined);
});

test("a dialling-code selector gets the country, which is what it lists", () => {
  // Workday's "Country Phone Code" options are country names carrying a code
  // ("United States of America (+1)"), so the country is the right answer —
  // the option matcher takes it from there.
  assert.equal(answer("Country Phone Code"), p.identity.location.country);
});

test("the street goes in the street line", () => {
  for (const label of ["Address Line 1", "Address", "Street Address", "Address 1"])
    assert.equal(answer(label), p.identity.location.street, label);
});

test("the second address line is left for the apartment it is meant for", () => {
  // Repeating line 1 in line 2 is a delivery error, not a filled field.
  for (const label of ["Address Line 2", "Address 2", "Apt/Suite", "Suite or Unit"])
    assert.equal(answer(label), undefined, label);
});

test('"Email Address" is never mistaken for a street address', () => {
  assert.equal(answer("Email Address"), p.identity.email);
});

test("an address split into parts gets the parts, not the whole", () => {
  assert.equal(answer("City"), p.identity.location.city);
  assert.equal(answer("City/Town"), p.identity.location.city);
  assert.equal(answer("State"), p.identity.location.state);
  assert.equal(answer("State/Province"), p.identity.location.state);
  assert.equal(answer("Country"), p.identity.location.country);
});

test("a single location field still gets the readable whole", () => {
  // The combined string is right here and wrong in a City box; both must work.
  assert.match(answer("Current Location"), /Asheville/);
  assert.match(answer("Current Location"), /North Carolina/);
});

test("a postal code absent from the profile is left empty, not invented", () => {
  assert.equal(p.identity.location.postal_code, undefined, "fixture has no postal code");
  assert.equal(answer("Postal Code"), undefined);
});

test("a required field with no answer is reported rather than passed over", () => {
  // This is how the user learns their profile is missing a street address,
  // instead of watching "Save and Continue" fail with no explanation.
  const schema = schemaOf({ id: "f0", label: "Postal Code", type: "text", required: true });
  const { fills, missingRequired } = validate({}, schema, p, {}, {});
  assert.equal(fills.f0, undefined);
  assert.deepEqual(
    missingRequired.map((f) => f.label),
    ["Postal Code"]
  );
});

test("the employer's own location is never answered from the profile", () => {
  const wrong = [];
  for (const label of ["Preferred Work Location", "Office City", "Desired City", "Willing to relocate to which city?"]) {
    const got = answer(label);
    if (got !== undefined) wrong.push(`"${label}" → ${JSON.stringify(got)}`);
  }
  assert.deepEqual(wrong, [], `these ask about the job, not the candidate:\n  ${wrong.join("\n  ")}`);
});

test("the terms box on an account form is ticked and surfaced", () => {
  // Without it Workday silently redisplays the create-account page, which
  // reads as "formwork cannot create accounts".
  const schema = schemaOf(
    { id: "f0", label: "Email Address", type: "text" },
    { id: "f1", label: "Password", type: "password" },
    { id: "f2", label: "I agree", type: "checkbox" }
  );
  const creds = { email: "a@b.test", password: "s3cret-value" };
  const { fills, review } = validate({}, schema, p, {}, creds);
  assert.equal(fills.f2, "yes");
  assert.ok(
    review.some((r) => r.id === "f2"),
    "the user is told what they agreed to"
  );
});

test("a stray agreement checkbox outside account creation is left alone", () => {
  // Same label, no password field: this is a question on the application
  // itself, and ticking it is the user's decision, not formwork's.
  const schema = schemaOf({ id: "f0", label: "I agree to receive marketing email", type: "checkbox" });
  assert.equal(validate({}, schema, p, {}, { email: "a@b.test" }).fills.f0, undefined);
});

/**
 * "Have you previously worked for us?"
 *
 * Asked by nearly every applicant tracking system, usually required, and
 * absent from every résumé — so it was left blank and blocked the page. The
 * profile does answer it: if the employment history names no such employer,
 * the answer is No. That is reading the history, not inventing an answer.
 */
const priorAt = (label, company, prof = p) => {
  const schema = { ...schemaOf({ id: "f0", label, type: "text", required: true }), company };
  return validate({}, schema, prof, {}, {});
};

test("a company absent from the work history answers no", () => {
  for (const label of [
    "Have you previously worked for NVIDIA?",
    "Have you ever been employed by this company?",
    "Are you a former employee?",
    "Are you a current or former employee of Testcorp?",
    "Did you previously work here?",
    "Is this a rehire?",
  ]) {
    assert.equal(priorAt(label, "NVIDIA").fills.f0, "No", label);
  }
});

test("it answers against the option wording the form uses", () => {
  const schema = {
    ...schemaOf({
      id: "f0",
      label: "Have you previously worked for NVIDIA?",
      type: "combobox",
      options: ["Yes, I am a former employee", "No, I have never worked here"],
    }),
    company: "NVIDIA",
  };
  assert.equal(validate({}, schema, p, {}, {}).fills.f0, "No, I have never worked here");
});

test("a company that IS in the history is handed back to the user", () => {
  // Whether an agency contract or a subsidiary counts is a judgement only the
  // applicant can make, so a match is a question, never an automatic "Yes".
  const { fills, review } = priorAt("Have you previously worked for Northlight Systems?", "Northlight Systems");
  assert.equal(fills.f0, undefined, "never auto-answers yes");
  assert.match(review[0].reason, /your history includes this employer/);
});

test("company names are compared the way a person would", () => {
  // The posting says "Northlight Systems, Inc." and the résumé says
  // "Northlight Systems". That is the same employer.
  const { fills } = priorAt("Have you previously worked for us?", "Northlight Systems, Inc.");
  assert.equal(fills.f0, undefined, "the suffix must not make it a different company");
});

test("with no employer named there is nothing to compare against", () => {
  // A schema without a company cannot support either answer, so it claims
  // neither rather than defaulting to "No" and being confidently wrong.
  assert.equal(priorAt("Have you previously worked for us?", "").fills.f0, undefined);
});

test("a question about someone else is still refused", () => {
  for (const label of [
    "Do you have a relative who works here?",
    "Has any family member been employed by this company?",
    "Do you know anyone you know who has worked here?",
  ]) {
    assert.equal(priorAt(label, "NVIDIA").fills.f0, undefined, label);
  }
});

test("an empty work history is not treated as evidence of employment", () => {
  const blank = { ...p, experience: [] };
  assert.equal(priorAt("Have you previously worked for NVIDIA?", "NVIDIA", blank).fills.f0, "No");
});

/**
 * Education.
 *
 * Workday asks for it in its own section and refuses to turn the page without
 * it, even with a résumé attached — so a form that stopped dead on "My
 * Experience" is not a form that got filled.
 */
test("the most recent education entry answers the education section", () => {
  const e = p.education[0];
  assert.equal(answer("School or University"), e.school);
  assert.equal(answer("University"), e.school);
  assert.equal(answer("Degree"), e.degree);
  assert.equal(answer("Field of Study"), e.field_of_study);
  assert.equal(answer("Major"), e.field_of_study);
  assert.equal(answer("Overall Result (GPA)"), e.gpa);
  assert.equal(answer("GPA"), e.gpa);
});

test("a school question about somewhere else is not answered from the profile", () => {
  // "Preferred school" is not a question about where the candidate studied,
  // and a reference's university is a question about another person.
  for (const label of ["Preferred School District", "Reference's University"])
    assert.notEqual(answer(label), p.education[0].school, label);
});

test("an empty education history answers nothing rather than crashing", () => {
  const blank = { ...p, education: [] };
  const schema = schemaOf({ id: "f0", label: "School or University", type: "text", required: true });
  const { fills, missingRequired } = validate({}, schema, blank, {}, {});
  assert.equal(fills.f0, undefined);
  assert.deepEqual(missingRequired.map((f) => f.label), ["School or University"]);
});

test("a degree is matched across the vocabularies forms use", () => {
  // A résumé writes "B.S."; forms offer "Bachelor's Degree", "Bachelor", or
  // "BS". All three mean the qualification the candidate holds.
  const withOptions = (options) => {
    const schema = schemaOf({ id: "f0", label: "Degree", type: "combobox", options });
    return validate({}, schema, p, { f0: options }, {}).fills.f0;
  };
  assert.equal(withOptions(["Bachelor's Degree", "Master's Degree", "Doctorate"]), "Bachelor's Degree");
  assert.equal(withOptions(["BS", "MS"]), "BS", "punctuation is not a difference");
  assert.equal(withOptions(["High School", "Associate", "Bachelor", "Master"]), "Bachelor");
  // Still refuses an option set that answers a different question entirely.
  assert.equal(withOptions(["Full-time", "Part-time"]), undefined);
});

/**
 * Education dates, and why they need to know which section they are in.
 */
test("education dates are answered as the year a form asks for", () => {
  const inSection = (label, section) => {
    const schema = schemaOf({ id: "f0", label, type: "text", required: true, section });
    return validate({}, schema, p, {}, {}).fills.f0;
  };
  // The profile records "August 2018"; a four-digit year box rejects that.
  assert.equal(inSection("From", "Education"), "2018");
  assert.equal(inSection("To (Actual or Expected)", "Education"), "2022");
  assert.equal(inSection("Start Date", "Education 1"), "2018");
});

test("the same date labels under a different section are left alone", () => {
  // "From" under Work Experience is a job's start, not a degree's. Answering
  // it from the education history is the kind of confident error that reads
  // as correct on the page.
  const inSection = (label, section) => {
    const schema = schemaOf({ id: "f0", label, type: "text", required: true, section });
    return validate({}, schema, p, {}, {}).fills.f0;
  };
  assert.equal(inSection("From", "Work Experience"), undefined);
  assert.equal(inSection("To (Actual or Expected)", "Work Experience"), undefined);
  assert.equal(inSection("From", undefined), undefined, "no section is not education");
});

test("an opt-out is matched however the form words it", () => {
  // Demographic questions are optional, and the phrasing differs everywhere:
  // a profile saying "Decline To Self Identify" against an option reading
  // "Decline to State (United States of America)". Dropping that discards an
  // answer the candidate deliberately chose.
  const options = [
    "Select One",
    "Asian (Not Hispanic or Latino) (United States of America)",
    "Decline to State (United States of America)",
    "White (Not Hispanic or Latino) (United States of America)",
  ];
  const schema = schemaOf({ id: "f0", label: "What is your ethnicity?", type: "combobox", options });
  const profile = { ...p, demographics: { ...p.demographics, race_ethnicity: "Decline To Self Identify" } };
  assert.equal(validate({}, schema, profile, { f0: options }, {}).fills.f0, "Decline to State (United States of America)");
});

test("an opt-out is not invented when the form offers no way to decline", () => {
  const options = ["Asian", "White", "Two or More Races"];
  const schema = schemaOf({ id: "f0", label: "What is your ethnicity?", type: "combobox", options });
  const profile = { ...p, demographics: { ...p.demographics, race_ethnicity: "Prefer not to say" } };
  const { fills, review } = validate({}, schema, profile, { f0: options }, {});
  assert.equal(fills.f0, undefined, "no option means it, so none is chosen");
  assert.ok(review.length);
});

test("a required agreement is accepted and surfaced; an optional one is not", () => {
  const box = (required) =>
    schemaOf({
      id: "f0",
      label: "By selecting the checkbox, you agree to our Terms and Conditions",
      type: "checkbox",
      required,
    });
  const { fills, review } = validate({}, box(true), p, {}, {});
  assert.equal(fills.f0, "yes", "the application cannot be sent without it");
  assert.match(review[0].reason, /cannot be submitted without agreeing/);
  // Not required: agreeing is the user's decision, not formwork's.
  assert.equal(validate({}, box(false), p, {}, {}).fills.f0, undefined);
});

test("a signature date is today, and no other date is", () => {
  // Attestation forms ask when you signed them. That is the one answer
  // formwork produces rather than reads — a fact about the form, not a claim
  // about the candidate. Every other date means something specific.
  const now = new Date();
  const today = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  const dated = (label) => {
    const schema = schemaOf({ id: "f0", label, type: "date", required: true });
    return validate({}, schema, p, {}, {}).fills.f0;
  };
  for (const label of ["Date", "Today's Date", "Date Signed", "Date / /"])
    assert.equal(dated(label), today, label);
  for (const label of ["Date of Birth", "Graduation Date", "Start Date", "Date Issued", "Hire Date"])
    assert.equal(dated(label), undefined, `${label} is not today`);
});

test("the generated date is the local one", () => {
  // An ISO string parses back as UTC midnight, which is yesterday west of
  // Greenwich — a signature dated the day before it was made.
  const schema = schemaOf({ id: "f0", label: "Date", type: "date", required: true });
  const value = validate({}, schema, p, {}, {}).fills.f0;
  const parsed = new Date(value);
  assert.equal(parsed.getDate(), new Date().getDate(), `${value} landed on the wrong day`);
});
