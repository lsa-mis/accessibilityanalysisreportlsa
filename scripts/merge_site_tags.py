#!/usr/bin/env python3
"""
Lightweight tag refresh: re-applies data/site-tags.csv onto the existing
data/sites.json without re-fetching from the Siteimprove API.

Use this when only the admin-configured site labels have changed. The
tag-merge workflow runs this on every push that touches site-tags.csv,
so the dashboard reflects new labels in seconds instead of waiting for
the next full crawl.

For everything else (scores, page counts, issues, PDFs, misspellings)
keep using scripts/fetch_siteimprove.py — that hits the API.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_siteimprove import load_site_tag_csv, lookup_csv_tags  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SITES_PATH = ROOT / "data" / "sites.json"


def main() -> None:
    if not SITES_PATH.exists():
        sys.exit(
            "data/sites.json is missing — run scripts/fetch_siteimprove.py first "
            "so there's a snapshot to merge tags into."
        )
    snapshot = json.loads(SITES_PATH.read_text(encoding="utf-8"))

    by_id, by_url, by_name = load_site_tag_csv()
    if not (by_id or by_url or by_name):
        print(
            "No data/site-tags.csv found — nothing to merge. "
            "Existing tag arrays were not modified.",
            file=sys.stderr,
        )
        return

    sites = snapshot.get("sites") or []
    matched = 0
    cleared = 0
    for site in sites:
        labels = lookup_csv_tags(site, by_id, by_url, by_name)
        had_tags = bool(site.get("tags"))
        site["tags"] = [f"tag:{label}" for label in labels]
        if labels:
            matched += 1
        elif had_tags:
            cleared += 1

    SITES_PATH.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    print(
        f"Merged tags for {matched}/{len(sites)} sites; "
        f"cleared previously-tagged but unmatched: {cleared}.",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
