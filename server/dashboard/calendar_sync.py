"""Google primary-calendar cache. Reading does not alter interview records."""
import json
import secrets
import time
from datetime import datetime, timezone
from urllib.parse import quote
from pydantic import BaseModel, Field
import httpx
from fastapi import APIRouter, HTTPException, Query
from . import google_connection as google, store

router=APIRouter(prefix='/api/calendar/google')


async def request(data,method,path,**kwargs):
    """Caller holds Google's connection lock; resource paths are internal."""
    if google.CALENDAR_SCOPE not in str(data.get('token',{}).get('scope','')).split():
        raise HTTPException(409,'Connect Google with calendar access first')
    if data['token'].get('expires_at',0)<time.time()+60: await google.refresh(data)
    extra_headers=kwargs.pop('headers',{})
    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                result=await client.request(method,'https://www.googleapis.com/calendar/v3/'+path,
                    headers={'Authorization':'Bearer '+data['token']['access_token'],**extra_headers},**kwargs)
        except httpx.HTTPError:
            raise HTTPException(502,'Google Calendar connection interrupted. Retry; exports retain the same event ID.') from None
        if result.status_code==401 and attempt==0:
            await google.refresh(data)
            continue
        return result


async def sync(data):
    cursor=data.get('calendarCursor',{})
    generation=cursor.get('generation') or secrets.token_hex(16)
    params={'maxResults':250,'singleEvents':'false','showDeleted':'true'}
    if cursor.get('syncToken'): params['syncToken']=cursor['syncToken']
    if cursor.get('pageToken'): params['pageToken']=cursor['pageToken']
    result=await request(data,'GET','calendars/primary/events',params=params)
    if result.status_code==410 and cursor.get('syncToken'):
        data.pop('calendarCursor',None)
        google.save(data)
        # Keep reviewed local interviews; rebuild only the provider cache.
        return await sync(data)
    if result.status_code!=200:
        raise HTTPException(502,f'Google Calendar returned HTTP {result.status_code}; retry synchronization')
    batch=result.json()
    if not batch.get('nextPageToken') and not batch.get('nextSyncToken'):
        raise HTTPException(502,'Google Calendar omitted its synchronization cursor')
    with store.db() as db:
        for item in batch.get('items',[]):
            db.execute('INSERT INTO calendar_events(id,payload,generation) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,generation=excluded.generation',
                (item['id'],json.dumps(item),generation))
        if not cursor.get('syncToken') and not batch.get('nextPageToken'):
            db.execute('DELETE FROM calendar_events WHERE generation!=?',(generation,))
    if batch.get('nextPageToken'):
        data['calendarCursor']={**cursor,'generation':generation,'pageToken':batch['nextPageToken']}
    else:
        data['calendarCursor']={'syncToken':batch['nextSyncToken']}
        data['calendarLastSync']=time.time()
    data['calendarError']=''
    google.save(data)
    return {'pending':bool(batch.get('nextPageToken')),'read':len(batch.get('items',[]))}


@router.post('/sync')
async def synchronize():
    async with google.LOCK:
        data=google.load()
        try: return await sync(data)
        except Exception as err:
            data['calendarError']=str(err.detail) if isinstance(err,HTTPException) else 'Calendar synchronization failed; retry this batch.'
            google.save(data)
            if isinstance(err,HTTPException): raise
            raise HTTPException(502,data['calendarError']) from None


@router.get('')
async def events():
    data=google.load()
    with store.db() as db:
        items=[json.loads(row['payload']) for row in db.execute('SELECT payload FROM calendar_events ORDER BY id')]
    return {'events':items,'pending':bool(data.get('calendarCursor',{}).get('pageToken')),
        'lastSync':data.get('calendarLastSync'),'error':data.get('calendarError',''),
        'connected':google.CALENDAR_SCOPE in str(data.get('token',{}).get('scope','')).split()}


class ImportIn(BaseModel):
    applicationId: int
    etag: str = Field(min_length=1,max_length=1000)


