#!/usr/bin/env python3
"""Parse a LaTeX resume into formwork's structured profile JSON.

Tuned to the \\sectionheader / \\entry macro pair used in the author's template::

    \\newcommand{\\entry}[4]{...}   % {primary}{subtitle}{location}{right-aligned}

The four positional slots mean different things per section (education leads with
the school, experience leads with the job title), so each section gets its own
mapping rather than one generic guess.

Usage:
    python3 tools/parse_resume.py profile/private/resume.tex -o profile/private/profile.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------- detex

# Applied in order; earlier rules may feed later ones.
_MATH_GLYPHS = {
    r"$-$": "-",
    r"$\times$": "\u00d7",
    r"$\rightarrow$": "\u2192",
    r"$\leftarrow$": "\u2190",
    r"$\pm$": "\u00b1",
    r"$\sim$": "~",
}

# Commands whose braced argument survives but the command itself is dropped.
_UNWRAP = ("textbf", "textit", "emph", "text", "underline", "texttt", "mbox")

# Commands dropped entirely, argument and all.
_DROP_WITH_ARG = ("vspace", "hspace", "rule", "label", "phantom")

# Bare commands dropped, no argument.
_DROP_BARE = (
    "noindent", "small", "Large", "large", "normalsize", "footnotesize",
    "hfill", "centering", "par", "bigskip", "medskip", "smallskip",
)


def _strip_comments(tex: str) -> str:
    """Remove % comments, honoring the \\% escape."""
    out = []
    for line in tex.splitlines():
        buf = []
        i = 0
        while i < len(line):
            ch = line[i]
            if ch == "\\" and i + 1 < len(line):
                buf.append(line[i : i + 2])
                i += 2
                continue
            if ch == "%":
                break
            buf.append(ch)
            i += 1
        out.append("".join(buf))
    return "\n".join(out)


def _read_group(s: str, i: int) -> tuple[str, int]:
    """Read one balanced {...} group starting at s[i] == '{'.

    Returns (inner_text, index_after_closing_brace). Nested groups are preserved
    verbatim in the returned text, which matters for \\href{url}{label}.
    """
    if i >= len(s) or s[i] != "{":
        raise ValueError(f"expected '{{' at offset {i}, found {s[i:i+12]!r}")
    depth = 0
    start = i + 1
    while i < len(s):
        if s[i] == "\\":  # escaped char — skip the pair
            i += 2
            continue
        if s[i] == "{":
            depth += 1
        elif s[i] == "}":
            depth -= 1
            if depth == 0:
                return s[start:i], i + 1
        i += 1
    raise ValueError("unbalanced braces")


def _read_args(s: str, i: int, count: int) -> tuple[list[str], int]:
    """Read `count` consecutive brace groups, skipping whitespace between them."""
    args = []
    for _ in range(count):
        while i < len(s) and s[i].isspace():
            i += 1
        arg, i = _read_group(s, i)
        args.append(arg)
    return args, i


def href_parts(text: str) -> tuple[str | None, str]:
    """Return (url, label) for a string that may contain a single \\href."""
    m = re.search(r"\\href\s*\{", text)
    if not m:
        return None, text
    (url, label), _ = _read_args(text, m.end() - 1, 2)
    return detex(url), detex(label)


def detex(text: str) -> str:
    """Reduce LaTeX markup to plain text."""
    if not text:
        return ""
    s = text

    for src, dst in _MATH_GLYPHS.items():
        s = s.replace(src, dst)

    # \href{url}{label} -> label (repeat: a field may hold several).
    while True:
        m = re.search(r"\\href\s*\{", s)
        if not m:
            break
        (_url, label), end = _read_args(s, m.end() - 1, 2)
        s = s[: m.start()] + label + s[end:]

    for cmd in _DROP_WITH_ARG:
        while True:
            m = re.search(rf"\\{cmd}\s*\*?\s*\{{", s)
            if not m:
                break
            _args, end = _read_args(s, m.end() - 1, 1)
            s = s[: m.start()] + s[end:]

    for cmd in _UNWRAP:
        while True:
            m = re.search(rf"\\{cmd}\s*\{{", s)
            if not m:
                break
            (inner,), end = _read_args(s, m.end() - 1, 1)
            s = s[: m.start()] + inner + s[end:]

    s = re.sub(rf"\\({'|'.join(_DROP_BARE)})\b", " ", s)
    s = re.sub(r"\\\\\s*(\[[^\]]*\])?", " ", s)  # line breaks, optional spacing arg
    s = s.replace(r"\,", " ").replace(r"\;", " ").replace(r"\:", " ")
    s = s.replace("---", "\u2014").replace("--", "\u2013")
    s = re.sub(r"\\([&%$#_{}])", r"\1", s)  # escaped specials
    s = s.replace("~", " ")
    s = re.sub(r"[{}]", " ", s)  # bare grouping braces, e.g. {\Large ...}
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def split_top_level(text: str, sep: str) -> list[str]:
    """Split on `sep`, ignoring separators nested inside (), [] or {}.

    Keeps 'CI/CD (GitHub Actions, Jenkins)' in one piece.
    """
    parts, buf, depth = [], [], 0
    for ch in text:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        if ch == sep and depth == 0:
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    parts.append("".join(buf))
    return [p.strip() for p in parts if p.strip()]


# ---------------------------------------------------------------- structure


def split_sections(body: str) -> dict[str, str]:
    """Split the document body on \\sectionheader{...} into {name: raw_chunk}."""
    hits = []
    for m in re.finditer(r"\\sectionheader\s*\{", body):
        (name,), end = _read_args(body, m.end() - 1, 1)
        hits.append((detex(name).lower(), m.start(), end))

    sections = {"_header": body[: hits[0][1]] if hits else body}
    for idx, (name, _start, end) in enumerate(hits):
        stop = hits[idx + 1][1] if idx + 1 < len(hits) else len(body)
        sections[name] = body[end:stop]
    return sections


def parse_entries(chunk: str) -> list[dict]:
    """Extract each \\entry{}{}{}{} in a section plus the itemize block after it."""
    entries = []
    for m in re.finditer(r"\\entry\s*\{", chunk):
        args, end = _read_args(chunk, m.end() - 1, 4)
        entries.append({"args": args, "_body_start": end})

    for idx, entry in enumerate(entries):
        stop = entries[idx + 1]["_body_start"] if idx + 1 < len(entries) else len(chunk)
        # Only the first itemize belongs to this entry.
        entry["bullets"] = parse_items(chunk[entry.pop("_body_start") : stop], first_only=True)
    return entries


def parse_items(chunk: str, first_only: bool = False) -> list[str]:
    """Pull \\item text out of itemize environments."""
    blocks = re.findall(
        r"\\begin\{itemize\}(?:\[[^\]]*\])?(.*?)\\end\{itemize\}", chunk, re.S
    )
    if first_only:
        blocks = blocks[:1]
    items: list[str] = []
    for block in blocks:
        parts = re.split(r"\\item\b", block)[1:]
        items.extend(detex(p) for p in parts if detex(p))
    return items


def parse_dates(raw: str) -> dict:
    """'May 2024 -- May 2026' -> {'start', 'end', 'current'}."""
    text = detex(raw)
    parts = [p.strip() for p in re.split(r"\s*[\u2013\u2014]\s*", text) if p.strip()]
    if len(parts) >= 2:
        end = parts[1]
        return {
            "start": parts[0],
            "end": end,
            "current": end.lower() in {"present", "current", "now"},
        }
    return {"start": text or None, "end": None, "current": False}


# ---------------------------------------------------------------- sections


def parse_header(chunk: str) -> dict:
    """Name, location, email, phone, and links from the \\begin{center} block."""
    m = re.search(r"\\begin\{center\}(.*?)\\end\{center\}", chunk, re.S)
    raw = m.group(1) if m else chunk

    links: dict[str, str] = {}
    for hm in re.finditer(r"\\href\s*\{", raw):
        (url, _label), _ = _read_args(raw, hm.end() - 1, 2)
        url = detex(url)
        low = url.lower()
        if low.startswith("mailto:"):
            links["email"] = url[7:]
        elif "github.com" in low:
            links["github"] = url
        elif "linkedin.com" in low:
            links["linkedin"] = url
        else:
            links.setdefault("website", url)

    flat = detex(raw)
    # The name is the first \textbf in the header block. Regex over the flattened
    # text would greedily swallow the city that follows it.
    name_m = re.search(r"\\textbf\s*\{", raw)
    full_name = detex(_read_group(raw, name_m.end() - 1)[0]) if name_m else ""
    first, _, last = full_name.partition(" ")

    phone_m = re.search(r"(\+?\d[\d\s().-]{7,}\d)", flat)
    email = links.pop("email", None)
    if not email:
        em = re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", flat)
        email = em.group(0) if em else None

    loc_m = re.search(r"([A-Z][a-zA-Z]+),\s*([A-Z][a-zA-Z ]+?)\s*(?:\(|\||$)", flat)
    relocate = "open to relocation" in flat.lower()

    return {
        "identity": {
            "full_name": full_name,
            "first_name": first,
            "last_name": last,
            "email": email,
            "phone": phone_m.group(1).strip() if phone_m else None,
            "location": {
                "city": loc_m.group(1) if loc_m else None,
                "state": loc_m.group(2).strip() if loc_m else None,
                "country": "United States",
            },
            "willing_to_relocate": relocate,
        },
        "links": links,
    }


def parse_education(chunk: str) -> list[dict]:
    """\\entry{school}{degree}{location}{dates}"""
    out = []
    for e in parse_entries(chunk):
        school, degree, location, dates = (detex(a) for a in e["args"])
        bullets = e["bullets"]
        gpa = next(
            (g.group(1) for b in bullets if (g := re.search(r"GPA:?\s*([\d.]+)", b))),
            None,
        )
        coursework: list[str] = []
        honors: list[str] = []
        for b in bullets:
            cm = re.search(r"Relevant Coursework:\s*(.+)", b)
            if cm:
                coursework = [c.strip() for c in cm.group(1).split(",") if c.strip()]
                continue
            if re.search(r"GPA", b):
                honors += [
                    p.strip() for p in b.split("|")[1:] if p.strip()
                ]
                continue
            honors.append(b)

        degree_m = re.match(r"(B\.?S\.?|B\.?A\.?|M\.?S\.?|Ph\.?D\.?)[\s.]*(?:in\s+)?(.*)", degree, re.I)
        out.append(
            {
                "school": school,
                "degree": degree_m.group(1) if degree_m else degree,
                "field_of_study": degree_m.group(2).strip() if degree_m else None,
                "location": location or None,
                "gpa": gpa,
                "honors": honors,
                "coursework": coursework,
                **parse_dates(dates),
            }
        )
    return out


def parse_experience(chunk: str) -> list[dict]:
    """\\entry{title}{employer}{location}{dates}"""
    out = []
    for e in parse_entries(chunk):
        title, employer, location, dates = (detex(a) for a in e["args"])
        out.append(
            {
                "employer": employer,
                "title": title,
                "location": location or None,
                "bullets": e["bullets"],
                **parse_dates(dates),
            }
        )
    return out


def parse_projects(chunk: str) -> list[dict]:
    """\\entry{name: tagline}{kind}{}{\\href{url}{label}}, plus a trailing 'Other:' list."""
    out = []
    for e in parse_entries(chunk):
        primary, kind, _loc, right = e["args"]
        url, _label = href_parts(right)
        name, _, tagline = detex(primary).partition(":")
        out.append(
            {
                "name": name.strip(),
                "tagline": tagline.strip() or None,
                "kind": detex(kind) or None,
                "url": url,
                "bullets": e["bullets"],
            }
        )

    # The "Other:" itemize sits after the last \entry's own itemize block.
    entry_spans = [m.start() for m in re.finditer(r"\\entry\s*\{", chunk)]
    tail = chunk[entry_spans[-1] :] if entry_spans else chunk
    blocks = re.findall(
        r"\\begin\{itemize\}(?:\[[^\]]*\])?(.*?)\\end\{itemize\}", tail, re.S
    )
    for block in blocks[1:]:  # blocks[0] belongs to the last \entry
        for raw in re.split(r"\\item\b", block)[1:]:
            if not detex(raw):
                continue
            url, label = href_parts(raw)
            text = detex(raw)
            name = label if url else text.split("\u2014")[0].strip()
            _, _, desc = text.partition("\u2014")
            out.append(
                {
                    "name": name.strip(),
                    "tagline": desc.strip() or None,
                    "kind": "Open Source",
                    "url": url,
                    "bullets": [],
                }
            )
    return out


def parse_skills(chunk: str) -> dict:
    """'\\textbf{Category:} a, b, c \\\\' lines -> {category_slug: [skills]}.

    Semicolons separate proficiency tiers, marked by a parenthetical on the tier's
    last item ('...Assembly (proficient); Rust, Go (familiar)'). Those tiers become
    their own keys so the model can answer honestly about depth.
    """
    skills: dict[str, list[str]] = {}
    for m in re.finditer(r"\\textbf\s*\{", chunk):
        (label,), end = _read_args(chunk, m.end() - 1, 1)
        category = detex(label).rstrip(":").strip()
        if not category:
            continue
        nxt = re.search(r"\\textbf\s*\{", chunk[end:])
        value = detex(chunk[end : end + nxt.start()] if nxt else chunk[end:])
        slug = re.sub(r"[^a-z0-9]+", "_", category.lower()).strip("_")

        for tier in split_top_level(value, ";"):
            items = split_top_level(tier, ",")
            if not items:
                continue
            # A trailing '(proficient)' qualifies every item in the tier.
            qual_m = re.search(r"\((proficient|familiar|expert|basic)\)\s*$", items[-1], re.I)
            key = slug
            if qual_m:
                items[-1] = items[-1][: qual_m.start()].strip()
                key = f"{slug}_{qual_m.group(1).lower()}"
            skills.setdefault(key, []).extend(i for i in items if i)
    return skills


# ---------------------------------------------------------------- assembly

# Fields every ATS asks for that no resume contains. Emitted as nulls so the
# review step surfaces them instead of the LLM inventing answers.
_NEEDS_INPUT = {
    "work_authorization": {
        "authorized_to_work_us": None,
        "requires_sponsorship_now": None,
        "requires_sponsorship_future": None,
        "visa_status": None,
    },
    "demographics": {
        "gender": None,
        "race_ethnicity": None,
        "veteran_status": None,
        "disability_status": None,
        "hispanic_latino": None,
    },
    "preferences": {
        "desired_salary": None,
        "earliest_start_date": None,
        "remote_preference": None,
        "requires_relocation_assistance": None,
        "how_did_you_hear": None,
    },
    "compliance": {
        "previously_employed_here": None,
        "non_compete": None,
        "over_18": None,
        "felony_conviction": None,
    },
}


def deep_merge(base: dict, overlay: dict) -> dict:
    """Recursively overlay `overlay` onto `base`. Keys starting with '_' are notes."""
    for key, value in overlay.items():
        if key.startswith("_"):
            continue
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def build_profile(tex: str, answers: dict | None = None) -> dict:
    body_m = re.search(r"\\begin\{document\}(.*)\\end\{document\}", tex, re.S)
    body = body_m.group(1) if body_m else tex
    sections = split_sections(_strip_comments(body))

    header = parse_header(sections.get("_header", ""))
    profile = {
        "schema_version": 1,
        **header,
        "education": parse_education(sections.get("education", "")),
        "experience": parse_experience(sections.get("experience", "")),
        "projects": parse_projects(sections.get("projects", "")),
        "skills": parse_skills(sections.get("skills", "")),
        **_NEEDS_INPUT,
        "answer_bank": {},
    }

    if answers:
        deep_merge(profile, answers)

    missing = []
    for group, fields in _NEEDS_INPUT.items():
        missing += [f"{group}.{k}" for k in fields if profile[group].get(k) is None]
    profile["_needs_input"] = missing
    return profile


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("tex", type=Path, help="LaTeX resume source")
    ap.add_argument("-o", "--out", type=Path, help="write JSON here (default: stdout)")
    ap.add_argument(
        "-a",
        "--answers",
        type=Path,
        help="JSON of non-resume answers to merge (default: answers.json beside the resume)",
    )
    args = ap.parse_args()

    answers_path = args.answers or args.tex.with_name("answers.json")
    answers = None
    if answers_path.exists():
        answers = json.loads(answers_path.read_text(encoding="utf-8"))
        print(f"merging answers from {answers_path}", file=sys.stderr)

    profile = build_profile(args.tex.read_text(encoding="utf-8"), answers)
    payload = json.dumps(profile, indent=2, ensure_ascii=False)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload + "\n", encoding="utf-8")
        print(f"wrote {args.out}", file=sys.stderr)
        print(
            f"  {len(profile['experience'])} roles, "
            f"{len(profile['education'])} schools, "
            f"{len(profile['projects'])} projects, "
            f"{sum(len(v) for v in profile['skills'].values())} skills",
            file=sys.stderr,
        )
        if profile["_needs_input"]:
            print(f"  {len(profile['_needs_input'])} fields need your input", file=sys.stderr)
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
