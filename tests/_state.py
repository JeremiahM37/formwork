"""Point the dashboard at a throwaway state directory, before it is imported.

`dashboard.config` reads these on import and binds the database path once. Any
test module that imports the dashboard has to import this first — including the
ones that only want the LaTeX helpers, because importing those imports config
too, and whichever test module the loader reaches first decides where every
later one writes.

Getting that wrong is not a failing test. It is a suite that quietly runs
against the real database and deletes the applications in it, which is what
happened before this file existed.
"""

import os
import tempfile

STATE_DIR = os.environ.get("FORMWORK_TEST_STATE_DIR")
if not STATE_DIR:
    STATE_DIR = tempfile.mkdtemp(prefix="formwork-tests-")
    os.environ["FORMWORK_TEST_STATE_DIR"] = STATE_DIR

# Set, not defaulted: an inherited value would be somebody's real profile.
os.environ["FORMWORK_STATE_DIR"] = STATE_DIR
os.environ["FORMWORK_PROFILE_DIR"] = STATE_DIR
os.environ["FORMWORK_CDP_URL"] = "http://127.0.0.1:1"
os.environ["FORMWORK_MODEL_URL"] = "http://127.0.0.1:1"
