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


def rule_order(rule_id):
    """Numeric order for Siteimprove's integer rule ids, held as strings."""
    return len(rule_id), rule_id


def rules_from_same_run(payload, rules):
    """True when rules.json was written by the collection run behind this observation
    and lists per-site counts for every rule."""
    try:
        when = datetime.fromisoformat(str(rules["generated_at"]).replace("Z", "+00:00"))
        return when == datetime.fromisoformat(payload["generated_at"]) and all(
            isinstance(rule["sites"], list) for rule in rules["rules"])
    except (KeyError, TypeError, ValueError):
        return False


def attach_rule_counts(payload, rules):
    """Add each site's occurrences per Siteimprove rule (issue title) to an observation.

    Sets payload["rules"] to {rule_id: {"title", "level"}} and, on each site whose issue
    counts are reliable, "rule_occurrences" to {rule_id: occurrences}. A site only gets
    counts that add up to its archived per-level totals; anything else stays
    unavailable, never zero. Returns how many sites received counts."""
    if not rules_from_same_run(payload, rules):
        return 0
    catalog, per_site = {}, {}
    try:
        for rule in rules["rules"]:
            rule_id = str(rule["rule_id"])
            catalog[rule_id] = {"title": (rule.get("title") or "").strip(), "level": rule.get("level")}
            for site_id, occurrences, *_ in rule["sites"]:
                if not isinstance(number(occurrences), int):
                    raise ValueError(f"Invalid occurrence count for rule {rule_id}")
                per_site.setdefault(site_id, {})[rule_id] = occurrences
    except (KeyError, TypeError, ValueError):
        return 0
    attached = 0
    for row in payload["sites"]:
        counts = per_site.get(row["id"], {})
        totals = dict.fromkeys(LEVELS, 0)
        for rule_id, occurrences in counts.items():
            if catalog[rule_id]["level"] in totals:
                totals[catalog[rule_id]["level"]] += occurrences
        if row["issues_reliable"] and all(totals[level] == row["by_level"][level]["occurrences"] for level in LEVELS):
            row["rule_occurrences"] = {rule_id: counts[rule_id] for rule_id in sorted(counts, key=rule_order)}
            attached += 1
    if attached:
        payload["rules"] = {rule_id: catalog[rule_id] for rule_id in sorted(catalog, key=rule_order)}
    return attached


def normalize(snapshot, source, historical=False, rules=None):
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
    payload = {
        "schema_version": 1, "generated_at": when.astimezone(timezone.utc).isoformat(),
        "reporting_date": when.astimezone(DETROIT).date().isoformat(),
        "started_at": snapshot.get("started_at"), "source": source,
        "historical": historical, "sites": sorted(rows, key=lambda row: row["key"]),
        "quality_note": "Historical issue/PDF endpoint success was not recorded; those deltas are unavailable." if historical else "",
    }
    if rules is not None:
        attach_rule_counts(payload, rules)
    return payload


def atomic_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def append_snapshot(snapshot, directory, source, historical=False, rules=None):
    path = write_observation(normalize(snapshot, source, historical, rules), directory)
    rebuild_index(directory)
    return path


def write_observation(payload, directory):
    raw = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
    identity = {key: value for key, value in payload.items() if key != "source"}
    digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()[:16]
    stamp = datetime.fromisoformat(payload["generated_at"]).strftime("%Y%m%dT%H%M%SZ")
    name = f"{stamp}-{digest}.json.gz"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    if not path.exists():
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(gzip.compress(raw, mtime=0))
        temporary.replace(path)
    return path


def backfill_rule_counts(directory):
    """Add per-rule counts to archived observations that lack them, from the rules.json
    that the same collection run committed to Git. The enriched observation replaces
    its file (the name carries a content digest); everything already archived is kept
    as it was. Observations with no matching per-site rule data stay untouched."""
    commits = subprocess.check_output(
        ["git", "log", "--format=%H", "--", "data/rules.json"], cwd=ROOT, text=True
    ).splitlines()
    by_time = {}
    for commit in commits:
        try:
            rules = json.loads(subprocess.check_output(["git", "show", f"{commit}:data/rules.json"], cwd=ROOT))
            by_time.setdefault(datetime.fromisoformat(str(rules["generated_at"]).replace("Z", "+00:00")), rules)
        except (subprocess.CalledProcessError, KeyError, TypeError, ValueError):
            continue
    enriched = 0
    for path in sorted(directory.glob("*.json.gz")):
        payload = json.loads(gzip.decompress(path.read_bytes()))
        rules = by_time.get(datetime.fromisoformat(payload["generated_at"]))
        if "rules" in payload or rules is None or not attach_rule_counts(payload, rules):
            continue
        if write_observation(payload, directory) != path:
            path.unlink()
        enriched += 1
    rebuild_index(directory)
    return enriched


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
            "rule_counts": "rules" in payload,
        })
    entries.sort(key=lambda e: (e["generated_at"], e["path"]))
    atomic_json(directory / "index.json", {"schema_version": 1, "entries": entries})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument("--backfill", action="store_true")
    parser.add_argument("--backfill-rule-counts", action="store_true",
                        help="add per-rule counts to archived observations from the rules.json in Git")
    args = parser.parse_args()
    directory = args.data_dir / "history"
    mapping = load_departments(args.data_dir / "site-departments.csv")
    atomic_json(args.data_dir / "departments.json", mapping)
    if args.backfill_rule_counts:
        print(f"Added per-rule counts to {backfill_rule_counts(directory)} archived observation(s).")
    elif args.backfill:
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
        rules_path = args.data_dir / "rules.json"
        rules = json.loads(rules_path.read_text()) if rules_path.exists() else None
        path = append_snapshot(snapshot, directory, snapshot.get("source_run") or "local", rules=rules)
        if "rules" not in json.loads(gzip.decompress(path.read_bytes())):
            print("::warning::Per-rule counts were not archived: rules.json is missing, from another run, or does not add up.")
    size = sum(path.stat().st_size for path in directory.glob("*") if path.is_file())
    print(f"History archive: {size / 1024**2:.1f} MiB (retained indefinitely).")
    if size > 500 * 1024**2:
        print("::warning::History exceeds 500 MiB; review repository and Pages capacity.")


if __name__ == "__main__":
    main()
