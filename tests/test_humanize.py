"""What the AI-tell detector must and must not flag in a drafted letter.

The second half matters more than the first. A detector that flags an honest
sentence is worse than no detector: the reviewer learns to skim the chip, and
then skims it on the letter that really does open with "I am writing to apply".
So every clean case here is a real cover-letter sentence, not a strawman.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from dashboard import humanize  # noqa: E402


def codes(text: str) -> set[str]:
    return {tell.code for tell in humanize.find(text)}


def names(text: str) -> set[str]:
    return {tell.name for tell in humanize.find(text)}


# A letter with no tells, used as the carrier whenever a test needs one tell in
# an otherwise clean letter. Written the way the prompt asks for: plain
# sentences, no dashes, no triads, opens on the work.
CLEAN = (
    "I worked on a sample data service at Fixture Company and helped make its "
    "daily maintenance easier to understand. I also wrote the short runbook the "
    "team uses when preparing a release.\n\n"
    "Your posting mentions maintaining reliable data tools. I enjoy that kind "
    "of work and can talk through the tradeoffs.\n\n"
    "I would like to talk about the role."
)


class CleanProse(unittest.TestCase):
    def test_a_plain_letter_has_no_tells(self):
        self.assertEqual(humanize.find(CLEAN), [])

    def test_empty_text_is_not_a_finding(self):
        self.assertEqual(humanize.find(""), [])
        self.assertEqual(humanize.find("   \n  "), [])

    def test_first_person_openings_are_the_form_working(self):
        """Two sentences starting "I" is a cover letter, not a model."""
        self.assertNotIn("§7", codes("I built the parser. I tested it on real forms."))

    def test_three_real_items_in_a_quotation_are_the_posting_not_the_writer(self):
        """A letter quoting the posting back should not be flagged for its prose."""
        text = (
            'The posting asks for "a robust, data-driven and world-class platform '
            'team", and that is the work I have been doing for three years.'
        )
        self.assertEqual(humanize.find(text), [])


class StrongTells(unittest.TestCase):
    """§1 to §5, §19, §22, §23 and the outright defects: one sighting is enough."""

    def test_not_x_but_y(self):
        self.assertIn("§1", codes(f"This is not just a job for me, but a chance to build. {CLEAN}"))
        self.assertIn("§1", codes(f"It's not the tooling, it's the ownership. {CLEAN}"))
        # The dash form is the one a model actually writes.
        self.assertIn("§1", codes(f"It's not just the scale — it's the ownership. {CLEAN}"))

    def test_staged_opener(self):
        self.assertIn("§4", codes(f"I am writing to apply for the Platform Engineer role. {CLEAN}"))

    def test_chatbot_residue(self):
        text = f"Certainly! Here is your cover letter. {CLEAN} Let me know if you would like it shorter."
        self.assertIn("§22", codes(text))

    def test_knowledge_limit_disclaimer(self):
        self.assertIn("§23", codes(f"While specific details about your funding are unclear, {CLEAN}"))

    def test_an_unfilled_placeholder_is_reported_alone(self):
        """The letter is compiled and attached unread; a bracketed blank ships."""
        self.assertIn("unfilled placeholder", names(f"I have long admired [Company Name]. {CLEAN}"))

    def test_a_salutation_would_double_the_letters_own(self):
        """LETTER_TEX supplies the name, the date and "Sincerely,"."""
        self.assertIn("salutation or sign-off", names(f"Dear Hiring Manager,\n\n{CLEAN}\n\nSincerely,"))

    def test_markdown_never_survives_latex(self):
        self.assertIn("§19", codes(f"I led **three** migrations.\n\n{CLEAN}"))
        self.assertIn("§19", codes(f"## Why me\n\n{CLEAN}"))

    def test_a_strong_tell_reports_on_its_own(self):
        found = humanize.find(f"I am writing to apply for this role. {CLEAN}")
        self.assertEqual([t.code for t in found], ["§4"])


class WeakAlone(unittest.TestCase):
    """The skill's own safeguard: a weak tell needs company."""

    def test_one_dash_by_itself_is_a_writer(self):
        self.assertEqual(humanize.find(f"I joined in 2019 — before the rewrite. {CLEAN}"), [])

    def test_one_stock_word_by_itself_is_not_reported(self):
        self.assertEqual(humanize.find(f"I am passionate about this work. {CLEAN}"), [])

    def test_a_weak_tell_reports_once_a_strong_one_shares_the_letter(self):
        text = f"I am writing to apply for this role. It is a passionate about fit. {CLEAN}"
        self.assertEqual(codes(text), {"§4", "§12"})

    def test_two_weak_tells_are_themselves_the_pattern(self):
        text = f"I am passionate about cross-functional teams. {CLEAN}"
        self.assertEqual(codes(text), {"§12", "§10"})

    def test_three_real_things_stay_three_real_things(self):
        """A letter about technical work lists three technologies honestly."""
        text = (
            "I built an inventory search, a small reporting API, and an import flow "
            "for sample records. Later I added a review screen and an offline export "
            "to the fixture app."
        )
        self.assertEqual(humanize.find(text), [])

    def test_dashes_stop_being_weak_once_there_are_two(self):
        text = f"I joined in 2019 — before the rewrite — and stayed. {CLEAN}"
        self.assertEqual([t.code for t in humanize.find(text)], ["§8"])


