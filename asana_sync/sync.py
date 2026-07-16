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
from .siteimprove_source import Site, load_sites, normalize_url


# --------------------------------------------------------------------------
# Mapping helpers
# --------------------------------------------------------------------------
def section_for(site: Site) -> str | None:
    """Return the configured section name for a site based on its tags.
    Sections are tried in config order (= precedence); a section matches on
    an exact tag ("match") or a tag prefix ("prefix", e.g. 'wp-')."""
    tags = set(site.plain_tags)
    for section in config.SECTIONS:
        if any(m.lower() in tags for m in section.get("match", [])):
            return section["name"]
        prefixes = section.get("prefix") or []
        if prefixes and any(t.startswith(p.lower()) for p in prefixes for t in tags):
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
    # Provenance: which pipeline input this row came from.
    out["source"] = (config.SOURCE_OPTION_API if site.source == "api"
                     else config.SOURCE_OPTION_CSV)
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

    # 1. Build the working site list from data/sites.json — the single
    #    source of truth. The fetch pipeline already makes it complete:
    #    API-returned sites carry metrics, CSV-only sites are appended as
    #    stubs, and every row's tags have the CSV merge + URL inference
    #    applied at fetch time. No separate inventory read needed here.
    print(f"Loading sites from {config.SITEIMPROVE_DATA_URL} …")
    all_sites = load_sites(config.SITEIMPROVE_DATA_URL)

    sites: list[Site] = []
    excluded = 0
    for s in all_sites:
        if set(s.plain_tags) & config.EXCLUDED_TAGS:
            excluded += 1
            continue
        sites.append(s)
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

    # Ensure creatable enum fields (e.g. Source) exist — same opt-in gate.
    for fname, options in config.CREATABLE_ENUM_FIELDS.items():
        if fname in field_map:
            continue
        if config.CREATE_MISSING_FIELDS and workspace_gid:
            created = asana.create_enum_field(workspace_gid, project_gid, fname, options)
            print(f"  + enum field {fname!r} ({', '.join(options)})")
            if created:
                field_map[fname] = {"gid": created["gid"], "type": "enum",
                                    "enum_options": created["enum_options"]}
            else:
                # Dry-run placeholder so per-site writes preview correctly.
                field_map[fname] = {
                    "gid": "DRY_RUN_NEW_FIELD", "type": "enum",
                    "enum_options": {o.lower(): f"DRY_RUN_OPT_{i}"
                                     for i, o in enumerate(options)},
                }
        else:
            print(f"  ⚠ enum field not found, not synced: {fname!r}. "
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

    # Section gids that belong to THIS project — used both to pick the
    # canonical duplicate and to detect when a task sits in the wrong section.
    project_section_gids = {gid for gid in sections.values() if gid}
    # Sections the sync never moves tasks out of (human-curated, e.g. Rails).
    protected_gids = {sections[n] for n in config.PROTECTED_SECTIONS
                      if sections.get(n)}

    def task_project_sections(task: dict) -> set[str]:
        return {
            (m.get("section") or {}).get("gid")
            for m in (task.get("memberships") or [])
        } & project_section_gids

    # 4. Index existing tasks by normalised URL (task name is the URL).
    # Duplicates (several tasks for one URL) are reported, and the sync only
    # ever writes to ONE canonical task per URL — preferring the task that
    # actually sits in one of our platform sections. Extras are left
    # untouched for a human to merge/close; we never delete.
    tasks = asana.list_tasks(project_gid)
    url_groups: dict[str, list[dict]] = {}
    for t in tasks:
        key = normalize_url(t.get("name"))
        if key:
            url_groups.setdefault(key, []).append(t)

    by_url: dict[str, dict] = {}
    board_dupes: list[tuple[str, int]] = []
    for key, group in url_groups.items():
        canonical = next((t for t in group if task_project_sections(t)), group[0])
        by_url[key] = canonical
        if len(group) > 1:
            board_dupes.append((key, len(group)))
    print(f"  {len(tasks)} existing tasks ({len(by_url)} URL-matchable)")
    if board_dupes:
        extras = sum(n - 1 for _, n in board_dupes)
        print(f"  ⚠ {len(board_dupes)} URL(s) have duplicate tasks on the board "
              f"({extras} extra task(s)) — updating only the canonical one; "
              f"extras left for manual merge:", file=sys.stderr)
        for key, n in sorted(board_dupes)[:10]:
            print(f"      {key}  ×{n}", file=sys.stderr)
        if len(board_dupes) > 10:
            print(f"      … and {len(board_dupes) - 10} more", file=sys.stderr)

    # 5. Reconcile
    # Field updates are queued and flushed through Asana's batch API
    # (10 actions per request) instead of one request per task — the
    # difference between ~20 minutes and ~2 for a full-portfolio update.
    updated = created = skipped_cap = unmatched_status = 0
    moved = dup_source_rows = 0
    status_meta = field_map.get(config.STATUS_ACCESSIBILITY_FIELD)
    pending_updates: list[tuple[str, str, dict]] = []
    pending_moves: list[tuple[str, str, str]] = []
    seen_source_urls: set[str] = set()

    for site in sites:
        # Source-side dedupe: if the inventory lists the same URL twice,
        # reconcile it once — a second pass could otherwise create a
        # duplicate task in the same run.
        if site.norm_url:
            if site.norm_url in seen_source_urls:
                dup_source_rows += 1
                continue
            seen_source_urls.add(site.norm_url)

        existing = by_url.get(site.norm_url)
        section_name = section_for(site)
        section_gid = sections.get(section_name) if section_name else None

        if existing:
            if not config.UPDATE_EXISTING:
                continue
            payload, notes = build_field_payload(site, field_map, existing)
            task_data: dict = {}
            if payload:
                task_data["custom_fields"] = payload
            # Milestone conversion: matched site tasks that are still plain
            # tasks become milestones (diffed — milestones are left alone).
            if (config.MILESTONE_TASKS
                    and existing.get("resource_subtype") not in (None, "milestone")):
                task_data["resource_subtype"] = "milestone"
                notes.append("→ milestone")
            if task_data:
                pending_updates.append((existing["gid"], site.name, task_data))
                print(f"  ~ {site.name}  [{', '.join(notes)}]")
            # Re-section: if the platform tags now put this site in a
            # different section than the task currently occupies, move it.
            # A task with NO section in this project (floating/untriaged)
            # also gets homed. Skipped when the target section was only
            # just created in dry-run (gid unknown), and NEVER moved out
            # of a protected section (human-curated, e.g. Rails).
            if section_gid:
                current = task_project_sections(existing)
                if current & protected_gids:
                    pass  # leave human-curated placement alone
                elif section_gid not in current:
                    pending_moves.append((existing["gid"], site.name, section_gid))
                    print(f"  ↪ {site.name}  → section {section_name}")
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
                              section_gid, section_name,
                              resource_subtype="milestone" if config.MILESTONE_TASKS else None)
            print(f"  + {site.url}  → {section_name}")
            created += 1

    # Flush all queued writes through the batch API.
    if pending_updates:
        print(f"\nApplying {len(pending_updates)} field update(s) via batch API …")
        updated = asana.batch_update_tasks(pending_updates)
    if pending_moves:
        print(f"Applying {len(pending_moves)} section move(s) via batch API …")
        moved = asana.batch_move_tasks(pending_moves)

    # 6. Summary
    print("\nSummary")
    print(f"  updated:        {updated}")
    print(f"  moved section:  {moved}")
    print(f"  created:        {created}")
    if dup_source_rows:
        print(f"  duplicate source rows skipped: {dup_source_rows}")
    if board_dupes:
        print(f"  board duplicates (manual merge needed): "
              f"{len(board_dupes)} URL(s)")
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
