"""Real SQLite/API round trips; all state lives in the suite's temporary directory."""
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import _state
from dashboard import store, matching
try:
    from fastapi.testclient import TestClient
    from dashboard.app import app
    HAVE_API = True
except ImportError:
    HAVE_API = False


class MatchingTests(unittest.TestCase):
    def test_empty_or_unknown_vocabulary_is_unknown(self):
        for posting in ['', 'Build delightful customer experiences.']:
            self.assertIsNone(matching.fit(posting, {})['coverage'])

    def test_names_and_javascript_do_not_supply_java_or_c(self):
        result = matching.fit('JavaScript with PostgreSQL and Kubernetes', {'identity': {'full_name': 'Kubernetes Smith'}, 'skills':['JavaScript', 'Postgres']})
        self.assertEqual([m['skill'] for m in result['missing']], ['Kubernetes'])
        self.assertEqual(result['coverage'], 67)
        self.assertNotIn('Java', [m['skill'] for m in result['matched']])

    def test_go_ordinary_verb_is_not_evidence(self):
        self.assertEqual(matching.fit('We go fast and rest well', {})['recognized'], 0)


@unittest.skipUnless(HAVE_API, 'FastAPI not installed')
class TrackingTests(unittest.TestCase):
    def setUp(self):
        store.init()
        with store.db() as db:
            db.execute('DELETE FROM applications')
            db.execute('DELETE FROM contacts')
            db.execute('DELETE FROM saved_views')
        self.client = TestClient(app)
        self.record = self.client.post('/api/applications', json={'url':'https://example.test/jobs/1', 'company':'Example', 'title':'Engineer', 'description':'Python and Kubernetes'}).json()
        self.base = f"/api/applications/{self.record['id']}"

    def test_pipeline_history_survives_rereads_and_records_denominator(self):
        self.assertIsNone(self.client.get('/api/analytics').json()['responseRate'])
        for stage in ['submitted', 'interview', 'rejected']:
            self.assertEqual(self.client.post(self.base+'/status', json={'status':stage}).status_code,200)
        events = self.client.get(self.base+'/timeline').json()['events']
        self.assertTrue(any('interview → rejected' == e['text'] for e in events))
        analytics = self.client.get('/api/analytics').json()
        self.assertEqual((analytics['submitted'],analytics['responses'],analytics['responseRate']),(1,1,100.0))
        self.assertEqual(self.client.post(self.base+'/status',json={'status':'invented'}).status_code,400)

    def test_capture_keeps_source_and_existing_posting(self):
        result = self.client.post('/api/applications', json={'url':self.record['url'], 'source':'extension'}).json()
        self.assertEqual(result['snapshot']['source'], 'extension')
        self.assertEqual(result['snapshot']['posting'], 'Python and Kubernetes')
        result = self.client.post('/api/applications', json={'url':self.record['url']}).json()
        self.assertEqual(result['snapshot']['source'], 'extension')

    def test_calendar_round_trip_and_injection(self):
        body = {'starts_at':1800000000, 'kind':'Technical', 'interviewer':'A\nBEGIN:VEVENT', 'location':'Remote, Zoom', 'notes':'你好'*70}
        result = self.client.post(self.base+'/interviews',json=body)
        self.assertEqual(result.status_code,200,result.text)
        interview = result.json()
        calendar = self.client.get('/api/calendar.ics').text
        self.assertEqual(calendar.count('\r\nBEGIN:VEVENT\r\n'),1)
        self.assertIn('Remote\\, Zoom',calendar)
        self.assertTrue(all(len(line.encode())<=75 for line in calendar.split('\r\n')))
        self.assertEqual(self.client.put(f"/api/interviews/{interview['id']}",json={**body,'outcome':'passed'}).status_code,200)
        self.assertEqual(self.client.get('/api/tracking').json()['interviews'][0]['outcome'],'passed')

    def test_reminder_contact_link_and_cascade(self):
        reminder = self.client.post(self.base+'/reminders',json={'text':'Follow up','due_at':time.time()-10}).json()
        self.assertEqual(self.client.get('/api/analytics').json()['overdue'],1)
        self.client.post(f"/api/reminders/{reminder['id']}/complete")
        self.assertEqual(self.client.get('/api/analytics').json()['overdue'],0)
        contact=self.client.post('/api/contacts',json={'name':'Sam','company':'Example'}).json()
        self.client.post(f"/api/contacts/{contact['id']}/interactions",json={'text':'Referral offered','application_id':self.record['id']})
        self.client.delete(self.base)
        self.assertEqual(self.client.get('/api/tracking').json()['reminders'],[])
        self.assertIsNone(self.client.get('/api/contacts').json()['interactions'][0]['application_id'])

    def test_views_and_csv_escape(self):
        self.client.post('/api/views',json={'name':'Open','filters':{'stage':'ready'}})
        self.client.post('/api/views',json={'name':'Open','filters':{'stage':'submitted'}})
        self.assertEqual(len(self.client.get('/api/views').json()['views']),1)
        store.update_application(self.record['id'],title='=WEBSERVICE("https://bad.test")')
        self.assertIn("'=WEBSERVICE",self.client.get('/api/export/applications.csv').text)
        self.assertEqual(self.client.post('/api/applications',json={'url':'javascript:alert(1)'}).status_code,400)

    def test_revised_letter_compiles_exact_approved_text_and_upload_failure_is_visible(self):
        from dashboard import app as dashboard
        path = Path(_state.STATE_DIR)/'approved.pdf'; path.write_bytes(b'%PDF-1.4')
        store.update_application(self.record['id'],status='ready')
        with patch.object(dashboard.resume_mod,'cover_letter_pdf',return_value=path) as compile_pdf, patch.object(dashboard.browser,'run',new=AsyncMock(return_value={'ok':False,'reason':'upload missing'})):
            response = self.client.post(self.base+'/cover/approve',json={'text':'I built a Python service.'})
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(compile_pdf.call_args.args[0],'I built a Python service.')
            self.assertFalse(response.json()['attachment']['ok'])
        with patch.object(dashboard.browser,'run',new=AsyncMock()) as browser:
            self.assertEqual(self.client.post(self.base+'/submit').status_code,409)
            browser.assert_not_called()

    def test_outcome_tracking_cannot_resubmit_or_overwrite_sent_answers(self):
        from dashboard import app as dashboard
        store.update_application(self.record['id'],status='interview',submitted_at=time.time(),snapshot={'fields':[{'id':'email','value':'original@example.test'}]})
        with patch.object(dashboard.browser,'run',new=AsyncMock()) as browser:
            for suffix, body in [('submit',None),('prepare',None),('refresh',None),('field',{'fieldId':'email','value':'changed@example.test'})]:
                self.assertEqual(self.client.post(self.base+'/'+suffix,json=body).status_code,409,suffix)
            browser.assert_not_called()
        self.assertEqual(store.get_application(self.record['id'])['snapshot']['fields'][0]['value'],'original@example.test')


