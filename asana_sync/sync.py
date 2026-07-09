#!/usr/bin/env python3
"""
Siteimprove → Asana sync.

For the one project named in config.ASANA_PROJECT_NAME:
  1. Ensure the platform sections exist (AEM, WordPress, Rails, Google
     Sites, Omeka, dotNet, + a fallback).
  2. Match each Siteimprove site to an Asana task by normalised URL.
  3. Update the allow-listed custom fields (Added to Siteimprove,
     Siteimprove Issues Remediation (98%)) when they differ.
  4. Create a task in the right section for any Siteimprove site that has
     no matching task (when CREATE_MISSING is on).

Honours DRY_RUN (default true) — in dry-run nothing is written and every
intended change is logged. Run:  python -m src.sync   (from repo root)
"""

from __future__ import annotations

import sys

from . import config
from .asana_client import AsanaClient
from .inventory_source import load_inventory
from .siteimprove_source import Site, load_sites, normalize_url


# --------------------------------------------------------------------------
# Mapping helpers
# --------------------------------------------------------------------------
def section_for(site: Site) -> str | None:
    """Return the configured section name for a site based on its tags."""
    tags = set(site.plain_tags)
    for section in config.SECTIONS:
        for matcher in section["match"]:
            if matcher.lower() in tags:
                return section["name"]
    return config.FALLBACK_SECTION


def derive_field_values(site: Site) -> dict[str, str]:
    """Logical value-key -> desired enum option NAME for this site.

    Every site comes from the Siteimprove inventory export, so
    'Added to Siteimprove' is always True. Remediation is only asserted
    when the site was actually scored (has a target %); for unscored sites
    we omit it rather than claim False."""
    out = {"added_to_siteimprove": "True"}
    if site.target_percentage is not None:
        met = site.target_percentage >= config.REMEDIATION_THRESHOLD
        out["remediation_met"] = "True" if met else "False"
    return out


def derive_number_values(site: Site) -> dict[str, float]:
    """Logical value-key -> numeric value. Omits keys with no data so we
    never overwrite a real value with a blank."""
    out: dict[str, float] = {}
    if site.target_percentage is not None:
        out["target_percentage"] = round(site.target_percentage, 2)
    return out


def enum_option_gid(field_meta: dict, option_name: str) -> str | None:
    return field_meta.get("enum_options", {}).get(option_name.strip().lower())


def current_number_value(task: dict, field_name: str) -> float | None:
    target = field_name.strip()
    for cf in task.get("custom_fields") or []:
        if (cf.get("name") or "").strip() == target:
            v = cf.get("number_value")
            try:
                return float(v) if v is not None else None
            except (TypeError, ValueError):
                return None
    return None


def current_enum_name(task: dict, field_name: str) -> str | None:
    # Compare on stripped names to match custom_field_map, which strips
    # trailing/leading whitespace from board field names.
    target = field_name.strip()
    for cf in task.get("custom_fields") or []:
        if (cf.get("name") or "").strip() == target:
            ev = cf.get("enum_value") or {}
            return ev.get("name")
    return None


# --------------------------------------------------------------------------
# Build the custom_fields payload {field_gid: option_gid} for a site,
# limited to fields that (a) are in the allow-list, (b) exist on the board,
# and (c) actually need changing (for updates).
# --------------------------------------------------------------------------
def build_field_payload(site: Site, field_map: dict[str, dict],
                        existing_task: dict | None) -> tuple[dict, list[str]]:
    desired = derive_field_values(site)
    payload: dict[str, object] = {}
    notes: list[str] = []

    # Enum fields (Added to Siteimprove, Remediation (98%)).
    for field_name, value_key in config.FIELD_WRITES.items():
        meta = field_map.get(field_name)
        if not meta:
            continue  # field not on this board; skip quietly
        want_name = desired.get(value_key)
        if want_name is None:
            continue
        opt_gid = enum_option_gid(meta, want_name)
        if not opt_gid:
            notes.append(f"!{field_name}: no option {want_name!r}")
            continue
        if existing_task is not None:
            have = current_enum_name(existing_task, field_name)
            if (have or "").strip().lower() == want_name.strip().lower():
                continue  # already correct — don't write
        payload[meta["gid"]] = opt_gid
        notes.append(f"{field_name}={want_name}")

    # Number fields (Siteimprove Target %).
    numbers = derive_number_values(site)
    for field_name, value_key in config.NUMBER_FIELD_WRITES.items():
        meta = field_map.get(field_name)
        if not meta:
            continue
        want = numbers.get(value_key)
        if want is None:
            continue
        if existing_task is not None:
            have = current_number_value(existing_task, field_name)
            # Skip when already equal to the precision we write at.
            if have is not None and abs(have - want) < 0.005:
                continue
        payload[meta["gid"]] = want
        notes.append(f"{field_name}={want}")

    return payload, notes


