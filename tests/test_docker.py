"""The container's permission granter.

It writes into a browser profile's own record of what an extension has been
allowed to reach, which is the sort of thing that should be difficult to get
subtly wrong without anyone noticing. So: that it grants what was asked and
nothing else, that it leaves other extensions alone, that running it twice
changes nothing the second time, and that every way of handing it rubbish ends
in a refusal rather than a broken profile.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRANT = ROOT / "docker" / "grant-host.py"
EXT = "/app/extension"
MODEL = "http://model.test:9105/api/jobfill/complete"

# 0 means "granted" for --check and "changed something" for a write; 1 means
# "not granted" and "nothing to do".
GRANTED = CHANGED = 0
ABSENT = UNCHANGED = 1


def profile(ext_path=EXT, granted=None, prefs=None):
    directory = Path(tempfile.mkdtemp())
    (directory / "Default").mkdir()
    if prefs is None:
        prefs = {
            "extensions": {
                "settings": {
                    "other": {
                        "path": "/browser/resources/pdf",
                        "granted_permissions": {"explicit_host": ["https://elsewhere/*"]},
                    },
                    "ours": {
                        "path": ext_path,
                        "granted_permissions": {"explicit_host": list(granted or [])},
                    },
                }
            }
        }
    (directory / "Default" / "Preferences").write_text(json.dumps(prefs))
    return directory


def run(directory, *flags, model=MODEL, ext=EXT):
    return subprocess.run(
        [sys.executable, str(GRANT), *flags, str(directory), model, ext],
        capture_output=True,
        text=True,
    ).returncode


def hosts(directory, key="ours"):
    prefs = json.loads((directory / "Default" / "Preferences").read_text())
    entry = prefs["extensions"]["settings"][key]
    return entry.get("granted_permissions", {}).get("explicit_host", [])


class GrantTests(unittest.TestCase):
    def test_grants_the_model_origin_and_says_it_changed_something(self):
        directory = profile()
        self.assertEqual(run(directory, "--check"), ABSENT)
        self.assertEqual(run(directory), CHANGED)
        self.assertIn("http://model.test:9105/*", hosts(directory))
        self.assertEqual(run(directory, "--check"), GRANTED)

    def test_running_it_again_changes_nothing(self):
        # The container runs this on every start; a second pass must not report
        # work it did not do, or the browser is restarted for no reason.
        directory = profile()
        run(directory)
        before = hosts(directory)
        self.assertEqual(run(directory), UNCHANGED)
        self.assertEqual(hosts(directory), before)

    def test_grants_the_path_and_nothing_wider(self):
        directory = profile()
        run(directory)
        self.assertEqual(hosts(directory), ["http://model.test:9105/*"])

    def test_leaves_every_other_extension_alone(self):
        directory = profile()
        run(directory)
        self.assertEqual(hosts(directory, "other"), ["https://elsewhere/*"])

    def test_all_hosts_is_opt_in(self):
        plain = profile()
        run(plain)
        self.assertNotIn("https://*/*", hosts(plain))

        wide = profile()
        self.assertEqual(run(wide, "--all-hosts"), CHANGED)
        self.assertIn("http://*/*", hosts(wide))
        self.assertIn("https://*/*", hosts(wide))
        self.assertIn("http://model.test:9105/*", hosts(wide))

    def test_check_notices_that_all_hosts_is_missing(self):
        # Otherwise turning the switch on would never restart the browser and
        # the setting would appear to do nothing.
        directory = profile()
        run(directory)
        self.assertEqual(run(directory, "--check"), GRANTED)
        self.assertEqual(run(directory, "--check", "--all-hosts"), ABSENT)

    def test_matches_the_extension_by_where_it_was_loaded_from(self):
        # Matching on the word "formwork" appearing in the path found nothing in
        # a container, where the directory is /app/extension — and reported
        # success while doing it.
        elsewhere = profile(ext_path="/some/other/place")
        self.assertEqual(run(elsewhere), UNCHANGED)
        self.assertEqual(hosts(elsewhere), [])

    def test_refuses_rubbish_without_damaging_the_profile(self):
        missing = Path(tempfile.mkdtemp())
        self.assertEqual(run(missing), UNCHANGED)

        corrupt = Path(tempfile.mkdtemp())
        (corrupt / "Default").mkdir()
        (corrupt / "Default" / "Preferences").write_text("{not json")
        self.assertEqual(run(corrupt), UNCHANGED)
        self.assertEqual((corrupt / "Default" / "Preferences").read_text(), "{not json")

        no_extensions = profile(prefs={"something": "else"})
        self.assertEqual(run(no_extensions), UNCHANGED)

    def test_refuses_a_model_address_that_is_not_one(self):
        for bad in ["", "not-a-url", "/just/a/path"]:
            directory = profile()
            self.assertEqual(run(directory, model=bad), UNCHANGED, bad)
            self.assertEqual(hosts(directory), [], bad)

    def test_the_file_it_writes_is_still_json(self):
        directory = profile()
        run(directory)
        prefs = json.loads((directory / "Default" / "Preferences").read_text())
        self.assertIn("ours", prefs["extensions"]["settings"])


if __name__ == "__main__":
    unittest.main()
