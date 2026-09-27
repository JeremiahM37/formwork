"""Document fingerprints and durable submission evidence, independent of the browser."""
import hashlib
from pathlib import Path
from .config import DOCS_DIR


def fingerprint(path):
    source = Path(path)
    data = source.read_bytes()
    return {"filename": source.name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def archive(path):
    """Keep the exact attempted bytes even if a later preparation replaces the source."""
    info = fingerprint(path)
    target = DOCS_DIR / (info["sha256"] + Path(path).suffix.lower())
    data = Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != info["sha256"]:
        raise ValueError("Document changed while archiving")
    if not target.exists():
        with target.open("xb") as stream:
            stream.write(data)
        target.chmod(0o600)
    if hashlib.sha256(target.read_bytes()).hexdigest() != info["sha256"]:
        raise ValueError("Archived document checksum differs")
    return {**info, "archive": target.name}
