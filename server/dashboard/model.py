"""
formwork dashboard — the model client.

One place, so a cover letter and a form answer come from the same model with
the same settings. The endpoint is the extension's own provider proxy, which
takes chat messages and returns text: keeping the dashboard on it means there
is no second prompt definition to drift.
"""
from __future__ import annotations

import json
import re
import os
import tempfile
from pathlib import Path

from .config import MODEL_NAME, MODEL_URL, STATE_DIR

PROVIDER_PATH = STATE_DIR / "provider.json"


def provider_config():
    try:
        return json.loads(PROVIDER_PATH.read_text())
    except FileNotFoundError:
        return {"provider":"homelab", "url":MODEL_URL, "model":MODEL_NAME, "key":""}


def public_config():
    config = provider_config()
    return {k:v for k,v in config.items() if k != "key"} | {"hasKey":bool(config.get("key"))}


def save_config(config):
    from urllib.parse import urlsplit
    parsed = urlsplit(config["url"])
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Use an HTTP or HTTPS provider URL without embedded credentials")
    if config["provider"] != "homelab" and not config["model"].strip():
        raise ValueError("Enter the model name")
    old = provider_config()
    # Never forward an old key to a newly selected endpoint.
    if not config.get("key") and all(config[k] == old.get(k) for k in ("provider", "url")):
        config["key"] = old.get("key", "")
    fd, name = tempfile.mkstemp(dir=STATE_DIR, prefix="provider-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(config, out)
        os.replace(name, PROVIDER_PATH)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return public_config()


class ModelError(RuntimeError):
    pass


async def complete(messages: list[dict[str, str]], *, want_json: bool = False, timeout: float = 300.0) -> str:
    # Imported here so the checkable half of this module — how a model's JSON
    # is dug out of whatever it wrapped it in — can be tested with the standard
    # library alone. The rules are the part worth guarding; a suite that needs
    # an HTTP client installed before it runs them is a suite that gets skipped.
    import httpx

    config = provider_config()
    provider, endpoint = config["provider"], config["url"].rstrip("/")
    headers = {}
    if provider == "homelab":
        payload = {"messages": messages, "json": want_json}
        if config.get("model"):
            payload["model"] = config["model"]
    elif provider == "ollama":
        if not endpoint.endswith("/api/chat"):
            endpoint += "/api/chat"
        payload = {"messages": messages, "model": config["model"], "stream":False, "think":False,
                   "options":{"num_ctx":16384}}
    elif provider == "anthropic":
        if not endpoint.endswith("/messages"):
            endpoint += "/messages" if endpoint.endswith("/v1") else "/v1/messages"
        headers = {"x-api-key":config.get("key", ""), "anthropic-version":"2023-06-01"}
        payload = {"model":config["model"], "max_tokens":4096,
                   "system":"\n".join(m["content"] for m in messages if m["role"] == "system"),
                   "messages":[m for m in messages if m["role"] != "system"]}
    else:
        if not endpoint.endswith("/chat/completions"):
            endpoint += "/chat/completions"
        headers = {"Authorization":f"Bearer {config['key']}"} if config.get("key") else {}
        payload = {"messages":messages, "model":config["model"]}
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(endpoint, json=payload, headers=headers)
            response.raise_for_status()
            body = response.json()
    except httpx.HTTPError as err:
        raise ModelError(f"model unreachable: {err}") from err
    if provider == "ollama":
        content = body.get("message", {}).get("content")
    elif provider == "anthropic":
        content = "".join(b.get("text", "") for b in body.get("content", []) if b.get("type") == "text")
    elif provider == "openai-compatible":
        content = ((body.get("choices") or [{}])[0].get("message") or {}).get("content")
    else:
        content = body.get("content")
    if not isinstance(content, str):
        raise ModelError("unexpected model response: missing text content")
    return content


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def parse_json(text: str) -> dict:
    """Parse a model's JSON however it chose to wrap it.

    Small models fence their output, prefix it with a sentence, or both. A
    parse failure here would throw away a whole tailoring pass, so the object
    is dug out rather than insisted upon.
    """
    candidates = [text]
    fenced = _FENCE.search(text)
    if fenced:
        candidates.insert(0, fenced.group(1))
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate.strip())
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise ModelError("model did not return an object")
