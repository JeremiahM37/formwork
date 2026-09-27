"""Tests for the dashboard's résumé tailoring.

Two things are worth guarding here, and neither is about LaTeX.

The first is that editing a résumé is *lossless where it should be*: a plan that
says nothing must give the master back byte for byte, because the alternative is
a document whose spacing quietly drifts every time a job is applied for.

The second is the pair of rules in resume.py: a rewritten bullet may not invent
a fact or lose a measured result. Both failures are covered by fixture-based tests.

Standard library only (`python3 -m unittest discover -s tests`).
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "server"))

import _state  # noqa: E402,F401 - must precede any dashboard import

from dashboard import latex  # noqa: E402
from dashboard import resume as resume_mod  # noqa: E402

MASTER = r"""
\documentclass{article}
\newcommand{\sectionheader}[1]{{\large\textbf{#1}}\\}
\newcommand{\entry}[4]{\noindent\textbf{#1} \hfill #4 \\ \textit{#2} \hfill \textit{#3} \\}
\begin{document}

\sectionheader{Experience}
\entry{Project Coordinator}{Fixture Corp}{Exampletown, Exampleland}{2019 -- 2021}
\begin{itemize}
    \item Built a fixture manager using SampleLib and FixtureKit.
    \item Reduced exported report from 72 KB to 54 KB (25\% smaller) across eight fixture runs.
\end{itemize}

\sectionheader{Projects}
\entry{alpha: First Project}{Open Source}{}{alpha}
\begin{itemize}
    \item Wrote twelve unit tests for a text parser.
\end{itemize}

\vspace{0.3em}
\entry{beta: Second Project}{Open Source}{}{beta}
\begin{itemize}
    \item A spreadsheet importer for sample data.
\end{itemize}

\end{document}
"""


class ParseTests(unittest.TestCase):
    def setUp(self):
        self.resume = latex.parse(MASTER)

    def test_finds_entries_with_their_sections(self):
        self.assertEqual(len(self.resume.entries), 3)
        self.assertEqual(
            [(e.section, e.title) for e in self.resume.entries],
            [
                ("Experience", "Project Coordinator"),
                ("Projects", "alpha: First Project"),
                ("Projects", "beta: Second Project"),
            ],
        )

    def test_bullets_are_read_as_plain_text(self):
        bullets = self.resume.entries[0].bullets
        self.assertEqual(len(bullets), 2)
        self.assertTrue(bullets[0].text.startswith("Built a fixture manager"))

    def test_document_text_excludes_the_preamble(self):
        # Margins and line spacing are numbers, and counting them as claims the
        # résumé "already makes" would let a fabricated one through.
        body = latex.document_text(MASTER)
        self.assertIn("FixtureKit", body)
        self.assertNotIn("newcommand", body)


class RenderTests(unittest.TestCase):
    def setUp(self):
        self.resume = latex.parse(MASTER)

    def test_an_empty_plan_returns_the_master_unchanged(self):
        self.assertEqual(latex.render(self.resume, {}), MASTER)

    def test_dropping_an_entry_removes_it_and_its_spacing(self):
        out = latex.render(self.resume, {"entries": [{"index": 2, "drop": True}]})
        self.assertNotIn("beta: Second Project", out)
        self.assertIn("alpha: First Project", out)
        # The \vspace that introduced it goes too, or the section ends in a gap.
        self.assertNotIn("\\vspace{0.3em}", out)

    def test_reordering_moves_entries_within_a_section(self):
        out = latex.render(self.resume, {"order": [2, 1]})
        self.assertLess(out.index("beta: Second Project"), out.index("alpha: First Project"))

    def test_reordering_leaves_the_spacing_where_it_was(self):
        # The \vspace belongs to the slot, not to the entry: whichever entry is
        # second gets it, so a reordered résumé keeps one gap, not two or none.
        out = latex.render(self.resume, {"order": [2, 1]})
        self.assertEqual(out.count("\\vspace{0.3em}"), 1)
        self.assertLess(out.index("beta: Second Project"), out.index("\\vspace{0.3em}"))

    def test_reordering_does_not_move_entries_between_sections(self):
        out = latex.render(self.resume, {"order": [1, 0]})
        self.assertLess(out.index("Project Coordinator"), out.index("alpha: First Project"))

    def test_dropping_a_bullet_leaves_no_blank_line_behind(self):
        out = latex.render(
            self.resume, {"entries": [{"index": 0, "bullets": [{"index": 0, "drop": True}]}]}
        )
        self.assertNotIn("SampleLib", out)
        body = out[out.index("\\begin{itemize}") : out.index("\\end{itemize}")]
        self.assertEqual(len([line for line in body.splitlines() if not line.strip()]), 0)

    def test_rewriting_a_bullet_replaces_only_that_bullet(self):
        out = latex.render(
            self.resume,
            {"entries": [{"index": 0, "bullets": [{"index": 0, "text": "Built a fixture manager."}]}]},
        )
        self.assertIn("\\item Built a fixture manager.", out)
        self.assertIn("54 KB", out)


class ClaimTests(unittest.TestCase):
    def test_a_quantity_is_a_claim(self):
        self.assertIn("41.7", resume_mod.claims("Cut perplexity 41.7%"))

    def test_a_product_name_is_a_claim(self):
        self.assertIn("fixturekit", resume_mod.claims("Worked on FixtureKit"))

    def test_an_ordinary_word_is_not(self):
        self.assertNotIn("worked", resume_mod.claims("Worked on things"))

    def test_trailing_punctuation_is_not_part_of_a_name(self):
        self.assertIn("tensorrt", resume_mod.claims("Used TensorRT."))
        self.assertNotIn("tensorrt.", resume_mod.claims("Used TensorRT."))

    def test_an_invented_fact_is_unsupported(self):
        found = resume_mod.unsupported("Cut latency 93% with TensorRT.", MASTER)
        self.assertEqual(found, {"93", "tensorrt"})

    def test_rewording_the_same_facts_is_supported(self):
        self.assertEqual(
            resume_mod.unsupported("Reduced exported report from 72 KB to 54 KB across eight fixture runs.", MASTER), set()
        )

    def test_a_preamble_number_is_not_a_supported_claim(self):
        # \vspace{0.3em} is in the source; 0.3 is not something the résumé says.
        self.assertIn("0.3", resume_mod.unsupported("Improved it 0.3x.", MASTER))

    def test_dropping_a_measurement_is_detectable(self):
        original = "Reduced exported report from 72 KB to 54 KB (25% smaller) across eight fixture runs."
        vague = "Reduced memory use and improved throughput."
        lost = {
            c
            for c in resume_mod.claims(original) - resume_mod.claims(vague)
            if resume_mod._is_measurement(c)
        }
        self.assertEqual(lost, {"72", "54", "25"})

    def test_dropping_a_name_is_not_a_lost_measurement(self):
        original = "Built a fixture manager with FixtureKit and SampleLib."
        shorter = "Built a fixture manager with FixtureKit."
        lost = {
            c
            for c in resume_mod.claims(original) - resume_mod.claims(shorter)
            if resume_mod._is_measurement(c)
        }
        self.assertEqual(lost, set())


if __name__ == "__main__":
    unittest.main()


class PluralTests(unittest.TestCase):
    """A plural is not a new claim; flagging it spends attention on nothing."""

    def test_a_plural_of_a_known_name_is_supported(self):
        self.assertEqual(resume_mod.unsupported("Built a fixture manager with FixtureKits", MASTER), set())

    def test_a_singular_of_a_known_plural_is_supported(self):
        master = MASTER.replace("FixtureKit and SampleLib", "FixtureKits and SampleLib")
        self.assertEqual(resume_mod.unsupported("Built a fixture manager with FixtureKit", master), set())

    def test_a_number_is_still_compared_exactly(self):
        # "25" and "25.1" are different claims; nothing about plurals
        # should loosen that.
        self.assertIn("25.1", resume_mod.unsupported("Reached 25.1 times throughput.", MASTER))

    def test_an_invented_name_is_still_caught_in_the_plural(self):
        self.assertIn("tensorrts", resume_mod.unsupported("Used TensorRTs.", MASTER))


class SectionTests(unittest.TestCase):
    """A section that loses every entry loses its heading too."""

    def setUp(self):
        self.resume = latex.parse(MASTER)

    def test_a_section_emptied_of_entries_loses_its_heading(self):
        # PROJECTS followed by nothing reads as a document that broke on the
        # way out, and it is going to an employer.
        out = latex.render(
            self.resume, {"entries": [{"index": 1, "drop": True}, {"index": 2, "drop": True}]}
        )
        self.assertNotIn("Projects", out)
        self.assertIn("Experience", out)

    def test_a_section_that_keeps_one_entry_keeps_its_heading(self):
        out = latex.render(self.resume, {"entries": [{"index": 1, "drop": True}]})
        self.assertIn("Projects", out)
        self.assertIn("beta: Second Project", out)

    def test_a_section_with_no_entries_at_all_is_left_alone(self):
        # A skills section is prose under a heading. Removing that would be the
        # same mistake in reverse.
        master = MASTER.replace(
            "\\end{document}", "\\sectionheader{Skills}\nGo, C\n\\end{document}"
        )
        out = latex.render(latex.parse(master), {"entries": [{"index": 1, "drop": True}]})
        self.assertIn("Skills", out)
        self.assertIn("Go, C", out)

    def test_itemize_stays_balanced_across_every_combination(self):
        plans = [
            {},
            {"order": [2, 1]},
            {"entries": [{"index": 1, "drop": True}]},
            {"order": [2, 1], "entries": [{"index": 1, "drop": True}]},
            {"entries": [{"index": 0, "bullets": [{"index": 0, "drop": True}]}]},
        ]
        for plan in plans:
            out = latex.render(self.resume, plan)
            self.assertEqual(
                out.count("\\begin{itemize}"), out.count("\\end{itemize}"), plan
            )
            self.assertIn("\\end{document}", out)


class TailorRuleTests(unittest.IsolatedAsyncioTestCase):
    """What a model is allowed to do to a résumé, and what is refused.

    The model is replaced with one that returns a chosen plan, so each rule can
    be shown refusing the thing it exists to refuse.
    """

    async def _tailor(self, plan):
        from dashboard import model

        async def fake(messages, want_json=False, timeout=300.0):
            return json.dumps(plan)

        original = model.complete
        model.complete = fake
        try:
            return await resume_mod.tailor("a posting", MASTER)
        finally:
            model.complete = original

    def _reasons(self, result):
        return " | ".join(r["reason"] for r in result["rejected"])

    async def test_a_rewrite_that_invents_a_number_is_refused(self):
        out = await self._tailor(
            {"entries": [{"index": 0, "bullets": [{"index": 0, "text": "Processed the fixture manager for 12 sample inputs."}]}]}
        )
        self.assertIn("introduces 12", self._reasons(out))
        self.assertEqual(out["plan"]["entries"], [])

    async def test_a_rewrite_that_drops_a_measurement_is_refused(self):
        out = await self._tailor(
            {"entries": [{"index": 0, "bullets": [{"index": 1, "text": "Reduced memory and improved throughput."}]}]}
        )
        self.assertIn("drops the evidence", self._reasons(out))

    async def test_a_rewrite_keeping_every_number_is_accepted(self):
        out = await self._tailor(
            {
                "entries": [
                    {
                        "index": 0,
                        "bullets": [
                            {"index": 1, "text": "Reduced exported report to 54 KB from 72 KB across eight runs (25% smaller)."}
                        ],
                    }
                ]
            }
        )
        self.assertEqual(out["rejected"], [])
        self.assertTrue(out["changed"])

    async def test_a_rewrite_that_pads_is_refused(self):
        padded = (
            "Built a thoroughly tested fixture manager for a wide variety of "
            "sample inputs with FixtureKit and SampleLib, ensuring consistent output."
        )
        out = await self._tailor({"entries": [{"index": 0, "bullets": [{"index": 0, "text": padded}]}]})
        self.assertIn("longer", self._reasons(out))

    async def test_a_rewrite_repeating_another_bullet_is_refused(self):
        # The model losing track of which bullet it was given: the entry would
        # end up saying one thing twice and the other thing not at all. The
        # duplicate is taken from the document so the test cannot drift from it.
        sibling = latex.parse(MASTER).entries[0].bullets[1].text
        out = await self._tailor(
            {"entries": [{"index": 0, "bullets": [{"index": 0, "text": sibling}]}]}
        )
        self.assertIn("repeats another bullet", self._reasons(out))

    async def test_education_and_employment_may_not_be_dropped(self):
        # Those are the record, not a pitch.
        out = await self._tailor({"entries": [{"index": 0, "drop": True}]})
        self.assertIn("refused to drop", self._reasons(out))
        self.assertEqual(out["plan"]["entries"], [])

    async def test_a_project_may_be_dropped(self):
        out = await self._tailor({"entries": [{"index": 2, "drop": True}]})
        self.assertEqual(out["rejected"], [])
        self.assertNotIn("beta: Second Project", out["tex"])

    async def test_only_one_bullet_per_entry_may_be_dropped(self):
        out = await self._tailor(
            {"entries": [{"index": 0, "bullets": [{"index": 0, "drop": True}, {"index": 1, "drop": True}]}]}
        )
        self.assertIn("asked to drop 2", self._reasons(out))
        dropped = [b for b in out["plan"]["entries"][0]["bullets"] if b.get("drop")]
        self.assertEqual(len(dropped), 1)

    async def test_nonsense_from_the_model_changes_nothing(self):
        out = await self._tailor(
            {"entries": [{"index": 99, "drop": True}, {"index": "x"}, {}], "order": [99, "a"]}
        )
        self.assertFalse(out["changed"])
        self.assertEqual(out["tex"], MASTER)

    async def test_an_unchanged_résumé_reports_no_summary(self):
        # A summary under a résumé the interface calls unchanged just sends the
        # reader looking for a difference that is not there.
        out = await self._tailor({})
        self.assertFalse(out["changed"])
        self.assertEqual(out["summary"], [])


class MalformedResumeTests(unittest.TestCase):
    """A résumé someone is halfway through editing.

    The dashboard lets the master be edited in a textarea, and LaTeX makes an
    unbalanced brace easy. Parsing has to fail in a way the caller can catch,
    not in a way that leaves a background task dead and an application spinning.
    """

    def test_unbalanced_braces_raise_something_catchable(self):
        broken = "\\begin{document}\\sectionheader{X}\\entry{A}{B}{C}{D\n\\end{document}"
        with self.assertRaises(ValueError):
            latex.parse(broken)

    def test_everything_else_odd_parses_without_raising(self):
        for name, source in {
            "empty": "",
            "no document environment": r"\entry{A}{B}{C}{D}",
            "entry with no bullet list": "\\begin{document}\\entry{A}{B}{C}{D}\\end{document}",
            "unclosed itemize": "\\begin{document}\\entry{A}{B}{C}{D}\\begin{itemize}\\item hi\\end{document}",
            "itemize with no items": "\\begin{document}\\entry{A}{B}{C}{D}\\begin{itemize}\\end{itemize}\\end{document}",
            "nested braces in an argument": "\\begin{document}\\entry{A {deep {er}}}{B}{C}{D}\\end{document}",
            "a section with no entries": "\\begin{document}\\sectionheader{Skills}Go, C\\end{document}",
        }.items():
            with self.subTest(name):
                resume = latex.parse(source)
                # And an empty plan still gives the source back untouched.
                self.assertEqual(latex.render(resume, {}), source)


class CoverLetterPrivacyTests(unittest.TestCase):
    """The cover letter is a model request like any other.

    The extension redacts contact details before any prompt. This path was
    handing over the whole résumé — header included, which is where the name,
    the email, the phone number and the links all live.
    """

    IDENTITY = {
        "full_name": "Dana Rivera",
        "first_name": "Dana",
        "last_name": "Rivera",
        "email": "dana.rivera@example.com",
        "phone": "919-555-0142",
        "links": {"github": "https://github.com/danarivera"},
    }

    def scrub(self, text):
        return resume_mod.without_identity(text, self.IDENTITY)

    def test_removes_every_way_the_details_are_written(self):
        text = (
            "Dana Rivera\n"
            "dana.rivera@example.com | 919-555-0142 | https://github.com/danarivera\n"
            "Reach me at Dana.Rivera@example.com or (919) 555-0142 or +1 919 555 0142."
        )
        out = self.scrub(text)
        for fragment in ["Dana", "Rivera", "example.com", "555-0142", "danarivera"]:
            self.assertNotIn(fragment.lower(), out.lower(), fragment)

    def test_keeps_the_evidence_the_letter_is_written_from(self):
        text = "Reduced exported report from 72 KB to 54 KB (25% smaller) across eight fixture runs."
        self.assertEqual(self.scrub(text), text)

    def test_does_not_eat_dates(self):
        # A pattern loose enough to catch every phone format is loose enough to
        # eat "2024 -- 2026", and a letter without dates is the worse document.
        for text in [
            "Software Engineer, Acme. 2024 -- 2026.",
            "Reviewed 200 pull requests in 2025",
            "Ported it in 2024, shipped 2026",
        ]:
            self.assertEqual(self.scrub(text), text, text)

    def test_removing_a_first_name_does_not_strand_the_surname(self):
        # Longest first, or "Dana Rivera" becomes " Rivera".
        self.assertNotIn("Rivera", self.scrub("Dana Rivera wrote this."))

    def test_an_empty_identity_changes_nothing(self):
        text = "Dana Rivera, 919-555-0142"
        self.assertEqual(resume_mod.without_identity(text, {}), text)
