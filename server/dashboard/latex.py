"""
formwork dashboard — reading and rewriting a LaTeX résumé.

The master document is treated as the source of truth and edited in place, not
regenerated. A résumé's preamble is where its whole appearance lives — margins,
line spacing, the `\\entry` and `\\sectionheader` macros — and regenerating from
a parsed model would quietly discard the parts nobody described. So the file is
indexed into spans, and tailoring is a matter of reordering and substituting
those spans; every byte not touched comes through unchanged.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from parse_resume import _read_args, detex  # noqa: E402


@dataclass
class Bullet:
    index: int
    span: tuple[int, int]  # into the source, covering the text after \item
    text: str  # detexed, for the model and the UI
    source: str  # the LaTeX, verbatim


@dataclass
class Entry:
    index: int
    section: str
    title: str
    subtitle: str
    span: tuple[int, int]  # the whole block: \entry through \end{itemize}
    bullets: list[Bullet] = field(default_factory=list)


@dataclass
class Resume:
    source: str
    entries: list[Entry]

    def section_names(self) -> list[str]:
        seen: list[str] = []
        for entry in self.entries:
            if entry.section not in seen:
                seen.append(entry.section)
        return seen


_SECTION = re.compile(r"\\sectionheader\{")
_ENTRY = re.compile(r"\\entry\{")
_ITEMIZE_BEGIN = re.compile(r"\\begin\{itemize\}")
_ITEMIZE_END = re.compile(r"\\end\{itemize\}")


def _sections(source: str) -> list[tuple[int, str]]:
    out = []
    for match in _SECTION.finditer(source):
        args, _ = _read_args(source, match.end() - 1, 1)
        out.append((match.start(), detex(args[0]) if args else ""))
    return out


def _section_spans(source: str) -> dict[str, tuple[int, int]]:
    """Where each section's heading starts and ends, by title."""
    spans: dict[str, tuple[int, int]] = {}
    for match in _SECTION.finditer(source):
        args, after = _read_args(source, match.end() - 1, 1)
        spans[detex(args[0]) if args else ""] = (match.start(), after)
    return spans


def _section_at(sections: list[tuple[int, str]], position: int) -> str:
    name = ""
    for start, title in sections:
        if start <= position:
            name = title
        else:
            break
    return name


def _split_items(body: str, offset: int) -> list[tuple[int, int, str]]:
    """Every `\\item` in an itemize body, as (start, end, source)."""
    positions = [m.start() for m in re.finditer(r"\\item\b", body)]
    out = []
    for i, start in enumerate(positions):
        text_start = start + len("\\item")
        text_end = positions[i + 1] if i + 1 < len(positions) else len(body)
        chunk = body[text_start:text_end]
        # Trim the trailing newline/indent that belongs to the next line, so a
        # substituted bullet does not accumulate blank lines on every pass.
        stripped = chunk.rstrip()
        out.append((offset + text_start, offset + text_start + len(stripped), stripped))
    return out


def parse(source: str) -> Resume:
    sections = _sections(source)
    entries: list[Entry] = []

    for index, match in enumerate(_ENTRY.finditer(source)):
        args, after = _read_args(source, match.end() - 1, 4)
        title = detex(args[0]) if args else ""
        subtitle = detex(args[1]) if len(args) > 1 else ""

        begin = _ITEMIZE_BEGIN.search(source, after)
        end = _ITEMIZE_END.search(source, begin.end()) if begin else None
        # An entry with no bullet list is still an entry — it just cannot have
        # its bullets tailored. Its block ends where its own text does.
        if not begin or not end:
            entries.append(
                Entry(
                    index=index,
                    section=_section_at(sections, match.start()),
                    title=title,
                    subtitle=subtitle,
                    span=(match.start(), after),
                )
            )
            continue

        body_start, body_end = begin.end(), end.start()
        bullets = [
            Bullet(index=i, span=(s, e), text=detex(src).strip(), source=src)
            for i, (s, e, src) in enumerate(_split_items(source[body_start:body_end], body_start))
        ]
        entries.append(
            Entry(
                index=index,
                section=_section_at(sections, match.start()),
                title=title,
                subtitle=subtitle,
                span=(match.start(), end.end()),
                bullets=bullets,
            )
        )
    return Resume(source=source, entries=entries)


_LEADING_SPACING = re.compile(r"(?:\\vspace\{[^}]*\}|\s)+\Z")


def _drop_span(source: str, entry: Entry) -> tuple[int, int]:
    """An entry's span, widened to swallow the spacing that preceded it.

    A `\\vspace` left behind by a removed entry is a gap in the middle of a
    section with nothing in it — the document still compiles, and it looks like
    a mistake, which on a résumé is the same as being one.
    """
    match = _LEADING_SPACING.search(source, 0, entry.span[0])
    return (match.start() if match else entry.span[0]), entry.span[1]


_LINE_START = re.compile(r"\n[ \t]*\Z")


