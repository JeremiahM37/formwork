import unittest
from unittest.mock import patch
import test_google_inbox as fixtures
response=fixtures.response
from dashboard import calendar_sync, google_connection as google, store


class CalendarTests(unittest.TestCase):
    connected=fixtures.GoogleInboxTests.connected
    def setUp(self):
        fixtures.GoogleInboxTests.setUp(self)
        with store.db() as db: db.execute('DELETE FROM calendar_events')

    def test_calendar_requires_separate_consent(self):
        self.connected()
        self.assertEqual(self.client.post('/api/calendar/google/sync').status_code,409)
        started=self.client.post('/api/connections/google/authorize?calendar=true')
        self.assertEqual(started.status_code,200)
        self.assertIn(google.CALENDAR_SCOPE,google.load()['pending']['scopes'])

    def test_pages_replay_updates_and_expired_cursor(self):
        self.connected()
        async def initial(data,method,path,**kw):
            params=kw['params']
            if params.get('pageToken')=='page2':
                return response({'items':[{'id':'two','summary':'Interview'}],'nextSyncToken':'sync1'})
            return response({'items':[{'id':'one','summary':'Old'}],'nextPageToken':'page2'})
        with patch.object(calendar_sync,'request',side_effect=initial):
            self.assertTrue(self.client.post('/api/calendar/google/sync').json()['pending'])
            self.assertNotIn('syncToken',google.load()['calendarCursor'])
            self.assertFalse(self.client.post('/api/calendar/google/sync').json()['pending'])
        async def fail(*args,**kw): raise RuntimeError('network fixture')
        with patch.object(calendar_sync,'request',side_effect=fail):
            self.assertEqual(self.client.post('/api/calendar/google/sync').status_code,502)
        self.assertEqual(google.load()['calendarCursor'],{'syncToken':'sync1'})
        async def incremental(data,method,path,**kw):
            self.assertEqual(kw['params']['syncToken'],'sync1')
            return response({'items':[{'id':'two','status':'cancelled'}],'nextSyncToken':'sync2'})
        with patch.object(calendar_sync,'request',side_effect=incremental):
            self.assertEqual(self.client.post('/api/calendar/google/sync').status_code,200)
        items=self.client.get('/api/calendar/google').json()['events']
        self.assertEqual(next(x for x in items if x['id']=='two')['status'],'cancelled')
        async def expired(data,method,path,**kw):
            if kw['params'].get('syncToken'): return response({},410)
            return response({'items':[{'id':'new','start':{'date':'2026-09-09'}}],'nextSyncToken':'sync3'})
        with patch.object(calendar_sync,'request',side_effect=expired):
            self.assertEqual(self.client.post('/api/calendar/google/sync').status_code,200)
        self.assertEqual([x['id'] for x in self.client.get('/api/calendar/google').json()['events']],['new'])
        with store.db() as db: self.assertEqual(db.execute('SELECT count(*) FROM interviews').fetchone()[0],0)

    def test_review_import_is_idempotent_timezone_correct_and_rejects_stale(self):
        self.connected()
        item={'id':'event1','etag':'v1','summary':'Technical','start':{'dateTime':'2026-09-09T10:00:00-06:00'},'end':{'dateTime':'2026-09-09T11:00:00-06:00'}}
        async def get(*args,**kw): return response(item)
        with patch.object(calendar_sync,'request',side_effect=get):
            body={'applicationId':self.application['id'],'etag':'v1'}
            first=self.client.post('/api/calendar/google/events/event1/import',json=body)
            self.assertEqual(first.status_code,200,first.text)
            again=self.client.post('/api/calendar/google/events/event1/import',json=body)
            self.assertTrue(again.json()['existing'])
            item['etag']='v2'
            self.assertEqual(self.client.post('/api/calendar/google/events/event1/import',json=body).status_code,409)
            body['etag']='v2';item['status']='cancelled'
            self.assertEqual(self.client.post('/api/calendar/google/events/event1/import',json=body).status_code,200)
        with store.db() as db:
            rows=db.execute('SELECT * FROM interviews').fetchall()
            self.assertEqual(len(rows),1);self.assertEqual(rows[0]['minutes'],60);self.assertEqual(rows[0]['outcome'],'cancelled')
            from datetime import datetime,timezone
            self.assertEqual(datetime.fromtimestamp(rows[0]['starts_at'],timezone.utc).hour,16)

    def test_export_retry_keeps_id_and_refuses_remote_conflict(self):
        self.connected()
        added=self.client.post(f"/api/applications/{self.application['id']}/interviews",json={'starts_at':1788800000,'kind':'Technical'}).json()
        path=f"/api/calendar/google/interviews/{added['id']}/export"
        remote={};ids=[]
        async def server(data,method,resource,**kw):
            if method=='GET': return response(remote,200 if remote else 404)
            if method=='POST':
                ids.append(kw['json']['id']);remote.update(kw['json'],etag='v1')
                self.assertNotIn('attendees',kw['json']);self.assertEqual(kw['params']['sendUpdates'],'none')
                raise RuntimeError('response lost after insertion')
            self.assertEqual(kw['headers']['If-Match'],'v1')
            remote.update(kw['json'],etag='v2');return response(remote)
        # A transport interruption can bubble through TestClient; the stable ID
        # must already be committed regardless of HTTP error presentation.
        with patch.object(calendar_sync,'request',side_effect=server):
            with self.assertRaises(RuntimeError): self.client.post(path)
            retry=self.client.post(path);self.assertEqual(retry.status_code,200,retry.text)
            self.assertEqual(len(ids),1);self.assertEqual(retry.json()['id'],ids[0])
            remote['etag']='edited-outside'
            self.assertEqual(self.client.post(path).status_code,409)

    def test_occurrences_preserve_provider_ids_and_range_across_pages(self):
        self.connected()
        async def provider(data,method,path,**kw):
            self.assertEqual(path,'calendars/primary/events/series%2B1/instances')
            self.assertEqual(kw['params']['timeMin'],'2026-09-07T00:00:00+00:00')
            self.assertEqual(kw['params']['pageToken'],'next')
            return response({'items':[{'id':'occurrence','recurringEventId':'series+1','originalStartTime':{'dateTime':'2026-09-09T10:00:00-06:00'}}]})
        with patch.object(calendar_sync,'request',side_effect=provider):
            result=self.client.get('/api/calendar/google/events/series%2B1/instances',params={'start':1788739200,'end':1788825600,'page':'next'})
            self.assertEqual(result.status_code,200,result.text)
            self.assertEqual(result.json()['events'][0]['id'],'occurrence')
        self.assertEqual(self.client.get('/api/calendar/google/events/x/instances',params={'start':1,'end':40000000}).status_code,400)

    def test_transport_failure_has_actionable_retry_message(self):
        import asyncio,httpx,time
        data={'token':{'scope':google.CALENDAR_SCOPE,'access_token':'fixture','expires_at':time.time()+3600}}
        with patch.object(httpx.AsyncClient,'request',side_effect=httpx.ConnectError('offline')):
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(calendar_sync.request(data,'POST','calendars/primary/events',json={}))
        self.assertEqual(caught.exception.status_code,502)
        self.assertIn('same event ID',caught.exception.detail)
