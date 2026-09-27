"""Read-only Gmail synchronization with explicit local review decisions."""
from __future__ import annotations
import html
import json
import re
import time
from email.utils import parseaddr
from email.header import decode_header, make_header
from typing import Literal
from urllib.parse import quote
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from . import google_connection as google, store

router=APIRouter(prefix='/api/inbox')
JOB_QUERY='{interview application recruiting recruiter "job offer" candidacy}'
JOB_WORDS=re.compile(r'\b(interview|application|recruit(?:ing|er|ment)?|job offer|candidacy)\b',re.I)


def decode_message(raw):
    headers={h['name'].lower():h.get('value','') for h in raw.get('payload',{}).get('headers',[])}
    def decoded(value):
        try: return str(make_header(decode_header(value)))
        except (ValueError,UnicodeError,LookupError): return value
    name,address=parseaddr(decoded(headers.get('from','')))
    subject=decoded(headers.get('subject',''))[:1000]
    snippet=html.unescape(raw.get('snippet',''))[:2000]
    text=subject+' '+snippet
    suggested=''
    for stage,pattern in [('rejected',r'not (?:be )?moving forward|unfortunately|other candidates|not selected'),
            ('offer',r'(?:job|employment) offer|pleased to offer'),('interview',r'\binterview\b'),
            ('submitted',r'application (?:has been )?received|thank you for applying|thanks for applying')]:
        if re.search(pattern,text,re.I): suggested=stage;break
    return {'id':str(raw['id']),'subject':subject,'snippet':snippet,'senderName':name[:200],
        'senderEmail':address[:320],'receivedAt':int(raw.get('internalDate','0'))/1000,
        'suggestedStatus':suggested,'relevant':bool(JOB_WORDS.search(text)),
        'rfc822Id':headers.get('message-id','').strip().strip('<>'),
        'provenance':'Message From header; sender identity and employer affiliation are not independently verified.'}


async def fetch_json(data,path,params=None,allow_missing=False):
    response=await google.google_get(data,path,params)
    if allow_missing and response.status_code==404: return None
    if response.status_code!=200: raise HTTPException(502,f'Gmail returned HTTP {response.status_code}; synchronization can be retried')
    return response.json()


async def _sync(data):
    if not data.get('token'): raise HTTPException(409,'Connect Google before synchronizing')
    data['lastSyncAttempt']=time.time();google.save(data)
    cursor=data.get('mailPage') or {}
    if not data.get('historyId') and not cursor:
        profile=await fetch_json(data,'profile')
        cursor={'mode':'full','anchor':profile['historyId'],'generation':str(time.time()),'page':''}
    if cursor.get('mode')=='full':
        query=JOB_QUERY if data.get('historyExpired') else 'newer_than:90d '+JOB_QUERY
        params={'q':query,'maxResults':50}
        if cursor.get('page'): params['pageToken']=cursor['page']
        batch=await fetch_json(data,'messages',params)
        ids=[item['id'] for item in batch.get('messages',[])];deleted=[]
    else:
        params={'startHistoryId':data['historyId'],'maxResults':50,'historyTypes':['messageAdded','messageDeleted']}
        if cursor.get('page'): params['pageToken']=cursor['page']
        batch=await fetch_json(data,'history',params,allow_missing=True)
        if batch is None:
            data.pop('historyId',None);data.pop('mailPage',None);data['historyExpired']=True;google.save(data)
            return await _sync(data)
        ids=list(dict.fromkeys(m['message']['id'] for h in batch.get('history',[]) for m in h.get('messagesAdded',[])))
        deleted=[m['message']['id'] for h in batch.get('history',[]) for m in h.get('messagesDeleted',[])]
        cursor={'mode':'history',**cursor}
    # Do not advance the cursor until every message in this page was read or
    # confirmed deleted. A failure replays this page; primary keys deduplicate it.
    messages=[]
    for message_id in ids:
        if message_id in deleted: continue
        raw=await fetch_json(data,'messages/'+quote(message_id,safe=''),
            {'format':'full','fields':'id,internalDate,snippet,payload(headers)'},allow_missing=True)
        if raw is None: deleted.append(message_id);continue
        message=decode_message(raw)
        relevant=cursor.get('mode')=='full' or message['relevant']
        # Search can match a word deeper in the body than Gmail's snippet. Use
        # the exact RFC message ID to ask Gmail without downloading the body.
        if not relevant and re.fullmatch(r'[A-Za-z0-9._+@=/\-]{1,500}',message['rfc822Id']):
            matched=await fetch_json(data,'messages',{'q':JOB_QUERY+' rfc822msgid:'+message['rfc822Id'],'maxResults':100})
            relevant=any(item['id']==message_id for item in matched.get('messages',[]))
        if relevant: messages.append(message)
    with store.db() as db:
        for message in messages:
            db.execute('''INSERT INTO inbox_messages(id,payload,received_at,scan) VALUES(?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,received_at=excluded.received_at,deleted=0,scan=excluded.scan''',
                (message['id'],json.dumps(message),message['receivedAt'],cursor.get('generation','')))
        for message_id in deleted: db.execute('UPDATE inbox_messages SET deleted=1 WHERE id=?',(message_id,))
        if cursor.get('mode')=='full' and not batch.get('nextPageToken') and data.get('historyExpired'):
            db.execute('UPDATE inbox_messages SET deleted=1 WHERE scan!=?',(cursor['generation'],))
    if batch.get('nextPageToken'):
        cursor['page']=batch['nextPageToken'];data['mailPage']=cursor
    else:
        data['historyId']=cursor['anchor'] if cursor['mode']=='full' else batch['historyId']
        data.pop('mailPage',None);data.pop('historyExpired',None);data['lastSync']=time.time()
    data['lastError']='';google.save(data)
    return {'read':len(ids),'imported':len(messages),'pending':bool(data.get('mailPage')),'connection':google.public(data)}


