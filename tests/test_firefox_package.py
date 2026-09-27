import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]

class FirefoxPackageTests(unittest.TestCase):
    def test_private_package_has_background_and_scoped_server_access_without_profile(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / 'formwork.xpi'
            subprocess.run(['python3', str(ROOT/'tools/build-firefox.py'), '--out', str(out), '--dashboard', 'http://lab.example:9113'], check=True, capture_output=True)
            with ZipFile(out) as archive:
                manifest = json.loads(archive.read('manifest.json'))
                self.assertNotIn('service_worker', manifest['background'])
                for script in manifest['background']['scripts']:
                    self.assertIn(script, archive.namelist())
                self.assertIn('http://lab.example/*', manifest['host_permissions'])
                self.assertNotIn('upgrade-insecure-requests',manifest['content_security_policy']['extension_pages'])
                self.assertEqual(json.loads(archive.read('dashboard.json')),{'origin':'http://lab.example:9113'})
                self.assertFalse(any('profile.json' in n for n in archive.namelist()))
            self.assertIn('service_worker',json.loads((ROOT/'extension/manifest.json').read_text())['background'])

    def test_rejects_credentials_in_dashboard_address(self):
        with tempfile.TemporaryDirectory() as d:
            result=subprocess.run(['python3',str(ROOT/'tools/build-firefox.py'),'--out',str(Path(d)/'bad.xpi'),'--dashboard','https://user:secret@example.com'],capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse((Path(d)/'bad.xpi').exists())