def _line_start(text: str, position: int) -> int:
    """Where the line containing `position` begins."""
    match = _LINE_START.search(text, 0, position)
    return match.start() if match else position


def _entry_text(resume: Resume, entry: Entry, plan: dict | None) -> str | None:
    """One entry's LaTeX with its bullet plan applied, or None if it is dropped."""
    if plan and plan.get("drop"):
        return None
    start, end = entry.span
    text = resume.source[start:end]
    if not plan:
        return text

    bullet_plans = {b["index"]: b for b in plan.get("bullets", []) if isinstance(b.get("index"), int)}
    edits: list[tuple[int, int, str]] = []
    for bullet in entry.bullets:
        bullet_plan = bullet_plans.get(bullet.index)
        if not bullet_plan:
            continue
        # Spans are absolute in the source; shift them into this slice.
        first, last = bullet.span[0] - start, bullet.span[1] - start
        if bullet_plan.get("drop"):
            # Take the \item and the line it sat on. Removing only the text
            # leaves an indented blank line inside the itemize, and LaTeX
            # renders that as a gap where a bullet used to be.
            edits.append((_line_start(text, first - len("\\item")), last, ""))
        elif bullet_plan.get("text"):
            edits.append((first, last, " " + bullet_plan["text"].strip()))
    for first, last, replacement in sorted(edits, key=lambda e: e[0], reverse=True):
        text = text[:first] + replacement + text[last:]
    return text


def render(resume: Resume, plan: dict) -> str:
    """Apply a tailoring plan to the master, returning new LaTeX.

    `plan` is `{"entries": [{"index": n, "drop": bool, "bullets": [...]}],
    "order": [n, ...]}`. Anything not mentioned keeps its place and its text,
    which is what makes a half-understood plan degrade into the master rather
    than into a hole.

    Reordering works by writing the surviving entries back into the *slots* the
    originals occupied, in the new order. The spacing between slots belongs to
    the document, not to the entry, so it stays put: whichever entry ends up
    first in a section gets that section's tighter opening, and the rest get
    their `\\vspace`. Moving the spacing with the entry is how a reordered
    résumé ends up with two gaps in one place and none in another.
    """
    entry_plans = {p["index"]: p for p in plan.get("entries", []) if isinstance(p.get("index"), int)}
    order = [i for i in plan.get("order", []) if isinstance(i, int)]

    edits: list[tuple[int, int, str]] = []

    for section in resume.section_names():
        entries = [e for e in resume.entries if e.section == section]
        if not entries:
            continue
        slots = [e.span for e in entries]

        # Entries this section keeps, in the order asked for. An index the
        # plan never mentions keeps its original position relative to the rest.
        ranked = sorted(
            entries,
            key=lambda e: order.index(e.index) if e.index in order else len(order) + e.index,
        )
        rendered = [t for t in (_entry_text(resume, e, entry_plans.get(e.index)) for e in ranked) if t is not None]

        for position, (start, end) in enumerate(slots):
            if position < len(rendered):
                edits.append((start, end, rendered[position]))
            else:
                # A slot with nothing left to put in it: remove it and the
                # spacing that introduced it.
                edits.append((*_drop_span(resume.source, entries[position]), ""))

    # A section that has lost every entry has to lose its heading too. A résumé
    # that says PROJECTS and then says nothing reads as a document that broke on
    # the way out, and it is going to an employer. Only headings that had
    # entries are candidates — a Skills section is prose under a heading, and
    # removing that would be the same mistake in reverse.
    spans = _section_spans(resume.source)
    for section in resume.section_names():
        entries = [e for e in resume.entries if e.section == section]
        if not entries:
            continue
        kept = sum(
            1
            for e in entries
            if not (entry_plans.get(e.index) or {}).get("drop")
        )
        if kept == 0 and section in spans:
            edits.append((*spans[section], ""))

    out = resume.source
    for start, end, replacement in sorted(edits, key=lambda e: e[0], reverse=True):
        out = out[:start] + replacement + out[end:]
    return out


def document_text(source: str) -> str:
    """The résumé as prose — everything the reader sees, and nothing else.

    Cut at `\\begin{document}` on purpose. The preamble is full of numbers that
    are not claims about the candidate — margins, line spacing, font sizes — and
    counting `0.45in` as a fact the résumé "already states" would let a model
    slip a fabricated 0.45 past the check in resume.py.
    """
    start = source.find(r"\begin{document}")
    body = source[start:] if start != -1 else source
    return detex(body)


def inventory(resume: Resume) -> list[dict]:
    """What the model is shown: plain text, indexed, no LaTeX."""
    return [
        {
            "index": entry.index,
            "section": entry.section,
            "title": entry.title,
            "subtitle": entry.subtitle,
            "bullets": [{"index": b.index, "text": b.text} for b in entry.bullets],
        }
        for entry in resume.entries
    ]