@router.post('/sync')
async def synchronize():
    async with google.LOCK:
        data=google.load()
        try: return await _sync(data)
        except HTTPException as err:
            data['lastError']=str(err.detail);google.save(data);raise
        except Exception:
            data['lastError']='Gmail synchronization failed; the cursor was preserved for retry.';google.save(data)
            raise HTTPException(502,data['lastError']) from None


@router.get('')
async def inbox(offset: int=Query(0,ge=0),limit: int=Query(50,ge=1,le=100)):
    with store.db() as db:
        rows=db.execute("SELECT * FROM inbox_messages WHERE decision='pending' AND deleted=0 ORDER BY received_at DESC,id LIMIT ? OFFSET ?",(limit,offset)).fetchall()
        count=db.execute("SELECT count(*) FROM inbox_messages WHERE decision='pending' AND deleted=0").fetchone()[0]
    applications=store.list_applications()
    messages=[]
    for row in rows:
        message=json.loads(row['payload']);text=message['subject']+' '+message['snippet']
        message['candidates']=[{'id':a['id'],'company':a['company'],'title':a['title'],'status':a['status']}
            for a in applications if len(a['company'])>=3 and re.search(r'(?<!\w)'+re.escape(a['company'])+r'(?!\w)',text,re.I)]
        messages.append(message)
    return {'messages':messages,'count':count,'offset':offset,'connection':google.public(google.load())}


class ReviewIn(BaseModel):
    action: Literal['link','dismiss']
    applicationId: int | None = None
    status: Literal['','submitted','screening','interview','offer','rejected','withdrawn','ghosted'] = ''


@router.post('/{message_id}/review')
async def review(message_id: str,body: ReviewIn):
    with store.db() as db:
        row=db.execute('SELECT * FROM inbox_messages WHERE id=?',(message_id,)).fetchone()
        if not row or row['deleted']: raise HTTPException(404,'Message is unavailable')
        if row['decision']!='pending': return {'ok':True,'alreadyReviewed':True}
        if body.action=='link':
            from .app import _idle_application
            _idle_application(body.applicationId)
            application=db.execute('SELECT * FROM applications WHERE id=?',(body.applicationId,)).fetchone()
            if not application: raise HTTPException(400,'Choose an application to associate with this message')
            message=json.loads(row['payload'])
            db.execute('INSERT INTO application_events(application_id,kind,text,created_at) VALUES(?,?,?,?)',
                (body.applicationId,'inbox',f"Gmail message {message_id}: {message['subject']} — association reviewed by user",time.time()))
            if body.status:
                db.execute("UPDATE applications SET status=?,updated_at=?,submitted_at=CASE WHEN ?='submitted' THEN COALESCE(submitted_at,?) ELSE submitted_at END WHERE id=?",(body.status,time.time(),body.status,time.time(),body.applicationId))
        db.execute('UPDATE inbox_messages SET decision=?,application_id=? WHERE id=?',
            (body.action,body.applicationId if body.action=='link' else None,message_id))
    return {'ok':True}


@router.post('/{message_id}/contact')
async def import_contact(message_id: str):
    with store.db() as db:
        row=db.execute('SELECT payload FROM inbox_messages WHERE id=? AND deleted=0',(message_id,)).fetchone()
        if not row: raise HTTPException(404,'Message is unavailable')
        message=json.loads(row['payload']);email=message['senderEmail']
        if not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+',email) or re.search(r'no.?reply|do.?not.?reply',email,re.I):
            raise HTTPException(400,'This message does not provide a usable sender contact')
        existing=db.execute('SELECT id FROM contacts WHERE lower(email)=lower(?)',(email,)).fetchone()
        if existing: return {'id':existing['id'],'existing':True}
        result=db.execute('INSERT INTO contacts(name,email,notes) VALUES(?,?,?)',
            (message['senderName'] or email,email,f"Imported by user from Gmail message {message_id}: {message['subject']}. {message['provenance']}"))
        return {'id':result.lastrowid,'existing':False}


async def scheduled_sync():
    import asyncio
    while True:
        await asyncio.sleep(60)
        if google.LOCK.locked(): continue
        try:
            data=google.load()
            interval=60 if data.get('mailPage') else 900
            if data.get('token') and data.get('autoSync') and time.time()-data.get('lastSyncAttempt',0)>=interval:
                await synchronize()
        except HTTPException:
            pass  # synchronize stores the actionable error in connection status
