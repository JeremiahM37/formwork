"""
formwork dashboard — persistence.

SQLite, one file, no migrations framework: the schema is small and the whole
database is disposable except for the applications table, which is the only
thing here that cannot be regenerated.

Everything a submitted application claimed is kept as a snapshot. That is the
point of the table: months later, "what did I tell them my GPA was" has an
answer, and it is not "whatever the profile says today".
"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Iterable

from .config import DB_PATH
from .job_identity import job_key

SCHEMA = """
CREATE TABLE IF NOT EXISTS applications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  url          TEXT NOT NULL,
  company      TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT '',
  -- queued -> filling -> ready -> submitted, or failed / skipped at any point.
  status       TEXT NOT NULL DEFAULT 'queued',
  -- The fill report: fields, values, what was flagged, what was drafted.
  snapshot     TEXT NOT NULL DEFAULT '{}',
  note         TEXT NOT NULL DEFAULT '',
  resume_path  TEXT NOT NULL DEFAULT '',
  cover_path   TEXT NOT NULL DEFAULT '',
  created_at   REAL NOT NULL,
  updated_at   REAL NOT NULL,
  submitted_at REAL
);
-- One row per posting. Re-running the aggregator must not create a second
-- application for a job already in flight.
CREATE UNIQUE INDEX IF NOT EXISTS applications_url ON applications(url);

