#!/usr/bin/env python3
"""Package the shared extension for Firefox/Zen, without changing Chrome's manifest."""
import argparse
import json
import subprocess
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZipFile, ZIP_DEFLATED

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--out', required=True, type=Path)
parser.add_argument('--dashboard', help='Optional server origin to grant at installation; no profile or keys are packaged')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1] / 'extension'
manifest = json.loads((root / 'manifest.json').read_text())
manifest['background'] = {'scripts': [manifest['background']['service_worker']], 'type': 'module'}
# Keep explicit self-hosted HTTP origins usable on the private network.
manifest['content_security_policy'] = {'extension_pages': "script-src 'self'; object-src 'self'"}
manifest['browser_specific_settings'] = {'gecko': {'id': '{064413a8-d009-4cfd-8e67-a4becc2e19ac}', 'strict_min_version': '128.0'}}
if args.dashboard:
    url = urlsplit(args.dashboard)
    if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        parser.error('--dashboard must be an HTTP(S) origin without credentials or a path')
    origin = f'{url.scheme}://{url.netloc}'
    # Firefox match patterns identify a hostname, not a server port.
    host = f'[{url.hostname}]' if ':' in url.hostname else url.hostname
    manifest['host_permissions'].append(f'{url.scheme}://{host}/*')
    manifest['background']['scripts'].append('src/background/dashboard-bootstrap.js')
subprocess.run(["npm", "run", "build:extension"], cwd=root.parent, check=True)
args.out.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(args.out, 'w', ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob('*')):
        if path.is_file() and path.name != 'manifest.json':
            archive.write(path, str(path.relative_to(root)))
    if args.dashboard:
        archive.writestr('dashboard.json', json.dumps({'origin': origin}) + '\n')
    archive.writestr('manifest.json', json.dumps(manifest, indent=2) + '\n')
print(args.out)
