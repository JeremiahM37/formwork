"""Saved searches evaluated against the queue that discovery already collects."""
import time
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from . import matching, store, tracking

router = APIRouter(prefix="/api")

class AlertIn(BaseModel):
    name: str = Field(min_length=1,max_length=100)
    query: str = Field(min_length=1,max_length=200)
    min_coverage: int = Field(default=0,ge=0,le=100)


def evaluate(jobs, profile, resume_text):
    searches = tracking.rows("SELECT * FROM search_alerts")
    for job in jobs:
        searchable = f"{job.get('company','')} {job.get('title','')} {job.get('description','')}".casefold()
        fit = None
        for alert in searches:
            if not all(word in searchable for word in alert['query'].casefold().split()):
                continue
            if alert['min_coverage']:
                fit = fit or matching.fit(job.get('description',''),profile,resume_text)
                if fit['coverage'] is None or fit['coverage'] < alert['min_coverage']:
                    continue
            with store.db() as conn:
                conn.execute("INSERT OR IGNORE INTO job_notifications(alert_id,url,company,title,created_at) VALUES(?,?,?,?,?)",
                    (alert['id'],job['url'],job.get('company',''),job.get('title',''),time.time()))


@router.get("/alerts")
def list_alerts():
    return {"alerts":tracking.rows("SELECT * FROM search_alerts ORDER BY name"),
        "notifications":tracking.rows("SELECT n.*,a.name AS alert FROM job_notifications n JOIN search_alerts a ON a.id=n.alert_id WHERE n.acknowledged=0 ORDER BY n.created_at DESC LIMIT 100")}


@router.post("/alerts")
def add_alert(body: AlertIn):
    with store.db() as conn:
        cur=conn.execute("INSERT INTO search_alerts(name,query,min_coverage) VALUES(?,?,?)",(body.name,body.query,body.min_coverage))
        return {"id":cur.lastrowid, **body.model_dump()}


@router.delete("/alerts/{alert_id}")
def delete_alert(alert_id: int):
    with store.db() as conn:
        conn.execute("DELETE FROM search_alerts WHERE id=?",(alert_id,))
    return {"ok":True}


@router.post("/notifications/{notification_id}/acknowledge")
def acknowledge(notification_id: int):
    with store.db() as conn:
        cur=conn.execute("UPDATE job_notifications SET acknowledged=1 WHERE id=?",(notification_id,))
        if not cur.rowcount: raise HTTPException(404,"no such notification")
    return {"ok":True}


@router.get('/digest')
def digest():
    """A copyable summary of existing local state; no fetches or messages."""
    now=time.time()
    notifications=tracking.rows("SELECT title,company,url FROM job_notifications WHERE created_at>=? ORDER BY created_at DESC LIMIT 20",(now-7*86400,))
    pending=tracking.rows("SELECT r.*,a.company FROM reminders r JOIN applications a ON a.id=r.application_id WHERE r.done=0 AND r.due_at<=? ORDER BY r.due_at LIMIT 20",(now+7*86400,))
    interviews=tracking.rows("SELECT i.*,a.company FROM interviews i JOIN applications a ON a.id=i.application_id WHERE i.starts_at BETWEEN ? AND ? AND i.outcome NOT IN ('cancelled','rejected') ORDER BY i.starts_at LIMIT 20",(now,now+7*86400))
    lines=['Formwork — weekly search digest','','New saved-search matches (past 7 days)']
    seen=set()
    for job in notifications:
        if job['url'] in seen: continue
        seen.add(job['url']);lines.append(f"- {job['company']} — {job['title']}\n  {job['url']}")
    if not seen: lines.append('- No new saved-search matches recorded.')
    lines.extend(['',f'Follow-ups due or coming up: {len(pending)}',f'Interviews in the next 7 days: {len(interviews)}',
                  '', 'Uses already collected local data. Lists are limited to 20 records; no message has been sent.'])
    return {'text':'\n'.join(lines)}
