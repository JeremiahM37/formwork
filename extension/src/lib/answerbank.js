/**
 * formwork — answer bank.
 *
 * Every answer the user approves is kept, keyed by the question it answered.
 * The next form that asks something similar either reuses it outright or hands
 * it to the drafter as a voice sample.
 *
 * This is the part that compounds: the twentieth application should need far
 * less drafting than the first, and the answers should sound more like the user
 * over time rather than more like a language model.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.__formwork = root.__formwork || {}).answerbank = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** Reuse an old answer verbatim at or above this similarity. */
  const REUSE_THRESHOLD = 0.82;
  /** Offer an old answer to the drafter as an example at or above this. */
  const REFERENCE_THRESHOLD = 0.45;

  /**
   * Question archetypes.
   *
   * Token overlap alone cannot tell that "Why do you want to work at X?" and
   * "Why are you interested in this role?" are the same question — after stop
   * words they share no tokens at all, which is precisely the most common essay
   * prompt. Matching intent catches the paraphrases that wording misses.
   *
   * Deliberately coarse: an archetype makes a prior answer eligible as a voice
   * sample, never as a verbatim reuse. Reuse still requires the wording itself
   * to line up.
   */
  const ARCHETYPES = [
    { name: "why-this-employer", re: /why (do|are|would).*(work|join|interest|apply|here|us\b)|why (this|our) (company|role|team|position)/i },
    { name: "proud-project", re: /(proud|favou?rite|interesting|challenging|significant).*(project|work|accomplish)|tell us about (a|your) (project|time)/i },
    { name: "strengths", re: /strength|greatest skill|what makes you|best qualif/i },
    { name: "weakness", re: /weakness|area (for|of) (improvement|growth)|struggle/i },
    { name: "salary", re: /salary|compensation|desired pay|pay expectation/i },
    { name: "availability", re: /available|start date|notice period|when (can|could) you/i },
    { name: "referral-source", re: /how did you (hear|find)|referral source/i },
    { name: "accommodation", re: /accommodation|accessib/i },
    { name: "additional", re: /anything else|additional information|other comments/i },
  ];

  /** The archetype a question belongs to, or null when it fits none. */
  const archetype = (question) =>
    (ARCHETYPES.find((a) => a.re.test(String(question || ""))) || {}).name || null;

  const STOP = new Set(
    ("a an the and or of to in for on at is are do you your yours we our us this that " +
      "with about please tell describe why what how would like it as be if any").split(" ")
  );

  /**
   * Reduce a question to comparable tokens. Company and role names are stripped
   * so "Why Cloudflare?" and "Why Stripe?" collapse to the same question — they
   * are the same question, and the answer differs only in the specifics the
   * drafter fills back in.
   */
  function tokenize(question, { company = "", role = "" } = {}) {
    let text = String(question || "").toLowerCase();
    for (const name of [company, role]) {
      if (name && name.length > 2) {
        text = text.split(String(name).toLowerCase()).join(" ");
      }
    }
    return text
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && w.length > 2 && !STOP.has(w));
  }

  function similarity(a, b) {
    const A = new Set(a);
    const B = new Set(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const t of A) if (B.has(t)) shared++;
    return shared / (A.size + B.size - shared); // Jaccard
  }

  /**
   * @param {object[]} entries stored answers
   * @param {string} question  the question being asked now
   * @param {{company?: string, role?: string}} context
   * @returns {{reuse: object|null, references: object[]}}
   */
  function lookup(entries, question, context = {}) {
    const target = tokenize(question, context);
    const targetKind = archetype(question);

    const roleSpecific = /\bfit\b|why|interest|motivat|this role|this position/i.test(question);
    const scored = (entries || [])
      .filter(e => {
        if(!e.company_specific && !roleSpecific)return true;
        return e.company && context.company && e.company.toLowerCase()===context.company.toLowerCase()
          && (!roleSpecific || (e.role && context.role && e.role.toLowerCase()===context.role.toLowerCase()));
      })
      .map((e) => ({
        entry: e,
        score: similarity(target, tokenize(e.question, context)),
        sameKind: Boolean(targetKind) && archetype(e.question) === targetKind,
      }))
      .filter((s) => s.score >= REFERENCE_THRESHOLD || s.sameKind)
      // Wording similarity ranks; a shared archetype only qualifies.
      .sort((a, b) => b.score - a.score);

    if (!scored.length) return { reuse: null, references: [] };

    const top = scored[0];
    // Only reuse verbatim if the previous answer was not company-specific, or it
    // was written for this same company. Cross-employer pitches were filtered above.
    const sameCompany =
      top.entry.company &&
      context.company &&
      top.entry.company.toLowerCase() === context.company.toLowerCase();
    const reusable =
      top.score >= REUSE_THRESHOLD && (sameCompany || !top.entry.company_specific);

    return {
      reuse: reusable ? top.entry : null,
      references: scored.slice(0, 3).map((s) => s.entry),
    };
  }

  /**
   * Record an approved answer. Called only on user approval — never on draft.
   */
  function record(entries, { question, answer, company, role, companySpecific }) {
    const list = entries || [];
    const existing = list.find((e) => e.question === question && e.company === company);
    if (existing) {
      existing.answer = answer;
      existing.used_count = (existing.used_count || 1) + 1;
      return list;
    }
    list.push({
      question,
      answer,
      company: company || null,
      role: role || null,
      company_specific: Boolean(companySpecific),
      used_count: 1,
    });
    return list;
  }

  return {
    lookup,
    record,
    tokenize,
    similarity,
    archetype,
    REUSE_THRESHOLD,
    REFERENCE_THRESHOLD,
  };
});
