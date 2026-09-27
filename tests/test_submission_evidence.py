import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import _state
from fastapi.testclient import TestClient
from dashboard import app as dashboard, store, submission
from dashboard.job_identity import job_key


class SubmissionEvidenceTests(unittest.TestCase):
    def setUp(self):
        dashboard.PROGRESS.clear()
        with store.db() as conn:
            conn.execute('DELETE FROM applications')
        self.client = TestClient(dashboard.app)
        self.path = dashboard.DOCS_DIR / 'submission-fixture.pdf'
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(b'%PDF-1.4 fixture resume bytes')
        self.record = store.upsert_application({'url': 'https://www.indeed.com/viewjob?jk=fixture1&from=search'})
        self.id = self.record['id']
        store.update_application(self.id, status='ready', resume_path=str(self.path), snapshot={'expectedResume': submission.fingerprint(self.path)})

    def test_click_without_confirmation_is_not_submitted_and_cannot_retry(self):
        run = AsyncMock(side_effect=[{'ok': True}, {'ok': False, 'clicked': True, 'confirmation': False}])
        with patch.object(dashboard.browser, 'run', run):
            self.assertEqual(self.client.post(f'/api/applications/{self.id}/submit').status_code, 200)
            self.assertEqual(self.client.post(f'/api/applications/{self.id}/submit').status_code, 409)
            self.assertEqual(self.client.post(f'/api/applications/{self.id}/status', json={'status':'ready'}).status_code, 409)
        saved = store.get_application(self.id)
        self.assertEqual(saved['status'], 'submission_unconfirmed')
        self.assertIsNone(saved['submitted_at'])
        self.assertEqual(run.await_count, 2)

    def test_timeout_after_attempt_is_durable_and_reconciliation_never_clicks(self):
        async def run(command, args, **kwargs):
            if args.get('dryRun'):
                return {'ok': True}
            self.assertEqual(store.get_application(self.id)['status'], 'submitting')
            raise dashboard.browser.BrowserError('Timeout after a possible click')
        with patch.object(dashboard.browser, 'run', run):
            self.client.post(f'/api/applications/{self.id}/submit')
        self.assertEqual(store.get_application(self.id)['status'], 'submission_unconfirmed')
        with patch.object(dashboard.browser, 'run', AsyncMock(return_value={'confirmation':True,'evidence':'Your application was submitted'})) as read:
            self.assertEqual(self.client.post(f'/api/applications/{self.id}/reconcile').status_code, 200)
            self.assertEqual(read.await_args.args[0], 'receipt')
        self.assertIsNotNone(store.get_application(self.id)['submitted_at'])

    def test_confirmed_submission_archives_exact_bytes_and_deduplicates_tracking_urls(self):
        original = self.path.read_bytes()
        with patch.object(dashboard.browser, 'run', AsyncMock(side_effect=[{'ok':True},{'ok':True,'clicked':True,'confirmation':True}])):
            response = self.client.post(f'/api/applications/{self.id}/submit')
        self.assertEqual(response.status_code, 200, response.text)
        saved = store.get_application(self.id)
        self.assertEqual(saved['status'], 'submitted')
        self.path.write_bytes(b'changed later')
        archive = saved['snapshot']['submissionAttempt']['documents']['resume']
        self.assertEqual((dashboard.DOCS_DIR / archive['archive']).read_bytes(), original)
        duplicate = store.upsert_application({'url':'https://www.indeed.com/viewjob?jk=fixture1&from=other'})
        self.assertEqual(duplicate['id'], self.id)
        self.assertEqual(duplicate['status'], 'submitted')

    def test_changed_resume_and_failed_preflight_never_click(self):
        self.path.write_bytes(b'changed')
        with patch.object(dashboard.browser, 'run', new_callable=AsyncMock) as run:
            self.assertEqual(self.client.post(f'/api/applications/{self.id}/submit').status_code,409)
            run.assert_not_awaited()
        store.update_application(self.id, snapshot={'expectedResume':submission.fingerprint(self.path)})
        with patch.object(dashboard.browser, 'run', AsyncMock(return_value={'ok':False,'clicked':False,'reason':'mismatched résumé'})) as run:
            self.client.post(f'/api/applications/{self.id}/submit')
            self.assertEqual(run.await_count,1)
        self.assertEqual(store.get_application(self.id)['status'],'ready')

    def test_identity_does_not_merge_different_jobs_or_unknown_query_ids(self):
        self.assertEqual(job_key('https://linkedin.com/jobs/view/123?trackingId=a'),job_key('https://www.linkedin.com/jobs/view/123?trackingId=b'))
        self.assertNotEqual(job_key('https://jobs.test/apply?id=1'),job_key('https://jobs.test/apply?id=2'))
        self.assertNotEqual(job_key('https://indeed.com/viewjob?jk=1'),job_key('https://indeed.com/viewjob?jk=2'))
