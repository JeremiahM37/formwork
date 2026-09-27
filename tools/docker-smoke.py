#!/usr/bin/env python3
"""Run only inside a disposable test container; writes synthetic profile/state."""
import io
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
from docx import Document
from pypdf import PdfReader

if os.environ.get('FORMWORK_SMOKE_TEST') != '1' or not Path('/.dockerenv').exists():
    raise SystemExit('Use a disposable Docker container with FORMWORK_SMOKE_TEST=1')


def request(path,body=None):
    data=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request('http://localhost:9113'+path,data=data,headers={'Content-Type':'application/json'})
    return urllib.request.urlopen(req,timeout=90)


def api(path,body=None):
    with request(path,body) as response: return json.load(response)


deadline=time.monotonic()+90
while True:
    try:
        state=api('/api/state');break
    except Exception:
        if time.monotonic()>=deadline: raise
        time.sleep(1)

marker=Path('/state/docker-smoke.json')
if '--after-restart' in sys.argv:
    saved=json.loads(marker.read_text())
    assert api('/api/profile')['profile']['identity']['full_name']=='Fixture Rivéra'
    assert api(f"/api/resumes/{saved['version']}")['name']=='Container smoke'
    assert api(f"/api/applications/{saved['application']}")['status']=='queued'
    assert api('/api/profile/sync',{})['synced']
    print('PASS: container restart preserves profile, document version, application and extension sync')
    raise SystemExit(0)

assert not marker.exists(), 'Use a fresh disposable container for the initial smoke test'
assert Path('/app/LICENSE').is_file()
assert 'Permission is hereby granted' in Path('/app/licenses/humanizer-MIT.txt').read_text()
assert 'report' in request('/writing/humanize.js').read().decode()
profile={'schema_version':1,'identity':{'full_name':'Fixture Rivéra','first_name':'Fixture','last_name':'Rivéra','email':'fixture@example.test'},
         'skills':{'languages':['Python']},'experience':[],'education':[],'projects':[]}
synced=api('/api/profile',{'text':json.dumps(profile)})
assert synced['synced'], synced
job=api('/api/applications',{'url':'https://example.test/container-smoke','company':'Fixture','title':'Engineer'})
layout={'name':'Fixture Rivéra','contact':'fixture@example.test','template':'compact','paper':'a4','font_size':11,'margin':.7,
        'sections':[{'heading':'Experience','entries':[{'title':'Engineer','subtitle':'Fixture Company','dates':'2022 – Present','bullets':['Organized sample records.']}]}]}
version=api('/api/resumes',{'name':'Container smoke','format':'structured','text':json.dumps(layout)})
with request(f"/api/resumes/{version['id']}/export.pdf?inline=1") as response:
    pdf=PdfReader(io.BytesIO(response.read()))
text='\n'.join(p.extract_text() for p in pdf.pages)
assert 'Rivéra' in text and 'sample records' in text and '2022 – Present' in text, text
with request(f"/api/resumes/{version['id']}/export.docx") as response:
    word=Document(io.BytesIO(response.read()))
assert any('sample records' in p.text for p in word.paragraphs)
api('/api/alerts',{'name':'Fixture search','query':'Python'})
assert len(api('/api/alerts')['alerts'])==1
marker.write_text(json.dumps({'application':job['id'],'version':version['id']}))
print('PASS: isolated container starts, includes licenses, syncs extension, persists state and exports readable PDF/DOCX offline')
