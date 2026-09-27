/** Local style review, adapted from blader/humanizer (MIT, Siqi Chen).
 * This is a writing checklist, never an authorship detector. Rules are generated
 * from the dashboard source; no text leaves the browser for these checks.
 */
(function(root, factory) {
  const api = factory(typeof require === "function" ? require("./humanizer-rules.js") : root.__formwork.humanizerRules);
  if (typeof module === "object" && module.exports) module.exports = api;
  else (root.__formwork = root.__formwork || {}).humanize = api;
})(globalThis, function(rules) {
  "use strict";
  const phrases = rules.phrases.map(([code, name, fix, weak, patterns]) =>
    ({code, name, fix, weak, patterns: patterns.map(p => new RegExp(p, "gimu"))}));
  const excerpt = (text, start, end) => {
    const left = Math.max(0, start - 34), right = Math.min(text.length, end + 34);
    return `${left ? "…" : ""}${text.slice(left, right).replace(/\s+/g, " ").trim()}${right < text.length ? "…" : ""}`;
  };
  function report(text, {bodyOnly = true} = {}) {
    if (!text?.trim()) return [];
    const searchable = text.replace(/["“][^"”]{0,300}["”]/g, m => " ".repeat(m.length));
    let tells = [];
    const hits = pattern => [...searchable.matchAll(pattern)].map(m => excerpt(text, m.index, m.index + m[0].length));
    for (const {code, name, fix, weak, patterns} of phrases) {
      const found = [...new Set(patterns.flatMap(hits))].sort().slice(0, 4);
      if (found.length) tells.push({code, name, fix, weak, found});
    }
    for (const [code, name, fix, pattern] of rules.simple) {
      if (!bodyOnly && name === "salutation or sign-off") continue;
      const found = [...new Set(hits(new RegExp(pattern, "gimu")))].sort().slice(0, 4);
      if (found.length) tells.push({code, name, fix, weak: false, found});
    }
    const dash = /\s[—–]\s|—|–|\s--\s/gu;
    const dashes = hits(dash);
    if (dashes.length) tells.push({code: "§8", name: `${dashes.length} dash${dashes.length > 1 ? "es" : ""}`,
      fix: "Replace the dashes with full stops, commas or brackets.", weak: dashes.length < 2, found: dashes.slice(0, 4)});
    const triads = hits(/\b([\w'’-]+(?:\s+[\w'’-]+){0,2}),\s+([\w'’-]+(?:\s+[\w'’-]+){0,2}),\s+and\s+([\w'’-]+(?:\s+[\w'’-]+){0,2})\b/gu);
    if (triads.length) tells.push({code: "§6", name: `${triads.length} list${triads.length > 1 ? "s" : ""} of three`,
      fix: "Keep three items only where there are three real ones; otherwise develop the strongest.", weak: true, found: [...new Set(triads)].sort().slice(0, 4)});
    if (/[“”]/u.test(searchable)) tells.push({code: "§21", name: "curly quotes", fix: "Use straight quotes.", weak: true, found: []});
    let previous = "", run = 1;
    for (const sentence of text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean)) {
      const word = sentence.toLowerCase().split(/\W+/)[0];
      run = word && word === previous ? run + 1 : 1;
      previous = word;
      if (run >= (word === "i" ? 4 : 3)) {
        tells.push({code: "§7", name: "repeated sentence openings", fix: `Vary the sentence openings; several in a row start with '${word[0].toUpperCase() + word.slice(1)}'.`, weak: true, found: []});
        break;
      }
    }
    if (tells.length < 2) tells = tells.filter(t => !t.weak);
    return tells.sort((a, b) => Number(a.weak) - Number(b.weak) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  }
  function instruction(tells) {
    return [...new Set(tells.map(t => t.fix))].slice(0, 5).join(" ") +
      " Preserve every factual claim, number, named technology and qualification. Match the candidate's writing samples.";
  }
  return {report, instruction, PROMPT_RULES: rules.prompt};
});
