"""Versioned, immutable accessibility observations and validated department mapping."""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo
from site_urls import is_junk_url

ROOT = Path(__file__).resolve().parents[1]
DETROIT = ZoneInfo("America/Detroit")
LEVELS = ("A", "AA", "ARIA", "AAA", "BP")


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


def normalized_url(value):
    parsed = urlsplit(value if "://" in value else "https://" + value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError(f"Expected an unambiguous site URL: {value!r}")
    port = parsed.port
    if (parsed.scheme, port) in (("http", 80), ("https", 443)):
        port = None
    return (parsed.hostname.lower().removeprefix("www.") + (f":{port}" if port else "") + parsed.path).rstrip("/")


def load_departments(path):
    by_id, by_url = {}, {}
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not {"site_id", "url", "department"}.issubset(reader.fieldnames or []):
            raise ValueError("Department CSV requires site_id,url,department headers")
        for line, row in enumerate(reader, 2):
            if None in row or any(row[k] is None for k in ("site_id", "url", "department")):
                raise ValueError(f"Malformed department CSV row on line {line}")
            sid, url, department = (row[k].strip() for k in ("site_id", "url", "department"))
            if not any((sid, url, department)):
                continue
            if not department or not (sid or url) or (sid and not sid.isdigit()):
                raise ValueError(f"Invalid department assignment on line {line}")
            for key, mapping in ((sid, by_id), (normalized_url(url) if url else "", by_url)):
                if key:
                    if key in mapping:
                        raise ValueError(f"Duplicate department key on line {line}: {key}")
                    mapping[key] = department
    return {"by_id": by_id, "by_url": by_url}


def normalize(snapshot, source, historical=False):
    if snapshot.get("in_progress") is not False or not isinstance(snapshot.get("sites"), list) or not snapshot["sites"]:
        raise ValueError("Snapshot must contain completed, nonempty site data")
    when = datetime.fromisoformat(snapshot["generated_at"].replace("Z", "+00:00"))
    if when.tzinfo is None:
        raise ValueError("Collection timestamp must include a timezone")
    rows, seen = [], set()
    for site in snapshot["sites"]:
        if is_junk_url(site.get("url")):
            continue
        tags = site.get("tags") or []
        if any(t.removeprefix("tag:").strip().lower() in {"test sites", "development"} for t in tags):
            continue
        url = site.get("url") or ""
        key = f"id:{site['id']}" if site.get("id") is not None else f"url:{normalized_url(url)}"
        if key in seen:
            raise ValueError(f"Ambiguous duplicate site identity: {key}")
        seen.add(key)
        scan = site.get("scan_status") or "unknown"
        reasons = []
        target = number(site.get("target_percentage"))
        if target is None or site.get("target_estimated"):
            reasons.append("Missing or estimated target")
        if site.get("errors"):
            reasons.append("Siteimprove target unavailable")
        if scan not in ("ok", "stale"):
            reasons.append(f"Scan: {scan}")
        levels = {
            level: {metric: number((site.get("by_level", {}).get(level) or {}).get(metric))
                    for metric in ("issues", "occurrences")}
            for level in LEVELS
        }
        issues_reliable = not reasons and all(
            levels[level][metric] is not None
            for level in LEVELS for metric in ("issues", "occurrences")
        ) and site.get("issues_available") is True
        rows.append({
            "key": key, "id": site.get("id"), "url": url,
            "site_name": site.get("site_name") or url, "tags": tags,
            "target_percentage": target, "pages": number(site.get("pages")),
            "target_estimated": bool(site.get("target_estimated")),
            "eligible": not reasons, "reasons": reasons, "scan_status": scan,
            "last_crawl": site.get("last_crawl"),
            "issues_reliable": issues_reliable,
            "by_level": levels,
            "pdf_count": number(site.get("pdf_count")),
            "pdfs_with_issues": number(site.get("pdfs_with_issues")),
            "pdf_total_issues": number(site.get("pdf_total_issues")),
            "pdfs_reliable": site.get("pdfs_available") is True,
        })
    if not any(row["target_percentage"] is not None for row in rows):
        raise ValueError("No compatible target percentages in snapshot")
    return {
        "schema_version": 1, "generated_at": when.astimezone(timezone.utc).isoformat(),
        "reporting_date": when.astimezone(DETROIT).date().isoformat(),
        "started_at": snapshot.get("started_at"), "source": source,
        "historical": historical, "sites": sorted(rows, key=lambda row: row["key"]),
        "quality_note": "Historical issue/PDF endpoint success was not recorded; those deltas are unavailable." if historical else "",
    }


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def append_snapshot(snapshot, directory, source, historical=False):
    payload = normalize(snapshot, source, historical)
    raw = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
    digest = hashlib.sha256(raw).hexdigest()[:16]
    stamp = datetime.fromisoformat(payload["generated_at"]).strftime("%Y%m%dT%H%M%SZ")
    name = f"{stamp}-{digest}.json.gz"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    if not path.exists():
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(gzip.compress(raw, mtime=0))
        temporary.replace(path)
    rebuild_index(directory)
    return path


def rebuild_index(directory):
    entries = []
    for path in sorted(directory.glob("*.json.gz")):
        payload = json.loads(gzip.decompress(path.read_bytes()))
        if payload.get("schema_version") != 1:
            raise ValueError(f"Unsupported history schema in {path.name}")
        sites = payload["sites"]
        eligible = [s for s in sites if s["eligible"]]
        entries.append({
            "path": f"history/{path.name}", "generated_at": payload["generated_at"],
            "date": payload["reporting_date"], "historical": payload["historical"],
            "site_count": len(sites), "eligible_count": len(eligible),
            "mean_target": sum(s["target_percentage"] for s in eligible) / len(eligible) if eligible else None,
        })
    entries.sort(key=lambda e: (e["generated_at"], e["path"]))
    atomic_json(directory / "index.json", {"schema_version": 1, "entries": entries})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--backfill", action="store_true")
    args = parser.parse_args()
    directory = args.data_dir / "history"
    mapping = load_departments(args.data_dir / "site-departments.csv")
    atomic_json(args.data_dir / "departments.json", mapping)
    if args.backfill:
        commits = subprocess.check_output(
            ["git", "log", "--reverse", "--format=%H", "--", "data/sites.json"], cwd=ROOT, text=True
        ).splitlines()
        imported = 0
        for commit in commits:
            raw = subprocess.check_output(["git", "show", f"{commit}:data/sites.json"], cwd=ROOT)
            try:
                append_snapshot(json.loads(raw), directory, f"git:{commit}", historical=True)
            except (ValueError, KeyError) as exc:
                print(f"Skipping incompatible historical snapshot {commit[:12]}: {exc}", file=sys.stderr)
                continue
            imported += 1
        print(f"Validated {imported} historical observations.")
        rebuild_index(directory)
        if not (args.data_dir / "refresh-status.json").exists():
            index = json.loads((directory / "index.json").read_text())
            latest = index["entries"][-1] if index["entries"] else None
            atomic_json(args.data_dir / "refresh-status.json", {
                "success": True, "historical_only": True,
                "attempted_at": latest["generated_at"] if latest else None,
            })
    else:
        snapshot = json.loads((args.data_dir / "sites.json").read_text())
        if not snapshot.get("collection_complete"):
            raise ValueError("Refusing to archive a collection without verified completeness")
        append_snapshot(snapshot, directory, snapshot.get("source_run") or "local")
    size = sum(path.stat().st_size for path in directory.glob("*") if path.is_file())
    print(f"History archive: {size / 1024**2:.1f} MiB (retained indefinitely).")
    if size > 500 * 1024**2:
        print("::warning::History exceeds 500 MiB; review repository and Pages capacity.")


if __name__ == "__main__":
    main()
