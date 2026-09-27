/**
 * formwork — output validation.
 *
 * The model is treated as an untrusted suggester. Everything it returns passes
 * through here before it can touch the page.
 *
 * The load-bearing idea: prompt rules are a request, validation is a guarantee.
 * Protected-characteristic and legal-attestation answers are *pinned* to the
 * profile — the model's value is discarded even when it happens to agree —
 * because a plausible-looking wrong answer to "are you Hispanic/Latino" is
 * materially worse than a blank field.
 */
(function (root, factory) {
  const api = factory(typeof require === "function" ? require("./history.js") : (root.__formwork || {}).history);
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.__formwork = root.__formwork || {}).validate = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (history) {
  "use strict";

  /**
   * Questions the model may never answer on its own. Each maps a label pattern
   * to the profile path that is allowed to answer it.
   */
  /**
   * Fields that ask about *someone else*.
   *
   * "Reference's email" matches /e-?mail/ and would otherwise be filled with
   * the candidate's own address — confidently wrong, and the kind of error a
   * reviewer skims past. Anything naming a third party is left alone.
   */
  const THIRD_PARTY =
    /\b(reference|referee|referrer|manager|supervisor|emergency|next of kin|spouse|partner|parent|guardian|colleague|contact person)\b|\bwho referred\b/i;

  const PINNED = [
    { re: /^(?:preferred|best) (?:contact|communication) (?:method|preference)\s*[:*]?$/i, path: "preferences.preferred_contact_method" },
    { re: /preferred (first|given) name/i, path: "identity.preferred_first_name" },
    { re: /preferred (last|family) name/i, path: "identity.preferred_last_name" },
    { re: /preferred name|nickname/i, path: "identity.preferred_name" },
    { re: /middle name/i, path: "identity.middle_name" },
    // Contact identity. Deterministic from the profile, so the model is never
    // asked for it — which also keeps PII out of the request body entirely.
    { re: /first name|given name|forename|^first\b/i, path: "identity.first_name" },
    { re: /last name|surname|family name|^last$/i, path: "identity.last_name" },
    { re: /^full name|^your name\b|^name\b/i, not: /user|company|school|referen/i, path: "identity.full_name" },
    { re: /date of birth|birth ?date|birthday|^dob$/i, path: "identity.date_of_birth" },
    { re: /^(current|present) employer\b|^current company\b/i, path: "experience.current.employer", currentExperience: "employer" },
    { re: /^(current|present) (job )?title\b/i, path: "experience.current.title", currentExperience: "title" },
    { re: /e-?mail/i, path: "identity.email" },
    // The phone number itself — but not the widgets Workday parks beside it.
    // "Country Phone Code" is a dropdown of dialling codes and "Phone
    // Extension" is a handful of digits; both matched /phone/ and were being
    // filled with the whole number.
    {
      re: /phone|mobile|cell\b|telephone|contact number/i,
      not: /extension|\bext\.?\b|country (phone )?code|phone (country )?code|phone (type|device)|device type|type of phone/i,
      path: "identity.phone",
    },
    // Which kind of number it is. Workday requires this before it will accept
    // the page, and no résumé carries it, so it is asked for once in setup
    // rather than left to a model that would be guessing.
    { re: /phone (device )?type|type of phone|device type/i, path: "identity.phone_type" },
    // Education. Applicant tracking systems ask for it separately from the
    // résumé even when the résumé is attached, and Workday will not turn the
    // page without it. Only the most recent entry is pinned: a form offering
    // repeated rows is the model's job, not a rule's.
    { re: /^(school|university|college|institution)\b|school or university|name of (school|institution)/i, path: "education.0.school" },
    { re: /^degree\b|degree (type|level|earned)|level of education|qualification/i, path: "education.0.degree" },
    { re: /field of study|major\b|area of study|discipline/i, path: "education.0.field_of_study" },
    { re: /\bgpa\b|grade point average|overall result/i, path: "education.0.gpa" },
    // Education dates, confined to the education section — see `section` above.
    {
      re: /^from\b|^start\b|start (date|year)|year started|first year/i,
      section: /education|school|university|college|degree/i,
      path: "education.0.start",
      format: "year",
    },
    {
      re: /^to\b|to \(actual|^end\b|end (date|year)|year (completed|graduated)|last year|graduation/i,
      section: /education|school|university|college|degree/i,
      path: "education.0.end",
      format: "year",
    },
    // The language a form is completed in. Workday's self-identification page
    // requires it and no résumé states it, so it is asked once in setup.
    { re: /^language\b|preferred language|language of/i, not: /programming|spoken languages|fluent/i, path: "identity.language" },
    // The date you sign an attestation is today — the one answer formwork
    // produces rather than reads, and it is a statement of fact about when
    // the form was completed, not a claim about the candidate. Excluded:
    // every other kind of date, which means something specific and must come
    // from the profile or not at all.
    {
      re: /^date\b|^today'?s date\b|date signed|signature date|date completed/i,
      not: /birth|graduat|start|end|expire|available|from|to\b|issued|hire/i,
      generate: "today",
    },
    { re: /linked-?in/i, path: "links.linkedin" },
    { re: /git-?hub/i, path: "links.github" },
    { re: /portfolio|personal (web)?site|^website/i, path: "links.website" },
    { re: /^country|(?:which|what) country (?:are you (?:located|based|living) in|do you (?:live|reside) in)/i, not: /citizenship|origin|calling code|phone.*code/i, path: "identity.location.country" },

    { re: /\bgender\b|gender identity/i, path: "demographics.gender" },
    { re: /hispanic|latino|latinx/i, path: "demographics.hispanic_latino" },
    { re: /\brace\b|ethnicit/i, path: "demographics.race_ethnicity" },
    { re: /veteran/i, path: "demographics.veteran_status" },
    { re: /disabilit/i, path: "demographics.disability_status" },
    // Work authorisation and sponsorship, however a form words them. The
    // second is often asked without the word "sponsorship" at all — "will you
    // require employer support to obtain or maintain authorization to work" —
    // and reading that as the first question answers "Yes" to needing support.
    {
      re: /sponsor|visa|work authoriz|authoriz(ed|ation) to work|eligib(le|ility).{0,25}(work|employ)|right to work|employer support|work permit/i,
      path: "work_authorization",
    },
    { re: /felony|criminal|convict|background check/i, path: "compliance.felony_conviction" },
    { re: /at least 18|18 years (of age|or older)|over (the age of )?18/i, path: "compliance.over_18" },
    { re: /non.?compet|non.?solicit|confidentiality.*agreement|agreement.*(restrict|limit|bar)/i, path: "compliance.employment_restrictions_attestation" },
    { re: /perform the essential functions/i, path: "compliance.can_perform_essential_functions" },
    { re: /willing to travel|willing.*travel as needed/i, path: "preferences.willing_to_travel" },
    { re: /may we contact|permission to contact/i, path: "preferences.may_contact_employer" },
    { re: /salary|compensation expectation|desired pay/i, path: "preferences.desired_salary" },
    { re: /how did you (hear|find)|referral source|source of application/i, path: "preferences.how_did_you_hear" },
    // Availability. A bare "Start Date" is deliberately not matched: in a work
    // history section it means the job's start, and answering that with
    // "Immediately" would be confidently wrong.
    {
      re: /earliest start|when (can|could|would) you (be able to )?start|availability to start|available start|start availability|notice period/i,
      path: "preferences.earliest_start_date",
    },
    // Where the candidate lives. Excluded throughout: the job's own location,
    // which the model otherwise copies off the posting ("Austin" for a Chicago
    // resident).
    //
    // A form that breaks the address into parts needs the parts. Answering a
    // "City" box with the whole formatted location puts "Asheville, North Carolina" in
    // it, which Workday rejects — so the components are pinned separately and
    // the combined string is reserved for a single free-text location field.
    // Street. "Address Line 2" is deliberately excluded: it holds an
    // apartment or suite, and repeating line 1 there is a delivery error.
    { re: /^address( line)? ?2\b|^(apartment|apt|suite|unit)\b/i, path: "identity.location.street2" },
    {
      re: /^address( line)? ?1?\b|^street( address)?\b|^home address\b/i,
      not: /preferred|desired|willing|office|work location|relocat|\b2\b|apt|suite|unit|e-?mail/i,
      path: "identity.location.street",
    },
    {
      re: /^city\b|^town\b|city\s*\/\s*town|^city or town|^(current|home) city\b/i,
      not: /preferred|desired|willing|office|work location|relocat/i,
      path: "identity.location.city",
    },
    {
      re: /^state\b|^province\b|state\s*\/\s*province|^region\b/i,
      not: /preferred|desired|willing|office|work location|relocat/i,
      path: "identity.location.state",
    },
    {
      re: /^(postal|post|zip)( ?code)?\b|zip\s*\/\s*postal/i,
      not: /preferred|desired|willing|office|work location|relocat/i,
      path: "identity.location.postal_code",
    },
    {
      re: /^location\b|current (location|address)|home address|where are you (located|based)/i,
      not: /preferred|desired|willing|office|work location|relocat/i,
      path: "identity.location",
    },
  ];

  /** Control types that can accept a pinned string answer. */
  const PINNABLE_TYPES = new Set([
    "text",
    "email",
    "tel",
    "url",
    "number",
    "date",
    "password",
    "textarea",
    "select",
    "combobox",
    "radio",
    "checkbox-group",
  ]);

  /**
   * Account-creation fields.
   *
   * Many applicant tracking systems make you register before you can apply.
   * These are answered from separately stored credentials — never from the
   * profile, and never by the model, which is not shown them and could not
   * produce the right value anyway.
   */
  const CREDENTIAL_RULES = [
    { re: /confirm.*password|re-?enter.*password|repeat.*password|password.*again/i, key: "password" },
    { re: /^\s*password|create.*password|new password|choose.*password/i, key: "password" },
    { re: /^\s*(email|e-?mail)( address)?\s*\*?\s*$|login email|account email/i, key: "email" },
    { re: /^\s*(username|user name|user id)\s*\*?\s*$/i, key: "username" },
  ];

  /**
   * The consent checkbox that gates account creation.
   *
   * Registration is impossible without it: Workday simply redisplays the form,
   * so an unticked box reads to the user as "account creation is broken". It is
   * still an agreement they are entering into, so it is ticked only on a form
   * that genuinely creates an account — one carrying a password field — and it
   * is always raised for review rather than passing silently.
   */
  const CONSENT =
    /\bi (agree|accept|consent|acknowledge)\b|terms (of (use|service)|and conditions)|privacy (policy|notice|statement)|read and (agree|accept|understood)/i;

  /**
   * Vocabulary differences that are not spelling differences.
   *
   * A profile says "Mobile"; Example Employer's Workday offers "Home Cellular". There is
   * no token in common, so option matching refuses — correctly, on the evidence
   * it has — yet the answer is knowable. This is the gap between the two.
   *
   * Deliberately keyed to the profile path it applies to, and used only after
   * ordinary matching has failed. A general synonym table would start making
   * confident guesses at questions it does not understand, which is the exact
   * failure this whole module exists to prevent. For the same reason an
   * ambiguous match — more than one option fitting — is still a refusal.
   */
  const SYNONYMS = {
    "identity.phone_type": {
      mobile: /\b(mobile|cell|cellular)\b/i,
      home: /\bhome\b/i,
      work: /\b(work|business|office)\b/i,
    },
    // A résumé writes "B.S."; a form offers "Bachelor's Degree". Same
    // qualification, no letters in common.
    "education.0.degree": {
      bs: /bachelor/i,
      ba: /bachelor/i,
      bsc: /bachelor/i,
      beng: /bachelor/i,
      bachelors: /bachelor/i,
      ms: /master/i,
      ma: /master/i,
      msc: /master/i,
      meng: /master/i,
      mba: /\bm\.?b\.?a\b|master of business/i,
      masters: /master/i,
      phd: /doctor|ph\.?\s?d/i,
      jd: /juris|\bj\.?d\b/i,
      md: /\bm\.?d\b|medical doctor/i,
      as: /associate/i,
      aa: /associate/i,
      associates: /associate/i,
    },
    // Work authorisation asked as a list of sentences rather than yes/no.
    // "for any employer" is how an unrestricted right to work is worded across
    // applicant tracking systems; the entry is guarded so it can never answer
    // the sponsorship question, where the same "Yes" means the opposite.
    work_authorization: {
      yes: {
        unless: /sponsor|employer support|work permit|require .*(support|assistance)/i,
        re: /authoriz\w*[^|]*\bany employer\b/i,
      },
    },
    // Every board words its own listing differently: a profile saying "Company
    // website" is the same answer as "Careers site" or "Company careers page".
    "preferences.how_did_you_hear": {
      companywebsite: /company\s*(web)?site|careers?\s*(site|page|website)|company careers/i,
      careerssite: /company\s*(web)?site|careers?\s*(site|page|website)|company careers/i,
      jobboard: /job board/i,
      linkedin: /linked-?in/i,
      indeed: /indeed/i,
      referral: /referr?al|referred by/i,
    },
  };

  /**
   * Same answer, different punctuation: "B.S." against an option reading "BS".
   * Tried before synonyms because it is an identity, not an interpretation.
   */
  function punctuationInsensitive(value, options) {
    const strip = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
    const want = strip(value);
    if (!want) return null;
    const hits = options.filter((o) => strip(o) === want);
    return hits.length === 1 ? hits[0] : null;
  }

  /** Every form's phrasing for "I would rather not answer this". */
  const DECLINE = /decline|prefer not|do not wish|don't wish|not disclose|choose not|rather not|no answer/i;

  const US_POSTAL = Object.fromEntries(("Alabama:AL|Alaska:AK|Arizona:AZ|Arkansas:AR|California:CA|Colorado:CO|Connecticut:CT|Delaware:DE|District of Columbia:DC|Florida:FL|Georgia:GA|Hawaii:HI|Idaho:ID|Illinois:IL|Indiana:IN|Iowa:IA|Kansas:KS|Kentucky:KY|Louisiana:LA|Maine:ME|Maryland:MD|Massachusetts:MA|Michigan:MI|Minnesota:MN|Mississippi:MS|Missouri:MO|Exampleland:MT|Nebraska:NE|Nevada:NV|New Hampshire:NH|New Jersey:NJ|New Mexico:NM|New York:NY|North Carolina:NC|North Dakota:ND|Ohio:OH|Oklahoma:OK|Oregon:OR|Pennsylvania:PA|Rhode Island:RI|South Carolina:SC|South Dakota:SD|Tennessee:TN|Texas:TX|Utah:UT|Vermont:VT|Virginia:VA|Washington:WA|West Virginia:WV|Wisconsin:WI|Wyoming:WY").split('|').map(pair=>pair.split(':')));

  function stateOption(path, value, options, profile) {
    if (path !== "identity.location.state" || !/^(united states( of america)?|usa|us)$/i.test(profile.identity?.location?.country || "")) return null;
    const state = Object.entries(US_POSTAL).find(([name,code])=>[norm(name),norm(code)].includes(norm(value)));
    if (!state) return null;
    const aliases = new Set([norm(state[0]), norm(state[1]), norm(`${state[1]} ${state[0]}`), norm(`${state[0]} ${state[1]}`)]);
    const matches = options.filter(option=>aliases.has(norm(option)));
    return matches.length === 1 ? matches[0] : null;
  }

  function phoneCountryOption(value, options) {
    const country = text => {
      const name = String(text).normalize('NFC').trim()
        .replace(/^[\u{1F1E6}-\u{1F1FF}]{2}\s*/u, '')
        .replace(/^\(?\+\d[\d ]*\)?\s*(?:[A-Z]{2}\s*-\s*)?/, '')
        .replace(/\s*\(\+\d[\d ]*\)$/, '').trim().toLowerCase();
      if (/^(us|usa|united states(?: of america)?)$/.test(name)) return 'united states';
      if (/^(uk|gb|united kingdom)$/.test(name)) return 'united kingdom';
      return name;
    };
    const wanted = country(value);
    const matches = options.filter(option => wanted && country(option) === wanted);
    return matches.length === 1 ? matches[0] : null;
  }

  function synonymOption(path, value, options, field = {}) {
    // Demographic questions are optional by law and every form words the
    // opt-out differently: "Decline To Self Identify" in a profile against
    // "Decline to State (United States of America)" on the page. Refusing to
    // match those means an answer the candidate deliberately chose is dropped.
    if (/^demographics\./.test(path) && DECLINE.test(String(value))) {
      const hits = options.filter((o) => DECLINE.test(o));
      if (hits.length === 1) return hits[0];
    }

    const table = SYNONYMS[path];
    // Keys are compared with punctuation stripped, so "B.S.", "BS" and "b s"
    // are one entry rather than three.
    const key = String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
    const entry = table && table[key];
    if (!entry) return null;
    // An entry may name the questions it does *not* apply to. "Yes" means
    // opposite things across "are you authorized to work" and "will you need
    // sponsorship", and a list phrased as sentences cannot tell those apart
    // from the value alone.
    if (entry.unless && entry.unless.test(`${field.label || ""} ${field.section || ""}`)) return null;
    const pattern = entry instanceof RegExp ? entry : entry.re;
    if (!pattern) return null;
    const hits = options.filter((o) => pattern.test(o));
    return hits.length === 1 ? hits[0] : null;
  }

  /**
   * "Have you previously worked for us?"
   *
   * Every applicant tracking system asks it, it is usually required, and no
   * résumé states it — so it was left blank and blocked the page. But it is not
   * unknowable: the employment history is in the profile, and if none of it
   * names this employer the answer is No. That is the same reasoning a person
   * does reading the question, not a guess.
   *
   * A *match* is deliberately not auto-answered "Yes". Whether a contract
   * through an agency counts, or a subsidiary, or an internship eight years
   * ago, is a judgement for the applicant — so it is raised for review instead.
   *
   * Questions about somebody else ("do you have a relative who works here")
   * are refused outright: the profile says nothing about anyone but its owner.
   */
  const PRIOR_EMPLOYMENT =
    /\b(have|did) you (ever |previously |formerly )*(been |be )?(work|worked|employed|an employee)\b|\bpreviously (worked|been employed)\b|\bformer(ly)? (an )?employee\b|\b(current or former|former or current) employee\b|\brehire\b|\bworked (here|for us|at this company)\b/i;
  const SOMEONE_ELSE = /\b(relative|family member|friend|acquaintance|anyone you know|household)\b/i;

  /** Company names, compared the way a person would rather than byte for byte. */
  const companyKey = (name) =>
    String(name || "")
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|holdings|group)\b/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  function employers(profile) {
    return (profile.experience || [])
      .map((role) => role.company || role.employer || role.organization)
      .filter(Boolean);
  }

  function priorEmployment(label, profile, company) {
    if (!PRIOR_EMPLOYMENT.test(label) || SOMEONE_ELSE.test(label)) return null;

    // The employer's name comes from the posting; without it there is nothing
    // to compare the history against, so nothing is claimed.
    const target = companyKey(company);
    if (!target) return null;

    const worked = employers(profile).some((name) => {
      const key = companyKey(name);
      return key && (key === target || key.includes(target) || target.includes(key));
    });

    // A match is a question for the applicant, not an answer from the profile.
    return { path: "experience", value: worked ? null : "No", matchedEmployer: worked };
  }

  /** Which credential, if any, answers this field. */
  function credentialFor(field, credentials) {
    if (field.type === "password") {
      // Any password control takes the password, however it is labelled.
      return credentials.password ? { key: "password", value: credentials.password } : { key: "password", value: null };
    }
    const rule = CREDENTIAL_RULES.find((r) => r.re.test(field.label || ""));
    if (!rule) return null;
    const value = rule.key === "username" ? credentials.username || credentials.email : credentials[rule.key];
    return { key: rule.key, value: value || null };
  }

  const get = (obj, path) =>
    path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  /**
   * Words that tell one campus of a university from another.
   *
   * School lists routinely carry no plain "Example State University" — only
   * "- East Campus", "- Exampletown" and "- North Campus", each of which contains the
   * name the résumé gives. Which one is a fact the profile already states, in
   * the campus's location, so it is used to break the tie rather than left to
   * whichever the widget rendered first. A hint is never an answer on its own:
   * nothing is filled from one, and a field with no unambiguous option is
   * still left blank and flagged.
   */
  function campusHint(profile) {
    const first = (profile.education || [])[0] || {};
    return String(first.location || "")
      .split(/[,/]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  /**
   * A grade against a list of grade bands.
   *
   * Applicant tracking systems ask for GPA as a dropdown of bands — "3.9 out of
   * 4.0", "3.8 out of 4.0" — and no profile holds a value that is one of them
   * verbatim. A 3.86 belongs in the 3.8 band: the highest band it actually
   * reaches, never the nearest, because rounding up to 3.9 overstates a number
   * an employer may verify against a transcript.
   *
   * A form that asks separately about graduate and doctorate study is asking
   * about degrees this candidate may not have. Answering those with the
   * undergraduate GPA is a claim to a degree, so they take the list's own
   * not-applicable option instead — and if it offers none, nothing.
   */
  const NOT_APPLICABLE = /not applicable|n\/a\b|do not recall|did not take|does not apply|none\b/i;

  const BELOW = /\b(below|under|less than|lower than)\b/i;
  const LEVELLED = /master|doctor|phd|ph\.d|graduate/i;

  /** The GPA the question is actually asking about. */
  function gradeFor(profile, level) {
    const entries = profile.education || [];
    // "Graduate GPA" means the graduate degree's, not the first entry's. The
    // pinned path points at education.0, and answering a master's question
    // with a bachelor's number is a claim about a degree that was not earned
    // at that level.
    const match = entries.find((e) =>
      LEVELLED.test(`${e.degree || ""} ${e.field_of_study || ""}`) === level
    );
    return (match || entries[0] || {}).gpa;
  }

  function gradeOption(field, value, options, profile) {
    const label = `${field.label || ""} ${field.section || ""}`;
    if (!/\bgpa\b|grade point average/i.test(label)) return null;

    const level = /graduate|master|doctor|phd|ph\.d/i.test(label) && !/under-?graduate/i.test(label);
    if (level) {
      const held = (profile.education || []).some((e) =>
        LEVELLED.test(`${e.degree || ""} ${e.field_of_study || ""}`)
      );
      if (!held) return options.find((o) => NOT_APPLICABLE.test(o)) || null;
    }

    const asked = gradeFor(profile, level);
    const grade = Number.parseFloat(String(asked ?? value).match(/\d+(\.\d+)?/)?.[0]);
    if (!Number.isFinite(grade)) return null;

    const bands = [];
    let below = null;
    let stated = null;
    for (const opt of options) {
      if (NOT_APPLICABLE.test(opt)) continue;
      const number = Number.parseFloat(String(opt).match(/\d+(\.\d+)?/)?.[0]);
      if (!Number.isFinite(number)) continue;
      // "3.8 out of 4.0" states the scale it is on; "3.8" alone does not.
      const scale = Number.parseFloat(String(opt).match(/out of\s*(\d+(\.\d+)?)/i)?.[1]);
      if (Number.isFinite(scale)) stated = scale;
      if (BELOW.test(opt)) below = { opt, number };
      else bands.push({ opt, number });
    }
    if (!bands.length && !below) return null;

    // Refuse a list that is not measuring what the profile measured. A grade
    // recorded as 3.86 is on a four-point scale; placing it in a list of
    // fifths understates it by a whole point, and in a list of percentages it
    // is not a grade at all. Neither is a near miss worth making silently.
    const implied = grade > 4 ? 5 : 4;
    if (Number.isFinite(stated) && Math.abs(stated - implied) > 0.01) return null;
    const ceiling = Math.max(...bands.map((b) => b.number), below ? below.number : 0);
    if (!Number.isFinite(stated) && ceiling > 5) return null;
    if (grade > ceiling + 1e-9 && !bands.some((b) => Math.abs(b.number - grade) < 1e-9)) return null;

    let best = null;
    let bestBand = -Infinity;
    for (const { opt, number } of bands) {
      if (number > grade + 1e-9) continue;
      if (number > bestBand) {
        bestBand = number;
        best = opt;
      }
    }
    // Under every band there is usually one more option, and it is the answer
    // for everyone the bands do not reach. Without it a grade below the lowest
    // band produced nothing at all — a required field left blank on every
    // application by a candidate whose GPA starts with a two.
    if (!best && below && grade < below.number) return below.opt;
    return best;
  }

  /**
   * Token overlap, for matching a plain value to an option.
   *
   * Overlap alone is not enough, because the tokens a value shares with the
   * wrong option are usually the ones every option shares. Asked to place
   * "Example State University" in a school list, "state" and "university" are
   * two thirds of a match against every "<somewhere> State University" in it —
   * and the list read off the page stopped in the A's, so the answer was
   * "Sample State University": a real school, on a real application, and the
   * wrong one.
   *
   * So the tokens that actually identify the value — the ones most of the list
   * does *not* share — must all be present in the option chosen. "exampleland" is
   * the whole of the evidence here, and it was missing. A tie is a refusal for
   * the same reason `matchYesNo` and `synonymOption` refuse one: overlap
   * answers only when exactly one option can be the intended one.
   */
  const DISTINGUISHING = 0.3; // share of the list a token may appear in

  function bestOption(value, options) {
    const want = new Set(norm(value).split(" ").filter(Boolean));
    if (!want.size) return null;

    const sets = options.map((opt) => new Set(norm(opt).split(" ").filter(Boolean)));
    const seenIn = new Map();
    for (const set of sets) for (const token of set) seenIn.set(token, (seenIn.get(token) || 0) + 1);
    const identifying = [...want].filter(
      (token) => (seenIn.get(token) || 0) <= DISTINGUISHING * options.length
    );

    let best = null;
    let bestScore = 0;
    let ties = 0;
    for (let i = 0; i < options.length; i += 1) {
      const opt = options[i];
      // An option that is missing something only this value would say is not a
      // near miss, it is a different answer.
      if (identifying.length && !identifying.every((token) => sets[i].has(token))) continue;
      let hits = 0;
      for (const token of want) if (sets[i].has(token)) hits++;
      // Favour exact and prefix matches over incidental token overlap.
      const score =
        (norm(opt) === norm(value) ? 100 : 0) +
        (norm(opt).startsWith(norm(value)) ? 50 : 0) +
        hits / Math.max(1, sets[i].size);
      if (score > bestScore) {
        bestScore = score;
        best = opt;
        ties = 1;
      } else if (score === bestScore && norm(opt) !== norm(best)) {
        ties += 1;
      }
    }
    if (ties > 1) return null;
    return bestScore >= 0.5 ? best : null;
  }

  /**
   * Match a yes/no answer against however the form words its choices.
   *
   * Token overlap cannot see that "No" means "I do not require sponsorship", or
   * that it means "N" — both are real option sets. Deliberately conservative:
   * it answers only when exactly one option can be the intended side, and
   * returns null otherwise so the caller leaves the field blank and flags it.
   */
  function matchYesNo(value, options) {
    const v = norm(value);
    const want = /^(yes|y|true)$/.test(v) ? "yes" : /^(no|n|false)$/.test(v) ? "no" : null;
    if (!want || !options || options.length < 2) return null;

    // Explicit yes/no phrasing wins: "Yes, I will…" / "No, I will not…".
    const prefix = (o) => (/^(yes|y)\b/.test(norm(o)) ? "yes" : /^(no|n)\b/.test(norm(o)) ? "no" : null);
    const byPrefix = options.filter((o) => prefix(o) === want);
    if (byPrefix.length === 1) return byPrefix[0];

    // Otherwise a two-way choice distinguished only by a negation:
    // "I require sponsorship" / "I do not require sponsorship".
    if (options.length === 2) {
      const negated = options.filter((o) => /\b(not|never|n't|cannot|won't|do not)\b/.test(norm(o).replace(/n t\b/, "n't")));
      if (negated.length === 1) {
        const positive = options.find((o) => o !== negated[0]);
        return want === "no" ? negated[0] : positive;
      }
    }
    return null;
  }

  /** Verbatim scalars the model should be transcribing, not composing. */
  function profileStrings(profile) {
    const id = profile.identity || {};
    const out = [];
    const push = (v) => {
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    };
    push(id.full_name);
    push(id.first_name);
    push(id.last_name);
    push(id.email);
    push(id.phone);
    Object.values(profile.links || {}).forEach(push);
    return out;
  }

  const hostOf = (s) => {
    try {
      return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  };

  /**
   * Snap a model-authored value back to the profile's exact text.
   *
   * The model rewrote a GitHub URL from memory — right host, wrong username.
   * Anything that is really a transcription of a profile scalar gets replaced
   * with the profile's own string, so typos cannot reach the page.
   *
   * @returns {string} the corrected value, or the original if nothing matched
   */
  function snapToProfile(value, known, field = {}) {
    const host = hostOf(value);
    if (host) {
      const sameHost = known.filter((k) => hostOf(k) === host);
      if (sameHost.length === 1) return sameHost[0];
    }
    const exact = known.find((k) => norm(k) === norm(value));
    if (exact) return exact;

    // Digit matching only where a phone number belongs. Applied everywhere it
    // would rewrite any 7+ digit value — a salary, an ID — into the phone
    // number whenever the digits happened to line up.
    const looksPhone = field.type === "tel" || /phone|mobile|cell\b|telephone/i.test(field.label || "");
    if (looksPhone) {
      const digits = String(value).replace(/\D/g, "");
      if (digits.length >= 7) {
        const phone = known.find((k) => k.replace(/\D/g, "") === digits);
        if (phone) return phone;
      }
    }
    return value;
  }

  /**
   * Which profile answer, if any, is allowed to fill this field.
   * @returns {{path: string, value: *} | null}
   */
  function pinnedAnswer(field, profile, company, job = {}) {
    const label = field.label || "";
    if(field.skillPicker && field.type==='combobox') {
      const source=Array.isArray(profile.skills)?profile.skills:Object.values(profile.skills||{}).flat();
      const skills=[...new Set(source.filter(v=>typeof v==='string' && v.trim()).map(v=>v.trim()))];
      // Prefer literal skill mentions in this posting; punctuation distinguishes
      // C, C++ and C#. Stable profile order breaks ties without inventing skills.
      const tokens=text=>String(text||'').toLowerCase().match(/[a-z0-9]+(?:[+#]+)?(?:[./-][a-z0-9]+)*/g)||[];
      const title=tokens(job.title),description=tokens(job.description);
      const contains=(hay,needle)=>hay.some((_,i)=>needle.every((token,j)=>hay[i+j]===token));
      const selected=skills.map((value,index)=>{const name=tokens(value);return{value,index,score:name.length?10*Number(contains(title,name))+Number(contains(description,name)):0};})
        .sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,5).map(item=>item.value);
      return {path:'skills',value:selected.length?selected:null};
    }
    if (/^role description\s*[*:]?$/i.test(label) && !field.history) {
      const records=profile.experience||[];
      return {path:'experience.role_description',value:records.length===1 && records[0].bullets?.length?records[0].bullets.join('\n'):null};
    }
    if (THIRD_PARTY.test(label)) return null;
    // Jobvite's residence/language entry presents countries, despite the
    // compound caption. A combined country+language option requires another
    // fact, so accept only one literal match to the saved residence country.
    if (/^location of residence and language\s*[:*]?$/i.test(label.trim())) {
      const country=profile.identity?.location?.country;
      const key=value=>String(value ?? '').normalize('NFC').trim().toLowerCase();
      const matches=country && field.type==='select'
        ? (field.options || []).filter(option=>key(option)===key(country)) : [];
      return {path:'identity.location.country',value:matches.length===1?matches[0]:null};
    }
    // A dialing country belongs to the phone, not to the residence address.
    // International phone widgets can infer it from +countrycode themselves.
    const dialingOptions = (field.options || []).filter(option => !/^\s*(please )?select\b/i.test(option));
    const bareDialingCode = /^country code\s*[:*]?$/i.test(label.trim()) &&
      dialingOptions.length >= 2 && dialingOptions.every(option => /\(\+\d[\d ]*\)/.test(option));
    if (bareDialingCode || /country (?:calling|phone) code|phone country|country dial(?:ing)? code/i.test(label))
      return { path: "identity.phone_country", value: profile.identity?.phone_country ?? null };
    if (/security clearance|secret clearance|clearance.{0,30}\b(hold|held|level)\b|\b(hold|held|obtain|level)\b.{0,45}clearance|^clearance[?: ]*$/i.test(label)) {
      const previous = /ever|previous|past/i.test(label);
      const key = /obtain|eligib/i.test(label) ? "eligible" : /level/i.test(label)
        ? (previous ? "previous_level" : "current_level") : (previous ? "previously_held" : "currently_held");
      return { path: `compliance.clearance.${key}`, value: profile.compliance?.clearance?.[key] ?? null };
    }
    if (field.type === "checkbox-group" && /^locations?\b|preferred (?:work )?locations?/i.test(label)) {
      const choices = profile.preferences?.work_locations;
      return { path: "preferences.work_locations", value: Array.isArray(choices) &&
        choices.length && choices.every(v => typeof v === "string") ? choices : null };
    }
    if (field.type === "checkbox-group" && /languages?/i.test(label) && /C2|near.native/i.test(label)) {
      const recorded = Array.isArray(profile.languages) ? profile.languages : [];
      const fluent = recorded.filter(r => r && typeof r === "object" &&
        /^(c2|native|near-native)$/i.test(r.proficiency || "") && typeof r.name === "string");
      return { path: "languages.C2", value: fluent.length ? fluent.map(r => r.name) : null };
    }
    const recorded = history?.answer(field, profile);
    if (recorded) return recorded;

    // "Have you worked here before?" is answerable from the employment history
    // sitting in the profile, and it blocks the page when left empty. Handled
    // before the table because the answer is derived, not looked up.
    const prior = priorEmployment(label, profile, company);
    if (prior) return prior;

    const rule = PINNED.find(
      (r) =>
        r.re.test(label) &&
        !(r.not && r.not.test(label)) &&
        // A rule may be confined to one part of the form. "From" under
        // Education is the year a degree started; under Work Experience it is
        // a different date entirely, and the label cannot tell them apart.
        (!r.section || r.section.test(field.section || ""))
    );
    if (!rule) return null;
    if (rule.currentExperience) {
      const current = (profile.experience || []).filter(e => e.current === true || (e.current == null && /^(present|current|now)$/i.test(e.end || "")));
      return {path:rule.path, value:current.length === 1 ? current[0][rule.currentExperience] || null : null};
    }

    // Location is an object; render it the way a form expects to receive it.
    if (rule.path === "identity.location") {
      const loc = profile.identity?.location || {};
      const parts = [loc.city, loc.state].filter(Boolean);
      return { path: rule.path, value: parts.length ? parts.join(", ") : null };
    }

    // Work authorization is several booleans; resolve against the question asked.
    if (rule.path === "work_authorization") {
      const wa = profile.work_authorization || {};
      const label = field.label || "";
      // Visa eligibility is not established by general US work authorization.
      if (/eligib.{0,100}visa|visa.{0,60}eligib/i.test(label))
        return { path: "work_authorization.visa_eligibility_unverified", value: null };
      // "Do you need us to do something for you" is the sponsorship question
      // whether or not it uses the word.
      if (/sponsor|employer support|work permit|require .*(support|assistance)/i.test(label)) {
        const facts = [wa.requires_sponsorship_now, wa.requires_sponsorship_future];
        const needs = facts.some(v => v === true) ? true : facts.every(v => v === false) ? false : null;
        if (needs == null) return { path: rule.path, value: null };
        return { path: rule.path, value: needs ? "Yes" : "No" };
      }
      if (/require (?:work )?authoriz/i.test(label))
        return { path: "work_authorization.authorization_requirement_unverified", value: null };
      // This profile fact is explicitly US-specific. A foreign jurisdiction
      // (or "this country") cannot inherit it just because both questions
      // contain "authorized to work".
      const us = /\b(united states(?: of america)?|u\.?s\.?a?\.?)\b/i.test(label);
      const otherJurisdiction = /\bin\b|\b(eu|eea|european union|uk|united kingdom|canad(?:a|ian)|german(?:y)?|australi(?:a|an)|india|israel|singapore|france|netherlands)\b/i.test(label);
      if (!us && otherJurisdiction) return { path: "work_authorization.jurisdiction_unverified", value: null };
      if (wa.authorized_to_work_us == null) return { path: rule.path, value: null };
      return { path: rule.path, value: wa.authorized_to_work_us ? "Yes" : "No" };
    }

    if (rule.generate === "today") {
      const now = new Date();
      // Local parts, not an ISO string: parsing "2026-08-14" back gives UTC
      // midnight, which is the previous day west of Greenwich.
      return { path: "today", value: `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}` };
    }

    const value = get(profile, rule.path) ?? null;
    return { path: rule.path, value: rule.format ? reshape(rule.format, value) : value };
  }

  /**
   * Reshape a profile value to the shape a field expects.
   *
   * A résumé records "May 2026"; a form offering only a four-digit year box
   * rejects that outright. Returning null rather than a best guess keeps the
   * usual promise: a field is either answered correctly or left for the user.
   */
  function reshape(format, value) {
    if (value == null) return null;
    if (format === "year") {
      const match = String(value).match(/\b(19|20)\d{2}\b/);
      return match ? match[0] : null;
    }
    return value;
  }

  /**
   * @param {object} raw      model output, {fieldId: value}
   * @param {object} schema   scraped schema
   * @param {object} profile  candidate profile
   * @param {object} fullOptions  {fieldId: string[]} complete option lists
   * @param {object} credentials  {email, password, username} for signup forms.
   *   Kept out of `profile` on purpose: the profile is what gets summarised into
   *   the prompt, and a password must never be able to reach a model.
   * @returns {{fills: object, review: object[], dropped: object[], missingRequired: object[]}}
   */
  function validate(raw, schema, profile, fullOptions = {}, credentials = {}) {
    const byId = Object.fromEntries(schema.fields.map((f) => [f.id, f]));
    const known = profileStrings(profile);
    const fills = {};
    const review = [];
    const dropped = [];
    // Extra words that can tell two otherwise identical options apart. Not an
    // answer and never filled on their own — only a tiebreak for the filler.
    const hints = {};
    const credentialFields = new Set();

    // 1. Start from the model's proposals, discarding anything unusable.
    for (const [id, value] of Object.entries(raw || {})) {
      const field = byId[id];
      if (!field) {
        dropped.push({ id, reason: "no such field on the page" });
        continue;
      }
      if (field.type === "file") {
        dropped.push({ id, reason: "file inputs are attached by the client" });
        continue;
      }
      if (value == null || value === "") continue;

      if (Array.isArray(value)) {
        if (field.type === "checkbox-group" && value.every(v => typeof v === "string")) fills[id] = value;
        else dropped.push({ id, reason: "multiple answers require a checkbox group of strings" });
        continue;
      }
      const snapped = snapToProfile(String(value), known, field);
      if (snapped !== String(value)) {
        dropped.push({ id, reason: `corrected "${value}" to your profile's "${snapped}"` });
      }
      fills[id] = snapped;
    }

    // 2a. Account-creation fields, answered from stored credentials.
    //
    // Checked before profile pinning because "Email" on a signup form means the
    // account's email, and a password field must never receive anything the
    // model proposed — it has not been shown the credentials and cannot know it.
    const isSignup = schema.fields.some((f) => f.type === "password");
    for (const field of schema.fields) {
      if (!PINNABLE_TYPES.has(field.type)) continue;
      const cred = credentialFor(field, credentials);
      if (!cred) continue;
      // A contact-email field on an application is not an account login.
      // Live Greenhouse forms otherwise get a spurious account warning, or
      // worse, the saved login email overrides the candidate's contact email.
      if (cred.key === "email" && !isSignup &&
          !/login|log[ -]?in|sign[ -]?in|account email|create.{0,12}account/i.test(`${field.label || ""} ${field.section || ""}`)) continue;

      const proposed = fills[field.id];
      if (proposed !== undefined && field.type === "password") {
        delete fills[field.id];
        dropped.push({ id: field.id, reason: "a model must never supply a password" });
      }
      if (!cred.value) {
        if (field.required) {
          review.push({
            id: field.id,
            label: field.label,
            reason: `this form wants an account — set your ${cred.key} in formwork's options`,
          });
        }
        continue;
      }
      fills[field.id] = cred.value;
      credentialFields.add(field.id);
    }

    // 2a-ii. Agreement checkboxes: the one on an account-creation form, and
    // any that the application itself makes mandatory. Optional ones — a
    // marketing opt-in — are left alone; those are the user's to choose.
    {
      for (const field of schema.fields) {
        if (field.type !== "checkbox" || !CONSENT.test(field.label || "")) continue;
        if (!isSignup && !field.required) continue;
        fills[field.id] = "yes";
        credentialFields.add(field.id);
        review.push({
          id: field.id,
          label: field.label,
          reason: isSignup
            ? "the account cannot be created without agreeing to this"
            : "this application cannot be submitted without agreeing to this",
        });
      }
    }

    // 2b. Overwrite every pinned field from the profile, whatever the model said.
    for (const field of schema.fields) {
      if (credentialFields.has(field.id)) continue; // already answered above
      // A pinned answer is a string, so only pin controls that take one. Label
      // patterns match more than they look like they do: a checkbox reading
      // "Email me about new roles" matches /e-?mail/ and would otherwise be
      // handed the user's email address as its value.
      const historyCheckbox = field.type === "checkbox" && field.history?.kind === "experience" && field.history?.key === "current";
      if (!PINNABLE_TYPES.has(field.type) && !historyCheckbox) continue;

      const pin = historyCheckbox ? history?.answer(field, profile) : pinnedAnswer(field, profile, schema.company, schema);
      if (!pin) continue;
      const proposed = fills[field.id];

      if (pin.value == null) {
        if (proposed !== undefined) {
          delete fills[field.id];
          dropped.push({
            id: field.id,
            reason: `unverifiable answer to a pinned question (${pin.path} is unset in your profile) — model suggested "${proposed}"`,
          });
        }
        // An optional field the profile simply has nothing for is not a problem.
        if (field.required || proposed !== undefined) {
          review.push({
            id: field.id,
            label: field.label,
            reason: pin.matchedEmployer
              ? `your history includes this employer — only you can say whether it counts here`
              : `needs your answer: ${pin.path}`,
          });
        }
        continue;
      }

      if (Array.isArray(pin.value) && (field.type === "checkbox-group" || field.skillPicker)) {
        fills[field.id] = pin.value;
        continue;
      }
      let value = typeof pin.value === "boolean" ? (pin.value ? "Yes" : "No") : String(pin.value);
      const options = fullOptions[field.id] || field.options;
      if (options && options.length) {
        // Yes/no is resolved semantically first — "No" against ["Y", "N"] or
        // against a negated sentence has no tokens in common with either.
        //
        // Token overlap is only allowed to decide when the whole list is
        // present. A virtualised list holds a couple of dozen entries out of
        // thousands, always from the top: asked to place "Exampleland State
        // University" in a list that reaches "Albany Technical College",
        // overlap answered "Sample State University" — two tokens in common,
        // a real school, and the wrong one. Against a partial list the value
        // is left as the profile wrote it and typed into the widget, which
        // filters its own options far better than a fragment of them can be
        // matched.
        // Overlap may only decide against a list that was read to the end.
        // `optionsPartial` means the widget holds more than could be scrolled
        // through, so the entry being looked for may simply not be in hand —
        // and the closest of the wrong entries is still wrong.
        const matched = pin.path === "identity.phone_country" ? phoneCountryOption(value, options) :
          (options.includes(value) ? value : null) ??
          stateOption(pin.path, value, options, profile) ??
          gradeOption(field, value, options, profile) ??
          matchYesNo(value, options) ??
          punctuationInsensitive(value, options) ??
          (field.optionsPartial ? null : bestOption(value, options)) ??
          synonymOption(pin.path, value, options, field);
        // Wanted most where nothing matched: that is the case where the value
        // goes in raw and the widget's own filtering decides between campuses.
        if (pin.path === "education.0.school") hints[field.id] = campusHint(profile);
        if (matched) {
          value = matched;
        } else if (field.type === "combobox" && (field.optionsTruncated || field.optionsPartial)) {
          // Only where the list read off the page is a fragment of a longer
          // one. A virtualised directory — schools, countries, disciplines —
          // filters itself far better from what is typed than a hundred of its
          // thousands of entries can be matched against, so the value goes in
          // as the profile wrote it and the widget decides. fill.js re-reads
          // every field afterwards, so a value the list does not actually hold
          // is reported unset, never assumed present.
          //
          // A short list that was read in full is the opposite case: it has
          // nothing more to reveal, and typing a value it does not offer just
          // produces a wrong answer where a blank one belonged.
          review.push({
            id: field.id,
            label: field.label,
            reason: `"${value}" is not in the options that could be read — typed for the list to filter`,
          });
        } else {
          delete fills[field.id];
          review.push({
            id: field.id,
            label: field.label,
            reason: `your profile says "${value}", which matches none of the offered options`,
          });
          continue;
        }
      }

      if (proposed !== undefined && proposed !== value) {
        dropped.push({
          id: field.id,
          reason: `model proposed "${proposed}" for a sensitive field; replaced with your profile's "${value}"`,
        });
      }
      fills[field.id] = value;
    }

    // 3. Resolve free-text values against option lists the model never saw.
    for (const [id, value] of Object.entries(fills)) {
      const field = byId[id];
      const options = fullOptions[id] || field.options;
      if (Array.isArray(value)) {
        // Searchable skills are resolved against live results, not the initial
        // page's incomplete menu. The pinned profile above owns these values.
        if(field.skillPicker && field.type==='combobox')continue;
        const selected = value.map(item => (options || []).filter(option => norm(option) === norm(item)));
        if (!options?.length || (field.required && !value.length) || (field.maxSelections && new Set(value.map(norm)).size > field.maxSelections) || selected.some(matches => matches.length !== 1)) {
          delete fills[id];
          review.push({ id, label: field.label, reason: "one or more requested choices do not match a unique available option" });
        } else fills[id] = [...new Set(selected.map(matches => matches[0]))];
        continue;
      }
      if (!options || !options.length || options.includes(value)) continue;
      const matched = field.optionsPartial ? null : bestOption(value, options);
      if (matched) {
        fills[id] = matched;
        if (!field.optionsTruncated) {
          review.push({ id, label: field.label, reason: `"${value}" → "${matched}"` });
        }
      } else if (field.type === "combobox" && (field.optionsTruncated || field.optionsPartial)) {
        // See the pinned path: a virtualised list read from the page is a
        // fragment, so it can neither place the value nor rule it out.
        review.push({ id, label: field.label, reason: `"${value}" typed for the list to filter` });
      } else {
        delete fills[id];
        review.push({ id, label: field.label, reason: `"${value}" matches no available option` });
      }
    }

    // File inputs are included even though this layer never fills them: a
    // required résumé upload with no stored document is exactly the kind of
    // empty field a reviewer needs told about. The caller removes any that its
    // attachment step went on to satisfy.
    const missingRequired = schema.fields.filter((f) => f.required && (fills[f.id] === undefined || (Array.isArray(fills[f.id]) && !fills[f.id].length)));

    return { fills, review, dropped, missingRequired, hints };
  }

  return { validate, bestOption, pinnedAnswer, snapToProfile, profileStrings, PINNED };
});
