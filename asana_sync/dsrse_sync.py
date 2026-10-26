"""
Siteimprove → DS/RSE a11y board sync.

A second, narrower sync, separate from the inventory sync (asana_sync.sync)
and triggered manually (.github/workflows/sync-asana-dsrse.yml).
For the one project in config.DSRSE_PROJECT_GID:

  * Take the sites tagged with any of config.DSRSE_TAGS (RSE,
    WP-DigitalScholarship, Omeka) — same data/sites.json + CSV tag overlay
    the inventory sync uses.
  * Match each to the board task whose URL column (config.DSRSE_URL_FIELD,
    "Public URL") holds the same URL — scheme, www and trailing slash
    ignored. A URL on more than one task, or Siteimprove sites sharing a URL
    but disagreeing on target %, is logged and skipped — never guessed.
  * Write the target-% field on matched tasks, only when it differs.

Update-only: never creates, completes, deletes, moves or renames tasks,
never creates fields or sections, and touches no other field. Sites with no
matching task are just listed in the log.

Run: python -m asana_sync.dsrse_sync
"""

from __future__ import annotations

import sys
from collections import defaultdict

from . import config
from .asana_client import AsanaClient
from .siteimprove_source import Site, load_sites, normalize_url
from .sync import (current_display_value, current_number_value,
                   current_text_value, derive_number_values)
from .tag_overlay import overlay_tags


def task_url(task: dict, field_name: str) -> str:
    """Normalized value of the task's URL column ('' when blank)."""
    raw = current_text_value(task, field_name) or current_display_value(task, field_name)
    return normalize_url(raw)


def select_sites() -> list[Site]:
    all_sites = load_sites(config.SITEIMPROVE_DATA_URL)
    if config.TAG_OVERLAY_FROM_CSV:
        overlay_tags(all_sites, config.SITE_TAGS_CSV_URL)
    return [
        s for s in all_sites
        if set(s.plain_tags) & config.DSRSE_TAGS
        and not set(s.plain_tags) & config.EXCLUDED_TAGS
    ]


def main() -> None:
    print(f"Siteimprove → DS/RSE a11y board  (DRY_RUN={config.DRY_RUN}, update-only)")

    sites = select_sites()
    tags = ", ".join(sorted(config.DSRSE_TAGS))
    print(f"  {len(sites)} sites tagged {tags} "
          f"({sum(1 for s in sites if s.target_percentage is not None)} scored)")

    asana = AsanaClient(config.ASANA_TOKEN, dry_run=config.DRY_RUN,
                        write_delay=config.ASANA_WRITE_DELAY_SECONDS)
    project = asana.resolve_project(project_gid=config.DSRSE_PROJECT_GID,
                                    project_name="", workspace_gid=None)
    project_gid = project["gid"]
    print(f"  project: {project.get('name')} ({project_gid})")

    # Both columns must already exist on the board — this sync never adds any.
    field_map = asana.custom_field_map(project_gid)
    field_name = config.TARGET_PCT_FIELD
    url_field = config.DSRSE_URL_FIELD
    for name, var in ((field_name, "TARGET_PCT_FIELD"), (url_field, "DSRSE_URL_FIELD")):
        if name not in field_map:
            sys.exit(f"Column {name!r} not found on the board "
                     f"(fields: {', '.join(sorted(field_map)) or 'none'}). "
                     f"Set {var} to the right name.")
    field_gid = field_map[field_name]["gid"]

    # Index board tasks by their URL column; a URL on >1 task is ambiguous.
    tasks_by_url: dict[str, list[dict]] = defaultdict(list)
    no_url = 0
    for t in asana.list_tasks(project_gid):
        key = task_url(t, url_field)
        if key:
            tasks_by_url[key].append(t)
        else:
            no_url += 1
    print(f"  {sum(map(len, tasks_by_url.values()))} tasks with a {url_field!r}, "
          f"{no_url} without (ignored)")

    # Siteimprove sometimes has the same URL under two site entries (e.g. a
    # descriptive name and a bare-URL name). Group them; they're one board row.
    sites_by_url: dict[str, list[Site]] = defaultdict(list)
    for s in sites:
        sites_by_url[s.norm_url].append(s)

    updates: list[tuple[str, str, dict]] = []
    unmatched: list[str] = []
    matched = in_sync = unscored = ambiguous = 0
    for key, group in sorted(sites_by_url.items()):
        found = tasks_by_url.get(key, [])
        if not found:
            unmatched.append(key)
            continue
        if len(found) > 1:
            ambiguous += 1
            names = ", ".join(repr(t.get("name")) for t in found)
            print(f"  ⚠ skip {key}: {len(found)} tasks have this URL ({names})",
                  file=sys.stderr)
            continue

        values = {derive_number_values(s).get("target_percentage") for s in group} - {None}
        if len(values) > 1:
            ambiguous += 1
            print(f"  ⚠ skip {key}: {len(group)} Siteimprove sites with different "
                  f"target % ({', '.join(map(str, sorted(values)))})", file=sys.stderr)
            continue

        matched += 1
        task = found[0]
        want = next(iter(values), None)
        if want is None:
            unscored += 1  # never blank out an existing value
            continue
        have = current_number_value(task, field_name)
        if have is not None and abs(have - want) < 0.005:
            in_sync += 1
            continue
        label = f"{task.get('name')} ({key}): {field_name} {have} → {want}"
        updates.append((task["gid"], label, {"custom_fields": {field_gid: want}}))

    for _gid, label, _data in updates:
        print(f"  ~ {label}")
    if updates:
        asana.batch_update_tasks(updates)
    for key in unmatched:
        print(f"  · no task with this {url_field}: {key}")

    print(f"\nDone. matched={matched} updated={len(updates)} already-current={in_sync} "
          f"unscored={unscored} skipped-ambiguous={ambiguous} no-task={len(unmatched)}"
          + ("  (dry run — nothing written)" if config.DRY_RUN else ""))


if __name__ == "__main__":
    main()
