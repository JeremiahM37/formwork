/**
 * Label variation.
 *
 * The same question is worded a dozen ways across applicant tracking systems,
 * and pinning is driven by label text — so this table is the real measure of
 * how much of the world formwork copes with. Every row is phrasing seen on a
 * live application form.
 *
 * A row that fails is not a bad test: it is a form somewhere that would be
 * filled wrong or left empty.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { lib, profile, schemaOf } from "../helpers/load.mjs";

const { validate } = lib("validate");
const p = profile();

/** [what it is, expected value, ...label phrasings] */
const CASES = [
  ["first name", "Dana", "First Name", "First name *", "Legal First Name", "Given Name", "First"],
  ["last name", "Rivera", "Last Name", "Surname", "Family Name", "Legal Last Name"],
  ["email", p.identity.email, "Email", "Email Address", "E-mail", "Email address *"],
  [
    "phone",
    p.identity.phone,
    "Phone",
    "Phone Number",
    "Mobile",
    "Mobile Number",
    "Cell Phone",
    "Telephone",
    "Contact Number",
  ],
  [
    "linkedin",
    p.links.linkedin,
    "LinkedIn",
    "LinkedIn Profile",
    "LinkedIn URL",
    "Linkedin profile URL",
  ],
  ["github", p.links.github, "GitHub", "GitHub Profile", "Github URL", "GitHub profile URL"],
  // A single free-text location field wants the readable whole...
  ["location", "Asheville, North Carolina", "Location", "Current Location", "Where are you located?"],
  // ...but a form that splits the address wants the components. Workday
  // rejects "Asheville, North Carolina" in a City box, which blocks the whole
  // application, so these two must not share a rule.
  ["city", "Asheville", "City", "City/Town", "Current City"],
  ["state", "North Carolina", "State", "State/Province", "Province"],
  ["country", "United States", "Country", "Country of Residence"],
  ["gender", p.demographics.gender, "Gender", "Gender Identity", "What is your gender?"],
  [
    "race",
    p.demographics.race_ethnicity,
    "Race",
    "Ethnicity",
    "Race/Ethnicity",
    "What is your race or ethnicity?",
  ],
  [
    "hispanic",
    p.demographics.hispanic_latino,
    "Are you Hispanic/Latino?",
    "Hispanic or Latino?",
    "Hispanic/Latinx",
  ],
  [
    "veteran",
    p.demographics.veteran_status,
    "Veteran Status",
    "Protected Veteran Status",
    "Are you a protected veteran?",
  ],
  [
    "disability",
    p.demographics.disability_status,
    "Disability Status",
    "Do you have a disability?",
    "Voluntary Self-Identification of Disability",
  ],
  [
    "sponsorship (needs none)",
    "No",
    "Will you require sponsorship?",
    "Do you require visa sponsorship?",
    "Will you now or in the future require sponsorship for employment?",
    "Do you need immigration sponsorship?",
  ],
  [
    "work authorisation",
    "Yes",
    "Are you legally authorized to work in the US?",
    "Are you authorized to work in the United States?",
    "Work Authorization",
  ],
  [
    "earliest start",
    p.preferences.earliest_start_date,
    "When can you start?",
    "Earliest Start Date",
    "Availability to start",
  ],
  [
    "referral source",
    p.preferences.how_did_you_hear,
    "How did you hear about us?",
    "How did you find this job?",
    "Referral Source",
    "How did you hear about this role?",
  ],
];

for (const [what, expected, ...labels] of CASES) {
  test(`resolves every phrasing of: ${what}`, () => {
    const missed = [];
    for (const label of labels) {
      const schema = schemaOf({ id: "f0", label, type: "text" });
      const { fills } = validate({}, schema, p, {}, {});
      if (fills.f0 !== expected) missed.push(`"${label}" → ${JSON.stringify(fills.f0)}`);
    }
    assert.deepEqual(missed, [], `expected ${JSON.stringify(expected)} for each:\n  ${missed.join("\n  ")}`);
  });
}

test("a question about the employer is never answered from the candidate's profile", () => {
  // These look superficially like pinned questions but ask something else.
  const wrong = [];
  for (const label of [
    "Preferred office location",
    "Which location are you applying to?",
    "Company name",
    "Reference's email",
    "Manager's phone number",
    "Emergency contact name",
    "Reference phone",
  ]) {
    const schema = schemaOf({ id: "f0", label, type: "text" });
    const { fills } = validate({}, schema, p, {}, {});
    if (fills.f0 !== undefined) wrong.push(`"${label}" → ${JSON.stringify(fills.f0)}`);
  }
  assert.deepEqual(wrong, [], `these ask about someone else and must be left alone:\n  ${wrong.join("\n  ")}`);
});

/**
 * Option-wording variation.
 *
 * A pinned answer is a plain value ("No"); the form offers whatever phrasing it
 * likes. Choosing the wrong one here is worse than leaving the field empty, so
 * anything ambiguous must resolve to nothing rather than a guess.
 */
const OPTION_CASES = [
  ["plain", ["Yes", "No"], "No"],
  ["initials", ["Y", "N"], "N"],
  ["sentences", ["Yes, I will require sponsorship", "No, I will not require sponsorship"], "No, I will not require sponsorship"],
  ["negated phrasing", ["I require sponsorship", "I do not require sponsorship"], "I do not require sponsorship"],
  ["with punctuation", ["Yes.", "No."], "No."],
  ["case differences", ["YES", "NO"], "NO"],
];

for (const [what, options, expected] of OPTION_CASES) {
  test(`matches a pinned "No" against options phrased as: ${what}`, () => {
    const schema = schemaOf({
      id: "f0",
      label: "Will you now or in the future require sponsorship?",
      type: "combobox",
      options,
    });
    const { fills } = validate({}, schema, p, {}, {});
    assert.equal(fills.f0, expected, `options ${JSON.stringify(options)}`);
  });
}

test("an option set that answers a different question is refused, not guessed", () => {
  const schema = schemaOf({
    id: "f0",
    label: "Will you now or in the future require sponsorship?",
    type: "combobox",
    options: ["Full-time", "Part-time", "Contract"],
  });
  const { fills, review } = validate({}, schema, p, {}, {});
  assert.equal(fills.f0, undefined, "a wrong answer here is worse than an empty field");
  assert.ok(review.length, "and the user is told");
});
