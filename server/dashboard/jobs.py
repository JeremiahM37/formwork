"""
formwork dashboard — the queue.

A thin wrapper around `tools/find-jobs.mjs`, which is the aggregator and stays
the single definition of where postings come from. Running it as a subprocess
rather than reimplementing its filters in Python is the point: the rule that no
login-walled board is ever a source is asserted by a test over that file, and a
second copy of the source list here would be a second thing to get wrong.
"""
from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from typing import Any

from .config import NODE, REPO

FINDER = REPO / "tools" / "find-jobs.mjs"
LAST_HEALTH = []


def default_sources():
    catalog = json.loads((REPO / 'tools/job-sources.json').read_text())
    return {**catalog['boards'], 'github':bool(catalog['github']), 'feeds':[item['name'] for item in catalog['feeds']]}


def _args(settings: dict[str, Any]) -> list[str]:
    args: list[str] = []
    if settings.get("query"):
        args += ["--query", str(settings["query"])]
    if settings.get("location"):
        args += ["--location", str(settings["location"])]
    if settings.get("remoteOnly"):
        args.append("--remote")
    if settings.get("hideNoSponsorship"):
        args.append("--needs-sponsorship")
    if settings.get("sinceDays"):
        args += ["--since", str(int(settings["sinceDays"]))]
    if settings.get("limit"):
        args += ["--limit", str(int(settings["limit"]))]
    return args


async def find(settings: dict[str, Any], timeout: float = 300.0) -> list[dict[str, Any]]:
    global LAST_HEALTH
    LAST_HEALTH = []
    if not FINDER.exists():
        raise RuntimeError(f"aggregator missing at {FINDER}")
    with tempfile.TemporaryDirectory() as work:
        out = Path(work) / "queue.json"
        health = Path(work) / "health.json"
        sources = Path(work) / "sources.json"
        sources.write_text(json.dumps(settings.get('jobSources') or default_sources()))
        search = {**settings}
        # Explicit target roles replace the old default title regex; otherwise
        # a nurse's preferences could still be filtered to software jobs.
        if settings.get('discoveryPriorities',{}).get('targetRoles'):
            search['query'] = ''
        process = await asyncio.create_subprocess_exec(
            NODE,
            str(FINDER),
            *_args(search),
            "--all", "--sources", str(sources),
            "--out",
            str(out),
            "--health-out",
            str(health),
            cwd=str(REPO),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except (asyncio.TimeoutError, asyncio.CancelledError) as err:
            if process.returncode is None:
                process.kill()
            await process.communicate()
            if isinstance(err,asyncio.CancelledError):
                raise
            raise RuntimeError("the aggregator timed out")
        if process.returncode != 0 or not out.exists():
            raise RuntimeError((stdout or b"").decode()[-1200:] or "the aggregator failed")
        LAST_HEALTH = json.loads(health.read_text()) if health.exists() else []
        if LAST_HEALTH and not any(s.get("ok") for s in LAST_HEALTH):
            raise RuntimeError("Every job source failed; the existing queue has been kept")
        return json.loads(out.read_text())
