import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
import _state
from fastapi.testclient import TestClient
from dashboard import app as dashboard


class ModelConnectionTests(unittest.TestCase):
    def test_connection_receipt_and_browser_failure_reach_the_ui(self):
        client=TestClient(dashboard.app)
        body={'baseUrl':'http://localhost:9113','testOnly':True}
        with patch.object(dashboard.browser,'run',new=AsyncMock(return_value={'ok':False,'needsPermission':True})) as run:
            response=client.post('/api/provider/extension',json=body)
            self.assertEqual(response.status_code,200)
            self.assertTrue(response.json()['needsPermission'])
            run.assert_awaited_once_with('modelConnection',body,timeout=60)
        with patch.object(dashboard.browser,'run',new=AsyncMock(side_effect=dashboard.browser.BrowserError('browser offline'))):
            self.assertEqual(client.post('/api/provider/extension',json=body).status_code,502)
        self.assertEqual(client.post('/api/provider/extension',json={}).status_code,422)


if __name__=='__main__': unittest.main()
