"""
formwork dashboard — the API and the app.

What this adds on top of the extension: a queue to work through, a place to
confirm one application at a time, a record of what was actually sent, and the
per-posting documents the extension has no way to produce.

The submit boundary is the design. The extension fills and refuses to submit;
this dashboard exposes one Submit button per application, and auto mode does
*not* reach it. Auto mode means "stop asking me about the wording of a drafted
answer", not "apply on my behalf" — every application still leaves the building
because a person pressed a button in front of it. That is partly about applicant
tracking system terms, which generally forbid automated submission, and mostly
about the fact that the account being risked is the one the user is job-hunting
with.
"""
from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any
from typing import Literal

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import calendar_sync, google_connection, inbox, alerts, browser, career, discovery, documents, humanize, jobs, latex, matching, model, profile_import, resume as resume_mod, store, tracking, submission
from .config import (
    ABOUT_MD,
    ANSWERS_JSON,
    DOCS_DIR,
    EXTENSION_DASHBOARD_URL,
    NOVNC_URL,
    PROFILE_JSON,
    RESUME_TEX,
)

STATIC = Path(__file__).resolve().parent / "static"

@asynccontextmanager
async def lifespan(app):
    for record in store.list_applications("filling"):
        store.update_application(record["id"],status="failed",note="Preparation was interrupted by a service restart. Inspect the browser before retrying.")
    for record in store.list_applications("submitting"):
        store.update_application(record["id"], status="submission_unconfirmed", note="Submission was interrupted. Check the employer's confirmation before taking any further action.")
    task = asyncio.create_task(scheduled_search())
    mail_task = asyncio.create_task(inbox.scheduled_sync())
    try:
        yield
    finally:
        task.cancel();mail_task.cancel()
        for pending in (task,mail_task):
            with suppress(asyncio.CancelledError): await pending


app = FastAPI(title="formwork", description="Fill, review and send job applications", version="1.0.0", lifespan=lifespan)

store.init()

# What each application is doing right now. In memory on purpose: a step in
# progress is not worth surviving a restart, and a stale "filling…" that
# outlived the process would be worse than none.
PROGRESS: dict[int, dict[str, Any]] = {}

# One fill at a time. There is one browser and one document slot in it, and two
# applications preparing at once would take turns typing into each other's form
# and lend each other's résumé. Prepare stays a background task so the UI is
# never blocked; the queue is here.
FILLING = asyncio.Lock()
SEARCHING = asyncio.Lock()


async def scheduled_search():
    while True:
        await asyncio.sleep(60)
        settings = store.get_settings()
        hours = settings.get("refreshIntervalHours", 0)
        if isinstance(hours, (int,float)) and 1 <= hours <= 168 and not SEARCHING.locked():
            if time.time() - settings.get("lastQueueAttempt",0) >= hours * 3600:
                try:
                    await refresh_queue()
                except Exception as err:
                    store.set_settings({"lastQueueError":str(getattr(err,"detail",err))})


def _progress(app_id: int, step: str, **extra: Any) -> None:
    PROGRESS[app_id] = {"step": step, "at": time.time(), **extra}


