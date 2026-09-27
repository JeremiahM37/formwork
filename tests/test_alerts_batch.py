"""Discovery notifications, sequential preparation and restart recovery."""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import _state
from fastapi.testclient import TestClient
from dashboard import alerts, app as dashboard, store


class SearchAndBatchTests(unittest.TestCase):
    def setUp(self):
        store.init()
        self.settings = store.get_settings()
        store.set_settings({'refreshIntervalHours': 0})
        dashboard.PROGRESS.clear()
        with store.db() as db:
            db.execute('DELETE FROM applications')
            db.execute('DELETE FROM search_alerts')
        self.client = TestClient(dashboard.app)

    def tearDown(self):
        store.set_settings(self.settings)
        dashboard.PROGRESS.clear()

    def add_job(self, number):
        return self.client.post('/api/applications', json={
            'url': f'https://example.test/jobs/{number}', 'company': 'Example',
            'title': 'Engineer'}).json()['id']

    def test_alerts_deduplicate_and_unknown_does_not_pass_threshold(self):
        first = self.client.post('/api/alerts', json={'name': 'Python roles', 'query': 'Python engineer'}).json()
        self.client.post('/api/alerts', json={'name': 'Evidence required', 'query': 'engineer', 'min_coverage': 50})
        jobs = [{'url': 'https://example.test/1', 'title': 'Python engineer', 'description': ''}]
        alerts.evaluate(jobs, {}, '')
        alerts.evaluate(jobs, {}, '')
        notifications = self.client.get('/api/alerts').json()['notifications']
        self.assertEqual(len(notifications), 1)
        self.assertEqual(notifications[0]['alert_id'], first['id'])
        self.client.post(f"/api/notifications/{notifications[0]['id']}/acknowledge")
        alerts.evaluate(jobs, {}, '')
        self.assertEqual(self.client.get('/api/alerts').json()['notifications'], [])
        jobs[0]['description'] = 'Python'
        alerts.evaluate(jobs, {'skills': ['Python']}, '')
        self.assertEqual(len(self.client.get('/api/alerts').json()['notifications']), 1)

    def test_batch_is_sequential_deduplicated_and_never_submits(self):
        one, two = self.add_job(1), self.add_job(2)
        events = []
        async def prepare(app_id):
            events.append(('start', app_id))
            await asyncio.sleep(0)
            events.append(('end', app_id))
            store.update_application(app_id, status='ready')
        with patch.object(dashboard, '_prepare', side_effect=prepare), patch.object(dashboard.browser, 'run', new_callable=AsyncMock) as browser:
            response = self.client.post('/api/prepare-batch', json={'ids': [one, one, two]})
        self.assertEqual(response.json(), {'started': [one, two], 'submits': False})
        self.assertEqual(events, [('start', one), ('end', one), ('start', two), ('end', two)])
        browser.assert_not_called()
        self.assertTrue(all(a['submitted_at'] is None for a in store.list_applications()))

    def test_batch_rejects_invalid_member_before_scheduling_anything(self):
        one, two = self.add_job(1), self.add_job(2)
        store.update_application(two, status='submitted')
        with patch.object(dashboard, '_prepare', new_callable=AsyncMock) as prepare:
            response = self.client.post('/api/prepare-batch', json={'ids': [one, two]})
        self.assertEqual(response.status_code, 409)
        prepare.assert_not_called()
        self.assertEqual(dashboard.PROGRESS, {})

    def test_restart_marks_interrupted_preparation_as_failed(self):
        job = self.add_job(1)
        store.update_application(job, status='filling')
        with patch.object(dashboard.jobs, 'find', new_callable=AsyncMock) as find:
            with TestClient(dashboard.app) as client:
                record = client.get(f'/api/applications/{job}').json()
                self.assertEqual(record['status'], 'failed')
                self.assertIn('restart', record['note'])
            find.assert_not_called()

    def test_active_and_sent_records_cannot_be_overwritten_through_add_job(self):
        job = self.add_job(1)
        dashboard.PROGRESS[job] = {'step': 'reading'}
        self.assertEqual(self.client.delete(f'/api/applications/{job}').status_code, 409)
        self.assertEqual(self.client.post(f'/api/applications/{job}/status', json={'status': 'submitted'}).status_code, 409)
        self.assertEqual(self.client.post('/api/applications', json={'url': 'https://example.test/jobs/1', 'description': 'overwrite'}).status_code, 409)
        dashboard.PROGRESS.clear()
        store.update_application(job, status='submitted', snapshot={'posting': 'original'})
        self.assertEqual(self.client.post('/api/applications', json={'url': 'https://example.test/jobs/1', 'description': 'overwrite'}).status_code, 409)
        self.assertEqual(store.get_application(job)['snapshot']['posting'], 'original')

    def test_failed_refresh_keeps_queue_and_records_error(self):
        store.replace_queue([{'url': 'https://example.test/kept', 'title': 'Existing', 'company': 'Example'}])
        with patch.object(dashboard.jobs, 'find', side_effect=RuntimeError('Every source failed')):
            response = self.client.post('/api/queue/refresh')
        self.assertEqual(response.status_code, 502)
        self.assertEqual(store.list_queue()[0]['title'], 'Existing')
        self.assertIn('failed', store.get_settings()['lastQueueError'])
        self.assertGreater(store.get_settings()['lastQueueAttempt'], 0)
        for value in [-1, 0.5, 169, 'hourly']:
            self.assertEqual(self.client.post('/api/settings', json={'values': {'refreshIntervalHours': value}}).status_code, 400)


if __name__ == '__main__':
    unittest.main()