class PipelineInsightTests(unittest.TestCase):
    def setUp(self):
        store.init();self.client=TestClient(app)
        with store.db() as c:c.execute('DELETE FROM applications')
    def tearDown(self):
        with store.db() as c:c.execute('DELETE FROM applications')
    def test_response_cohorts_use_submission_month_and_do_not_double_count_transitions(self):
        record=self.client.post('/api/applications',json={'url':'https://example.test/insights','company':'Fixture','description':'Python required'}).json()
        sent=1767225600
        store.update_application(record['id'],submitted_at=sent,status='interview')
        with store.db() as c:
            c.execute('DELETE FROM application_events')
            for stage,days in [('screening',2),('interview',5)]:
                c.execute("INSERT INTO application_events(application_id,kind,text,created_at) VALUES(?,?,?,?)",(record['id'],'status','submitted → '+stage,sent+days*86400))
        result=self.client.get('/api/analytics').json()
        self.assertEqual(result['responses'],1);self.assertEqual(result['medianResponseDays'],2)
        self.assertEqual(result['cohorts'],[{'month':'2026-01','submitted':1,'responses':1}])
        self.assertEqual(sum(v['count'] for v in result['transitions']),2)
        self.assertIn('Python required',self.client.get(f"/api/applications/{record['id']}/handoff.md").text)
        self.assertIn('no message has been sent',self.client.get('/api/digest').json()['text'])
