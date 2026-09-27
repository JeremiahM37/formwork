import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
import _state
from dashboard import store
from dashboard.app import app
from fastapi.testclient import TestClient

class ComparisonTests(unittest.TestCase):
    def test_sponsorship_text_preserves_negation_and_does_not_infer(self):
        from dashboard.documents import sponsorship_excerpts
        text = 'Python required. We cannot provide visa sponsorship. H-1B transfers may be considered. Lunch provided.'
        self.assertEqual(sponsorship_excerpts(text), ['We cannot provide visa sponsorship.', 'H-1B transfers may be considered.'])
        self.assertEqual(sponsorship_excerpts('We sponsor a local football team.'), [])
    def setUp(self):
        self.client=TestClient(app)
        self.job=self.client.post('/api/applications',json={'url':'https://example.test/compare-resume','description':'Required: Python SQL Docker'}).json()
    def tearDown(self):
        with store.db() as c:
            c.execute('DELETE FROM applications');c.execute('DELETE FROM resume_versions')
    def test_actual_document_evidence_is_not_padded_by_shared_profile(self):
        ids=[]
        for name,text in [('Backend','Python SQL Docker'),('General','Python')]:
            ids.append(self.client.post('/api/resumes',json={'name':name,'text':text}).json()['id'])
        result=self.client.post(f"/api/applications/{self.job['id']}/compare-resumes",json={'version_ids':ids})
        self.assertEqual(result.status_code,200,result.text)
        versions=result.json()['versions']
        self.assertEqual([v['fit']['coverage'] for v in versions],[100,33])
        self.assertIsNone(store.get_application(self.job['id'])['snapshot'].get('resumeVersion'))
        self.assertEqual(self.client.post(f"/api/applications/{self.job['id']}/compare-resumes",json={'version_ids':[ids[0],ids[0]]}).status_code,400)

    def test_posting_analysis_uses_selected_resume_without_persisting_application(self):
        version=self.client.post('/api/resumes',json={'name':'Backend only','text':'Python'}).json()
        before=len(store.list_applications())
        result=self.client.post('/api/posting-analysis',json={'description':'Python and SQL required','version_id':version['id']})
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json()['fit']['coverage'],50)
        self.assertEqual(result.json()['resume'],'Backend only')
        self.assertEqual(len(store.list_applications()),before)
