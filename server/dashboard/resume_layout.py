"""One editable résumé structure rendered to LaTeX and Word."""
import io
from typing import Literal

from pydantic import BaseModel, Field, ConfigDict

from .resume import _tex_escape


TEMPLATES = {
    "classic": {"center": True, "space": 6, "accent": "222222", "sans": False, "rule": False},
    "compact": {"center": False, "space": 3, "accent": "222222", "sans": False, "rule": False},
    "modern": {"center": False, "space": 6, "accent": "245B78", "sans": True, "rule": True},
    "executive": {"center": True, "space": 8, "accent": "253647", "sans": False, "rule": True},
    "minimal": {"center": False, "space": 8, "accent": "333333", "sans": True, "rule": False},
    "technical": {"center": False, "space": 3, "accent": "24614F", "sans": True, "rule": True},
    "editorial": {"center": False, "space": 8, "accent": "713F49", "sans": False, "rule": True},
    "traditional": {"center": True, "space": 3, "accent": "222222", "sans": False, "rule": True},
}


class Entry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="", max_length=500)
    subtitle: str = Field(default="", max_length=500)
    dates: str = Field(default="", max_length=200)
    location: str = Field(default="", max_length=300)
    bullets: list[str] = Field(default_factory=list, max_length=30)


class Section(BaseModel):
    model_config = ConfigDict(extra="forbid")
    heading: str = Field(min_length=1, max_length=100)
    text: str = Field(default="", max_length=10000)
    entries: list[Entry] = Field(default_factory=list, max_length=30)


