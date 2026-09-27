/**
 * formwork — prompt construction.
 *
 * Single source of truth for how a scraped form + a profile become model input.
 * Providers are dumb transports: they receive the messages built here and return
 * the model's JSON. That keeps the homelab, OpenAI-compatible, and Anthropic
 * paths behaviourally identical instead of drifting apart.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.__formwork = root.__formwork || {}).prompt = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * Flat {fieldId: value}. Small models emit this shape naturally; asking for a
   * richer envelope cost adherence without buying anything, since "which fields
   * need review" is derived more reliably client-side than self-reported.
   */
  const RESPONSE_SCHEMA = {
    type: "object",
    additionalProperties: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
  };

  const SYSTEM = `You map job-application form fields onto a candidate's profile.

You are filling a form on the candidate's behalf. They review every value before
submitting, so accuracy matters far more than coverage. Omitting a field is
cheap and safe. Inventing one is neither.

OUTPUT
A single JSON object mapping each field's "id" to the value to enter, e.g.
  {"f97": "Yes", "f98": "Bachelor's"}
(f97/f98 are placeholders for illustration only — use the real ids given below,
and never copy values out of this example.)
For checkbox-group fields, return an array of the exact option labels to select.
Use strings for other fields. Omit any field you cannot answer from the profile. No commentary, no nulls.

RULES
1. Never invent a fact. Every value must trace to something in the profile.
2. When a field lists "options", copy one EXACTLY, character for character.
3. When a field has "optionsTruncated": true, the list shown is partial. Ignore
   it and return the plain real-world value (e.g. "United States"). The client
   matches it against the full list.
4. When a field has "asyncSearch": true, return the text to type as a search
   query (e.g. "Chicago, Illinois").
5. Never answer a field of type "file".
6. For a checkbox, return "true" or "false". Acknowledgements and consent boxes
   required to apply are "true".
7. Free-text longer than a sentence — "why do you want to work here", cover
   letters, essays — omit entirely unless told otherwise.

8. Skip contact fields entirely — name, email, phone, location, country, and
   LinkedIn/GitHub/portfolio links are filled automatically from records you have
   not been given. Omit them.
9. Answer demographic and work-eligibility questions only from the profile's
   stated values. If the profile declines to answer one, select the form's
   decline option. If the profile says nothing, omit the field.
10. The "derived" block is already computed. Use it rather than reasoning about
    dates yourself, and keep answers consistent with it.`;

  /** "May 2026" | "2026" | "Present" -> Date (or null). */
  function parseWhen(text) {
    if (!text) return null;
    const s = String(text).trim();
    if (/^(present|current|now)$/i.test(s)) return new Date();
    const m = /^([A-Za-z]+)\s+(\d{4})$/.exec(s);
    if (m) {
      const month = new Date(`${m[1]} 1, 2000`).getMonth();
      return Number.isNaN(month) ? null : new Date(Number(m[2]), month, 1);
    }
    const y = /^(\d{4})$/.exec(s);
    return y ? new Date(Number(y[1]), 0, 1) : null;
  }

  /**
   * Precompute the date arithmetic instead of asking the model to do it.
   *
   * A 35B reliably copies a stated fact and unreliably derives one — it answered
   * "currently enrolled: Yes" for a degree that ended three months ago. Deriving
   * here turns a reasoning step into a lookup.
   */
  function deriveFacts(profile, today = new Date()) {
    const ends = (profile.education || [])
      .map((e) => ({ edu: e, when: parseWhen(e.end) }))
      .filter((x) => x.when);
    const latest = ends.sort((a, b) => b.when - a.when)[0];

    const graduated = latest ? latest.when <= today : null;
    const jobs = (profile.experience || []).map((e) => ({
      ...e,
      startAt: parseWhen(e.start),
      endAt: e.current ? today : parseWhen(e.end),
    }));
    const months = jobs.reduce((n, j) => {
      if (!j.startAt || !j.endAt) return n;
      return n + Math.max(0, (j.endAt - j.startAt) / (1000 * 60 * 60 * 24 * 30.44));
    }, 0);
    const employed = jobs.some((j) => j.endAt && j.endAt >= today);

    return {
      today: today.toISOString().slice(0, 10),
      graduated,
      currently_enrolled: graduated === null ? null : !graduated,
      graduation_date: latest ? latest.edu.end : null,
      highest_degree: latest ? `${latest.edu.degree} in ${latest.edu.field_of_study}` : null,
      currently_employed: employed,
      years_of_experience: Math.round((months / 12) * 10) / 10,
      available_to_start: profile.preferences?.earliest_start_date ?? null,
    };
  }

  /**
   * Trim the profile to what a form actually asks about. Bullet-point work
   * history is what makes the payload large and it is only needed for essays.
   */
  function condenseProfile(profile, { includeBullets = false, redactIdentity = true } = {}) {
    const slim = JSON.parse(JSON.stringify(profile));
    // Employer-specific pitches belong only in the scoped drafting pass.
    delete slim.company_notes;
    delete slim._needs_input;
    delete slim.schema_version;

    // Account credentials are stored separately and passed to the validator,
    // never through here — but strip them unconditionally anyway. If a password
    // ever reaches this function (a hand-edited profile, a future refactor that
    // merges the two), the failure is a password sent to a third-party API.
    // Defence in depth is cheap; that failure is not recoverable.
    delete slim.credentials;
    delete slim.password;

    if (redactIdentity) {
      // Contact details are filled deterministically by the validator, so they
      // are withheld here. Two benefits: the model cannot mistype them, and in
      // bring-your-own-key mode no personally identifying scalar is ever sent to
      // a third-party API — only the shape of the candidate's history.
      delete slim.links;
      const id = slim.identity || {};
      // The town and the state stay, because a drafted answer about relocating
      // has to know where from. Everything finer goes: a street address is
      // never needed to answer a question, it is the most identifying line in
      // a profile, and it was being sent to the model in full.
      const where = id.location || {};
      slim.identity = {
        location: {
          city: where.city,
          state: where.state,
          country: where.country,
        },
        willing_to_relocate: id.willing_to_relocate,
        relocation_note: id.relocation_note,
      };
      // A project URL carries the same handle as the profile links it replaces
      // (github.com/<user>/<repo>), so dropping `links` alone does not redact.
      // The model never needs the URL: it does not fill link fields, and a
      // draft should describe the work rather than paste a address.
      (slim.projects || []).forEach((p) => delete p.url);
    }
    if (!includeBullets) {
      (slim.experience || []).forEach((e) => delete e.bullets);
      (slim.projects || []).forEach((p) => delete p.bullets);
      (slim.education || []).forEach((e) => delete e.coursework);
    }
    return slim;
  }

  /**
   * @param {object} schema  output of scrapeFull()
   * @param {object} profile parsed profile
   * @param {{today?: string, allowEssays?: boolean}} opts
   * @returns {{messages: Array, format: object}}
   */
  function buildMessages(schema, profile, opts = {}) {
    const { today = new Date().toISOString().slice(0, 10), allowEssays = false } = opts;

    const fields = schema.fields.filter((f) => f.type !== "file");

    const slim = condenseProfile(profile, { includeBullets: allowEssays });
    slim.derived = deriveFacts(profile, new Date(`${today}T12:00:00`));

    const user = [
      `Today's date: ${today}`,
      "",
      `Application: ${schema.title || "(unknown role)"}${schema.company ? ` at ${schema.company}` : ""}`,
      `Applicant tracking system: ${schema.ats}`,
      "",
      "CANDIDATE PROFILE",
      "(the 'derived' block is already computed — use it, do not recompute dates)",
      JSON.stringify(slim, null, 1),
      "",
      "FORM FIELDS",
      JSON.stringify(fields, null, 1),
      "",
      allowEssays
        ? "Write free-text answers grounded strictly in the profile. Do not invent projects, motivations, or claims about the company."
        : "Leave essay and long free-text fields unanswered.",
    ].join("\n");

    return {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      format: RESPONSE_SCHEMA,
    };
  }

  return { buildMessages, condenseProfile, deriveFacts, parseWhen, RESPONSE_SCHEMA, SYSTEM };
});
