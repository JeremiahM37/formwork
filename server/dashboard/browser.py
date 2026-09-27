"""
formwork dashboard — talking to drive.mjs.

One subprocess per command, JSON in and JSON out. Deliberately not a long-lived
Node process: a fill can take minutes and a crashed driver must not take the
dashboard with it, and there is no state worth keeping between commands — the
state lives in the browser.
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import httpx

from .config import CDP_URL, DRIVER, NODE, REPO


class BrowserError(RuntimeError):
    pass


async def run(command: str, payload: dict[str, Any] | None = None, timeout: float = 600.0) -> Any:
    env = {**os.environ, "FORMWORK_CDP_URL": CDP_URL}
    process = await asyncio.create_subprocess_exec(
        NODE,
        str(DRIVER),
        command,
        json.dumps(payload or {}),
        cwd=str(REPO),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        process.kill()
        raise BrowserError(f"{command} timed out after {int(timeout)}s")

    text = (stdout or b"").decode().strip()
    if not text:
        raise BrowserError((stderr or b"").decode().strip()[-800:] or f"{command} returned nothing")
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        raise BrowserError(f"{command} returned unreadable output: {text[:400]}")
    if isinstance(result, dict) and result.get("error"):
        raise BrowserError(result["error"])
    return result


async def probe(timeout: float = 4.0) -> dict[str, Any]:
    """Is the browser there, is formwork loaded in it, what is open.

    Asked over the debugging protocol's own HTTP endpoint rather than through
    drive.mjs. This is what the dashboard's status line and health check call,
    and spawning Node and Playwright to answer it made a question that should
    cost milliseconds cost seconds — enough that the health check timed out
    while the browser was busy filling something.
    """
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            targets = (await client.get(f"{CDP_URL}/json/list")).json()
    except (httpx.HTTPError, ValueError) as err:
        return {"connected": False, "reason": str(err) or "no browser at that address"}

    extension = ""
    tabs = []
    for target in targets:
        url = target.get("url") or ""
        if url.startswith("chrome-extension://") and "/src/" in url:
            extension = url.split("/")[2]
        elif url.startswith("http") and target.get("type") == "page":
            tabs.append(url)
    return {"connected": True, "extension": extension, "tabs": tabs}
