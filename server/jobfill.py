"""Job-application autofill — thin model proxy for the formwork browser extension.

The extension builds the prompt and validates the response; this endpoint only
moves messages to Ollama and text back. Keeping it dumb is deliberate: the
prompt has exactly one definition, in the extension, so the self-hosted path and
the bring-your-own-key path cannot drift apart.

Install: copy to homelab-api/routers/jobfill.py, then in main.py add `jobfill`
to the routers import and `app.include_router(jobfill.router)`.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from config import OLLAMA_URL
from helpers import post_json

router = APIRouter(prefix="/api/jobfill", tags=["jobfill"])

# Big enough for field mapping and essay drafting; small enough to stay snappy.
DEFAULT_MODEL = "qwen3.6:35b-a3b"


class Message(BaseModel):
    role: str
    content: str


class CompleteRequest(BaseModel):
    messages: list[Message]
    json_mode: bool = Field(False, alias="json")
    model: str | None = None

    model_config = {"populate_by_name": True}


@router.post("/complete")
async def complete(req: CompleteRequest):
    """Run a chat completion for the extension.

    `json` asks Ollama to constrain output to an object. The extension still
    parses defensively — a small model occasionally wraps JSON in prose, and a
    parse failure here would lose the deterministic fills too.
    """
    payload = {
        "model": req.model or DEFAULT_MODEL,
        "messages": [m.model_dump() for m in req.messages],
        "stream": False,
        # Reasoning adds seconds and nothing here: the model is matching form
        # labels to profile keys, not solving anything.
        "think": False,
        "options": {"temperature": 0.4 if not req.json_mode else 0},
    }
    if req.json_mode:
        payload["format"] = "json"

    result = await post_json(f"{OLLAMA_URL}/api/chat", json=payload, timeout=180)
    if not result:
        raise HTTPException(status_code=502, detail="Ollama unreachable")

    content = (result.get("message") or {}).get("content")
    if content is None:
        raise HTTPException(status_code=502, detail=f"Unexpected Ollama response: {result}")
    return {"content": content, "model": payload["model"]}


@router.get("/health")
async def health():
    """Report whether the backing model is loaded, for the extension's settings page."""
    tags = await post_json(f"{OLLAMA_URL}/api/show", json={"model": DEFAULT_MODEL}, timeout=10)
    return {"ok": bool(tags), "model": DEFAULT_MODEL, "ollama": OLLAMA_URL}
