#!/usr/bin/env python3
"""
Fetch site-level accessibility data from the Siteimprove API and write
two JSON snapshots used by accessibiltiyreport/data.html:

  data/sites.json — per-site overview with scores, target %, A/AA/AAA breakdowns
  data/rules.json — cross-site rollup of failing accessibility rules

Auth: HTTP Basic. Username = SITEIMPROVE_EMAIL, password = SITEIMPROVE_API_KEY.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse

import requests

API_ROOT = os.environ.get("SITEIMPROVE_API_ROOT", "https://api.siteimprove.com/v2").rstrip("/")
PAGE_SIZE = 100
REQUEST_TIMEOUT = 60
MAX_RETRIES = 4
RETRY_BACKOFF_SECONDS = 5
MAX_WORKERS = int(os.environ.get("SITEIMPROVE_MAX_WORKERS", "8"))
FLUSH_EVERY_SECONDS = int(os.environ.get("SITEIMPROVE_FLUSH_SECONDS", "10"))

LEVEL_KEYS = ("A", "AA", "AAA", "ARIA")

# Lifecycle subdomain heuristics — first match wins.
LIFECYCLE_PATTERNS = [
    ("staging", re.compile(r"^(staging|stage|stg)\b")),
    ("dev",     re.compile(r"^(dev|develop|development)\b")),
    ("test",    re.compile(r"^(test|qa)\b")),
    ("train",   re.compile(r"^(train|training)\b")),
    ("author",  re.compile(r"^(author|edit|editor|aem-author)\b")),
    ("preview", re.compile(r"^(preview|prev|preprod)\b")),
]

# Platform heuristics from site_name prefix or URL — best-effort.
PLATFORM_PATTERNS = [
    ("aem",       re.compile(r"^aem\b|aem-|adobe[- ]experience", re.IGNORECASE)),
    ("wordpress", re.compile(r"\bwordpress\b|\bwp[- ]", re.IGNORECASE)),
    ("drupal",    re.compile(r"\bdrupal\b", re.IGNORECASE)),
    ("squarespace", re.compile(r"\bsquarespace\b", re.IGNORECASE)),
    ("wix",       re.compile(r"\bwix\b", re.IGNORECASE)),
]


def derive_tags(site_name: str | None, url: str | None) -> list[str]:
    tags: list[str] = []
    name = (site_name or "").strip()
    parsed = urlparse(url or "")
    host = (parsed.hostname or "").lower()
    subdomain = host.split(".")[0] if host else ""

    # Lifecycle
    lifecycle = "production"
    for tag, pat in LIFECYCLE_PATTERNS:
        if pat.search(subdomain):
            lifecycle = tag
            break
    tags.append(f"lifecycle:{lifecycle}")

    # Domain class
    if host.endswith(".lsa.umich.edu") or host == "lsa.umich.edu":
        domain_class = "lsa-umich"
    elif host.endswith(".umich.edu") or host == "umich.edu":
        domain_class = "umich"
    elif host:
        domain_class = "external"
    else:
        domain_class = "unknown"
    tags.append(f"domain:{domain_class}")

    # Platform — search both name and host (without subdomain) for signals.
    haystack = f"{name} {host}"
    for tag, pat in PLATFORM_PATTERNS:
        if pat.search(haystack):
            tags.append(f"platform:{tag}")
            break

    return tags


def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"Missing required env var: {name}")
    return value


def get(session: requests.Session, url: str) -> dict[str, Any]:
    for attempt in range(1, MAX_RETRIES + 1):
        response = session.get(url, timeout=REQUEST_TIMEOUT)
        if response.status_code == 429 or response.status_code >= 500:
            if attempt == MAX_RETRIES:
                response.raise_for_status()
            sleep_for = RETRY_BACKOFF_SECONDS * attempt
            print(f"  retry {attempt} after {sleep_for}s ({response.status_code})", file=sys.stderr)
            time.sleep(sleep_for)
            continue
        response.raise_for_status()
        return response.json()
    raise RuntimeError("unreachable")


def paginate(session: requests.Session, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    params = dict(params or {})
    params.setdefault("page_size", PAGE_SIZE)
    items: list[dict[str, Any]] = []
    page = 1
    while True:
        params["page"] = page
        url = f"{API_ROOT}{path}?{urlencode(params)}"
        payload = get(session, url)
        batch = payload.get("items") or []
        items.extend(batch)
        total_pages = payload.get("total_pages") or 1
        if page >= total_pages or not batch:
            break
        page += 1
    return items


def ping(session: requests.Session) -> None:
    try:
        get(session, f"{API_ROOT}/ping/account")
    except requests.HTTPError as exc:
        sys.exit(
            f"Auth check failed: {exc.response.status_code} {exc.response.reason}\n"
            f"  URL: {API_ROOT}/ping/account\n"
            f"  Verify SITEIMPROVE_EMAIL / SITEIMPROVE_API_KEY are correct."
        )


def fetch_site_target(session: requests.Session, site_id: int) -> dict[str, Any]:
    try:
        return get(session, f"{API_ROOT}/sites/{site_id}/a11y/overview/site_target/overview")
    except requests.HTTPError as exc:
        return {"_error": f"target {exc.response.status_code}"}


def fetch_site_issues(session: requests.Session, site_id: int) -> list[dict[str, Any]]:
    try:
        return paginate(session, f"/sites/{site_id}/a11y/issue_kinds/confirmed/issues")
    except requests.HTTPError as exc:
        print(f"  issues fetch failed: {exc.response.status_code}", file=sys.stderr)
        return []


def fetch_site_groups(session: requests.Session, site_id: int) -> list[str]:
    """Best-effort fetch of accessibility groups (server-side tags). Silent on errors."""
    try:
        payload = get(session, f"{API_ROOT}/sites/{site_id}/a11y/overview/groups")
        items = payload.get("items") or []
        names: list[str] = []
        for item in items:
            label = item.get("name") or item.get("group_name") or item.get("title")
            if label:
                names.append(f"group:{label}")
        return names
    except requests.HTTPError:
        return []


def fetch_site_detail(session: requests.Session, site_id: int) -> dict[str, Any]:
    """Fetch /sites/{id} for any extra fields not present in /sites listing."""
    try:
        return get(session, f"{API_ROOT}/sites/{site_id}")
    except requests.HTTPError:
        return {}


def fetch_site_pdfs(session: requests.Session, site_id: int) -> list[dict[str, Any]]:
    """Fetch list of PDFs flagged by the accessibility module for this site."""
    try:
        return paginate(session, f"/sites/{site_id}/a11y/validation/pdfs")
    except requests.HTTPError:
        return []


def summarize_pdfs(pdfs: list[dict[str, Any]]) -> dict[str, Any]:
    """Pull useful counts out of the PDF list — defensive about field names."""
    pdf_count = len(pdfs)
    issue_keys = ("issues", "errors", "issue_count", "error_count", "occurrences")
    total_issues = 0
    pdfs_with_issues = 0
    for pdf in pdfs:
        n = 0
        for k in issue_keys:
            v = pdf.get(k)
            if isinstance(v, (int, float)):
                n = int(v)
                break
        if n > 0:
            pdfs_with_issues += 1
            total_issues += n
    return {
        "pdf_count": pdf_count,
        "pdfs_with_issues": pdfs_with_issues,
        "pdf_total_issues": total_issues,
    }


def coerce_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def coerce_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_level(value: Any) -> str | None:
    """Return 'A', 'AA', 'AAA', or 'ARIA' — strict exact match so 'aria'
    is preserved as its own bucket rather than mis-falling-into AA."""
    if not value:
        return None
    text = str(value).strip().upper()
    return text if text in LEVEL_KEYS else None


def aggregate_site_issues(issues: list[dict[str, Any]]) -> dict[str, Any]:
    by_level = {k: {"issues": 0, "occurrences": 0, "pages": 0} for k in LEVEL_KEYS}
    total_issues = 0
    total_occurrences = 0
    max_pages_affected = 0
    other_conformance: dict[str, dict[str, int]] = defaultdict(lambda: {"issues": 0, "occurrences": 0})

    for issue in issues:
        raw_level = issue.get("conformance")
        level = normalize_level(raw_level)
        occ = coerce_int(issue.get("occurrences")) or 0
        pages_affected = coerce_int(issue.get("pages")) or 0
        if pages_affected > max_pages_affected:
            max_pages_affected = pages_affected

        total_issues += 1
        total_occurrences += occ

        if level:
            by_level[level]["issues"] += 1
            by_level[level]["occurrences"] += occ
            by_level[level]["pages"] = max(by_level[level]["pages"], pages_affected)
        elif raw_level:
            bucket = other_conformance[str(raw_level).lower()]
            bucket["issues"] += 1
            bucket["occurrences"] += occ

    return {
        "total_issues": total_issues,
        "total_occurrences": total_occurrences,
        "max_pages_affected": max_pages_affected,
        "by_level": by_level,
        "other_conformance": dict(other_conformance),
    }


def shape_site_row(
    site: dict[str, Any],
    target: dict[str, Any],
    rollup: dict[str, Any],
    groups: list[str] | None = None,
) -> dict[str, Any]:
    score = coerce_float(target.get("accessibility_dci_score"))
    target_score = coerce_float(target.get("accessibility_dci_target_score"))
    target_percentage = coerce_float(target.get("site_target_percentage"))
    site_name = site.get("site_name") or site.get("sitename") or site.get("name")
    url = site.get("url") or site.get("site")

    # Authoritative page count from /sites; fall back to derived only if
    # the API value is missing entirely (0 is a legitimate value — not crawled).
    api_pages = site.get("pages")
    pages = coerce_int(api_pages) if api_pages is not None else None
    pages_with_issues = rollup.get("max_pages_affected") or 0

    tags = derive_tags(site_name, url)
    # Real product/module enablement from /sites — data-driven, not a heuristic.
    products = site.get("product") or []
    if isinstance(products, list):
        for product in products:
            if product:
                tags.append(f"product:{product}")
    if groups:
        tags.extend(groups)
    # Defensive: if either /sites or /sites/{id} ever returns a tags
    # / category / department / domain field, surface it as a tag.
    for source in (site, target):
        if not isinstance(source, dict):
            continue
        for tagish_key in ("tags", "category", "categories", "department", "domain", "labels"):
            value = source.get(tagish_key)
            if isinstance(value, list):
                for v in value:
                    if v:
                        tags.append(f"{tagish_key}:{v}")
            elif isinstance(value, str) and value:
                tags.append(f"{tagish_key}:{value}")

    return {
        "id": site.get("id"),
        "site_name": site_name,
        "url": url,
        "score": score,
        "target_score": target_score,
        "target_percentage": target_percentage,
        "pages": pages,
        "pages_with_issues": pages_with_issues,
        "visits": coerce_int(site.get("visits")),
        "policies": coerce_int(site.get("policies")),
        "issues": rollup["total_occurrences"],
        "issue_types": rollup["total_issues"],
        "by_level": rollup["by_level"],
        "other_conformance": rollup["other_conformance"],
        "tags": tags,
        "errors": [target["_error"]] if target.get("_error") else None,
    }


def build_rule_rollup(per_site_issues: list[tuple[dict[str, Any], list[dict[str, Any]]]]) -> list[dict[str, Any]]:
    """Aggregate confirmed issues across all sites by rule_id."""
    by_rule: dict[int, dict[str, Any]] = defaultdict(lambda: {
        "rule_id": None,
        "title": None,
        "description": None,
        "conformance": None,
        "level": None,
        "difficulty": None,
        "sites_affected": set(),
        "total_occurrences": 0,
        "max_pages": 0,
    })

    for site, issues in per_site_issues:
        site_id = site.get("id")
        for issue in issues:
            rule_id = issue.get("rule_id")
            if rule_id is None:
                continue
            help_block = issue.get("help") or {}
            bucket = by_rule[rule_id]
            bucket["rule_id"] = rule_id
            bucket["title"] = bucket["title"] or help_block.get("title")
            bucket["description"] = bucket["description"] or help_block.get("description")
            bucket["conformance"] = bucket["conformance"] or issue.get("conformance")
            bucket["level"] = bucket["level"] or normalize_level(issue.get("conformance"))
            bucket["difficulty"] = bucket["difficulty"] or coerce_int(issue.get("difficulty"))
            if site_id is not None:
                bucket["sites_affected"].add(site_id)
            bucket["total_occurrences"] += coerce_int(issue.get("occurrences")) or 0
            pages = coerce_int(issue.get("pages")) or 0
            if pages > bucket["max_pages"]:
                bucket["max_pages"] = pages

    rows: list[dict[str, Any]] = []
    for bucket in by_rule.values():
        bucket["sites_affected"] = len(bucket["sites_affected"])
        rows.append(bucket)
    rows.sort(key=lambda r: -r["total_occurrences"])
    return rows


def main() -> None:
    email = env("SITEIMPROVE_EMAIL")
    api_key = env("SITEIMPROVE_API_KEY")

    session = requests.Session()
    session.auth = (email, api_key)
    session.headers.update({"Accept": "application/json"})

    print(f"Auth check against {API_ROOT}...", file=sys.stderr)
    ping(session)
    print("  ok", file=sys.stderr)

    print("Fetching site list...", file=sys.stderr)
    sites = paginate(session, "/sites")
    print(f"  found {len(sites)} sites", file=sys.stderr)

    runnable_sites = [s for s in sites if s.get("id") is not None]

    def fetch_one(site: dict[str, Any]) -> tuple[
        dict[str, Any], dict[str, Any], list[dict[str, Any]], list[str], dict[str, Any], dict[str, Any]
    ]:
        site_id = site["id"]
        target = fetch_site_target(session, site_id)
        issues = fetch_site_issues(session, site_id)
        groups = fetch_site_groups(session, site_id)
        detail = fetch_site_detail(session, site_id)
        pdfs = summarize_pdfs(fetch_site_pdfs(session, site_id))
        return site, target, issues, groups, detail, pdfs

    site_rows: list[dict[str, Any]] = []
    per_site_issues: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    total = len(runnable_sites)
    started = time.monotonic()
    last_flush = started

    out_dir = Path(__file__).resolve().parent.parent / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    def write_partial(in_progress: bool) -> None:
        snapshot = {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "site_count": len(site_rows),
            "in_progress": in_progress,
            "progress": {"completed": len(site_rows), "total": total},
            "sites": site_rows,
        }
        tmp = out_dir / "sites.json.tmp"
        tmp.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
        tmp.replace(out_dir / "sites.json")

    # Initial empty in-progress file so the dashboard can start polling immediately.
    write_partial(in_progress=True)

    print(f"Fetching per-site data with {MAX_WORKERS} workers...", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(fetch_one, s): s for s in runnable_sites}
        for index, future in enumerate(as_completed(futures), start=1):
            site, target, issues, groups, detail, pdfs = future.result()
            per_site_issues.append((site, issues))
            rollup = aggregate_site_issues(issues)
            row = shape_site_row(site, target, rollup, groups)
            row.update(pdfs)
            # Surface any extra metadata from /sites/{id} (only fields not
            # already present on the listing row), so we can audit later.
            extras = {
                k: v for k, v in (detail or {}).items()
                if k not in row and k not in ("_links",) and not k.startswith("_")
            }
            if extras:
                row["site_detail"] = extras
            site_rows.append(row)

            now = time.monotonic()
            if now - last_flush >= FLUSH_EVERY_SECONDS:
                write_partial(in_progress=True)
                last_flush = now

            if index % 25 == 0 or index == total:
                elapsed = now - started
                rate = index / elapsed if elapsed else 0
                eta = (total - index) / rate if rate else 0
                print(f"  {index}/{total} done ({rate:.1f}/s, ~{eta:.0f}s remaining)", file=sys.stderr)

    # Final write — clears in_progress flag.
    write_partial(in_progress=False)

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rules_snapshot = {
        "generated_at": generated_at,
        "rules": build_rule_rollup(per_site_issues),
    }
    (out_dir / "rules.json").write_text(json.dumps(rules_snapshot, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_dir / 'sites.json'} and {out_dir / 'rules.json'}", file=sys.stderr)


if __name__ == "__main__":
    main()