class Layout(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(default="", max_length=200)
    headline: str = Field(default="", max_length=300)
    contact: str = Field(default="", max_length=1000)
    template: Literal["classic", "compact", "modern", "executive", "minimal", "technical", "editorial", "traditional"] = "classic"
    paper: Literal["letter", "a4"] = "letter"
    font_size: Literal[10, 11, 12] = 11
    margin: float = Field(default=0.7, ge=0.5, le=1.0, allow_inf_nan=False)
    sections: list[Section] = Field(default_factory=list, max_length=20)


def from_profile(profile):
    identity = profile.get("identity", {})
    contact = [identity.get("email", ""), identity.get("phone", "")]
    location = identity.get("location", {})
    contact.append(", ".join(str(location[k]) for k in ("city", "state", "country") if location.get(k)))
    contact.extend(v for v in profile.get("links", {}).values() if isinstance(v, str))
    sections = []
    for key, heading, title_key, sub_key in [("experience", "Experience", "title", "employer"), ("education", "Education", "school", "degree"), ("projects", "Projects", "name", "tagline")]:
        entries = []
        for record in profile.get(key, []):
            subtitle = str(record.get(sub_key, ""))
            if key == "education" and record.get("field_of_study"):
                subtitle += (", " if subtitle else "") + str(record["field_of_study"])
            bullets = list(record.get("bullets", []))
            if key == "education":
                if record.get("gpa"): bullets.append("GPA: " + str(record["gpa"]))
                bullets.extend(record.get("honors", []))
                if record.get("coursework"): bullets.append("Coursework: " + ", ".join(record["coursework"]))
            if key == "projects" and record.get("url"): bullets.append(str(record["url"]))
            entries.append(Entry(title=str(record.get(title_key, "")), subtitle=subtitle,
                location=str(record.get("location", "")), dates=" – ".join(str(record[k]) for k in ("start", "end") if record.get(k)), bullets=bullets))
        if entries: sections.append(Section(heading=heading, entries=entries))
    skills = profile.get("skills", {})
    if isinstance(skills, dict):
        text = "\n".join(k.replace("_", " ").title() + ": " + ", ".join(v) for k, v in skills.items() if isinstance(v, list))
    else: text = ", ".join(skills) if isinstance(skills, list) else ""
    if text: sections.append(Section(heading="Skills", text=text))
    return Layout(name=identity.get("full_name", ""), contact=" | ".join(v for v in contact if v), sections=sections)


def tex(layout):
    e = _tex_escape
    theme = TEMPLATES[layout.template]
    compact = theme["space"] == 3
    rule = r"\vspace{2pt}\hrule\vspace{2pt}" if theme["rule"] else ""
    preamble = rf"""\documentclass[{layout.font_size}pt,{layout.paper}paper]{{article}}
\usepackage[margin={layout.margin}in]{{geometry}}
\usepackage{{fontspec}}
\usepackage{{xcolor}}
\definecolor{{accent}}{{HTML}}{{{theme["accent"]}}}
\pagestyle{{empty}}
\setlength{{\parindent}}{{0pt}}
\setlength{{\parskip}}{{{theme["space"]}pt}}
\newcommand{{\sectionheader}}[1]{{\par\vspace{{6pt}}{{\color{{accent}}\textbf{{\large #1}}\par{rule}}}\vspace{{2pt}}}}
\newcommand{{\entry}}[4]{{\par\textbf{{#1}}\hfill #4\\#2\hfill #3\par}}
\begin{{document}}
"""
    lines = [preamble]
    if theme["sans"]: lines.append(r"\sffamily")
    if theme["center"]: lines.append(r"\begin{center}")
    lines.extend([r"{\LARGE\bfseries " + e(layout.name) + r"}\par", e(layout.headline) + r"\par", e(layout.contact) + r"\par"])
    if theme["center"]: lines.append(r"\end{center}")
    for section in layout.sections:
        lines.append(r"\sectionheader{" + e(section.heading) + "}")
        for line in section.text.splitlines():
            if line.strip(): lines.append(e(line) + r"\par")
        for entry in section.entries:
            lines.append(r"\entry" + "".join("{" + e(v) + "}" for v in (entry.title, entry.subtitle, entry.location, entry.dates)))
            if entry.bullets:
                lines.append(r"\begin{itemize}\setlength{\itemsep}{" + ("0" if compact else "2") + r"pt}\setlength{\parskip}{0pt}")
                lines.extend(r"\item " + e(bullet) for bullet in entry.bullets)
                lines.append(r"\end{itemize}")
    lines.append(r"\end{document}")
    return "\n".join(lines)


def word(layout):
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    theme = TEMPLATES[layout.template]
    doc = Document()
    for section in doc.sections:
        section.top_margin = section.bottom_margin = section.left_margin = section.right_margin = Inches(layout.margin)
        section.page_width = Inches(8.5 if layout.paper == "letter" else 8.2677)
        section.page_height = Inches(11 if layout.paper == "letter" else 168.129)
    normal = doc.styles['Normal']
    normal.font.name = 'Calibri' if theme['sans'] else 'Cambria'
    normal.font.size = Pt(layout.font_size)
    normal.paragraph_format.space_after = Pt(theme['space'])
    for text, size in [(layout.name, 22), (layout.headline, layout.font_size), (layout.contact, layout.font_size)]:
        if not text: continue
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER if theme['center'] else WD_ALIGN_PARAGRAPH.LEFT
        p.add_run(text).font.size = Pt(size)
    for section in layout.sections:
        heading = doc.add_heading(section.heading, level=1)
        for run in heading.runs:
            run.font.color.rgb = RGBColor.from_string(theme['accent'])
            run.font.name = normal.font.name
        if theme['rule']:
            border=OxmlElement('w:pBdr');bottom=OxmlElement('w:bottom')
            for key,value in [('val','single'),('sz','4'),('color',theme['accent'])]: bottom.set(qn('w:'+key),value)
            border.append(bottom);heading._p.get_or_add_pPr().append(border)
        for line in section.text.splitlines():
            if line.strip(): doc.add_paragraph(line)
        for entry in section.entries:
            p = doc.add_paragraph(); p.paragraph_format.keep_with_next = True
            p.add_run(entry.title).bold = True
            if entry.dates: p.add_run(' | ' + entry.dates)
            if entry.subtitle or entry.location:
                p = doc.add_paragraph(' | '.join(v for v in [entry.subtitle, entry.location] if v))
                p.paragraph_format.keep_with_next = bool(entry.bullets)
            for bullet in entry.bullets:
                doc.add_paragraph(bullet, style='List Bullet')
    out = io.BytesIO(); doc.save(out)
    return out.getvalue()
