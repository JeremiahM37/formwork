"""formwork dashboard — reviewing a drafted letter's writing style.

A cover letter can contain repetitive openers, padded contrasts and generic
claims. This checklist helps the writer notice them. It does not establish who
wrote a letter or predict how a recruiter will react to it.

This module is a *detector*, not a rewriter. That is the same split the rest of
formwork makes: the model proposes and something deterministic decides. Handing
the letter straight back to a model to "make it sound human" would be a second
unreviewed pass over prose the first pass already got wrong, and a style rewrite
drops facts more often than it adds them. So the rules are applied here as
checks, shown to the reviewer beside the claim check, and acted on only through
the redraft button — which already goes through approval and re-runs
`resume.unsupported`.

The patterns and their numbering come from the humanizer skill
(github.com/blader/humanizer, MIT, © 2025 Siqi Chen), which draws them from
Wikipedia's "Signs of AI writing" (WikiProject AI Cleanup). Only the
mechanically checkable ones are here — a regex cannot tell inflated
significance from a real claim of significance, and guessing costs the reviewer
the attention the real flags need.

The skill's own safeguard is kept: a pattern marked *weak alone* is a choice a
person makes on purpose, so weak tells are reported only when the letter shows
another tell as well. One dash is a writer. Six dashes and a staged opener is a
model.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

UPSTREAM_VERSION = "3.0.0"


@dataclass
class Tell:
    """One pattern, and every place in the letter it turned up."""

    code: str  # the section in the humanizer skill, for anyone chasing the rule
    name: str  # what the reviewer sees
    fix: str  # imperative, phrased for a model: this becomes redraft instruction
    weak: bool = False  # needs company from another tell before it is reported
    found: list[str] = field(default_factory=list)


# Straight and curly double quotes. A watched phrase inside a quotation is the
# writer quoting someone, not the writer's own habit, so phrase matching runs
# against a copy with quoted spans blanked out. Kept the same length, so every
# offset the caller reports still points at the real text.
_QUOTED = re.compile(r"[\"“][^\"”]{0,300}[\"”]")

# A cover letter has no code blocks, but it does have paths and versions, and
# `Python 3.11 -- 3.13` is not a dash used as a connector.
_DASH = re.compile(r"\s[—–]\s|—|–|\s--\s")

_PHRASES: list[tuple[str, str, str, bool, list[str]]] = [
    # (code, name, fix, weak, patterns)
    (
        "§1",
        "not X but Y",
        "State the point directly instead of setting it against something nobody claimed.",
        False,
        [
            r"\bnot (?:only|just|merely|simply)\b[^.!?]{1,90}?\bbut\b",
            # The second half is as often introduced by a dash or a semicolon
            # as by "but", and the dash version is the one models reach for:
            # "It's not the scale — it's the ownership."
            r"\b(?:it'?s not|not (?:only|just|merely|simply))\b[^.!?]{1,80}?[,;:—–]\s*it'?s\b",
            r"\bisn'?t (?:just|only|merely|simply|about)\b",
            r"\bthis (?:does not|doesn'?t) mean\b[^.!?]{0,60}[.!?]\s*it means\b",
        ],
    ),
    (
        "§2",
        "one-line closer",
        "Cut any closing line that only restates the paragraph above it.",
        False,
        [
            r"\bthat'?s the real (?:win|point|story)\b",
            r"\blet that sink in\b",
            r"\bread that again\b",
            r"\bthat'?s what (?:matters|counts)\b",
        ],
    ),
    (
        "§3",
        "sayings that sound deep",
        "Replace any 'at its core' / 'what really matters' phrasing with the specific claim.",
        False,
        [
            r"\bthe real question is\b",
            r"\bat its core\b",
            r"\bwhat really matters\b",
            r"\bthe heart of the matter\b",
            r"\bthe deeper (?:issue|question)\b",
            r"\bthe (?:language|currency|architecture) of\b",
        ],
    ),
    (
        "§4",
        "staged run-up",
        "Open on a fact about the work, not on an announcement that you are about to say something.",
        False,
        [
            r"\bi am writing to (?:apply|express|submit)\b",
            r"\blet'?s (?:dive|explore|break this down)\b",
            r"\bhere'?s (?:the thing|what you need to know)\b",
            r"\bthe thing is\b",
            r"\blet'?s be honest\b",
            r"\breal talk\b",
            r"^\s*(?:look|honestly)[,?]",
        ],
    ),
    (
        "§5",
        "arguing with no one",
        "Remove the defence against an objection the reader has not made.",
        False,
        [
            r"\bthis isn'?t (?:mainly )?about\b",
            r"\bi'?m not saying\b",
            r"\bdon'?t get me wrong\b",
            r"\bto be clear\b",
            r"\bsome might say\b",
            r"\byou might think\b[^.!?]{1,60}\bbut\b",
        ],
    ),
    (
        "§9",
        "stacked qualifiers",
        "Say it once, plainly, instead of hedging the same claim twice.",
        True,
        [
            r"\bcould potentially\b",
            r"\bmight arguably\b",
            r"\bit'?s also possible\b",
            r"\bin some cases it may\b",
            r"\bto be fair\b",
        ],
    ),
    (
        "§10",
        "hyphenated pairs",
        "Drop the stock hyphenated pairs: cross-functional, data-driven, end-to-end.",
        True,
        [
            r"\b(?:cross-functional|client-facing|data-driven|decision-making"
            r"|high-quality|real-time|long-term|end-to-end|results-driven|detail-oriented)\b",
        ],
    ),
    (
        "§12",
        "stock AI words",
        "Cut the stock vocabulary: delve, leverage, robust, passionate, align with, showcase.",
        True,
        [
            r"\b(?:delve|deep dive|bolstered|garner|interplay|intricacies|tapestry"
            r"|testament|underscores?|showcas(?:e|es|ing)|meticulous(?:ly)?|pivotal"
            r"|vibrant|crucial|foster(?:s|ing)?|leverag(?:e|es|ing)|align with"
            r"|passionate about|thrilled|excited to bring)\b",
        ],
    ),
    (
        "§15",
        "shallow -ing riders",
        "Cut the trailing '-ing' clause that adds importance rather than information.",
        True,
        [
            r",\s+(?:highlighting|underscoring|emphasizing|ensuring|reflecting"
            r"|symbolizing|contributing to|cultivating|fostering|encompassing|showcasing)\b",
        ],
    ),
    (
        "§16",
        "sales language",
        "Describe the work; do not advertise it.",
        True,
        [
            r"\b(?:boasts|renowned|groundbreaking|cutting-edge|best-in-class"
            r"|world-class|diverse array|proven track record|uniquely positioned)\b",
        ],
    ),
    (
        "§18",
        "avoiding is and has",
        "Use 'is' and 'has' rather than 'serves as' or 'stands as'.",
        True,
        [r"\b(?:serves as|stands as|functions as|operates as)\b"],
    ),
    (
        "§22",
        "chatbot residue",
        "Remove every line addressed to whoever asked for the letter.",
        False,
        [
            r"\bi hope this helps\b",
            r"\b(?:of course|certainly|great question)[!.]",
            r"\byou'?re absolutely right\b",
            r"\b(?:would you like|want me to|should i continue)\b",
            r"\blet me know if\b",
            r"^\s*here(?:'?s| is) (?:a|the|your)\b",
            r"\bas an ai\b",
        ],
    ),
    (
        "§23",
        "knowledge-limit disclaimer",
        "Remove anything about what you do or do not know about the company.",
        False,
        [
            r"\bas of my (?:last )?(?:training|knowledge)\b",
            r"\bbased on (?:the )?available information\b",
            r"\bwhile specific details\b",
            r"\bnot (?:publicly available|widely documented)\b",
            r"\bit is believed that\b",
        ],
    ),
    (
        "§25",
        "revision residue",
        "Describe the work itself; remove commentary about revising this draft.",
        False,
        [r"\b(?:in this revised version|the revised (?:letter|draft)|i have (?:revised|rewritten) (?:the|your)|compared (?:with|to) the previous (?:draft|version))\b"],
    ),
]

_COMPILED = [
    (code, name, fix, weak, [re.compile(p, re.I | re.M) for p in patterns])
    for code, name, fix, weak, patterns in _PHRASES
]

# A placeholder is not a style tell — it is a defect. The letter is compiled
# into a PDF and attached without anyone retyping it, so "[Company Name]"
# reaching this point reaches the employer.
_PLACEHOLDER = re.compile(r"\[[^\]\n]{2,40}\]|\{\{[^}\n]{1,40}\}\}|\bXXX+\b")

# LETTER_TEX supplies the name, the date and "Sincerely," itself. A model that
# writes its own produces a letter with two of each.
_SALUTATION = re.compile(
    r"^\s*(?:dear\b[^\n]{0,60}|to whom it may concern\b[^\n]{0,20})$"
    r"|^\s*(?:sincerely|best regards|kind regards|warm regards|yours (?:truly|faithfully))\b[,.]?\s*$",
    re.I | re.M,
)

# Markdown in prose bound for LaTeX: bold that will compile as literal asterisks,
# headings, bullet lists, emoji. §19 and §20 as they apply to a letter.
_MARKUP = re.compile(r"\*\*[^*\n]+\*\*|^\s{0,3}#{1,6}\s|^\s{0,3}[-*+]\s+|[\U0001F300-\U0001FAFF→]")

_TRIAD = re.compile(
    r"\b([\w'’-]+(?:\s+[\w'’-]+){0,2}),\s+([\w'’-]+(?:\s+[\w'’-]+){0,2}),"
    r"\s+and\s+([\w'’-]+(?:\s+[\w'’-]+){0,2})\b"
)

_CURLY = re.compile(r"[“”]")

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _excerpt(text: str, start: int, end: int, width: int = 34) -> str:
    """The match with a little of what surrounds it, for a tooltip.

    The reviewer needs to find the phrase in the letter, and a bare match like
    "but" is unfindable. Whitespace is collapsed because the excerpt goes into
    a one-line chip.
    """
    left = max(0, start - width)
    right = min(len(text), end + width)
    snippet = re.sub(r"\s+", " ", text[left:right]).strip()
    return f"{'…' if left else ''}{snippet}{'…' if right < len(text) else ''}"


def _blank_quotes(text: str) -> str:
    """The letter with quoted spans blanked, offsets preserved.

    A letter that quotes a job posting back at the employer should not be
    flagged for the posting's own marketing language.
    """
    return _QUOTED.sub(lambda m: " " * len(m.group(0)), text)


def find(text: str) -> list[Tell]:
    """Every AI tell in a drafted letter, strongest first.

    Weak-alone patterns are dropped unless the letter shows at least one other
    tell, per the skill's own rule: any one of them is a choice a person makes.
    """
    if not text or not text.strip():
        return []
    searchable = _blank_quotes(text)
    tells: list[Tell] = []

    for code, name, fix, weak, patterns in _COMPILED:
        hits: list[str] = []
        for pattern in patterns:
            for match in pattern.finditer(searchable):
                hits.append(_excerpt(text, match.start(), match.end()))
        if hits:
            # De-duplicated: the same stock word three times is one thing to
            # fix, and three identical chips is three times the noise.
            tells.append(Tell(code, name, fix, weak, sorted(set(hits))[:4]))

    def simple(code: str, name: str, fix: str, pattern: re.Pattern, weak: bool = False) -> None:
        hits = [_excerpt(text, m.start(), m.end()) for m in pattern.finditer(searchable)]
        if hits:
            tells.append(Tell(code, name, fix, weak, sorted(set(hits))[:4]))

    simple(
        "!",
        "unfilled placeholder",
        "Remove every bracketed blank; write the real detail or leave the sentence out.",
        _PLACEHOLDER,
    )
    simple(
        "!",
        "salutation or sign-off",
        "Write the letter body only — no 'Dear…' line and no sign-off.",
        _SALUTATION,
    )
    simple(
        "§19",
        "markdown formatting",
        "Plain prose only: no asterisks, headings, bullets or emoji.",
        _MARKUP,
    )

    # Dashes are counted rather than listed: the tell is the rate, not any one
    # of them. One is a writer's habit and stays weak; a letter built out of
    # them is the model refusing to choose how its clauses relate.
    dashes = _DASH.findall(searchable)
    if dashes:
        tells.append(
            Tell(
                "§8",
                f"{len(dashes)} dash{'es' if len(dashes) > 1 else ''}",
                "Replace the dashes with full stops, commas or brackets.",
                weak=len(dashes) < 2,
                found=[_excerpt(text, m.start(), m.end()) for m in list(_DASH.finditer(searchable))[:4]],
            )
        )

    triads = [_excerpt(text, m.start(), m.end()) for m in _TRIAD.finditer(searchable)]
    if triads:
        tells.append(
            Tell(
                "§6",
                f"{len(triads)} list{'s' if len(triads) > 1 else ''} of three",
                "Keep three items only where there are three real ones; otherwise develop the strongest.",
                # Never strong, however many there are. The skill files triads
                # under rhythm-by-rule rather than among the act-on-one-sighting
                # patterns, and this is the one construction a letter about
                # technical work has an honest reason to keep: "primitives, TLS
                # protocol code, and FIPS-mode compliance" is three real things.
                # Measured on a real drafted letter, counting two of them as
                # strong lit the chip on a letter with nothing wrong with it.
                weak=True,
                found=sorted(set(triads))[:4],
            )
        )

    curly = _CURLY.findall(searchable)
    if curly:
        tells.append(Tell("§21", "curly quotes", "Use straight quotes.", True, []))

    openings = _repeated_openings(text)
    if openings:
        tells.append(
            Tell(
                "§7",
                "repeated sentence openings",
                f"Vary the sentence openings; several in a row start with '{openings}'.",
                True,
                [],
            )
        )

    strong = [t for t in tells if not t.weak]
    # The skill's safeguard, applied literally: a weak tell reports only in
    # company. Company means any other tell, weak ones included — three weak
    # habits together is itself the pattern.
    if len(tells) < 2:
        tells = strong
    tells.sort(key=lambda t: (t.weak, t.code))
    return tells


def _repeated_openings(text: str) -> str:
    """The word that starts several consecutive sentences, if any.

    Three in a row is the model handling variety by rule. "I" gets one more,
    because a cover letter is first-person by construction and nearly every
    sentence in a good one has the candidate as its subject — flagging three
    would fire on most letters, and a chip that is always lit is a chip nobody
    reads. Four consecutive "I" sentences is a monotonous letter either way.
    """
    sentences = [s.strip() for s in _SENTENCE_SPLIT.split(text) if s.strip()]
    run, previous = 1, ""
    for sentence in sentences:
        word = re.split(r"\W+", sentence.lower())[0] if sentence else ""
        if word and word == previous:
            run += 1
            if run >= (4 if word == "i" else 3):
                return word.capitalize()
        else:
            run, previous = 1, word
    return ""


def report(text: str) -> list[dict]:
    """`find` as plain data, for the snapshot and the dashboard."""
    return [
        {"code": t.code, "name": t.name, "fix": t.fix, "weak": t.weak, "found": t.found}
        for t in find(text)
    ]


# Folded into the drafting prompt as well as checked afterwards. Deliberately
# short and phrased as what to do rather than as a list of banned things: the
# résumé work already showed this model answering a long prohibition list by
# writing to the list. The detector is the guarantee; this is only the request.
PROMPT_RULES = (
    "Write the way a person writes: plain sentences of uneven length, no dashes, no "
    "bullet points or bold, and no list of exactly three things unless there are three. "
    "Open with something you did, never with an announcement that you are applying. "
    "Do not end on a line that restates the paragraph above it. Avoid delve, leverage, "
    "robust, passionate, showcase, align with, and testament."
    " Name who did the work; retain passive voice when the actor is unknown or irrelevant. "
    "Support significance, connections and attributed opinions with the supplied evidence. "
    "Do not inflate importance or borrow unnamed experts' authority. Avoid repeating a heading "
    "in the next sentence or talking about earlier drafts. Preserve the meaning of every "
    "claim, including rankings, qualifications, numbers, names and dates. Follow the writer's "
    "own samples where their deliberate style differs from this checklist."
)
