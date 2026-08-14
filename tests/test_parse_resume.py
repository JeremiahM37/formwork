"""Tests for the LaTeX resume parser.

Written against unittest so they run with the standard library alone
(`python3 -m unittest discover -s tests`); pytest collects them too.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import parse_resume  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "resume.example.tex"


class ParseResumeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tex = FIXTURE.read_text(encoding="utf-8")
        cls.profile = parse_resume.build_profile(cls.tex)

    # ------------------------------------------------------------- identity

    def test_name_is_taken_from_the_heading_not_the_running_text(self):
        # A regex over flattened text greedily swallows the city that follows,
        # producing "Dana Rivera Asheville".
        identity = self.profile["identity"]
        self.assertEqual(identity["full_name"], "Dana Rivera")
        self.assertEqual(identity["first_name"], "Dana")
        self.assertEqual(identity["last_name"], "Rivera")

    def test_contact_details_and_links(self):
        identity = self.profile["identity"]
        self.assertEqual(identity["email"], "dana.rivera@example.com")
        self.assertEqual(identity["phone"], "919-555-0142")
        self.assertEqual(identity["location"]["city"], "Asheville")
        self.assertEqual(identity["location"]["state"], "North Carolina")
        self.assertTrue(identity["willing_to_relocate"])
        self.assertEqual(self.profile["links"]["github"], "https://github.com/danarivera")
        self.assertIn("linkedin.com", self.profile["links"]["linkedin"])

    # ------------------------------------------------------------ sections

    def test_education_entry_leads_with_the_school(self):
        # \entry's four slots mean different things per section: education
        # leads with the school, experience with the job title.
        edu = self.profile["education"][0]
        self.assertEqual(edu["school"], "Blue Ridge State University")
        self.assertEqual(edu["degree"], "B.S.")
        self.assertEqual(edu["field_of_study"], "Computer Science")
        self.assertEqual(edu["gpa"], "3.7")
        self.assertEqual(edu["start"], "August 2018")
        self.assertEqual(edu["end"], "May 2022")
        self.assertIn("Dean's List", edu["honors"])
        self.assertIn("Operating Systems", edu["coursework"])

    def test_experience_entry_leads_with_the_title(self):
        job = self.profile["experience"][0]
        self.assertEqual(job["employer"], "Northlight Systems")
        self.assertEqual(job["title"], "Software Engineer")
        self.assertEqual(job["end"], "Present")
        self.assertTrue(job["current"])
        self.assertEqual(len(job["bullets"]), 2)

    def test_projects_include_both_entries_and_the_trailing_other_list(self):
        names = [p["name"] for p in self.profile["projects"]]
        self.assertIn("tilebase", names)
        self.assertIn("ledgerctl", names, "the 'Other:' list is easy to miss")
        tilebase = next(p for p in self.profile["projects"] if p["name"] == "tilebase")
        self.assertEqual(tilebase["url"], "https://github.com/danarivera/tilebase")
        self.assertEqual(tilebase["tagline"], "Offline-first map tile server")

    def test_skill_tiers_are_kept_apart(self):
        skills = self.profile["skills"]
        self.assertEqual(skills["languages_proficient"], ["Go", "Python", "SQL"])
        self.assertEqual(skills["languages_familiar"], ["Rust", "TypeScript"])

    def test_a_parenthesised_list_is_not_split_on_its_inner_comma(self):
        self.assertIn("CI/CD (GitHub Actions, Jenkins)", self.profile["skills"]["infrastructure_devops"])

    # -------------------------------------------------------------- detex

    def test_latex_escapes_and_math_glyphs_are_reduced_to_text(self):
        bullets = " ".join(self.profile["experience"][0]["bullets"])
        self.assertIn("-87% tail latency", bullets, "$-$ and \\% must decode")
        self.assertNotIn("\\", bullets)
        project = self.profile["projects"][0]["bullets"][0]
        self.assertIn("3× faster", project, "$\\times$ must decode")

    def test_detex_handles_nested_and_escaped_braces(self):
        self.assertEqual(parse_resume.detex(r"\textbf{Bold \& \textit{nested}}"), "Bold & nested")
        self.assertEqual(parse_resume.detex(r"\href{https://x.test}{label}"), "label")
        self.assertEqual(parse_resume.detex(""), "")

    def test_unbalanced_braces_raise_rather_than_silently_truncating(self):
        with self.assertRaises(ValueError):
            parse_resume._read_group("{unterminated", 0)

    # ----------------------------------------------------- non-resume data

    def test_fields_no_resume_contains_are_reported_as_needing_input(self):
        needs = self.profile["_needs_input"]
        self.assertIn("work_authorization.authorized_to_work_us", needs)
        self.assertIn("demographics.gender", needs)
        self.assertIn("compliance.felony_conviction", needs)

    def test_answers_file_is_merged_over_the_parsed_resume(self):
        answers = {
            "work_authorization": {"authorized_to_work_us": True, "requires_sponsorship_now": False},
            "demographics": {"gender": "Decline To Self Identify"},
        }
        merged = parse_resume.build_profile(self.tex, answers)
        self.assertTrue(merged["work_authorization"]["authorized_to_work_us"])
        self.assertEqual(merged["demographics"]["gender"], "Decline To Self Identify")
        # Resume-derived content survives the merge.
        self.assertEqual(merged["identity"]["full_name"], "Dana Rivera")
        # And what is still unanswered shrinks accordingly.
        self.assertNotIn("demographics.gender", merged["_needs_input"])
        self.assertIn("compliance.felony_conviction", merged["_needs_input"])

    def test_comment_only_answers_keys_are_ignored(self):
        merged = parse_resume.build_profile(self.tex, {"_comment": "ignore me", "demographics": {}})
        self.assertNotIn("_comment", merged)

    # ---------------------------------------------------------------- cli

    def test_cli_writes_json_that_round_trips(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "profile.json"
            argv = sys.argv
            sys.argv = ["parse_resume.py", str(FIXTURE), "-o", str(out)]
            try:
                self.assertEqual(parse_resume.main(), 0)
            finally:
                sys.argv = argv
            data = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(data["identity"]["full_name"], "Dana Rivera")
            self.assertEqual(data["schema_version"], 1)


if __name__ == "__main__":
    unittest.main()
