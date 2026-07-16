"""
Run-time tag overlay for the Asana sync.

The sync reads metrics from sites.json, but that file's tags are only as
fresh as the last full fetch. To let a CSV push take effect by running the
sync alone (no ~15-min fetch), this module re-reads the committed
Siteimprove CSV export and overlays its tags onto the loaded sites,
matched by site id, then URL, then name — the same precedence the fetch
pipeline uses.

Self-contained (only stdlib) so the sync package doesn't cross-import the
fetch script from scripts/.
"""

from __future__ import annotations

import csv
import io
import re
import sys
import urllib.request

from .siteimprove_source import Site, normalize_url

_TAG_SPLIT = re.compile(r"[,|;]")


def _norm_header(k: str | None) -> str:
    return (k or "").strip().lower().replace(" ", "_")


def _read_bytes(url: str) -> bytes:
    if url.startswith("file://"):
        with open(url[len("file://"):], "rb") as fh:
            return fh.read()
    req = urllib.request.Request(url, headers={"User-Agent": "asana-sync"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
        return resp.read()


def _decode(raw: bytes) -> str:
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    return raw.decode("utf-8-sig")


def load_csv_tags(url: str) -> tuple[dict[int, list[str]], dict[str, list[str]], dict[str, list[str]]]:
    """Return (by_id, by_url, by_name) tag lookups from the Siteimprove CSV
    export. Empty dicts if the file is missing or has no site rows."""
    try:
        text = _decode(_read_bytes(url))
    except (FileNotFoundError, OSError):
        return {}, {}, {}
    first = text.splitlines()[0] if text else ""
    delimiter = "\t" if "\t" in first else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    headers = {_norm_header(h) for h in (reader.fieldnames or [])}
    if not headers & {"site_id", "id", "site_url", "url", "site_name", "name"}:
        # Wrong export (e.g. the tag-summary report) — don't wipe tags.
        print(f"  ⚠ tag overlay: {url} isn't the per-site export "
              f"(headers {sorted(headers)}); keeping sites.json tags.",
              file=sys.stderr)
        return {}, {}, {}
    by_id: dict[int, list[str]] = {}
    by_url: dict[str, list[str]] = {}
    by_name: dict[str, list[str]] = {}
    for raw in reader:
        row = {_norm_header(k): (v or "") for k, v in raw.items()}
        tags = [t.strip() for t in _TAG_SPLIT.split(row.get("tags") or row.get("labels") or "") if t.strip()]
        if not tags:
            continue
        sid = row.get("site_id") or row.get("id")
        if sid:
            try:
                by_id[int(str(sid).strip())] = tags
            except ValueError:
                pass
        url_key = normalize_url(row.get("site_url") or row.get("url"))
        if url_key:
            by_url[url_key] = tags
        name = (row.get("site_name") or row.get("name") or "").strip().lower()
        if name:
            by_name[name] = tags
    return by_id, by_url, by_name


def overlay_tags(sites: list[Site], csv_url: str) -> int:
    """Overlay CSV tags onto sites in place (matched id -> url -> name).
    Tags are stored as 'tag:<label>' to match sites.json convention. A site
    the CSV doesn't list keeps whatever tags sites.json already had (the CSV
    only lists tagged sites, so absence != untagged). Returns how many sites
    had their tags changed."""
    by_id, by_url, by_name = load_csv_tags(csv_url)
    if not (by_id or by_url or by_name):
        return 0
    changed = 0
    for s in sites:
        try:
            sid = int(s.site_id) if s.site_id else None
        except (TypeError, ValueError):
            sid = None
        labels = (
            (by_id.get(sid) if sid is not None else None)
            or by_url.get(s.norm_url)
            or by_name.get((s.name or "").strip().lower())
        )
        if labels is None:
            continue
        new_tags = [f"tag:{lbl}" for lbl in labels]
        if new_tags != s.tags:
            s.tags = new_tags
            changed += 1
    return changed
