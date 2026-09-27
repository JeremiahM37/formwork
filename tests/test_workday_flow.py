import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
import _state
from fastapi.testclient import TestClient
from dashboard import app as dashboard, store


class WorkdayFlowTests(unittest.TestCase):
    def setUp(self):
        dashboard.PROGRESS.clear()
        with store.db() as db:
            db.execute('DELETE FROM applications');db.execute('DELETE FROM settings')
        self.client=TestClient(dashboard.app)
        self.record=store.upsert_application({'url':'https://fixture.wd5.myworkdayjobs.com/en-US/External/job/Denver/Engineer_R1','company':'Fixture','title':'Engineer'})
        self.id=self.record['id']
        self.snapshot={'flow':{'kind':'next','fingerprint':'step1','heading':'My Information'},'fields':[{'id':'name','label':'Name','value':'Before edit'}],
                       'cover':{'text':'Approved letter','approvedText':'Approved letter'},'posting':'Preserve posting','staged':[]}
        store.update_application(self.id,status='ready',snapshot=self.snapshot,resume_path='/tmp/fixture-resume.pdf',cover_path='/tmp/fixture-cover.pdf')

    def test_continue_preserves_documents_and_actual_previous_answers_without_submitting(self):
        result={'flow':{'kind':'review','fingerprint':'review'},'fields':[],'staged':[],'advanced':True,
                'previousStep':{'flow':self.snapshot['flow'],'fields':[{'label':'Name','value':'Actual browser edit'}]},'reviewText':'Final review'}
        run=AsyncMock(return_value=result)
        with patch.object(dashboard.browser,'run',run):
            response=self.client.post(f'/api/applications/{self.id}/continue',json={'action':'next'})
        self.assertEqual(response.status_code,200,response.text)
        saved=store.get_application(self.id)
        self.assertEqual(saved['status'],'ready');self.assertEqual(saved['snapshot']['steps'][0]['fields'][0]['value'],'Actual browser edit')
        self.assertEqual(saved['snapshot']['cover'],self.snapshot['cover']);self.assertEqual(saved['snapshot']['posting'],'Preserve posting')
        calls=run.await_args_list;self.assertEqual([c.args[0] for c in calls],['documents','fill','documents'])
        self.assertEqual(calls[1].args[1]['fingerprint'],'step1');self.assertTrue(calls[1].args[1]['resume']);self.assertTrue(calls[-1].args[1]['restore'])

    def test_login_and_unreviewed_drafts_cannot_advance_or_submit(self):
        for kind,staged in [('login',[]),('next',[{'id':'draft','text':'Review me'}]),('review',[])]:
            store.update_application(self.id,snapshot={**self.snapshot,'flow':{'kind':kind},'staged':staged})
            with patch.object(dashboard.browser,'run',new_callable=AsyncMock) as run:
                self.assertEqual(self.client.post(f'/api/applications/{self.id}/continue',json={'action':'next'}).status_code,409)
                if kind!='review': self.assertEqual(self.client.post(f'/api/applications/{self.id}/submit?dry=true').status_code,409)
                run.assert_not_awaited()

    def test_failed_step_keeps_history_and_restores_document_slot(self):
        run=AsyncMock(side_effect=[{'ok':True},RuntimeError('Browser disappeared'),{'ok':True}])
        with patch.object(dashboard.browser,'run',run):
            self.client.post(f'/api/applications/{self.id}/continue',json={'action':'next'})
        saved=store.get_application(self.id);self.assertEqual(saved['status'],'failed');self.assertEqual(saved['snapshot'],self.snapshot)
        self.assertIn('Browser disappeared',saved['note']);self.assertTrue(run.await_args_list[-1].args[1]['restore'])

    def test_validation_error_does_not_duplicate_saved_steps(self):
        result={'advanced':False,'flow':{'kind':'next','errors':['Required field missing'],'fingerprint':'step1'},'fields':self.snapshot['fields'],'staged':[]}
        with patch.object(dashboard.browser,'run',AsyncMock(return_value=result)):
            self.client.post(f'/api/applications/{self.id}/continue',json={'action':'next'})
        saved=store.get_application(self.id);self.assertEqual(saved['snapshot']['steps'],[]);self.assertEqual(saved['snapshot']['flow']['errors'],['Required field missing'])

    def test_sign_in_resume_fills_without_advancing_and_can_pause_again(self):
        store.update_application(self.id,snapshot={**self.snapshot,'flow':{'kind':'login'}},status='queued')
        with patch.object(dashboard.browser,'run',AsyncMock(return_value={'flow':{'kind':'login','message':'Sign in'},'fields':[],'staged':[]})) as run:
            self.client.post(f'/api/applications/{self.id}/continue',json={'action':'fill'})
        call=next(c for c in run.await_args_list if c.args[0]=='fill');self.assertFalse(call.args[1]['advance'])
        self.assertEqual(store.get_application(self.id)['status'],'queued');self.assertTrue(dashboard.PROGRESS[self.id]['done'])
