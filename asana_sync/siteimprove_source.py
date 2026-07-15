"""
Loads the Siteimprove site snapshot.

Default source is the JSON the accessibility report publishes to GitHub
Pages (see config.SITEIMPROVE_DATA_URL). That snapshot already has tags
merged, AAA handling applied, and Test/Development sites excluded, so this
module is deliberately thin — fetch, parse, normalise a few fields.

Supports http(s) URLs and local file:// paths (handy for testing).
"""

from __future__ import annotations

import json
import sys
import urllib.request
from dataclasses import dataclass, field
from urllib.parse import urlparse


@dataclass
class Site:
    site_id: str
    name: str
    url: str
    target_percentage: float | None
    score: float | None
    pages: int | None
    tags: list[str] = field(default_factory=list)
    # Data provenance: "api" for rows the Siteimprove API returned,
    # "inventory" for stub rows appended from the CSV export at fetch time.
    source: str = "api"

    @property
    def norm_url(self) -> str:
        return normalize_url(self.url)

    @property
    def plain_tags(self) -> list[str]:
        """Tags with the 'tag:' prefix stripped, lowercased."""
        out = []
        for t in self.tags:
            t = t.split(":", 1)[1] if ":" in t else t
            out.append(t.strip().lower())
        return out


def normalize_url(url: str | None) -> str:
    """Canonical form for matching: scheme/www stripped, lowercased, no
    trailing slash. 'https://www.LSA.umich.edu/anthro/' -> 'lsa.umich.edu/anthro'."""
    if not url:
        return ""
    u = url.strip().lower()
    parsed = urlparse(u if "://" in u else "https://" + u)
    host = (parsed.netloc or "").removeprefix("www.")
    path = (parsed.path or "").rstrip("/")
    return f"{host}{path}"


def _read(url: str) -> str:
    if url.startswith("file://"):
        path = url[len("file://"):]
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    req = urllib.request.Request(url, headers={"User-Agent": "siteimprove-asana-sync"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (trusted URL)
        return resp.read().decode("utf-8")


def load_sites(url: str) -> list[Site]:
    raw = _read(url)
    data = json.loads(raw)
    rows = data.get("sites") if isinstance(data, dict) else data
    if not isinstance(rows, list):
        sys.exit(f"Unexpected Siteimprove data shape from {url}")

    sites: list[Site] = []
    for r in rows:
        site_url = r.get("url") or r.get("site") or ""
        if not site_url:
            continue  # can't match a site with no URL
        sites.append(
            Site(
                site_id=str(r.get("id") or ""),
                name=r.get("site_name") or r.get("name") or site_url,
                url=site_url,
                target_percentage=_num(r.get("target_percentage")),
                score=_num(r.get("score")),
                pages=_int(r.get("pages")),
                tags=list(r.get("tags") or []),
                source="inventory" if r.get("source") == "inventory" else "api",
            )
        )
    return sites


def _num(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _int(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