@router.get('/events/{event_id}/instances')
async def instances(event_id: str,start: float=Query(gt=0,lt=32500000000),
                    end: float=Query(gt=0,lt=32503680000),page: str=Query(default='',max_length=4000)):
    if not 0<end-start<=366*86400:
        raise HTTPException(400,'Choose an occurrence range of at most one year')
    async with google.LOCK:
        data=google.load()
        iso=lambda value: datetime.fromtimestamp(value,timezone.utc).isoformat()
        params={'timeMin':iso(start),'timeMax':iso(end),'showDeleted':'true','maxResults':50}
        if page: params['pageToken']=page
        result=await request(data,'GET','calendars/primary/events/'+quote(event_id,safe='')+'/instances',params=params)
        if result.status_code!=200: raise HTTPException(502,'Could not load calendar occurrences; retry this range')
        batch=result.json()
        return {'events':batch.get('items',[]),'page':batch.get('nextPageToken','')}


def event_time(value):
    try:
        parsed=datetime.fromisoformat(value['dateTime'].replace('Z','+00:00'))
        if parsed.tzinfo is None:
            from zoneinfo import ZoneInfo
            parsed=parsed.replace(tzinfo=ZoneInfo(value['timeZone']))
        return parsed.timestamp()
    except (KeyError,ValueError):
        raise HTTPException(400,'Choose a timed event or occurrence; all-day dates need a time before import') from None


@router.post('/events/{event_id}/import')
async def import_event(event_id: str,body: ImportIn):
    async with google.LOCK:
        data=google.load()
        result=await request(data,'GET','calendars/primary/events/'+quote(event_id,safe=''))
        if result.status_code!=200: raise HTTPException(502,'Could not read this Google event')
        item=result.json()
        if item.get('etag')!=body.etag: raise HTTPException(409,'Event changed in Google. Refresh and review it again.')
        if item.get('recurrence'): raise HTTPException(400,'Choose an individual occurrence of this recurring event')
        from .app import _idle_application
        _idle_application(body.applicationId)
        account=data['account']
        with store.db() as db:
            link=db.execute('SELECT * FROM calendar_links WHERE account=? AND event_id=?',(account,event_id)).fetchone()
            if link:
                old=db.execute('SELECT * FROM interviews WHERE id=?',(link['interview_id'],)).fetchone()
                if old['application_id']!=body.applicationId: raise HTTPException(409,'This event is already linked to another application')
                if link['etag']==body.etag: return {'id':old['id'],'existing':True}
            cancelled=item.get('status')=='cancelled'
            if cancelled and not link: raise HTTPException(400,'A cancelled event cannot create an interview')
            if cancelled:
                db.execute("UPDATE interviews SET outcome='cancelled' WHERE id=?",(old['id'],))
                interview_id=old['id']
            else:
                start=event_time(item.get('start',{}));end=event_time(item.get('end',{}))
                from .tracking import InterviewIn
                if not 300<=end-start<=86400: raise HTTPException(400,'Interview duration must be between 5 minutes and 24 hours')
                values=InterviewIn(starts_at=start,minutes=round((end-start)/60),kind=(item.get('summary') or 'Interview')[:200],
                    location=item.get('location','')[:2000],notes=('Imported from Google Calendar: '+event_id+'\n'+item.get('description',''))[:20000])
                if link:
                    db.execute('UPDATE interviews SET starts_at=?,minutes=?,kind=?,location=? WHERE id=?',
                        (values.starts_at,values.minutes,values.kind,values.location,old['id']))
                    interview_id=old['id']
                else:
                    cur=db.execute('INSERT INTO interviews(application_id,starts_at,minutes,kind,location,notes,outcome) VALUES(?,?,?,?,?,?,?)',
                        (body.applicationId,values.starts_at,values.minutes,values.kind,values.location,values.notes,'scheduled'))
                    interview_id=cur.lastrowid
            db.execute("INSERT INTO calendar_links(account,event_id,interview_id,etag,direction) VALUES(?,?,?,?, 'import') ON CONFLICT(account,event_id) DO UPDATE SET etag=excluded.etag",
                (account,event_id,interview_id,body.etag))
            db.execute('INSERT INTO application_events(application_id,kind,text,created_at) VALUES(?,?,?,?)',
                (body.applicationId,'calendar','Google Calendar event '+event_id+': '+('cancellation' if cancelled else 'schedule')+' reviewed and imported',time.time()))
        return {'id':interview_id}


