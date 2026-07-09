"""
Loads the FULL site inventory from the Siteimprove CSV export that the
accessibility report publishes (data/site-tags.csv on its Pages site).

Why this and not just sites.json: sites.json only contains sites the
Siteimprove API scored (~1,446). The CSV is the complete inventory
(~1,634) and carries the authoritative admin tags — including Omeka, RSE
(Rails), and Google-Sites, which never appear in sites.json because those
sites weren't scored. Driving task creation + section placement off the
CSV is what lets the Omeka / Rails / Google Sites sections fill up.

The export is UTF-16, tab-separated, with a header row. We auto-detect
encoding (BOM) and delimiter so a re-export drops in without conversion.
"""

from __future__ import annotations

import csv
import io
import re
import sys
import urllib.request
from dataclasses import dataclass, field
from urllib.parse import urlparse

TAG_SPLIT = re.compile(r"[,|;]")

# URL-based platform inference for sites the CSV leaves untagged. Mirrors
# derive_fallback_tags in the accessibility repo so the Asana board and the
# dashboard classify untagged sites identically. CSV tags always win; this
# only fills gaps. Returns plain labels matched by config.SECTIONS.
_WP_HOSTS = {"sites.lsa.umich.edu", "courses.lsa.umich.edu",
             "digitalscholarship.umich.edu", "digitalscholarship-dev.lsa.umich.edu"}
_AEM_HOSTS = {"lsa.umich.edu", "ii.umich.edu"}


def fallback_tags(url: str | None) -> list[str]:
    parsed = urlparse(url if (url and "://" in url) else "https://" + (url or ""))
    host = (parsed.hostname or "").lower()
    if not host:
        return []
    if host in _WP_HOSTS:
        return ["WP"]
    if host in _AEM_HOSTS:
        return ["AEM"]
    if host == "websites.umich.edu":
        return ["External"]
    if not (host.endswith(".umich.edu") or host == "umich.edu"):
        return ["External"]
    return []  # unknown umich subdomain — likely Omeka/Rails; don't guess


@dataclass
class InventoryRow:
    site_id: str
    name: str
    url: str
    tags: list[str] = field(default_factory=list)


def _read_bytes(url: str) -> bytes:
    if url.startswith("file://"):
        with open(url[len("file://"):], "rb") as fh:
            return fh.read()
    req = urllib.request.Request(url, headers={"User-Agent": "siteimprove-asana-sync"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
        return resp.read()


def _decode(raw: bytes) -> str:
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    return raw.decode("utf-8-sig")


def _norm_header(k: str | None) -> str:
    return (k or "").strip().lower().replace(" ", "_")


def load_inventory(url: str) -> list[InventoryRow]:
    text = _decode(_read_bytes(url))
    first_line = text.splitlines()[0] if text else ""
    delimiter = "\t" if "\t" in first_line else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

    rows: list[InventoryRow] = []
    for raw in reader:
        r = {_norm_header(k): (v or "") for k, v in raw.items()}
        site_url = (r.get("site_url") or r.get("url") or "").strip()
        if site_url and "://" not in site_url:
            site_url = "https://" + site_url
        tags_field = r.get("tags") or r.get("labels") or ""
        tags = [t.strip() for t in TAG_SPLIT.split(tags_field) if t.strip()]
        # Gap-filler: infer a platform tag from the URL when the export has
        # none, so untagged sites land in the right section instead of
        # Uncategorized. Real CSV tags are never overridden.
        if not tags:
            tags = fallback_tags(site_url)
        name = (r.get("site_name") or r.get("name") or site_url).strip()
        if not site_url and not name:
            continue
        rows.append(InventoryRow(
            site_id=str(r.get("site_id") or r.get("id") or "").strip(),
            name=name or site_url,
            url=site_url,
            tags=tags,
        ))
    if not rows:
        sys.exit(f"No inventory rows parsed from {url}")
    return rows
