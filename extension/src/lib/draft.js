/**
 * formwork — free-text drafting.
 *
 * Open-ended questions ("why do you want to work here", "tell us about a project
 * you're proud of") get their own pass, one call per question, with the user's
 * about-me text and previously approved answers as grounding.
 *
 * Every draft returned from here carries `needsApproval: true`. The filler will
 * not write a draft to the page unless the user approves it or auto-approve is
 * explicitly enabled — that invariant lives in the type, not in a prompt.
 */
(function (root, factory) {
  const api = factory(
    typeof require === "function" ? require("./answerbank.js") : (root.__formwork || {}).answerbank
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.__formwork = root.__formwork || {}).draft = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (answerbank) {
  "use strict";

  /** A field is an essay if it's free-text with room for prose. */
  function isEssayField(field) {
    if (field.type === "textarea") return true;
    if (field.type !== "text") return false;
    return (field.maxLength || 0) > 300 || /describe|why|tell us|explain|what makes/i.test(field.label || "");
  }

  const SYSTEM = `You draft answers to job application questions in the candidate's own voice.

You are writing a first draft the candidate will read, edit, and approve. Write
what they would plausibly have written, not what a careful assistant would.

GROUNDING
- Every concrete claim must come from the candidate's profile or about-me text.
- You may not invent projects, employers, metrics, coursework, or motivations.
- You may not claim knowledge of the company beyond what the question itself
  states. No flattery about their products, mission, culture, or scale unless
  the candidate's own notes mention them. If the question demands specifics
  about the company, write the parts you can support and leave the rest for the
  candidate — a short honest draft beats a padded one.

NEVER CHARACTERIZE THE COMPANY
You have not been given information about this employer. Do not describe their
focus, mission, values, products, scale, or reputation, and do not assert that
anything "aligns with" them. Sentences of the form "X's commitment to Y matches
my Z" are guesses dressed as research, and a reader who works there can tell.
Write about what the candidate has done and wants to do. That is all you know.

VOICE
- Plain, direct sentences. First person.
- Banned, no substitutes: "excited", "eager", "passionate", "thrilled", "aligns
  with", "resonates", "leverage", "cutting-edge", "fast-paced", "world-class",
  "I would love the opportunity", "I am confident that". Do not open with "I
  want to work at <company> because".
- Do not restate the question before answering it.
- Concrete beats general: name the thing built, the number measured, the problem
  hit. Specifics are what the candidate has and a generic applicant does not.
- If previous approved answers are provided, match their rhythm and vocabulary.
  They are the best available sample of how this person actually writes.

FORM
- Answer every part of the question. A two-part question gets a two-part answer.
- Respect the length limit given. Shorter is fine.
- Prose only. No headers, no bullet lists, no sign-off, no preamble.
- Output only the answer text itself.`;

  /**
   * Build messages for one free-text question.
   *
   * @param {object} field   the form field
   * @param {object} schema  scraped form schema (for company/role context)
   * @param {object} profile candidate profile
   * @param {string} about   raw about-me markdown
   * @param {object[]} references previously approved answers to similar questions
   */
  function buildDraftMessages(field, schema, profile, about, references = []) {
    const words = field.maxLength ? Math.max(60, Math.floor(field.maxLength / 7)) : 180;

    const relevant = {
      experience: (profile.experience || []).map((e) => ({
        employer: e.employer,
        title: e.title,
        bullets: e.bullets,
      })),
      projects: (profile.projects || []).map((p) => ({
        name: p.name,
        tagline: p.tagline,
        bullets: p.bullets,
      })),
      education: (profile.education || []).map((e) => ({
        school: e.school,
        degree: e.degree,
        field_of_study: e.field_of_study,
        coursework: e.coursework,
      })),
      skills: profile.skills,
    };

    const parts = [
      `QUESTION (from ${schema.company || "the company"}${schema.title ? `, for the role: ${schema.title}` : ""})`,
      field.label,
      "",
      `LENGTH: about ${words} words maximum.`,
      "",
      "CANDIDATE'S OWN NOTES ABOUT THEMSELVES",
      about && about.trim() ? about.trim() : "(none provided — rely on the profile below)",
      "",
      "CANDIDATE PROFILE",
      JSON.stringify(relevant, null, 1),
    ];

    if (references.length) {
      parts.push(
        "",
        "PREVIOUSLY APPROVED ANSWERS BY THIS CANDIDATE (match this voice; do not copy content that does not fit this question)",
        references.map((r) => `Q: ${r.question}\nA: ${r.answer}`).join("\n\n")
      );
    }

    return {
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: parts.join("\n") },
      ],
    };
  }

  /**
   * Draft every essay field on a form.
   *
   * @param {object} opts
   * @param {(messages: object[]) => Promise<string>} opts.complete transport
   * @returns {Promise<object[]>} staged drafts, each needing approval
   */
  async function draftAll({ schema, profile, about, bank = [], complete }) {
    const essays = schema.fields.filter(isEssayField);
    const staged = [];

    for (const field of essays) {
      const context = { company: schema.company, role: schema.title };
      const { reuse, references } = answerbank.lookup(bank, field.label, context);

      if (reuse) {
        staged.push({
          id: field.id,
          question: field.label,
          text: reuse.answer,
          origin: "answer-bank",
          note: `reused from a previous application${reuse.company ? ` to ${reuse.company}` : ""}`,
          needsApproval: true,
        });
        continue;
      }

      const { messages } = buildDraftMessages(field, schema, profile, about, references);
      let text;
      try {
        text = (await complete(messages)).trim();
      } catch (err) {
        staged.push({
          id: field.id,
          question: field.label,
          text: "",
          origin: "error",
          note: String(err.message || err).slice(0, 200),
          needsApproval: true,
        });
        continue;
      }

      staged.push({
        id: field.id,
        question: field.label,
        text,
        origin: "drafted",
        note: references.length
          ? `drafted, matching the voice of ${references.length} approved answer(s)`
          : "drafted from your profile and notes",
        needsApproval: true,
      });
    }

    return staged;
  }

  /**
   * Turn approved drafts into fills. Anything still awaiting approval is refused
   * — the only way past this gate is an explicit user decision or auto-approve.
   */
  function applyApproved(staged, { autoApprove = false } = {}) {
    const fills = {};
    const withheld = [];
    for (const item of staged) {
      const ok = autoApprove || item.approved === true;
      if (ok && item.text) fills[item.id] = item.text;
      else withheld.push(item);
    }
    return { fills, withheld };
  }

  return { draftAll, applyApproved, buildDraftMessages, isEssayField, SYSTEM };
});