def _read(path: Path, default: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return default


def _profile() -> dict[str, Any]:
    try:
        return json.loads(PROFILE_JSON.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _identity():
    profile = _profile()
    return {**profile.get("identity", {}), "links":{**profile.get("identity", {}).get("links", {}), **profile.get("links", {})}}


def _editable_application(app_id):
    record = tracking.application(app_id)
    _idle_application(app_id)
    if record["submitted_at"] or record["status"] in {"submitting", "submission_unconfirmed", "submitted", "screening", "interview", "offer", "accepted", "rejected", "withdrawn", "ghosted"}:
        raise HTTPException(409, "This application is already in outcome tracking; its submitted answers and documents are preserved")
    return record


def _idle_application(app_id):
    if PROGRESS.get(app_id) and not PROGRESS[app_id].get("done"):
        raise HTTPException(409, "Preparation is running; wait for it to finish before editing this application")


# --------------------------------------------------------------------- models

class SettingsIn(BaseModel):
    values: dict[str, Any]


class JobIn(BaseModel):
    url: str
    company: str = ""
    title: str = ""
    source: str = ""
    description: str = ""


class FieldIn(BaseModel):
    fieldId: str
    value: str


class ApproveIn(BaseModel):
    fieldId: str
    text: str


class RedraftIn(BaseModel):
    question: str
    previous: str = ""
    instruction: str = ""
    # Set for the cover letter, which the dashboard drafts rather than the
    # extension, and so has to be revised by the same code that wrote it.
    cover: bool = False


class StatusIn(BaseModel):
    status: str
    note: str = ""


class TextIn(BaseModel):
    text: str


class ProviderIn(BaseModel):
    provider: Literal["homelab", "ollama", "openai-compatible", "anthropic"]
    url: str
    model: str = ""
    key: str = ""


class CompletionIn(BaseModel):
    messages: list[dict[str, str]]
    want_json: bool = Field(default=False, alias="json")


class ModelConnectionIn(BaseModel):
    baseUrl: str = Field(min_length=1,max_length=2000)
    testOnly: bool = False


@app.post("/api/provider/extension")
async def connect_extension_model(body: ModelConnectionIn):
    async with FILLING:
        try:
            return await browser.run("modelConnection",body.model_dump(),timeout=60)
        except browser.BrowserError as err:
            raise HTTPException(502,str(err))


class BatchIn(BaseModel):
    ids: list[int] = Field(min_length=1,max_length=20)


@app.post("/api/jobfill/complete")
async def complete_for_extension(body: CompletionIn):
    try:
        return {"content":await model.complete(body.messages, want_json=body.want_json)}
    except model.ModelError as err:
        raise HTTPException(502, str(err))


@app.get("/api/provider")
async def get_provider():
    return {**model.public_config(), "extensionDashboardUrl":EXTENSION_DASHBOARD_URL}


@app.post("/api/provider")
async def save_provider(body: ProviderIn):
    try:
        return model.save_config(body.model_dump())
    except ValueError as err:
        raise HTTPException(400, str(err))


@app.post("/api/provider/test")
async def test_provider():
    try:
        reply = await model.complete([{"role":"user", "content":"Reply with the word ready."}], timeout=45)
    except model.ModelError as err:
        raise HTTPException(502, str(err))
    return {"ok":bool(reply.strip()), "reply":reply[:200]}


# ---------------------------------------------------------------------- state

@app.get("/api/state")
async def state() -> dict[str, Any]:
    profile = _profile()
    browser_status = await browser.probe()
    return {
        "counts": store.counts(),
        "settings": store.get_settings(),
        "browser": browser_status,
        "novnc": NOVNC_URL,
        "profile": {
            "name": profile.get("identity", {}).get("full_name", ""),
            "roles": len(profile.get("experience") or []),
            "projects": len(profile.get("projects") or []),
            "needsInput": profile.get("_needs_input") or [],
            "present": bool(profile),
        },
        "progress": PROGRESS,
    }


@app.get("/api/widget")
async def widget() -> dict[str, Any]:
    """A flat, always-present shape for a dashboard tile.

    `/api/state` reports only the statuses that exist, which is right for the
    app and wrong for a widget: a tile whose field vanishes when the count
    reaches zero renders blank rather than "0", and reads as broken.
    """
    counts = store.counts()
    return {
        "queue": counts.get("queue", 0),
        "ready": counts.get("ready", 0),
        "working": counts.get("filling", 0) + counts.get("queued", 0),
        "submitted": counts.get("submitted", 0),
    }


@app.get("/api/settings")
async def get_settings() -> dict[str, Any]:
    return store.get_settings()


@app.post("/api/settings")
async def post_settings(body: SettingsIn) -> dict[str, Any]:
    hours = body.values.get("refreshIntervalHours",0)
    if not isinstance(hours,(int,float)) or not (hours == 0 or 1 <= hours <= 168):
        raise HTTPException(400,"Refresh interval must be zero (off) or 1–168 hours")
    if 'sinceDays' in body.values and (type(body.values['sinceDays']) is not int or not 0 <= body.values['sinceDays'] <= 365):
        raise HTTPException(400,'Posting age must be 0–365 days')
    if 'limit' in body.values and (type(body.values['limit']) is not int or not 1 <= body.values['limit'] <= 400):
        raise HTTPException(400,"Queue limit must be 1–400")
    if 'discoveryPriorities' in body.values or 'jobSources' in body.values:
        raise HTTPException(400,"Use the discovery settings form for sources and preferences")
    return store.set_settings(body.values)


@app.get("/api/discovery")
async def get_discovery():
    settings = store.get_settings()
    return {'priorities':settings.get('discoveryPriorities',discovery.Priorities().model_dump()),
            'sources':settings.get('jobSources',jobs.default_sources())}


@app.post("/api/discovery")
async def save_discovery(body: discovery.Settings):
    sources=body.sources.model_dump()
    if not any(sources.values()):
        raise HTTPException(400,"Enable at least one source")
    store.set_settings({'discoveryPriorities':body.priorities.model_dump(),'jobSources':sources})
    return {'ok':True,'refreshRequired':True}


# ---------------------------------------------------------------------- queue

@app.get("/api/queue")
async def get_queue() -> dict[str, Any]:
    profile = _profile()
    evidence = latex.document_text(_read(RESUME_TEX))
    found = store.list_queue(limit=400)
    settings=store.get_settings()
    found=discovery.rank(discovery.recent(found,settings.get('sinceDays',0)),profile,evidence,settings.get('discoveryPriorities'))
    return {"jobs": found, "sources":settings.get("sourceHealth", []),
            "discovery":settings.get('lastDiscovery',{}),"sinceDays":settings.get("sinceDays",0),"priorities":settings.get("discoveryPriorities",{})}


@app.post("/api/queue/refresh")
async def refresh_queue() -> dict[str, Any]:
    if SEARCHING.locked():
        raise HTTPException(409,"A job refresh is already running")
    async with SEARCHING:
        settings = store.get_settings()
        store.set_settings({"lastQueueAttempt":time.time()})
        try:
            found = await jobs.find(settings)
        except RuntimeError as err:
            store.set_settings({"sourceHealth":jobs.LAST_HEALTH,"lastQueueError":str(err)})
            raise HTTPException(status_code=502, detail=str(err))
        store.set_settings({"sourceHealth":jobs.LAST_HEALTH,"lastQueueError":"","lastQueueRefresh":time.time()})
        profile=_profile(); evidence=latex.document_text(_read(RESUME_TEX))
        hidden=store.hidden_queue_urls()
        ranked=discovery.rank([job for job in discovery.recent(found,settings.get('sinceDays',0)) if job['url'] not in hidden],profile,evidence,settings.get('discoveryPriorities'))
        limit=max(1,min(400,int(settings.get('limit',60))))
        selected=[{key:value for key,value in job.items() if key not in {'fit','recommendation'}} for job in ranked[:limit]]
        count = store.replace_queue(selected)
        alerts.evaluate(ranked,profile,evidence)
        store.set_settings({'lastDiscovery':{'fetchedMatches':len(found),'eligible':len(ranked),'selected':count,
            'order':settings.get('discoveryPriorities',{}).get('order','recommended')}})
        return {"count":count,**await get_queue()}


@app.post("/api/queue/hide")
async def hide(body: JobIn) -> dict[str, str]:
    store.hide_queue_entry(body.url)
    return {"ok": "hidden"}


# --------------------------------------------------------------- applications

@app.get("/api/applications")
async def get_applications(status: str | None = None) -> dict[str, Any]:
    return {"applications": store.list_applications(status)}


@app.post("/api/applications")
async def create_application(body: JobIn) -> dict[str, Any]:
    from urllib.parse import urlsplit
    parsed = urlsplit(body.url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="enter an HTTP or HTTPS posting URL")
    with store.db() as conn:
        existing = conn.execute("SELECT id FROM applications WHERE url=?", (body.url,)).fetchone()
    if existing:
        _editable_application(existing["id"])
    record = store.upsert_application(body.model_dump())
    _editable_application(record["id"])
    snapshot = dict(record["snapshot"])
    if body.description:
        snapshot["posting"] = body.description[:30000]
    if body.source:
        snapshot["source"] = body.source[:200]
    if snapshot != record["snapshot"]:
        record = store.update_application(record["id"], snapshot=snapshot)
    return record


@app.get("/api/applications/{app_id}")
async def get_application(app_id: int) -> dict[str, Any]:
    record = store.get_application(app_id)
    if not record:
        raise HTTPException(status_code=404, detail="no such application")
    record["progress"] = PROGRESS.get(app_id)
    record["fit"] = matching.fit(record["snapshot"].get("posting", ""), _profile(), latex.document_text(_read(RESUME_TEX)))
    return record


@app.delete("/api/applications/{app_id}")
async def remove_application(app_id: int) -> dict[str, str]:
    _idle_application(app_id)
    record = tracking.application(app_id)
    if record["status"] in {"submitting", "submission_unconfirmed"}:
        raise HTTPException(409, "Resolve the uncertain submission before removing its record")
    store.delete_application(app_id)
    PROGRESS.pop(app_id, None)
    return {"ok": "deleted"}


@app.post("/api/applications/{app_id}/status")
async def set_status(app_id: int, body: StatusIn) -> dict[str, Any]:
    _idle_application(app_id)
    if body.status not in tracking.STAGES or body.status in {"submitting", "submission_unconfirmed"}:
        raise HTTPException(status_code=400, detail="unknown application status")
    old = tracking.application(app_id)
    if old["status"] in {"submitting", "submission_unconfirmed"} and body.status not in {"submitted", "rejected", "withdrawn"}:
        raise HTTPException(409, "Submission outcome is uncertain. Reconcile it before changing status; do not send it again.")
    fields = {"status": body.status, "note": body.note}
    if body.status == "submitted" and not old["submitted_at"]:
        fields["submitted_at"] = time.time()
    record = store.update_application(app_id, **fields)
    if not record:
        raise HTTPException(status_code=404, detail="no such application")
    return record


# ------------------------------------------------------------------- the work

async def _prepare(app_id: int) -> None:
    """Read the posting, write its documents, fill the form.

    Ordered so the expensive, failable parts happen before the browser is
    touched: a model that is down should not leave a half-filled form open on
    screen, and a tailored résumé has to exist before the fill that attaches it.
    """
    record = store.get_application(app_id)
    if not record:
        return
    settings = store.get_settings()
    master = _read(RESUME_TEX)
    selected_version = record["snapshot"].get("resumeVersion")
    slug = f"{record['company']}-{record['title']}"[:60]

    try:
        if selected_version:
            master = documents.version_tex(documents.get_version(selected_version))
        _progress(app_id, "reading the posting")
        described = await browser.run("describe", {"url": record["url"]}, timeout=180)
        posting = described.get("text", "")

        resume_path = ""
        rejected: list[dict[str, Any]] = []
        if master:
            try:
                resume_path = str(resume_mod.compile_pdf(master, slug))
            except RuntimeError as err:
                if selected_version:
                    raise
                rejected.append({"reason": f"Master résumé compilation failed — select a valid résumé before submitting: {err}"})
        resume_summary: list[str] = []
        # What the employer will actually read. The cover letter is written
        # from this rather than from the master, so the two documents cannot
        # disagree: a letter that leads with a project the tailored résumé
        # dropped sends the reader looking for something that is not there.
        sent_resume = master
        if settings.get("tailorResume") and master and posting:
            _progress(app_id, "tailoring your résumé")
            try:
                tailored = await resume_mod.tailor(posting, master)
                rejected = tailored["rejected"]
                resume_summary = tailored["summary"]
                if tailored["changed"]:
                    resume_path = str(resume_mod.compile_pdf(tailored["tex"], slug))
                    sent_resume = tailored["tex"]
            except (model.ModelError, RuntimeError, ValueError) as err:
                # A tailoring failure is not an application failure: the master
                # résumé is already attached by the fill. ValueError is in there
                # for the résumé itself — an unbalanced brace is an ordinary
                # LaTeX typo, and it must cost the tailoring rather than the
                # application.
                rejected.append({"reason": f"tailoring skipped — {err}"})

        cover: dict[str, Any] = {}
        cover_path = ""
        if settings.get("draftCoverLetter") and posting:
            _progress(app_id, "drafting a cover letter")
            try:
                cover = await resume_mod.cover_letter(
                    posting,
                    record["company"],
                    record["title"],
                    latex.document_text(sent_resume),
                    _read(ABOUT_MD),
                    identity=_identity(),
                )
                cover_path = str(
                    resume_mod.cover_letter_pdf(cover["text"], _profile().get("identity", {}), slug)
                )
            except (model.ModelError, RuntimeError, ValueError) as err:
                cover = {"error": str(err)}

        # Hand the per-posting documents to the extension before it fills, so
        # its own attachment path puts them on the form. Attaching afterwards
        # does not work: a form that has taken a file replaces the input with a
        # filename, leaving nothing to override.
        lent = {}
        if resume_path:
            lent["resume"] = {"path": resume_path}
        if cover_path and settings.get("autoMode"):
            lent["coverLetter"] = {"path": cover_path}
            cover["approvedText"] = cover["text"]
            cover["needsApproval"] = False
        if FILLING.locked():
            _progress(app_id, "waiting for the browser")
        async with FILLING:
            if lent:
                await browser.run("documents", {"set": lent}, timeout=180)
            try:
                _progress(app_id, "filling the form")
                store.update_application(app_id, status="filling")
                report = await browser.run("fill", {"url": record["url"], "expectedResume": submission.fingerprint(resume_path) if resume_path else None}, timeout=900)
            finally:
                # The user's own documents go back even if the fill died: that
                # slot is their setting, not ours.
                if lent:
                    await browser.run("documents", {"restore": True}, timeout=180)

        attached = [
            field["label"]
            for field in report.get("fields", [])
            if field.get("type") == "file" and field.get("value")
        ]

        staged = report.get("staged", [])
        # The same read the cover letter gets. An open-ended answer is model
        # prose too, and it goes straight onto the form, so how it reads is
        # worth showing before it is approved.
        for draft in staged:
            draft["tells"] = humanize.report(draft.get("text", ""))
        if settings.get("autoMode") and staged:
            _progress(app_id, "approving drafts")
            for draft in staged:
                await browser.run(
                    "approve",
                    {
                        "url": record["url"],
                        "fieldId": draft["id"],
                        "text": draft["text"],
                        "company": report.get("company", record["company"]),
                        "role": report.get("title", record["title"]),
                        "companySpecific": True,
                    },
                    timeout=180,
                )
            report = await browser.run("read", {"url": record["url"], "expectedResume": record["snapshot"].get("expectedResume")}, timeout=180)
            report["staged"] = []

        snapshot = {
            **report,
            "posting": posting[:8000],
            "postingUrl": record["snapshot"].get("postingUrl") or record["url"],
            "resumeVersion": selected_version,
            "expectedResume": submission.fingerprint(resume_path) if resume_path else None,
            "resumeText": latex.document_text(sent_resume),
            "resumeRejected": rejected,
            "resumeSummary": resume_summary,
            "attached": attached,
            "cover": cover,
            "preparedAt": time.time(),
        }
        store.update_application(
            app_id,
            status="queued" if report.get("flow",{}).get("kind") in {"login","unknown"} else "ready",
            snapshot=snapshot,
            resume_path=resume_path,
            cover_path=cover_path,
            url=report.get("url") or record["url"],
            # A successful run clears the last failure's note; leaving it would
            # show "fill returned nothing" under an application that is filled.
            note=report.get("flow",{}).get("message", ""),
        )
        _progress(app_id, report.get("flow",{}).get("message", "ready"), done=True)
    except Exception as err:  # noqa: BLE001 - see below
        # Deliberately everything. This runs as a background task, so an
        # exception it does not catch goes nowhere: the application keeps
        # whichever status it had, its progress never reaches "done", and the
        # interface spins on it forever with nothing to show. A failure the user
        # can read is the least this owes them.
        store.update_application(app_id, status="failed", note=str(err))
        _progress(app_id, "failed", done=True, error=str(err))


@app.post("/api/applications/{app_id}/prepare")
async def prepare(app_id: int, background: BackgroundTasks) -> dict[str, str]:
    record = _editable_application(app_id)
    if not record:
        raise HTTPException(status_code=404, detail="no such application")
    running = PROGRESS.get(app_id)
    if running and not running.get("done"):
        return {"ok": "already running", "step": running["step"]}
    _progress(app_id, "queued")
    store.update_application(app_id,status="queued")
    background.add_task(_prepare, app_id)
    return {"ok": "started"}


class ContinueIn(BaseModel):
    action: Literal["next","fill"] = "next"


async def _continue_workday(app_id: int, action: str):
    record=store.get_application(app_id)
    try:
        snapshot=record["snapshot"]
        lent={}
        if record["resume_path"]: lent["resume"]={"path":record["resume_path"]}
        cover=snapshot.get("cover",{})
        if record["cover_path"] and cover.get("approvedText")==cover.get("text") and cover.get("approvedText"):
            lent["coverLetter"]={"path":record["cover_path"]}
        async with FILLING:
            if lent: await browser.run("documents",{"set":lent},timeout=180)
            try:
                report=await browser.run("fill",{"url":record["url"],"resume":True,"advance":action=="next",
                    "fingerprint":snapshot.get("flow",{}).get("fingerprint")},timeout=900)
            finally:
                if lent: await browser.run("documents",{"restore":True},timeout=180)
            for draft in report.get("staged",[]): draft["tells"]=humanize.report(draft.get("text",""))
            if store.get_settings().get("autoMode") and report.get("staged"):
                for draft in report["staged"]:
                    await browser.run("approve",{"url":report.get("url",record["url"]),"fieldId":draft["id"],"text":draft["text"],
                        "company":record["company"],"role":record["title"],"companySpecific":True},timeout=180)
                report={**report,**await browser.run("read",{"url":report.get("url",record["url"])},timeout=180),"staged":[]}
        steps=list(snapshot.get("steps",[]))
        if report.get("advanced"):
            previous=report.pop("previousStep",None) or snapshot
            steps.append({"flow":previous.get("flow",{}),"fields":previous.get("fields",[]),"savedAt":time.time()})
        snapshot={**snapshot,**report,"steps":steps}
        kind=report.get("flow",{}).get("kind")
        if not kind: raise RuntimeError("Browser did not return a Workday step; inspect it before retrying")
        store.update_application(app_id,status="queued" if kind in {"login","unknown"} else "ready",snapshot=snapshot,
            url=report.get("url") or record["url"],note=report.get("flow",{}).get("message", ""))
        _progress(app_id,"Workday page ready for review",done=True)
    except Exception as err:
        store.update_application(app_id,status="failed",note=str(err))
        _progress(app_id,"Workday continuation failed",done=True,error=str(err))


@app.post("/api/applications/{app_id}/continue")
async def continue_workday(app_id: int, body: ContinueIn, background: BackgroundTasks):
    record=_editable_application(app_id)
    flow=record["snapshot"].get("flow",{})
    if not flow or flow.get("kind")=="review": raise HTTPException(409,"No Workday step is available to continue")
    if body.action=="next" and flow.get("kind")!="next": raise HTTPException(409,"Sign in or resume the application first")
    if body.action=="next" and record["snapshot"].get("staged"): raise HTTPException(409,"Review drafted answers before continuing")
    running=PROGRESS.get(app_id)
    if running and not running.get("done"): return {"ok":"already running"}
    _progress(app_id,"Continuing Workday application")
    store.update_application(app_id,status="filling")
    background.add_task(_continue_workday,app_id,body.action)
    return {"ok":"started"}


@app.post("/api/prepare-batch")
async def prepare_batch(body: BatchIn, background: BackgroundTasks):
    ids = list(dict.fromkeys(body.ids))
    for app_id in ids:
        record = _editable_application(app_id)
        if record["status"] not in {"queued","failed"} or (PROGRESS.get(app_id) and not PROGRESS[app_id].get("done")):
            raise HTTPException(409,"Select queued or failed applications; review prepared applications individually")
    for app_id in ids:
        _progress(app_id,"queued for batch preparation")
        store.update_application(app_id,status="queued")
    async def run_batch():
        for app_id in ids:
            await _prepare(app_id)
    background.add_task(run_batch)
    return {"started":ids,"submits":False}


@app.post("/api/applications/{app_id}/field")
async def edit_field(app_id: int, body: FieldIn) -> dict[str, Any]:
    record = _editable_application(app_id)
    if not record:
        raise HTTPException(status_code=404, detail="no such application")
    try:
        await browser.run(
            "edit", {"url": record["url"], "fieldId": body.fieldId, "value": body.value}, timeout=300
        )
        report = await browser.run("read", {"url": record["url"], "expectedResume": record["snapshot"].get("expectedResume")}, timeout=180)
    except browser.BrowserError as err:
        raise HTTPException(status_code=502, detail=str(err))
    snapshot = {**record["snapshot"], **report}
    store.update_application(app_id, snapshot=snapshot)
    return snapshot


@app.post("/api/applications/{app_id}/approve")
async def approve_draft(app_id: int, body: ApproveIn) -> dict[str, Any]:
    record = _editable_application(app_id)
    if not record:
        raise HTTPException(status_code=404, detail="no such application")
    try:
        await browser.run(
            "approve",
            {
                "url": record["url"],
                "fieldId": body.fieldId,
                "text": body.text,
                "company": record["company"],
                "role": record["title"],
                "companySpecific": True,
            },
            timeout=300,
        )
        report = await browser.run("read", {"url": record["url"], "expectedResume": record["snapshot"].get("expectedResume")}, timeout=180)
    except browser.BrowserError as err:
        raise HTTPException(status_code=502, detail=str(err))
    snapshot = {**record["snapshot"], **report}
    snapshot["staged"] = [s for s in snapshot.get("staged", []) if s["id"] != body.fieldId]
    store.update_application(app_id, snapshot=snapshot)
    return snapshot


@app.post("/api/applications/{app_id}/redraft")
async def redraft(app_id: int, body: RedraftIn) -> dict[str, Any]:
    """Write the answer again, with a note on what to change.

    Returns the new text and does not touch the page. A revision is a draft
    like any other, and the approval gate is the same one.
    """
    record = _editable_application(app_id)
    if not record:
        raise HTTPException(status_code=404, detail="no such application")
    snapshot = record["snapshot"] or {}

    if body.cover:
        try:
            cover = await resume_mod.cover_letter(
                snapshot.get("posting", ""),
                record["company"],
                record["title"],
                snapshot.get("resumeText") or latex.document_text(_read(RESUME_TEX)),
                _read(ABOUT_MD),
                revision={"previous": body.previous, "instruction": body.instruction},
                identity=_identity(),
            )
        except (model.ModelError, RuntimeError) as err:
            raise HTTPException(status_code=502, detail=str(err))
        old_cover = snapshot.get("cover", {})
        legacy_attachment = any("cover" in label.lower() for label in snapshot.get("attached", []))
        cover["approvedText"] = old_cover.get("approvedText", old_cover.get("text", "") if legacy_attachment else "")
        snapshot["cover"] = cover
        store.update_application(app_id, snapshot=snapshot)
        return {
            "text": cover["text"],
            "unsupported": cover.get("unsupported", []),
            "lost": cover.get("lost", []),
            "tells": cover.get("tells", []),
            "factualReview": cover.get("factualReview"),
        }

    try:
        item = await browser.run(
            "redraft",
            {
                "url": record["url"],
                "question": body.question,
                "previous": body.previous,
                "instruction": body.instruction,
                "company": record["company"],
                "role": record["title"],
            },
            timeout=300,
        )
    except browser.BrowserError as err:
        raise HTTPException(status_code=502, detail=str(err))
    if not item or not item.get("text"):
        raise HTTPException(status_code=502, detail=(item or {}).get("note") or "nothing came back")
    return {"text": item["text"], "note": item.get("note", ""), "tells": humanize.report(item["text"])}


@app.post("/api/applications/{app_id}/refresh")
async def refresh_application(app_id: int) -> dict[str, Any]:
    record = _editable_application(app_id)
    if not record:
        raise HTTPException(status_code=404, detail="no such application")
    try:
        report = await browser.run("read", {"url": record["url"], "expectedResume": record["snapshot"].get("expectedResume")}, timeout=180)
    except browser.BrowserError as err:
        store.update_application(app_id, snapshot={**record["snapshot"], "resumeCheck": {"status":"unknown", "reason":"The open employer page could not be checked. Open it and re-read before sending."}})
        raise HTTPException(status_code=502, detail=str(err))
    snapshot = {**record["snapshot"], **report}
    store.update_application(app_id, snapshot=snapshot)
    return snapshot


@app.post("/api/applications/{app_id}/submit")
async def submit(app_id: int, dry: bool = False) -> dict[str, Any]:
    """Press the form's own submit control.

    Reached only from the dashboard's Submit button. Auto mode does not call
    this and there is no setting that makes it call itself — see the note at
    the top of this file.
    """
    async with FILLING:
        record = store.get_application(app_id)
        if not record:
            raise HTTPException(status_code=404, detail="no such application")
        if record["status"] != "ready" or record["submitted_at"]:
            raise HTTPException(409, "Only a prepared, unsent application can be submitted")
        flow=record["snapshot"].get("flow")
        if flow and flow.get("kind")!="review":
            raise HTTPException(409,"Complete the Workday steps before submitting")
        cover = record["snapshot"].get("cover", {})
        if cover.get("approvedText") and (cover.get("approvedText") != cover.get("text") or
                (cover.get("attachment") and not cover["attachment"].get("ok"))):
            raise HTTPException(status_code=409, detail="The revised cover letter is not attached. Approve and attach it before submitting.")
        expected = record["snapshot"].get("expectedResume")
        if not record["resume_path"] and any(field.get("type")=="file" and "resume" in field.get("label", "").lower() for field in record["snapshot"].get("fields", [])):
            raise HTTPException(409, "Select and prepare a résumé so its exact version can be checked and recorded")
        if record["resume_path"]:
            try:
                current = submission.fingerprint(record["resume_path"])
            except OSError:
                raise HTTPException(409, "The prepared résumé file is missing. Prepare it again.")
            if expected and current != expected:
                raise HTTPException(409, "The prepared résumé changed. Attach and review the replacement first.")
            expected = current
        args = {"url": record["url"], "expectedResume": expected}
        # A preflight has no side effects. Persist the attempt BEFORE any click,
        # so a timeout, restart or second request cannot blindly retry it.
        try:
            check = await browser.run("submit", {**args, "dryRun": True}, timeout=180)
        except browser.BrowserError as err:
            raise HTTPException(502, str(err))
        if dry or not check.get("ok"):
            return check
        snapshot = dict(record["snapshot"])
        try:
            documents_sent = {kind: submission.archive(record[kind + "_path"])
                              for kind in ("resume", "cover") if record[kind + "_path"]}
        except (OSError, ValueError) as err:
            raise HTTPException(409, str(err))
        snapshot["submissionAttempt"] = {"at": time.time(), "documents": documents_sent, "expectedResume": expected}
        store.update_application(app_id, status="submitting", snapshot=snapshot)
        try:
            result = await browser.run("submit", {**args, "dryRun": False}, timeout=300)
        except browser.BrowserError as err:
            result = {"ok": False, "confirmation": False, "reason": str(err)}
        snapshot["submitResult"] = result
        confirmed = result.get("confirmation") is True
        # Only a definite refusal before a click can return to ready.
        status = "submitted" if confirmed else "ready" if result.get("clicked") is False else "submission_unconfirmed"
        store.update_application(app_id, status=status, snapshot=snapshot,
                                 submitted_at=time.time() if confirmed else None)
        return result


@app.post("/api/applications/{app_id}/reconcile")
async def reconcile_submission(app_id: int):
    async with FILLING:
        record = tracking.application(app_id)
        if record["status"] != "submission_unconfirmed":
            raise HTTPException(409, "Only an unconfirmed submission can be reconciled")
        url = record["snapshot"].get("submitResult", {}).get("url") or record["url"]
        try:
            result = await browser.run("receipt", {"url": url}, timeout=60)
        except browser.BrowserError as err:
            raise HTTPException(502, str(err))
        if result.get("confirmation") is True:
            store.update_application(app_id, status="submitted", submitted_at=time.time(),
                snapshot={**record["snapshot"], "submitResult": result})
        return result


@app.post("/api/applications/{app_id}/resume/attach")
async def attach_resume(app_id: int):
    async with FILLING:
        record = _editable_application(app_id)
        if not record["resume_path"]:
            raise HTTPException(409, "Select and prepare a résumé first")
        try:
            expected = submission.fingerprint(record["resume_path"])
            result = await browser.run("attach", {"url": record["url"], "path": record["resume_path"], "match": "resume"}, timeout=180)
        except (OSError, browser.BrowserError) as err:
            raise HTTPException(502, str(err))
        snapshot = {**record["snapshot"], "resumeAttachment": result}
        if result.get("ok"):
            snapshot["expectedResume"] = expected
        snapshot["resumeCheck"] = result.get("resumeCheck", {"status": "unknown", "reason": result.get("reason", "Re-read the employer review to verify the upload.")})
        store.update_application(app_id, snapshot=snapshot)
        return result


# ------------------------------------------------------------------ documents

@app.post("/api/applications/{app_id}/cover/approve")
async def approve_cover(app_id: int, body: TextIn) -> dict[str, Any]:
    record = _editable_application(app_id)
    if not record:
        raise HTTPException(status_code=404, detail="no such application")
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="the cover letter is empty")
    async with FILLING:
        try:
            path = await asyncio.to_thread(resume_mod.cover_letter_pdf, body.text,
                _profile().get("identity", {}), f"application-{app_id}")
            result = await browser.run("attach", {"url": record["url"], "path": str(path), "match": "cover"})
        except (RuntimeError, browser.BrowserError) as err:
            raise HTTPException(status_code=502, detail=str(err))
        snapshot = record["snapshot"] or {}
        old_cover = snapshot.get("cover", {})
        if old_cover.get("text") != body.text and old_cover.get("factualReview"):
            old_cover["factualReview"] = {"status":"stale", "concerns":[], "note":"The letter was edited after its model-assisted factual review. The approved wording needs your own factual check."}
        snapshot["cover"] = {**snapshot.get("cover", {}), "text": body.text,
            "tells": humanize.report(body.text), "approvedText": body.text,
            "needsApproval": False, "attachment": result}
        store.update_application(app_id, snapshot=snapshot, cover_path=str(path))
    return {"document": path.name, "attachment": result, "cover": snapshot["cover"]}

@app.get("/api/resume")
async def get_resume() -> dict[str, Any]:
    return {"tex": _read(RESUME_TEX), "path": str(RESUME_TEX)}


@app.post("/api/applications/{app_id}/cover/confirm-manual")
async def confirm_manual_cover(app_id: int):
    record = _editable_application(app_id)
    cover = record["snapshot"].get("cover", {})
    if not record["cover_path"] or not cover.get("approvedText") or cover.get("approvedText") != cover.get("text"):
        raise HTTPException(409, "Approve and compile the current letter before confirming its upload")
    cover["attachment"] = {"ok":True, "confirmedBy":"user", "at":time.time(), "filename":Path(record["cover_path"]).name}
    store.update_application(app_id, snapshot={**record["snapshot"], "cover":cover})
    return {"ok":True, "confirmedBy":"user"}


@app.post("/api/resume")
async def put_resume(body: TextIn) -> dict[str, Any]:
    RESUME_TEX.write_text(body.text, encoding="utf-8")
    return {"ok": "saved", "bytes": len(body.text)}


@app.post("/api/resume/compile")
async def compile_resume() -> dict[str, Any]:
    try:
        path = resume_mod.compile_pdf(_read(RESUME_TEX), "master")
    except RuntimeError as err:
        raise HTTPException(status_code=400, detail=str(err))
    return {"ok": "compiled", "document": path.name}


@app.get("/api/documents/{name}")
async def document(name: str) -> FileResponse:
    # Resolved and re-checked: a name is a path component, and "../" is a name.
    path = (DOCS_DIR / name).resolve()
    if path.parent != DOCS_DIR.resolve() or not path.is_file():
        raise HTTPException(status_code=404, detail="no such document")
    return FileResponse(path, media_type="application/pdf", filename=path.name)


@app.get("/api/profile")
async def get_profile() -> dict[str, Any]:
    return {
        "profile": _profile(),
        "answers": json.loads(_read(ANSWERS_JSON, "{}") or "{}"),
        "about": _read(ABOUT_MD),
    }


@app.post("/api/profile/answers")
async def put_answers(body: TextIn) -> dict[str, Any]:
    try:
        answers = json.loads(body.text)
        if not isinstance(answers, dict):
            raise HTTPException(400, "answers must be a JSON object")
    except json.JSONDecodeError as err:
        raise HTTPException(status_code=400, detail=f"not valid JSON: {err}")
    ANSWERS_JSON.write_text(body.text, encoding="utf-8")
    profile = _profile()
    for key, value in answers.items():
        profile[key] = {**profile.get(key, {}), **value} if isinstance(value, dict) and isinstance(profile.get(key, {}), dict) else value
    PROFILE_JSON.write_text(json.dumps(profile, indent=2), encoding="utf-8")
    return {"ok": "saved", **await sync_profile()}


@app.post("/api/profile/about")
async def put_about(body: TextIn) -> dict[str, Any]:
    ABOUT_MD.write_text(body.text, encoding="utf-8")
    return {"ok": "saved", **await sync_profile()}


@app.post("/api/profile")
async def save_profile(body: TextIn):
    try:
        profile = json.loads(body.text)
    except json.JSONDecodeError as err:
        raise HTTPException(400, str(err))
    if not isinstance(profile, dict) or not isinstance(profile.get("identity", {}), dict):
        raise HTTPException(400, "profile must be an object with an identity object")
    for key in ("experience", "education", "projects"):
        if key in profile and not isinstance(profile[key], list):
            raise HTTPException(400, f"{key} must be a list")
    PROFILE_JSON.write_text(json.dumps(profile, indent=2), encoding="utf-8")
    return {"ok":"saved", **await sync_profile()}


@app.post("/api/profile/sync")
async def sync_profile():
    async with FILLING:
        try:
            result = await browser.run("profile", {"profile":_profile(), "about":_read(ABOUT_MD)}, timeout=30)
            return {"synced":bool(result.get("ok"))}
        except browser.BrowserError as err:
            return {"synced":False, "syncError":str(err)}


# ------------------------------------------------------------------------ app

@app.get("/writing/{name}")
async def writing_script(name: str) -> FileResponse:
    if name not in {"humanizer-rules.js", "humanize.js"}:
        raise HTTPException(status_code=404, detail="no such script")
    return FileResponse(Path(__file__).resolve().parents[2] / "extension/src/lib" / name,
                        media_type="application/javascript")

app.include_router(google_connection.router)
app.include_router(inbox.router)
app.include_router(calendar_sync.router)
app.include_router(tracking.router)
app.include_router(career.router)
app.include_router(documents.router)
app.include_router(alerts.router)
app.include_router(profile_import.router)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return HTMLResponse((STATIC / "index.html").read_text(encoding="utf-8"))
