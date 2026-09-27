"""
formwork dashboard — where everything lives.

Every path and endpoint is overridable by environment variable so the dashboard
can be run against a checkout somewhere else, or pointed at a browser on another
machine, without editing anything.
"""
from __future__ import annotations

import os
from pathlib import Path

# The repository root: server/dashboard/config.py -> server/dashboard -> server -> repo
REPO = Path(__file__).resolve().parents[2]

# Personal data lives outside the repo's tracked tree by default (profile/private
# is gitignored) so a fork of formwork never carries someone's résumé with it.
PROFILE_DIR = Path(os.environ.get("FORMWORK_PROFILE_DIR", REPO / "profile" / "private"))
PROFILE_JSON = PROFILE_DIR / "profile.json"
ANSWERS_JSON = PROFILE_DIR / "answers.json"
ABOUT_MD = PROFILE_DIR / "about.md"
RESUME_TEX = PROFILE_DIR / "resume.tex"

# Generated artefacts: per-posting résumés and cover letters, and the database.
STATE_DIR = Path(os.environ.get("FORMWORK_STATE_DIR", Path.home() / ".formwork"))
DOCS_DIR = STATE_DIR / "documents"
DB_PATH = STATE_DIR / "formwork.db"

# The browser the extension is loaded into. The dashboard drives it over the
# DevTools protocol rather than running a browser of its own: the user has to be
# able to watch it, take it over mid-application, and click Submit in the same
# window the fill happened in.
CDP_URL = os.environ.get("FORMWORK_CDP_URL", "http://localhost:9223")
# Empty means "same host, port 9112", which is how the container and the usual
# single-machine setup are arranged. "off" hides the tab for someone driving a
# browser they are already looking at.
NOVNC_URL = os.environ.get("FORMWORK_NOVNC_URL", "")

# Where model calls go. The dashboard uses the same provider the extension does,
# so a drafted cover letter and a drafted form answer come from one model.
MODEL_URL = os.environ.get("FORMWORK_MODEL_URL", "http://localhost:9105/api/jobfill/complete")
MODEL_NAME = os.environ.get("FORMWORK_MODEL", "")
EXTENSION_DASHBOARD_URL = os.environ.get("FORMWORK_EXTENSION_DASHBOARD_URL",
    "http://127.0.0.1:" + os.environ.get("FORMWORK_PORT", "9113"))

# LaTeX engine for compiling a tailored résumé. tectonic downloads what a
# document needs on first use, so it is the one that works on a bare server.
LATEX = os.environ.get("FORMWORK_LATEX", "tectonic")

NODE = os.environ.get("FORMWORK_NODE", "node")
DRIVER = REPO / "server" / "dashboard" / "drive.mjs"

for directory in (STATE_DIR, DOCS_DIR):
    directory.mkdir(parents=True, exist_ok=True)
