#!/usr/bin/env python3
"""
Read-only Siteimprove API diagnostic.

Prints the raw JSON Siteimprove returns for a handful of sites so we can
see exactly which fields exist — e.g. why some sites report a 0 target
score while the UI shows one, and what the crawl/scan status endpoint
exposes. Writes nothing: no files, no commits, no Asana calls.

Usage:
  SITEIMPROVE_EMAIL=… SITEIMPROVE_API_KEY=… \
    python scripts/siteimprove_diagnostic.py [site_id,site_id,…]

With no IDs, it samples from data/sites.json: every site with a 0 target
score, up to 3 sites with 0 pages, up to 3 with no score, and 2 healthy
sites for comparison.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_siteimprove import (  # noqa: E402
    API_ROOT, SITE_TAG_CSV_PATH, env, get, load_inventory_rows, ping,
)

# Endpoints to dump per site. A 404 just means the path doesn't exist for
# this account/site — it's printed, not fatal.
ENDPOINTS = [
    "/sites/{id}",
    "/sites/{id}/a11y/overview/site_target/overview",
    "/sites/{id}/a11y/overview/groups",
    "/sites/{id}/content/crawl",
    "/sites/{id}/content/crawl/history",
    "/sites/{id}/dci/overview",
]


def default_ids() -> list[tuple[int, str]]:
    path = Path(__file__).resolve().parent.parent / "data" / "sites.json"
    sites = json.loads(path.read_text(encoding="utf-8"))["sites"]
    api = [s for s in sites if s.get("id") is not None and s.get("source") != "inventory"]
    picks: list[tuple[int, str]] = []
    picks += [(s["id"], "target 0") for s in api if s.get("target_percentage") == 0]
    picks += [(s["id"], "0 pages") for s in api if s.get("pages") == 0][:3]
    picks += [(s["id"], "no score") for s in api if s.get("score") is None][:3]
    picks += [(s["id"], "healthy") for s in api
              if (s.get("target_percentage") or 0) > 0 and (s.get("pages") or 0) > 0][:2]
    seen: set[int] = set()
    return [(i, why) for i, why in picks if not (i in seen or seen.add(i))]


def csv_pages_by_id() -> dict[int, str]:
    """'Pages crawled in last scan' from the committed export, for comparison.
    Reads only that column — never the users column."""
    import csv
    from fetch_siteimprove import _detect_csv_delimiter, _detect_csv_encoding, _norm_header
    if not SITE_TAG_CSV_PATH.exists():
        return {}
    enc = _detect_csv_encoding(SITE_TAG_CSV_PATH)
    delim = _detect_csv_delimiter(SITE_TAG_CSV_PATH, enc)
    out: dict[int, str] = {}
    with SITE_TAG_CSV_PATH.open(newline="", encoding=enc) as fh:
        for raw in csv.DictReader(fh, delimiter=delim):
            row = {_norm_header(k): (v or "") for k, v in raw.items()}
            try:
                out[int(row.get("site_id", "").strip())] = row.get("pages_crawled_in_last_scan", "")
            except ValueError:
                pass
    return out


def main() -> None:
    session = requests.Session()
    session.auth = (env("SITEIMPROVE_EMAIL"), env("SITEIMPROVE_API_KEY"))
    session.headers.update({"Accept": "application/json"})
    ping(session)

    if len(sys.argv) > 1 and sys.argv[1].strip():
        ids = [(int(x), "requested") for x in sys.argv[1].split(",") if x.strip()]
    else:
        ids = default_ids()
    csv_pages = csv_pages_by_id()
    names = {r["site_id"]: r["name"] for r in load_inventory_rows() if r["site_id"]}

    print(f"Diagnosing {len(ids)} site(s) against {API_ROOT}\n")
    for site_id, why in ids:
        print("=" * 78)
        print(f"site {site_id}  [{why}]  {names.get(site_id, '')}")
        print(f"  CSV 'Pages crawled in last scan': {csv_pages.get(site_id, '(not in CSV)')}")
        for template in ENDPOINTS:
            path = template.format(id=site_id)
            try:
                body = get(session, f"{API_ROOT}{path}")
                body = {k: v for k, v in body.items() if k != "_links"} if isinstance(body, dict) else body
                print(f"--- {path}\n{json.dumps(body, indent=2, default=str)}")
            except requests.HTTPError as exc:
                print(f"--- {path}\n  HTTP {exc.response.status_code}")
        print()


if __name__ == "__main__":
    main()
