"""The dashboard's storage, its JSON reading, and its HTTP surface.

Storage and the JSON reader need nothing but the standard library, so they
always run. The API tests need FastAPI and skip cleanly without it, the way the
browser tests skip without Playwright — a check that cannot run should say so
rather than fail.

Every test gets its own state directory: the module creates one at import, and
a suite that shared it would be testing yesterday's database.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "server"))

import _state  # noqa: E402,F401 - must precede any dashboard import

from dashboard import model, store  # noqa: E402
from dashboard.config import DOCS_DIR  # noqa: E402

try:
    from fastapi.testclient import TestClient

    from dashboard.app import app

    HAVE_API = True
except ImportError:  # pragma: no cover - depends on what is installed
    HAVE_API = False


class IsolationTests(unittest.TestCase):
    """The suite must never be able to touch a real profile.

    `dashboard.config` binds its paths on import, so whichever test module the
    loader reaches first decides where every later one writes. When that was
    left to chance the suite ran against the real database and deleted the
    applications in it.
    """

    def test_the_database_is_not_a_real_one(self):
        from dashboard.config import DB_PATH, STATE_DIR

        self.assertEqual(str(STATE_DIR), os.environ["FORMWORK_TEST_STATE_DIR"])
        self.assertNotEqual(STATE_DIR, Path.home() / ".formwork")
        self.assertTrue(str(DB_PATH).startswith(str(STATE_DIR)))

    def test_the_profile_directory_is_not_a_real_one(self):
        from dashboard.config import PROFILE_DIR

        self.assertNotIn("profile/private", str(PROFILE_DIR))
        self.assertEqual(str(PROFILE_DIR), os.environ["FORMWORK_TEST_STATE_DIR"])


class StoreTests(unittest.TestCase):
    def setUp(self):
        store.init()
        with store.db() as conn:
            for table in ("applications", "queue", "settings"):
                conn.execute(f"DELETE FROM {table}")

    def test_an_application_is_identified_by_its_url(self):
        # Re-running the aggregator must not open a second application for a
        # job already in flight.
        first = store.upsert_application({"url": "https://x.test/1", "company": "X", "title": "T"})
        again = store.upsert_application({"url": "https://x.test/1", "company": "X Ltd", "title": "T2"})
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(again["company"], "X Ltd")
        self.assertEqual(len(store.list_applications()), 1)

    def test_a_snapshot_survives_as_an_object(self):
        row = store.upsert_application({"url": "https://x.test/2"})
        store.update_application(row["id"], snapshot={"fields": [{"id": "f0"}], "n": 3})
        back = store.get_application(row["id"])
        self.assertEqual(back["snapshot"]["n"], 3)
        self.assertEqual(back["snapshot"]["fields"][0]["id"], "f0")

    def test_a_corrupt_snapshot_reads_as_empty_rather_than_raising(self):
        row = store.upsert_application({"url": "https://x.test/3"})
        with store.db() as conn:
            conn.execute("UPDATE applications SET snapshot = ? WHERE id = ?", ("{not json", row["id"]))
        self.assertEqual(store.get_application(row["id"])["snapshot"], {})

    def test_settings_keep_their_types(self):
        self.assertIs(store.get_settings()["autoMode"], False)
        store.set_settings({"autoMode": True, "limit": 5, "nested": {"a": [1, 2]}})
        settings = store.get_settings()
        self.assertIs(settings["autoMode"], True)
        self.assertEqual(settings["limit"], 5)
        self.assertEqual(settings["nested"], {"a": [1, 2]})
        # Unset keys still come back with their defaults.
        self.assertIn("query", settings)

    def test_the_queue_shows_which_rows_are_already_being_applied_for(self):
        store.upsert_application({"url": "https://x.test/4", "company": "X", "title": "T"})
        store.update_application(store.list_applications()[0]["id"], status="ready")
        store.replace_queue(
            [
                {"url": "https://x.test/4", "company": "X", "title": "T"},
                {"url": "https://y.test/9", "company": "Y", "title": "U"},
            ]
        )
        by_company = {j["company"]: j.get("application_status") for j in store.list_queue()}
        self.assertEqual(by_company["X"], "ready")
        self.assertIsNone(by_company["Y"])

    def test_hiding_a_posting_survives_the_next_search(self):
        store.replace_queue([{"url": "https://x.test/5", "company": "X", "title": "T"}])
        store.hide_queue_entry("https://x.test/5")
        self.assertEqual(store.list_queue(), [])
        store.replace_queue([{"url": "https://x.test/5", "company": "X", "title": "T"}])
        self.assertEqual(store.list_queue(), [], "a hidden posting came back")

    def test_a_posting_without_a_url_is_not_stored(self):
        self.assertEqual(store.replace_queue([{"company": "X"}, {"url": "", "company": "Y"}]), 0)

    def test_an_update_may_only_touch_columns_of_the_table(self):
        # The statement interpolates its own column names, which is safe only
        # while those names cannot come from anywhere but the whitelist.
        row = store.upsert_application({"url": "https://x.test/8"})
        with self.assertRaises(ValueError):
            store.update_application(row["id"], **{"status = 'x', note": "y"})
        with self.assertRaises(ValueError):
            store.update_application(row["id"], nonexistent="y")
        # And the ordinary ones still work.
        store.update_application(row["id"], status="ready", note="fine")
        self.assertEqual(store.get_application(row["id"])["note"], "fine")

    def test_counts_cover_the_queue_and_every_status(self):
        store.replace_queue([{"url": "https://q.test/1"}])
        row = store.upsert_application({"url": "https://x.test/6"})
        store.update_application(row["id"], status="submitted")
        counts = store.counts()
        self.assertEqual(counts["queue"], 1)
        self.assertEqual(counts["submitted"], 1)


class JsonReadingTests(unittest.TestCase):
    """Small models fence their JSON, or explain it first, or both."""

    def test_reads_json_however_it_was_wrapped(self):
        for raw, expected in [
            ('{"a": 1}', {"a": 1}),
            ('```json\n{"a": 2}\n```', {"a": 2}),
            ("```\n{\"a\": 3}\n```", {"a": 3}),
            ('Sure! Here you go:\n{"a": 4}', {"a": 4}),
            ('{"a": 5}\nHope that helps.', {"a": 5}),
            ('{"a": {"b": [1, 2]}, "c": "}"}', {"a": {"b": [1, 2]}, "c": "}"}),
        ]:
            self.assertEqual(model.parse_json(raw), expected, raw)

    def test_refuses_anything_that_is_not_an_object(self):
        # An array or a sentence is not a plan, and guessing at one would send
        # a half-understood instruction into a résumé.
        for raw in ["[1, 2, 3]", "no json at all", "", "null", "42"]:
            with self.assertRaises(model.ModelError, msg=raw):
                model.parse_json(raw)


class AggregatorArgumentTests(unittest.TestCase):
    """What the queue search is asked for, and how it is asked."""

    def test_builds_only_the_flags_it_was_given(self):
        from dashboard.jobs import _args

        self.assertEqual(
            _args({"query": "a|b", "location": "CA", "remoteOnly": True,
                   "hideNoSponsorship": True, "sinceDays": 7, "limit": 10}),
            ["--query", "a|b", "--location", "CA", "--remote", "--needs-sponsorship",
             "--since", "7", "--limit", "10"],
        )

    def test_blank_and_missing_settings_add_nothing(self):
        from dashboard.jobs import _args

        self.assertEqual(_args({}), [])
        self.assertEqual(_args({"query": "", "location": "", "sinceDays": 0, "limit": 0}), [])

    def test_a_setting_that_looks_like_a_shell_command_is_just_a_string(self):
        # The search runs through exec, not a shell, so a query is a query. The
        # settings come from a form, and a form is not a trusted place.
        from dashboard import jobs

        self.assertEqual(
            jobs._args({"query": "a; rm -rf /"})[1],
            "a; rm -rf /",
            "the query was split or interpreted",
        )
        source = (ROOT / "server" / "dashboard" / "jobs.py").read_text()
        self.assertIn("create_subprocess_exec", source)
        self.assertNotIn("create_subprocess_shell", source)
        self.assertNotIn("shell=True", source)


@unittest.skipUnless(HAVE_API, "fastapi not installed")
class DocumentEndpointTests(unittest.TestCase):
    """The one route that turns a URL into a path on disk."""

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        (DOCS_DIR / "real.pdf").write_bytes(b"%PDF-1.4 inside")
        cls.secret = Path(os.environ["FORMWORK_STATE_DIR"]) / "secret.pdf"
        cls.secret.write_bytes(b"%PDF-1.4 OUTSIDE")

    def test_serves_a_document_it_generated(self):
        response = self.client.get("/api/documents/real.pdf")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"inside", response.content)

    def test_refuses_to_walk_out_of_the_documents_directory(self):
        for probe in [
            "../secret.pdf",
            "..%2Fsecret.pdf",
            "....//secret.pdf",
            "%2e%2e%2fsecret.pdf",
            "..\\secret.pdf",
            "real.pdf/../../secret.pdf",
            "%2e%2e/%2e%2e/etc/passwd",
        ]:
            response = self.client.get(f"/api/documents/{probe}")
            self.assertNotIn(b"OUTSIDE", response.content, probe)
            self.assertNotIn(b"root:", response.content, probe)
            self.assertNotEqual(response.status_code, 200, probe)


@unittest.skipUnless(HAVE_API, "fastapi not installed")
class ApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        store.init()
        with store.db() as conn:
            for table in ("applications", "queue"):
                conn.execute(f"DELETE FROM {table}")

    def test_the_widget_shape_is_flat_and_always_complete(self):
        # A tile whose field vanishes at zero renders blank and reads as broken.
        body = self.client.get("/api/widget").json()
        self.assertEqual(set(body), {"queue", "ready", "working", "submitted"})
        for value in body.values():
            self.assertIsInstance(value, int)

    def test_asking_for_an_application_that_is_not_there(self):
        for path in ["/api/applications/9999", "/api/applications/9999/refresh"]:
            method = self.client.get if path.endswith("9999") else self.client.post
            self.assertEqual(method(path).status_code, 404, path)

    def test_settings_round_trip(self):
        saved = self.client.post("/api/settings", json={"values": {"autoMode": True}}).json()
        self.assertIs(saved["autoMode"], True)
        self.assertIs(self.client.get("/api/settings").json()["autoMode"], True)
        self.client.post("/api/settings", json={"values": {"autoMode": False}})

    def test_answers_must_be_valid_json_before_they_are_written(self):
        # This file is the one a model is never allowed to decide. Saving a
        # broken one would take work authorisation and demographics with it.
        response = self.client.post("/api/profile/answers", json={"text": "{not json"})
        self.assertEqual(response.status_code, 400)

    def test_auto_mode_is_off_until_it_is_asked_for(self):
        with store.db() as conn:
            conn.execute("DELETE FROM settings")
        self.assertIs(self.client.get("/api/settings").json()["autoMode"], False)

    def test_nothing_in_the_api_submits_on_its_own(self):
        # The only route that can press Submit is the one a person presses, and
        # it is reached by POSTing to it explicitly. Everything else must leave
        # an application where it found it.
        row = store.upsert_application({"url": "https://x.test/7", "company": "X", "title": "T"})
        for path in ["/api/applications/{}/refresh", "/api/applications/{}/status"]:
            body = {"status": "ready"} if path.endswith("status") else None
            self.client.post(path.format(row["id"]), json=body)
        self.assertNotEqual(store.get_application(row["id"])["status"], "submitted")


@unittest.skipUnless(HAVE_API, "fastapi not installed")
class PreparePipelineTests(unittest.IsolatedAsyncioTestCase):
    """Preparing an application, with the browser and the model stood in for.

    The point is the failure paths. `_prepare` runs as a background task, so
    anything it does not catch goes nowhere at all: the application keeps
    whichever status it had, its progress never reaches done, and the interface
    spins on it forever with nothing to show.
    """

    def setUp(self):
        store.init()
        with store.db() as conn:
            conn.execute("DELETE FROM applications")
        self.record = store.upsert_application(
            {"url": "https://x.test/prepare", "company": "X", "title": "Engineer"}
        )

    async def _prepare_with(self, browser_run, resume_tex="", settings=None):
        from dashboard import app as dashboard_app
        from dashboard import model

        store.set_settings(settings or {"tailorResume": True, "draftCoverLetter": False, "autoMode": False})
        original_run, original_read, original_complete = (
            dashboard_app.browser.run,
            dashboard_app._read,
            model.complete,
        )
        dashboard_app.browser.run = browser_run
        dashboard_app._read = lambda path, default="": resume_tex

        async def complete(messages, want_json=False, timeout=300.0):
            return "{}"

        model.complete = complete
        try:
            await dashboard_app._prepare(self.record["id"])
        finally:
            dashboard_app.browser.run = original_run
            dashboard_app._read = original_read
            model.complete = original_complete
        return store.get_application(self.record["id"]), dashboard_app.PROGRESS.get(self.record["id"])

    async def test_a_browser_that_is_not_there_fails_readably(self):
        async def missing(command, payload=None, timeout=600.0):
            raise __import__("dashboard.browser", fromlist=["x"]).BrowserError("no browser")

        record, progress = await self._prepare_with(missing)
        self.assertEqual(record["status"], "failed")
        self.assertIn("no browser", record["note"])
        self.assertTrue(progress["done"])

    async def test_an_unparseable_résumé_costs_the_tailoring_not_the_application(self):
        # An unbalanced brace is an ordinary LaTeX typo, and the dashboard lets
        # the master be edited in a textarea.
        calls = []

        async def fake(command, payload=None, timeout=600.0):
            calls.append(command)
            if command == "describe":
                return {"text": "a posting", "url": "https://x.test/prepare"}
            if command == "fill":
                return {"fields": [], "staged": [], "url": "https://x.test/prepare"}
            return {"ok": True}

        broken = "\\begin{document}\\entry{A}{B}{C}{D"
        record, progress = await self._prepare_with(fake, resume_tex=broken)
        self.assertEqual(record["status"], "ready", record["note"])
        self.assertIn("fill", calls)
        reasons = " ".join(r.get("reason", "") for r in record["snapshot"]["resumeRejected"])
        self.assertIn("tailoring skipped", reasons)

    async def test_an_unexpected_error_still_reaches_the_user(self):
        async def explodes(command, payload=None, timeout=600.0):
            raise TypeError("something nobody predicted")

        record, progress = await self._prepare_with(explodes)
        self.assertEqual(record["status"], "failed")
        self.assertIn("nobody predicted", record["note"])
        self.assertTrue(progress["done"], "the interface would spin on this forever")

    async def test_the_documents_it_borrows_are_given_back_even_when_filling_fails(self):
        # That slot holds the user's own résumé. A crashed fill must not eat it.
        commands = []

        async def fake(command, payload=None, timeout=600.0):
            commands.append((command, payload))
            if command == "describe":
                return {"text": "a posting", "url": "https://x.test/prepare"}
            if command == "fill":
                raise RuntimeError("the fill died")
            return {"ok": True}

        master = (
            r"\begin{document}\sectionheader{Projects}\entry{alpha}{OSS}{}{a}"
            "\n"
            r"\begin{itemize}\item Written in Go.\end{itemize}\end{document}"
        )
        record, _ = await self._prepare_with(fake, resume_tex=master)
        self.assertEqual(record["status"], "failed")
        lent = [c for c, _ in commands if c == "documents"]
        if lent:
            restored = [p for c, p in commands if c == "documents" and p.get("restore")]
            self.assertTrue(restored, "documents were borrowed and never given back")


if __name__ == "__main__":
    unittest.main()