class Reporting(unittest.TestCase):
    def test_strong_tells_sort_before_weak_ones(self):
        text = f"I am writing to apply. I am passionate about it. {CLEAN}"
        self.assertFalse(humanize.find(text)[0].weak)

    def test_an_excerpt_carries_enough_context_to_find_the_phrase(self):
        (tell,) = humanize.find(f"I am writing to apply for the Platform role. {CLEAN}")
        self.assertIn("Platform", tell.found[0])

    def test_the_same_word_four_times_is_one_finding(self):
        text = (
            "I am writing to apply. I am passionate about delve, and passionate "
            f"about tapestry. A meticulous interplay. {CLEAN}"
        )
        stock = [t for t in humanize.find(text) if t.code == "§12"]
        self.assertEqual(len(stock), 1)
        self.assertLessEqual(len(stock[0].found), 4)

    def test_report_is_plain_json_shaped_data(self):
        (item,) = humanize.report(f"I am writing to apply for this role. {CLEAN}")
        self.assertEqual(
            set(item), {"code", "name", "fix", "weak", "found"}
        )
        self.assertIsInstance(item["found"], list)
        self.assertTrue(item["fix"])

    def test_every_pattern_carries_a_fix_the_model_can_act_on(self):
        """The fix strings become the one-click redraft instruction."""
        for code, _name, fix, _weak, _patterns in humanize._PHRASES:
            self.assertTrue(fix.endswith("."), f"{code} fix should be a sentence")
            self.assertGreater(len(fix), 20, code)


class RepeatedOpenings(unittest.TestCase):
    def test_three_sentences_in_a_row_is_the_tell(self):
        text = (
            "Every form was different. Every form was hand-mapped. Every form "
            f"broke on the next redesign. I am writing to apply. {CLEAN}"
        )
        self.assertIn("§7", codes(text))

    def test_a_first_person_letter_gets_one_more_before_it_counts(self):
        """Three "I" sentences is the form; four is a monotonous letter."""
        # CLEAN is not the carrier here: it opens on "I" too, and would extend
        # whichever run the case is meant to end.
        tail = "Let me know if you would like it shorter."
        self.assertNotIn("§7", codes(f"I built the parser. I tested it. I shipped it. {tail}"))
        self.assertIn("§7", codes(f"I built it. I tested it. I shipped it. I own it. {tail}"))


if __name__ == "__main__":
    unittest.main()
