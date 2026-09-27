import hashlib
import json
import logging
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs,urlsplit
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
import _state
import httpx
from fastapi.testclient import TestClient
from dashboard import app, google_connection as google, inbox, store

CONFIG={'clientId':'fixture.apps.googleusercontent.com','clientSecret':'private-fixture-secret','redirectUri':'https://formwork.test/api/connections/google/callback'}
def response(data,status=200): return httpx.Response(status,json=data,request=httpx.Request('GET','https://gmail.googleapis.com/fixture'))
def message(id='abc',subject='Fixture interview invitation',sender='Recruiter <recruiter@example.test>'):
    return {'id':id,'internalDate':'1788800000000','snippet':'An interview for your application at Fixture.',
        'payload':{'headers':[{'name':'Subject','value':subject},{'name':'From','value':sender}]}}


class GoogleInboxTests(unittest.TestCase):
    def setUp(self):
        self.work=tempfile.TemporaryDirectory();self.addCleanup(self.work.cleanup)
        self.patch=patch.object(google,'PRIVATE',Path(self.work.name)/'connections/google.json');self.patch.start();self.addCleanup(self.patch.stop)
        app.PROGRESS.clear()
        with store.db() as db:
            db.execute('DELETE FROM inbox_messages');db.execute('DELETE FROM applications');db.execute('DELETE FROM contacts')
        self.client=TestClient(app.app,base_url='https://formwork.test')
        self.application=store.upsert_application({'url':'https://jobs.test/1','company':'Fixture','title':'Engineer'})

    def connected(self,**extra):
        google.save({'config':CONFIG,'account':'candidate@example.test','token':{'access_token':'private-access','refresh_token':'private-refresh','scope':google.GMAIL_SCOPE,'expires_at':time.time()+3600},**extra})

    def test_oauth_configuration_private_storage_pkce_and_cookie_binding(self):
        result=self.client.post('/api/connections/google/config',json=CONFIG);self.assertEqual(result.status_code,200,result.text)
        self.assertNotIn(CONFIG['clientSecret'],result.text);self.assertEqual(google.PRIVATE.stat().st_mode & 0o777,0o600)
        self.assertEqual(google.PRIVATE.parent.stat().st_mode & 0o777,0o700)
        started=self.client.post('/api/connections/google/authorize');self.assertEqual(started.status_code,200,started.text)
        query=parse_qs(urlsplit(started.json()['url']).query)
        self.assertEqual(query['scope'],[google.GMAIL_SCOPE]);self.assertEqual(query['code_challenge_method'],['S256'])
        self.assertEqual(query['access_type'],['offline']);self.assertIn('HttpOnly',started.headers['set-cookie'])
        state=query['state'][0]
        stranger=TestClient(app.app,base_url='https://formwork.test')
        self.assertEqual(stranger.get(google.CALLBACK,params={'state':state,'code':'stolen'}).status_code,400)
        self.assertIn('pending',google.load())
        denied=self.client.get(google.CALLBACK,params={'state':state,'error':'access_denied'},follow_redirects=False)
        self.assertEqual(denied.status_code,303);self.assertNotIn('pending',google.load());self.assertFalse(google.public(google.load())['connected'])
        self.assertEqual(self.client.get(google.CALLBACK,params={'state':state,'code':'replay'}).status_code,400)

    def test_successful_callback_checks_mailbox_and_never_exposes_tokens(self):
        self.client.post('/api/connections/google/config',json=CONFIG)
        self.client.post('/api/connections/google/authorize');pending=google.load()['pending']
        oauth=AsyncMock();oauth.__aenter__.return_value=oauth
        oauth.fetch_token.return_value={'access_token':'private-access','refresh_token':'private-refresh','scope':google.GMAIL_SCOPE,'expires_at':time.time()+3600}
        client=AsyncMock();client.__aenter__.return_value=client;client.get.return_value=response({'emailAddress':'candidate@example.test'})
        with patch.object(google,'oauth',return_value=oauth),patch.object(google.httpx,'AsyncClient',return_value=client):
            result=self.client.get(google.CALLBACK,params={'state':pending['state'],'code':'private-code'},follow_redirects=False)
        self.assertEqual(result.status_code,303)
        self.assertEqual(oauth.fetch_token.await_args.kwargs['code_verifier'],pending['verifier'])
        status=self.client.get('/api/connections/google').json();self.assertTrue(status['connected']);self.assertEqual(status['account'],'candidate@example.test')
        self.assertNotIn('private-',json.dumps(status));self.assertNotIn('token',json.dumps(status))
        record=logging.LogRecord('uvicorn.access',20,'x',1,'%s %s %s %s %s',('client','GET',google.CALLBACK+'?code=private-code','1.1',303),None)
        google.RedactOAuthCallback().filter(record);self.assertNotIn('private-code',record.getMessage())

    def test_initial_pagination_incremental_addition_and_deletion(self):
        self.connected()
        calls=[]
        async def api(data,path,params=None):
            calls.append((path,params))
            if path=='profile': return response({'historyId':'100'})
            if path=='messages': return response({'messages':[{'id':'abc'}],'nextPageToken':'page2'}) if not params.get('pageToken') else response({'messages':[{'id':'def'}]})
            if path=='history': return response({'historyId':'200','history':[{'messagesDeleted':[{'message':{'id':'abc'}}],'messagesAdded':[{'message':{'id':'ghi'}}]}]})
            return response(message(path.split('/')[-1]))
        with patch.object(google,'google_get',side_effect=api):
            first=self.client.post('/api/inbox/sync');self.assertEqual(first.status_code,200,first.text);self.assertTrue(first.json()['pending']);self.assertNotIn('historyId',google.load())
            second=self.client.post('/api/inbox/sync');self.assertFalse(second.json()['pending']);self.assertEqual(google.load()['historyId'],'100')
            third=self.client.post('/api/inbox/sync');self.assertEqual(third.status_code,200,third.text)
        listing=self.client.get('/api/inbox').json();self.assertEqual({m['id'] for m in listing['messages']},{'def','ghi'})
        self.assertEqual(google.load()['historyId'],'200');self.assertEqual(listing['messages'][0]['candidates'][0]['id'],self.application['id'])
        detail=next(params for path,params in calls if path=='messages/abc');self.assertEqual(detail['fields'],'id,internalDate,snippet,payload(headers)')
        self.assertEqual(store.get_application(self.application['id'])['status'],'queued')

    def test_failed_page_preserves_cursor_and_retry_is_idempotent(self):
        self.connected(historyId='100')
        batch=response({'historyId':'200','history':[{'messagesAdded':[{'message':{'id':'abc'}},{'message':{'id':'def'}}]}]})
        with patch.object(google,'google_get',side_effect=[batch,response(message()),response({},503)]):
            result=self.client.post('/api/inbox/sync');self.assertEqual(result.status_code,502)
        self.assertEqual(google.load()['historyId'],'100');self.assertEqual(self.client.get('/api/inbox').json()['count'],0)
        for _ in range(2):
            with patch.object(google,'google_get',side_effect=[batch,response(message()),response(message('def'))]):
                self.assertEqual(self.client.post('/api/inbox/sync').status_code,200)
        self.assertEqual(self.client.get('/api/inbox').json()['count'],2)

    def test_expired_history_rescans_job_archive_and_marks_missing_messages(self):
        self.connected(historyId='expired')
        with store.db() as db: db.execute('INSERT INTO inbox_messages(id,payload,received_at) VALUES(?,?,?)',('old',json.dumps(inbox.decode_message(message('old'))),1))
        with patch.object(google,'google_get',side_effect=[response({},404),response({'historyId':'new'}),response({'messages':[{'id':'abc'}]}),response(message())]) as api:
            result=self.client.post('/api/inbox/sync');self.assertEqual(result.status_code,200,result.text)
        self.assertNotIn('newer_than',api.await_args_list[2].args[2]['q'])
        self.assertEqual(google.load()['historyId'],'new');self.assertEqual(self.client.get('/api/inbox').json()['count'],1)

    def test_reviews_and_contact_import_are_explicit_idempotent_local_writes(self):
        self.connected()
        payload=inbox.decode_message(message())
        with store.db() as db: db.execute('INSERT INTO inbox_messages(id,payload,received_at) VALUES(?,?,?)',('abc',json.dumps(payload),1))
        self.assertEqual(self.client.post('/api/inbox/abc/contact').status_code,200)
        self.assertTrue(self.client.post('/api/inbox/abc/contact').json()['existing'])
        body={'action':'link','applicationId':self.application['id'],'status':'interview'}
        for _ in range(2): self.assertEqual(self.client.post('/api/inbox/abc/review',json=body).status_code,200)
        with store.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM application_events WHERE application_id=?',(self.application['id'],)).fetchone()[0],1)
            self.assertEqual(db.execute('SELECT count(*) FROM contacts').fetchone()[0],1)
            self.assertIn('not independently verified',db.execute('SELECT notes FROM contacts').fetchone()[0])
        self.assertEqual(store.get_application(self.application['id'])['status'],'interview')
        self.assertEqual(self.client.get('/api/inbox').json()['count'],0)

    def test_disconnect_removes_local_access_even_if_revocation_is_unreachable(self):
        self.connected(mailPage={'page':'next'},pending={'state':'old'})
        with store.db() as db: db.execute('INSERT INTO inbox_messages(id,payload,received_at) VALUES(?,?,?)',('abc','{}',1))
        client=AsyncMock();client.__aenter__.return_value=client;client.post.side_effect=httpx.ConnectError('offline')
        with patch.object(google.httpx,'AsyncClient',return_value=client):
            result=self.client.post('/api/connections/google/disconnect')
        self.assertFalse(result.json()['revoked']);self.assertNotIn('token',google.load());self.assertNotIn('pending',google.load())
        self.assertEqual(self.client.get('/api/inbox').json()['count'],0)
        self.assertEqual(self.client.post('/api/inbox/sync').status_code,409)

    def test_insecure_callbacks_and_wrong_start_hosts_are_rejected(self):
        for uri in ['http://public.test'+google.CALLBACK,'https://formwork.test'+google.CALLBACK+'?x=1','https://formwork.homelab.internal'+google.CALLBACK,'https://203.0.113.1'+google.CALLBACK]:
            self.assertEqual(self.client.post('/api/connections/google/config',json={**CONFIG,'redirectUri':uri}).status_code,422)
        self.client.post('/api/connections/google/config',json=CONFIG)
        client=TestClient(app.app,base_url='https://wrong.test')
        self.assertEqual(client.post('/api/connections/google/authorize').status_code,409)


    def test_expired_access_refresh_and_one_401_retry_preserve_refresh_token(self):
        import asyncio
        self.connected()
        data=google.load()
        oauth=AsyncMock();oauth.__aenter__.return_value=oauth
        oauth.refresh_token.return_value={'access_token':'new-private-access','expires_at':time.time()+3600}
        client=AsyncMock();client.__aenter__.return_value=client
        client.get.side_effect=[response({},401),response({'historyId':'200'})]
        with patch.object(google,'oauth',return_value=oauth),patch.object(google.httpx,'AsyncClient',return_value=client):
            result=asyncio.run(google.google_get(data,'profile'))
        self.assertEqual(result.status_code,200);oauth.refresh_token.assert_awaited_once()
        self.assertEqual(google.load()['token']['refresh_token'],'private-refresh')
        self.assertEqual(client.get.await_args_list[-1].kwargs['headers']['Authorization'],'Bearer new-private-access')

    def test_revoked_grant_fails_visibly_without_leaking_provider_details(self):
        self.connected();data=google.load();data['token']['expires_at']=0;google.save(data)
        oauth=AsyncMock();oauth.__aenter__.return_value=oauth;oauth.refresh_token.side_effect=ValueError('private-refresh-token-detail')
        with patch.object(google,'oauth',return_value=oauth):
            result=self.client.post('/api/inbox/sync')
        self.assertEqual(result.status_code,409);self.assertIn('Connect again',result.text)
        self.assertNotIn('private-refresh',result.text)
        self.assertNotIn('private-refresh',self.client.get('/api/connections/google').text)


    def test_incremental_body_only_job_match_uses_exact_message_id_and_decodes_headers(self):
        self.connected(historyId='100')
        raw=message('abc',subject='=?utf-8?b?Q2Fmw6k=?=',sender='=?utf-8?b?Sm9zw6k=?= <recruiter@example.test>')
        raw['snippet']='Details are attached.'
        raw['payload']['headers'].append({'name':'Message-ID','value':'<abc@example.test>'})
        batch=response({'historyId':'200','history':[{'messagesAdded':[{'message':{'id':'abc'}}]}]})
        with patch.object(google,'google_get',side_effect=[batch,response(raw),response({'messages':[{'id':'abc'}]})]) as api:
            result=self.client.post('/api/inbox/sync');self.assertEqual(result.status_code,200,result.text)
        self.assertTrue(api.await_args_list[-1].args[2]['q'].endswith('rfc822msgid:abc@example.test'))
        imported=self.client.get('/api/inbox').json()['messages'][0]
        self.assertEqual(imported['subject'],'Café');self.assertEqual(imported['senderName'],'José')

    def test_real_oauth_client_serializes_code_verifier_and_refresh_grants(self):
        import asyncio
        from urllib.parse import parse_qs
        bodies=[]
        def transport(request):
            bodies.append(parse_qs(request.content.decode()))
            return httpx.Response(200,json={'access_token':'wire-fixture','refresh_token':'wire-refresh','token_type':'Bearer','expires_in':3600,'scope':google.GMAIL_SCOPE})
        async def exchange():
            async with google.oauth(CONFIG,scope=google.GMAIL_SCOPE,transport=httpx.MockTransport(transport)) as client:
                token=await client.fetch_token(google.TOKEN,code='wire-code',code_verifier='v'*64,grant_type='authorization_code')
                self.assertGreater(token['expires_at'],time.time())
                await client.refresh_token(google.TOKEN,refresh_token=token['refresh_token'])
        asyncio.run(exchange())
        self.assertEqual(bodies[0]['client_secret'],[CONFIG['clientSecret']])
        self.assertEqual(bodies[0]['redirect_uri'],[CONFIG['redirectUri']])
        self.assertEqual(bodies[0]['code_verifier'],['v'*64])
        self.assertEqual(bodies[1]['grant_type'],['refresh_token']);self.assertEqual(bodies[1]['refresh_token'],['wire-refresh'])
