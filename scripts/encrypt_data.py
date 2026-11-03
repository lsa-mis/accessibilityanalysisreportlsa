"""Encrypt the dashboard's JSON snapshots for publishing to GitHub Pages.

data.html asks for a password, derives a key with PBKDF2-SHA256 and
decrypts these files with AES-256-GCM in the browser (Web Crypto). The
password comes from the DASHBOARD_PASSWORD environment variable.

Usage: DASHBOARD_PASSWORD=... python scripts/encrypt_data.py <out_dir>
Writes <out_dir>/sites.enc.json and <out_dir>/rules.enc.json.
"""

import base64
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

# Must match PBKDF2_ITERATIONS in data.html.
ITERATIONS = 600_000
ROOT = Path(__file__).resolve().parent.parent
FILES = {"sites.json": "sites.enc.json", "rules.json": "rules.enc.json"}


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def main() -> None:
    password = os.environ.get("DASHBOARD_PASSWORD")
    if not password:
        sys.exit("DASHBOARD_PASSWORD is not set")
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    # One salt per build so the browser derives the key once for all files.
    salt = os.urandom(16)
    key = PBKDF2HMAC(
        algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS
    ).derive(password.encode("utf-8"))
    aes = AESGCM(key)

    for src_name, out_name in FILES.items():
        src = ROOT / "data" / src_name
        if not src.exists():
            continue
        iv = os.urandom(12)
        ct = aes.encrypt(iv, src.read_bytes(), None)
        payload = {"salt": b64(salt), "iv": b64(iv), "iterations": ITERATIONS, "ct": b64(ct)}
        (out_dir / out_name).write_text(json.dumps(payload))
        print(f"Encrypted {src_name} -> {out_dir / out_name}")


if __name__ == "__main__":
    main()
