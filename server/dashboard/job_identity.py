"""Stable identities for known posting URLs; unknown query parameters stay significant."""
import re
from urllib.parse import urlsplit, parse_qsl, urlencode


def job_key(url):
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or '').lower()
        if parsed.scheme not in {'http', 'https'}:
            return url
        query = dict(parse_qsl(parsed.query))
        if host == 'linkedin.com' or host.endswith('.linkedin.com'):
            match = re.search(r'/jobs/view/(?:[^/]*-)?(\d+)/?$', parsed.path)
            ident = match[1] if match else query.get('currentJobId', '')
            if ident.isdigit():
                return 'linkedin:' + ident
        if (host == 'indeed.com' or host.endswith('.indeed.com')) and query.get('jk'):
            return 'indeed:' + query['jk']
        if re.fullmatch(r'[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com', host):
            match = re.search(r'/([^/]+)/job/[^/]+/[^/]+_([A-Za-z0-9-]+)(?:/|$)', parsed.path)
            if match:
                return parsed.netloc.lower() + '|' + match[1] + '|' + match[2]
        host = parsed.netloc.lower().replace('boards.greenhouse.io', 'job-boards.greenhouse.io') if host == 'boards.greenhouse.io' else parsed.netloc.lower()
        query = [(k, v) for k, v in parse_qsl(parsed.query) if not re.fullmatch(r'utm_.*|source|ref|referrer|gh_src|lever-source|lever-origin', k, re.I)]
        path = re.sub(r'/(apply|application)/?$', '', parsed.path, flags=re.I).rstrip('/')
        return host + path + '?' + urlencode(sorted(query)) + ('#' + parsed.fragment if parsed.fragment.startswith(('/', '!')) else '')
    except ValueError:
        return url