def main() -> None:
    print(f"Siteimprove → Asana sync  (DRY_RUN={config.DRY_RUN}, "
          f"CREATE_MISSING={config.CREATE_MISSING})")

    # 1. Build the working site list: full CSV inventory (authoritative tags
    #    + complete coverage) enriched with sites.json metrics where scored.
    print(f"Loading inventory from {config.INVENTORY_URL} …")
    inventory = load_inventory(config.INVENTORY_URL)
    print(f"  {len(inventory)} inventory rows")

    print(f"Loading Siteimprove metrics from {config.SITEIMPROVE_DATA_URL} …")
    metrics = load_sites(config.SITEIMPROVE_DATA_URL)
    by_id = {m.site_id: m for m in metrics if m.site_id}
    by_url = {m.norm_url: m for m in metrics if m.norm_url}
    print(f"  {len(metrics)} scored sites for enrichment")

    sites: list[Site] = []
    excluded = 0
    for row in inventory:
        plain = {(t.split(':', 1)[1] if ':' in t else t).strip().lower() for t in row.tags}
        if plain & config.EXCLUDED_TAGS:
            excluded += 1
            continue
        m = by_id.get(row.site_id) or by_url.get(normalize_url(row.url))
        sites.append(Site(
            site_id=row.site_id,
            name=row.name,
            url=row.url,
            target_percentage=m.target_percentage if m else None,
            score=m.score if m else None,
            pages=m.pages if m else None,
            tags=row.tags,
        ))
    print(f"  {len(sites)} sites to reconcile "
          f"({excluded} excluded by tag, "
          f"{sum(1 for s in sites if s.target_percentage is not None)} scored)")

    # 2. Asana project + schema
    asana = AsanaClient(config.ASANA_TOKEN, config.DRY_RUN,
                        config.ASANA_WRITE_DELAY_SECONDS)
    project = asana.resolve_project(
        project_gid=config.ASANA_PROJECT_GID,
        project_name=config.ASANA_PROJECT_NAME,
        workspace_gid=config.ASANA_WORKSPACE_GID,
    )
    project_gid = project["gid"]
    print(f"  project: {project.get('name')} ({project_gid})")

    field_map = asana.custom_field_map(project_gid)
    print(f"  custom fields on board: {', '.join(sorted(field_map)) or '(none)'}")
    for fname in config.FIELD_WRITES:
        if fname not in field_map:
            print(f"  ⚠ field not found, will skip: {fname!r}", file=sys.stderr)

    # Ensure number fields (e.g. Siteimprove Target %) exist. Create them
    # only when CREATE_MISSING_FIELDS is on, since that alters the board.
    workspace_gid = (project.get("workspace") or {}).get("gid") or config.ASANA_WORKSPACE_GID
    for fname in config.NUMBER_FIELD_WRITES:
        if fname in field_map:
            continue
        if config.CREATE_MISSING_FIELDS and workspace_gid:
            gid = asana.create_number_field(workspace_gid, project_gid, fname,
                                            config.NUMBER_FIELD_PRECISION)
            print(f"  + number field {fname!r}")
            # Live: register the real gid so this run can write to it.
            # Dry-run: register a placeholder so the reconcile loop still
            # PREVIEWS the per-site percentage writes (the placeholder gid is
            # never sent — _write short-circuits in dry-run).
            field_map[fname] = {
                "gid": gid or "DRY_RUN_NEW_FIELD",
                "type": "number",
                "enum_options": {},
            }
        else:
            print(f"  ⚠ number field not found, percentage not synced: {fname!r}. "
                  f"Set CREATE_MISSING_FIELDS=true to auto-create it.", file=sys.stderr)

    # 3. Ensure sections exist
    sections = asana.section_map(project_gid)
    wanted = [s["name"] for s in config.SECTIONS]
    if config.FALLBACK_SECTION:
        wanted.append(config.FALLBACK_SECTION)
    for name in wanted:
        if name not in sections:
            gid = asana.create_section(project_gid, name)
            sections[name] = gid  # None in dry-run; create_task tolerates it
            print(f"  + section {name!r}")

    # 4. Index existing tasks by normalised URL (task name is the URL)
    tasks = asana.list_tasks(project_gid)
    by_url: dict[str, dict] = {}
    for t in tasks:
        key = normalize_url(t.get("name"))
        if key:
            by_url.setdefault(key, t)
    print(f"  {len(tasks)} existing tasks ({len(by_url)} URL-matchable)")

    # 5. Reconcile
    updated = created = skipped_cap = unmatched_status = 0
    status_meta = field_map.get(config.STATUS_ACCESSIBILITY_FIELD)

    for site in sites:
        existing = by_url.get(site.norm_url)
        section_name = section_for(site)
        section_gid = sections.get(section_name) if section_name else None

        if existing:
            if not config.UPDATE_EXISTING:
                continue
            payload, notes = build_field_payload(site, field_map, existing)
            if payload:
                asana.update_task_fields(existing["gid"], site.name, payload)
                print(f"  ~ {site.name}  [{', '.join(notes)}]")
                updated += 1
        else:
            if not config.CREATE_MISSING:
                continue
            if created >= config.MAX_CREATES:
                skipped_cap += 1
                continue
            payload, _ = build_field_payload(site, field_map, None)
            # Status (Accessibility) on new tasks only.
            if status_meta and config.NEW_TASK_STATUS_ACCESSIBILITY:
                opt = enum_option_gid(status_meta, config.NEW_TASK_STATUS_ACCESSIBILITY)
                if opt:
                    payload[status_meta["gid"]] = opt
                else:
                    unmatched_status += 1
            asana.create_task(project_gid, site.url, payload,
                              section_gid, section_name)
            print(f"  + {site.url}  → {section_name}")
            created += 1

    # 6. Summary
    print("\nSummary")
    print(f"  updated:        {updated}")
    print(f"  created:        {created}")
    if skipped_cap:
        print(f"  skipped (cap):  {skipped_cap}  (raise MAX_CREATES={config.MAX_CREATES})")
    if unmatched_status:
        print(f"  status option not found for {unmatched_status} new tasks "
              f"({config.NEW_TASK_STATUS_ACCESSIBILITY!r})")
    if config.DRY_RUN:
        print("  DRY-RUN: nothing was written. Set DRY_RUN=false to apply.")
    else:
        print(f"  Asana write calls: {asana.write_count}")


if __name__ == "__main__":
    main()
