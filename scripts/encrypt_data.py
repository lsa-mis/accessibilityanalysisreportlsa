"""Encrypt the dashboard's JSON snapshots for publishing to GitHub Pages.

data.html asks for a password, derives a key with PBKDF2-SHA256 and
decrypts these files with AES-256-GCM in the browser (Web Crypto). The
password comes from the DASHBOARD_PASSWORD environment variable.

Usage: DASHBOARD_PASSWORD=... python scripts/encrypt_data.py <out_dir>
Writes encrypted latest, history, department, and refresh-status resources.
Historical snapshots retain their gzip compression inside the encrypted payload.
"""

import base64
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

# New payloads carry this value for both browser readers.
ITERATIONS = 600_000
ROOT = Path(__file__).resolve().parent.parent
FILES = {
    "sites.json": "sites.enc.json", "rules.json": "rules.enc.json",
    "departments.json": "departments.enc.json", "refresh-status.json": "refresh-status.enc.json",
    "history/index.json": "history/index.enc.json",
}


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def main() -> None:
    password = os.environ.get("DASHBOARD_PASSWORD")
    if not password:
        sys.exit("DASHBOARD_PASSWORD is not set")
    missing = [name for name in FILES if not (ROOT / "data" / name).is_file()]
    if missing:
        sys.exit(f"Missing required publication data: {', '.join(missing)}")
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    # One salt per build so the browser derives the key once for all files.
    salt = os.urandom(16)
    key = PBKDF2HMAC(
        algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS
    ).derive(password.encode("utf-8"))
    aes = AESGCM(key)

    files = dict(FILES)
    files.update({str(p.relative_to(ROOT / "data")): str(p.relative_to(ROOT / "data")).replace(".json.gz", ".enc.json")
                  for p in (ROOT / "data" / "history").glob("*.json.gz")})
    for src_name, out_name in files.items():
        src = ROOT / "data" / src_name
        iv = os.urandom(12)
        ct = aes.encrypt(iv, src.read_bytes(), None)
        payload = {"salt": b64(salt), "iv": b64(iv), "iterations": ITERATIONS, "ct": b64(ct)}
        if src.suffix == ".gz":
            payload["compression"] = "gzip"
        destination = out_dir / out_name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(payload))
    print(f"Encrypted {len(files)} data resources into {out_dir}")


if __name__ == "__main__":
    main()