@router.post('/interviews/{interview_id}/export')
async def export_interview(interview_id: int):
    async with google.LOCK:
        data=google.load()
        if not data.get('account'): raise HTTPException(409,'Connect Google first')
        with store.db() as db:
            item=db.execute('SELECT i.*,a.company FROM interviews i JOIN applications a ON a.id=i.application_id WHERE i.id=?',(interview_id,)).fetchone()
            if not item: raise HTTPException(404,'No such interview')
            from .app import _idle_application
            _idle_application(item['application_id'])
            imported=db.execute("SELECT * FROM calendar_links WHERE account=? AND interview_id=? AND direction='import'",(data['account'],interview_id)).fetchone()
            if imported: raise HTTPException(409,'This interview came from Google. Edit its original event in Google, then import the update.')
            link=db.execute("SELECT * FROM calendar_links WHERE account=? AND interview_id=? AND direction='export'",(data['account'],interview_id)).fetchone()
            if not link:
                event_id='f'+secrets.token_hex(20)
                db.execute("INSERT INTO calendar_links(account,event_id,interview_id,direction) VALUES(?,?,?,'export')",(data['account'],event_id,interview_id))
            else: event_id=link['event_id']
        # Persist the chosen ID before network I/O, so a lost response is retryable.
        path='calendars/primary/events/'+event_id
        current=await request(data,'GET',path)
        iso=lambda stamp: datetime.fromtimestamp(stamp,timezone.utc).isoformat()
        payload={'summary':item['company']+' · '+item['kind'],'location':item['location'],
            'start':{'dateTime':iso(item['starts_at'])},'end':{'dateTime':iso(item['starts_at']+item['minutes']*60)},
            'extendedProperties':{'private':{'formworkInterview':str(interview_id)}}}
        if current.status_code==404:
            if link and link['etag']: raise HTTPException(409,'The exported event was removed from Google; it will not be recreated automatically')
            if item['outcome']=='cancelled': raise HTTPException(409,'A cancelled interview cannot create a calendar event')
            result=await request(data,'POST','calendars/primary/events',params={'sendUpdates':'none'},json={'id':event_id,**payload})
        elif current.status_code==200:
            remote=current.json()
            if remote.get('extendedProperties',{}).get('private',{}).get('formworkInterview')!=str(interview_id):
                raise HTTPException(409,'This calendar event is not owned by this Formwork interview')
            if remote.get('attendees') or remote.get('recurrence'):
                raise HTTPException(409,'This event now has guests or recurrence. Edit it in Google Calendar.')
            if link and link['etag'] and remote.get('etag')!=link['etag']:
                raise HTTPException(409,'Event changed in Google. Import the reviewed Google update before making further changes.')
            if item['outcome']=='cancelled': payload['status']='cancelled'
            result=await request(data,'PATCH',path,params={'sendUpdates':'none'},headers={'If-Match':remote['etag']},json=payload)
        else: raise HTTPException(502,'Could not check the exported Google event')
        if result.status_code in {409,412}: raise HTTPException(409,'Google event changed during export; refresh and retry')
        if result.status_code not in {200,201}: raise HTTPException(502,'Calendar export failed; retry uses the same event ID')
        saved=result.json()
        with store.db() as db:
            db.execute('UPDATE calendar_links SET etag=? WHERE account=? AND event_id=?',(saved['etag'],data['account'],event_id))
            db.execute('INSERT INTO application_events(application_id,kind,text,created_at) VALUES(?,?,?,?)',
                (item['application_id'],'calendar','Interview explicitly exported to Google Calendar: '+event_id,time.time()))
        return {'id':event_id,'url':saved.get('htmlLink','')}
