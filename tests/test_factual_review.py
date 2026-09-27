import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
import _state
from dashboard import model, resume
from dashboard import app as dashboard, store
from fastapi.testclient import TestClient


class FactualReviewTests(unittest.TestCase):
    def test_count_formatting_is_equivalent_but_changed_measurements_are_not(self):
        self.assertEqual(resume.claims('18 sample records'),resume.claims('18 sample records'))
        self.assertEqual(resume.claims('12.5k records'),resume.claims('12,500 records'))
        self.assertEqual(resume.unsupported('Handled 18 sample records.','Handled 18 sample records.'),set())
        self.assertIn('201',resume.unsupported('Handled 201 events.','Handled 18 sample records.'))

    def test_posting_duties_are_separate_from_candidate_evidence(self):
        text='I reviewed weekly ticket trends and documented common solutions.'
        response={'concerns':[{'quote':text,'reason':'The posting requests this, but the candidate facts do not say they did it.'}]}
        with patch.object(model,'complete',new=AsyncMock(return_value=json.dumps(response))) as call:
            result=asyncio.run(resume.review_facts(text,'I supervised 16 staff.','Review weekly ticket trends and document common solutions.'))
        self.assertEqual(result['concerns'],response['concerns'])
        self.assertIn('POSTING (not candidate evidence)',call.call_args.args[0][1]['content'])

    def test_unverifiable_reviewer_quotes_are_not_treated_as_a_clean_review(self):
        with patch.object(model,'complete',new=AsyncMock(return_value=json.dumps({'concerns':[{'quote':'An invented sentence not in the draft.','reason':'Invented'}]}))):
            result=asyncio.run(resume.review_facts('I coached staff.','I coached staff.','Coach staff.'))
        self.assertEqual(result['status'],'incomplete')
        self.assertEqual(result['concerns'],[])

    def test_review_failure_is_visible_and_never_rewrites_the_draft(self):
        with patch.object(model,'complete',new=AsyncMock(side_effect=model.ModelError('offline'))):
            result=asyncio.run(resume.review_facts('I coached staff.','',''))
        self.assertEqual(result['status'],'unavailable')
        self.assertIn('offline',result['note'])

    def test_redraft_uses_the_resume_sent_with_this_application(self):
        record=store.upsert_application({'url':'https://example.test/factual-context','company':'Example','title':'Role'})
        store.update_application(record['id'],status='ready',snapshot={'resumeText':'Selected resume facts.','posting':'Posting duties.'})
        returned={'text':'Revised letter.','factualReview':{'status':'checked','concerns':[],'note':'Review'}}
        with patch.object(resume,'cover_letter',new=AsyncMock(return_value=returned)) as generate:
            response=TestClient(dashboard.app).post(f"/api/applications/{record['id']}/redraft",json={'question':'cover letter','previous':'Old letter','instruction':'Revise','cover':True})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(generate.call_args.args[3],'Selected resume facts.')
        self.assertEqual(response.json()['factualReview'],returned['factualReview'])