CREATE TABLE IF NOT EXISTS queue (
  url        TEXT PRIMARY KEY,
  company    TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  locations  TEXT NOT NULL DEFAULT '[]',
  source     TEXT NOT NULL DEFAULT '',
  posted     TEXT NOT NULL DEFAULT '',
  raw        TEXT NOT NULL DEFAULT '{}',
  fetched_at REAL NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, received_at REAL NOT NULL,
  decision TEXT NOT NULL DEFAULT 'pending', application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  deleted INTEGER NOT NULL DEFAULT 0, scan TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_events (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, text TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY, payload TEXT NOT NULL, generation TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  starts_at REAL NOT NULL, minutes INTEGER NOT NULL DEFAULT 60,
  kind TEXT NOT NULL, interviewer TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS calendar_links (
  account TEXT NOT NULL, event_id TEXT NOT NULL,
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  etag TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL,
  PRIMARY KEY(account,event_id), UNIQUE(account,interview_id,direction)
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  due_at REAL NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS contact_interactions (
  id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  text TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_views (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, filters TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS writing_drafts (
  id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, text TEXT NOT NULL, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS offers (
  application_id INTEGER PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  currency TEXT NOT NULL, base REAL NOT NULL, bonus REAL NOT NULL,
  equity REAL NOT NULL, benefits REAL NOT NULL, annual_costs REAL NOT NULL, signing REAL NOT NULL,
  notes TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resume_versions (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, text TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'text', created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS search_alerts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL, min_coverage INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS job_notifications (
  id INTEGER PRIMARY KEY, alert_id INTEGER NOT NULL REFERENCES search_alerts(id) ON DELETE CASCADE,
  url TEXT NOT NULL, company TEXT NOT NULL, title TEXT NOT NULL, created_at REAL NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0, UNIQUE(alert_id,url)
);
"""

DEFAULT_SETTINGS: dict[str, Any] = {
    # Off by design. Auto mode approves drafted answers and marks an
    # application ready; automatic preparation never sends it. See the note in app.py.
    "autoMode": False,
    "tailorResume": True,
    "draftCoverLetter": True,
    "query": "software engineer|backend|systems|embedded|platform|infrastructure|security",
    "location": "",
    "remoteOnly": False,
    "hideNoSponsorship": False,
    "sinceDays": 21,
    "limit": 60,
    "refreshIntervalHours": 0,
}


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    # The dashboard reads while a fill is writing; WAL is what keeps the UI
    # from blocking behind a two-minute browser run.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init() -> None:
    with db() as conn:
        conn.executescript(SCHEMA)
    # Application records and imported mail contain private candidate data.
    for path in (DB_PATH,DB_PATH.with_name(DB_PATH.name+'-wal'),DB_PATH.with_name(DB_PATH.name+'-shm')):
        if path.exists(): path.chmod(0o600)


def _row(row: sqlite3.Row) -> dict[str, Any]:
    out = dict(row)
    for key in ("snapshot", "raw", "locations"):
        if key in out and isinstance(out[key], str):
            try:
                out[key] = json.loads(out[key])
            except json.JSONDecodeError:
                out[key] = {} if key != "locations" else []
    return out


# ------------------------------------------------------------------- settings

def get_settings() -> dict[str, Any]:
    merged = dict(DEFAULT_SETTINGS)
    with db() as conn:
        for row in conn.execute("SELECT key, value FROM settings"):
            try:
                merged[row["key"]] = json.loads(row["value"])
            except json.JSONDecodeError:
                merged[row["key"]] = row["value"]
    return merged


def set_settings(values: dict[str, Any]) -> dict[str, Any]:
    with db() as conn:
        for key, value in values.items():
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, json.dumps(value)),
            )
    return get_settings()


# ---------------------------------------------------------------------- queue

def replace_queue(jobs: Iterable[dict[str, Any]]) -> int:
    now = time.time()
    rows = [
        (
            job.get("url", ""),
            job.get("company", ""),
            job.get("title", ""),
            json.dumps(job.get("locations") or []),
            job.get("source", ""),
            job.get("posted", "") or "",
            json.dumps(job),
            now,
        )
        for job in jobs
        if job.get("url")
    ]
    with db() as conn:
        conn.execute("DELETE FROM queue WHERE hidden = 0")
        conn.executemany(
            "INSERT INTO queue(url, company, title, locations, source, posted, raw, fetched_at) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET "
            "company=excluded.company, title=excluded.title, locations=excluded.locations, "
            "source=excluded.source, posted=excluded.posted, raw=excluded.raw, "
            "fetched_at=excluded.fetched_at",
            rows,
        )
    return len(rows)


def list_queue(limit: int = 200) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT q.* , a.id AS application_id, a.status AS application_status "
            "FROM queue q LEFT JOIN applications a ON a.url = q.url "
            "WHERE q.hidden = 0 ORDER BY q.posted DESC, q.company LIMIT ?",
            (limit,),
        ).fetchall()
    return [_row(r) for r in rows]


def hide_queue_entry(url: str) -> None:
    with db() as conn:
        conn.execute("UPDATE queue SET hidden = 1 WHERE url = ?", (url,))


def hidden_queue_urls() -> set[str]:
    with db() as conn:
        return {row[0] for row in conn.execute("SELECT url FROM queue WHERE hidden = 1")}


# --------------------------------------------------------------- applications

def upsert_application(job: dict[str, Any]) -> dict[str, Any]:
    now = time.time()
    with db() as conn:
        # Serialize lookup+insert across requests, including tracking URL variants.
        conn.execute("BEGIN IMMEDIATE")
        key = job_key(job["url"])
        rows = conn.execute("SELECT * FROM applications ORDER BY submitted_at DESC, id").fetchall()
        for existing in rows:
            snapshot = json.loads(existing["snapshot"] or "{}")
            if key in {job_key(existing["url"]), job_key(snapshot.get("postingUrl", existing["url"]))}:
                if not existing["submitted_at"] and existing["status"] not in {"submitting", "submission_unconfirmed"}:
                    conn.execute("UPDATE applications SET company=?, title=?, updated_at=? WHERE id=?",
                                 (job.get("company") or existing["company"], job.get("title") or existing["title"], now, existing["id"]))
                    existing = conn.execute("SELECT * FROM applications WHERE id=?", (existing["id"],)).fetchone()
                return _row(existing)
        conn.execute(
            "INSERT INTO applications(url, company, title, source, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET "
            "company=excluded.company, title=excluded.title, updated_at=excluded.updated_at",
            (
                job["url"],
                job.get("company", ""),
                job.get("title", ""),
                job.get("source", ""),
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM applications WHERE url = ?", (job["url"],)).fetchone()
    return _row(row)


def get_application(app_id: int) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute("SELECT * FROM applications WHERE id = ?", (app_id,)).fetchone()
    return _row(row) if row else None


def list_applications(status: str | None = None) -> list[dict[str, Any]]:
    query = "SELECT * FROM applications"
    args: tuple[Any, ...] = ()
    if status:
        query += " WHERE status = ?"
        args = (status,)
    query += " ORDER BY updated_at DESC"
    with db() as conn:
        rows = conn.execute(query, args).fetchall()
    return [_row(r) for r in rows]


# The columns an update may touch. The statement below interpolates its own
# column names, which is safe only for as long as those names cannot come from
# anywhere but this list — so they cannot.
UPDATABLE = frozenset(
    {
        "url",
        "company",
        "title",
        "source",
        "status",
        "snapshot",
        "note",
        "resume_path",
        "cover_path",
        "submitted_at",
        "updated_at",
    }
)


def update_application(app_id: int, **fields: Any) -> dict[str, Any] | None:
    if not fields:
        return get_application(app_id)
    unknown = set(fields) - UPDATABLE
    if unknown:
        raise ValueError(f"not columns of applications: {', '.join(sorted(unknown))}")
    if "snapshot" in fields and not isinstance(fields["snapshot"], str):
        fields["snapshot"] = json.dumps(fields["snapshot"])
    fields["updated_at"] = time.time()
    assignments = ", ".join(f"{k} = ?" for k in fields)
    with db() as conn:
        previous = conn.execute("SELECT status FROM applications WHERE id = ?", (app_id,)).fetchone()
        conn.execute(
            f"UPDATE applications SET {assignments} WHERE id = ?",
            (*fields.values(), app_id),
        )
        if previous and "status" in fields and fields["status"] != previous["status"]:
            conn.execute("INSERT INTO application_events(application_id,kind,text,created_at) VALUES(?,?,?,?)",
                         (app_id, "status", f"{previous['status']} → {fields['status']}", time.time()))
    return get_application(app_id)


def delete_application(app_id: int) -> None:
    with db() as conn:
        conn.execute("DELETE FROM applications WHERE id = ?", (app_id,))


def counts() -> dict[str, int]:
    with db() as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) AS n FROM applications GROUP BY status"
        ).fetchall()
        queued = conn.execute("SELECT COUNT(*) AS n FROM queue WHERE hidden = 0").fetchone()
    out = {r["status"]: r["n"] for r in rows}
    out["queue"] = queued["n"]
    return out
