import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import _state
from dashboard import profile_import as importer
from dashboard.app import app
from fastapi.testclient import TestClient

SOURCE = 'Experience\nFixture Company\nSoftware Engineer\nJune 2022 - Present\nBuilt Python services.\nEducation\nBlue Ridge University\nB.S.\nSkills\nPython, SQL'
PROPOSAL = {'experience':[{'employer':'Fixture Company','title':'Software Engineer','start':'June 2022','end':'Present','bullets':['Built Python services.'], 'source':'Fixture Company\nSoftware Engineer\nJune 2022 - Present\nBuilt Python services.'}], 'skills':['Python','SQL']}


class ProfileImportTests(unittest.TestCase):
    def test_source_quotes_and_fields_are_verified_without_sensitive_defaults(self):
        value = json.loads(json.dumps(PROPOSAL))
        value['experience'][0]['bullets'].append('Reduced latency by 90%.')
        value['experience'][0]['authorized_to_work_us'] = True
        value['skills'].extend(['Java','Kubernetes'])
        result = importer.validate(value,SOURCE)
        job = result['sections']['experience'][0]
        self.assertEqual(job['bullets'],['Built Python services.'])
        self.assertNotIn('authorized_to_work_us',job)
        self.assertTrue(job['current'])
        self.assertEqual(result['sections']['skills'],{'imported':['Python','SQL']})
        self.assertTrue(result['rejected'])

    def test_unverified_block_and_wrong_field_assignment_do_not_pass(self):
        value = {'experience':[{'employer':'Invented Inc','source':SOURCE}], 'education':[{'school':'Blue Ridge University','source':'invented quotation'}]}
        self.assertEqual(importer.validate(value,SOURCE)['sections'],{})

    def test_header_contacts_and_known_identity_stay_out_of_model_request(self):
        identity = {'full_name':'Dana Rivera','email':'dana@example.test'}
        text = 'Dana Rivera\ndana@example.test\nPrivate home address\n' + SOURCE + '\nReferences: Dana Rivera https://example.test/me 919-555-0142'
        redacted = importer.career_text(text,identity)
        for secret in ['Dana Rivera','dana@example.test','Private home address','https://example.test/me','919-555-0142']:
            self.assertNotIn(secret,redacted)
        with self.assertRaises(ValueError): importer.career_text('Name\nUnknown layout',{})

    def test_extraction_is_preview_only_and_model_sees_only_career_content(self):
        path = Path(_state.STATE_DIR)/'import-profile.json'
        original = json.dumps({'identity':{'full_name':'Dana Rivera'},'work_authorization':{'authorized_to_work_us':False}})
        path.write_text(original)
        with patch.object(importer,'PROFILE_JSON',path), patch.object(importer.model,'complete',new=AsyncMock(return_value=json.dumps(PROPOSAL))) as complete:
            response = TestClient(app).post('/api/resumes/extract-profile',json={'text':'Dana Rivera\nPrivate header\n'+SOURCE})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(path.read_text(),original)
        self.assertNotIn('Private header',complete.call_args.args[0][1]['content'])
        self.assertEqual(response.json()['sections']['experience'][0]['employer'],'Fixture Company')
