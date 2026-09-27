"""Give the unpacked extension a host permission it cannot ask for itself.

`optional_host_permissions` are granted through `chrome.permissions.request`,
which needs a user gesture and then a native dialog. Neither exists in a
container, so the grant is written into the browser profile's own record of
what has been granted — the same place Chrome would write it.

With `--check` it only reports, read-only: 0 if the grant is already there, 1
if it is not. Otherwise it writes, and exits 0 if it changed something.

Chrome must not be running when it writes. Chrome keeps Preferences in memory
and rewrites the file when it exits, so a patch applied to a running browser is
undone a moment later by the browser itself — which looks exactly like the
patch having silently failed.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import urlsplit


def patterns_for(model_url: str, all_hosts: bool) -> list[str]:
    """The origins to grant.

    The model's own, always. Every host as well, only when asked: the extension
    deliberately ships `activeTab` instead of all-sites access, so that on a
    normal browser it can reach a page only when its icon is clicked. A
    dashboard has no icon to click, so a container told to fill a posting on a
    company's own careers domain cannot reach it. Handing over every host is
    the way through, and it is a real widening — hence opt-in, and hence said
    out loud in the log rather than done quietly.
    """
    origin = urlsplit(model_url)
    found = []
    if origin.scheme and origin.netloc:
        found.append(f"{origin.scheme}://{origin.netloc}/*")
    if all_hosts:
        found += ["http://*/*", "https://*/*"]
    return found


def main(profile_dir: str, model_url: str, ext_dir: str, check_only: bool = False,
         all_hosts: bool = False) -> int:
    wanted_patterns = patterns_for(model_url, all_hosts)
    if not wanted_patterns:
        return 1

    prefs_path = Path(profile_dir) / "Default" / "Preferences"
    try:
        prefs = json.loads(prefs_path.read_text())
    except (OSError, json.JSONDecodeError):
        return 1

    settings = (prefs.get("extensions") or {}).get("settings") or {}
    wanted = Path(ext_dir).resolve()
    changed = False
    for entry in settings.values():
        # Matched on the directory it was loaded from, not on the word
        # "formwork" appearing in it: in a container that directory is
        # /app/extension, and a name match found nothing while reporting
        # success. The rest of the entries ship with the browser.
        try:
            if Path(str(entry.get("path", ""))).resolve() != wanted:
                continue
        except (OSError, ValueError):
            continue
        if check_only:
            granted = (entry.get("granted_permissions") or {}).get("explicit_host") or []
            return 0 if all(p in granted for p in wanted_patterns) else 1
        for bucket in ("granted_permissions", "active_permissions"):
            hosts = entry.setdefault(bucket, {}).setdefault("explicit_host", [])
            for pattern in wanted_patterns:
                if pattern not in hosts:
                    hosts.append(pattern)
                    changed = True
            hosts.sort()

    if check_only or not changed:
        return 1
    prefs_path.write_text(json.dumps(prefs, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    flags = {"--check", "--all-hosts"}
    args = [a for a in sys.argv[1:] if a not in flags]
    raise SystemExit(
        main(
            args[0],
            args[1],
            args[2],
            check_only="--check" in sys.argv,
            all_hosts="--all-hosts" in sys.argv,
        )
    )
