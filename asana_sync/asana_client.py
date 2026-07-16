"""
Minimal Asana REST client scoped to exactly what the sync needs:
resolve a project, read its sections + custom-field schema, list tasks,
create sections/tasks, and update task custom fields.

Auth is a Personal Access Token (Bearer). Handles pagination, 429
back-off, and 5xx retries. Every write goes through _write() so DRY_RUN
short-circuits in one place.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

API_ROOT = "https://app.asana.com/api/1.0"
MAX_RETRIES = 5


class AsanaError(RuntimeError):
    pass


class AsanaClient:
    def __init__(self, token: str, dry_run: bool, write_delay: float = 0.4):
        if not token:
            sys.exit("ASANA_TOKEN is not set.")
        self.token = token
        self.dry_run = dry_run
        self.write_delay = write_delay
        self._writes = 0

    # ---- low-level -------------------------------------------------------
    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        url = path if path.startswith("http") else f"{API_ROOT}{path}"
        data = json.dumps({"data": body}).encode() if body is not None else None
        for attempt in range(1, MAX_RETRIES + 1):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("Authorization", f"Bearer {self.token}")
            req.add_header("Accept", "application/json")
            if data is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                if exc.code == 429 or exc.code >= 500:
                    if attempt == MAX_RETRIES:
                        raise AsanaError(f"{method} {url} failed: {exc.code}") from exc
                    retry_after = exc.headers.get("Retry-After")
                    wait = float(retry_after) if retry_after else 2.0 * attempt
                    print(f"  Asana {exc.code} — retry {attempt} in {wait:.0f}s", file=sys.stderr)
                    time.sleep(wait)
                    continue
                detail = exc.read().decode("utf-8", "replace")[:500]
                raise AsanaError(f"{method} {url} -> {exc.code}: {detail}") from exc
        raise AsanaError("unreachable")

    def _get(self, path: str, params: dict | None = None) -> dict:
        if params:
            sep = "&" if "?" in path else "?"
            path = path + sep + urllib.parse.urlencode(params)
        return self._request("GET", path)

    def _paginate(self, path: str, params: dict | None = None) -> list[dict]:
        params = dict(params or {})
        params.setdefault("limit", 100)
        items: list[dict] = []
        offset = None
        while True:
            p = dict(params)
            if offset:
                p["offset"] = offset
            payload = self._get(path, p)
            items.extend(payload.get("data") or [])
            nxt = (payload.get("next_page") or {}) or {}
            offset = nxt.get("offset")
            if not offset:
                break
        return items

    def _write(self, method: str, path: str, body: dict | None, what: str) -> dict | None:
        """Single choke point for all mutations so DRY_RUN is honoured everywhere."""
        if self.dry_run:
            print(f"  [DRY-RUN] would {what}")
            return None
        result = self._request(method, path, body)
        self._writes += 1
        if self.write_delay:
            time.sleep(self.write_delay)
        return result.get("data")

    @property
    def write_count(self) -> int:
        return self._writes

    # ---- batched writes ---------------------------------------------------
    # Asana's batch API packs up to 10 actions into one POST /batch request.
    # For a steady-state sync (~1,400 field updates) this turns ~1,400
    # round-trips into ~140, cutting the write phase from ~20 minutes to
    # ~2. Each action still counts toward Asana's rate limit individually,
    # but the limit (150/min free, 1500/min premium) is enforced via the
    # existing 429 Retry-After handling in _request, so we can pace by
    # request rather than by action.
    BATCH_SIZE = 10

    def _batch(self, labeled_actions: list[tuple[str, dict]], what: str) -> int:
        """Run [(label, action), ...] through POST /batch in chunks of 10.
        Returns the number of successfully applied actions. Dry-run counts
        (per-item logging is the caller's job) without writing."""
        if not labeled_actions:
            return 0
        total_chunks = (len(labeled_actions) + self.BATCH_SIZE - 1) // self.BATCH_SIZE
        if self.dry_run:
            print(f"  [DRY-RUN] would apply {len(labeled_actions)} {what} "
                  f"in {total_chunks} batch request(s)")
            return len(labeled_actions)

        applied = 0
        for i in range(0, len(labeled_actions), self.BATCH_SIZE):
            chunk = labeled_actions[i:i + self.BATCH_SIZE]
            actions = [action for _label, action in chunk]
            result = self._request("POST", "/batch", {"actions": actions})
            self._writes += 1
            statuses = result.get("data") or []
            for (label, _a), st in zip(chunk, statuses):
                code = st.get("status_code")
                if code and code < 400:
                    applied += 1
                else:
                    print(f"  ! batch item failed ({code}) for {label!r}",
                          file=sys.stderr)
            chunk_no = i // self.BATCH_SIZE + 1
            if chunk_no % 20 == 0 or chunk_no == total_chunks:
                print(f"  … batch {chunk_no}/{total_chunks} ({applied} {what} applied)")
            if self.write_delay:
                time.sleep(self.write_delay)
        return applied

    def batch_update_tasks(self, updates: list[tuple[str, str, dict]]) -> int:
        """Apply [(task_gid, label, task_data), ...] via /batch. task_data is
        the raw PUT /tasks body ({"custom_fields": {...}} and/or
        {"resource_subtype": "milestone"} etc.)."""
        labeled = [
            (label, {"relative_path": f"/tasks/{gid}", "method": "put",
                     "data": data})
            for gid, label, data in updates
        ]
        return self._batch(labeled, "task update(s)")

    def batch_move_tasks(self, moves: list[tuple[str, str, str]]) -> int:
        """Move tasks between sections: [(task_gid, label, section_gid), ...].
        Uses POST /sections/{gid}/addTask, which re-homes the task within the
        project (a task has one section per project, so this is a move, not
        an add)."""
        labeled = [
            (label, {"relative_path": f"/sections/{section_gid}/addTask",
                     "method": "post", "data": {"task": task_gid}})
            for task_gid, label, section_gid in moves
        ]
        return self._batch(labeled, "section move(s)")

    # ---- project resolution ---------------------------------------------
    def resolve_project(self, *, project_gid: str | None, project_name: str,
                        workspace_gid: str | None) -> dict:
        if project_gid:
            proj = self._get(f"/projects/{project_gid}",
                             {"opt_fields": "name,workspace.name,workspace.gid"}).get("data")
            if not proj:
                sys.exit(f"Project gid {project_gid} not found.")
            return proj

        workspaces = ([{"gid": workspace_gid}] if workspace_gid
                      else self._paginate("/workspaces", {"opt_fields": "name"}))
        matches: list[dict] = []
        for ws in workspaces:
            projects = self._paginate(
                f"/workspaces/{ws['gid']}/projects",
                {"opt_fields": "name,workspace.name,workspace.gid"},
            )
            matches += [p for p in projects if p.get("name") == project_name]
        if not matches:
            sys.exit(f"No project named {project_name!r} visible to this token.")
        if len(matches) > 1:
            gids = ", ".join(p["gid"] for p in matches)
            sys.exit(f"Multiple projects named {project_name!r} ({gids}). "
                     f"Set ASANA_PROJECT_GID to disambiguate.")
        return matches[0]

    # ---- schema ----------------------------------------------------------
    def custom_field_map(self, project_gid: str) -> dict[str, dict]:
        """name -> { gid, type, enum_options: {option_name_lower: option_gid} }."""
        settings = self._paginate(
            f"/projects/{project_gid}/custom_field_settings",
            {"opt_fields": "custom_field.name,custom_field.resource_subtype,"
                           "custom_field.enum_options.name,custom_field.enum_options.gid,"
                           "custom_field.enum_options.enabled"},
        )
        out: dict[str, dict] = {}
        for s in settings:
            cf = s.get("custom_field") or {}
            # Strip stray whitespace — some board fields carry a trailing
            # space (e.g. 'Status (Accessibility) ') that would otherwise
            # break exact-name lookups from config.
            name = (cf.get("name") or "").strip()
            if not name:
                continue
            enum_opts = {
                (o.get("name") or "").strip().lower(): o.get("gid")
                for o in (cf.get("enum_options") or [])
                if o.get("enabled", True)
            }
            out[name] = {
                "gid": cf.get("gid"),
                "type": cf.get("resource_subtype"),
                "enum_options": enum_opts,
            }
        return out

    def create_enum_field(self, workspace_gid: str, project_gid: str,
                          name: str, options: list[str]) -> dict | None:
        """Create an enum custom field with the given option names and attach
        it to the project. Returns {'gid': ..., 'enum_options': {name_lower:
        option_gid}} or None in dry-run."""
        created = self._write(
            "POST", "/custom_fields",
            {"workspace": workspace_gid, "name": name,
             "resource_subtype": "enum",
             "enum_options": [{"name": o} for o in options]},
            f"create enum field {name!r} with options {options}",
        )
        if not created:
            return None
        gid = created.get("gid")
        if gid:
            self._write(
                "POST", f"/projects/{project_gid}/addCustomFieldSetting",
                {"custom_field": gid},
                f"attach field {name!r} to project",
            )
        enum_options = {
            (o.get("name") or "").strip().lower(): o.get("gid")
            for o in (created.get("enum_options") or [])
        }
        return {"gid": gid, "enum_options": enum_options}

    def create_number_field(self, workspace_gid: str, project_gid: str,
                            name: str, precision: int) -> str | None:
        """Create a number custom field in the workspace and attach it to the
        project. Returns the new field gid (None in dry-run)."""
        # Asana 'format' accepts none/currency/percentage/custom — NOT
        # 'number'. We store the raw percentage (e.g. 97.59) in a plain
        # number field (format=none); the field name carries the '%'. This
        # avoids Asana's percentage format, which expects a 0–1 fraction and
        # would mis-display the value.
        created = self._write(
            "POST", "/custom_fields",
            {"workspace": workspace_gid, "name": name,
             "resource_subtype": "number", "format": "none",
             "precision": precision},
            f"create number field {name!r}",
        )
        if not created:
            return None
        gid = created.get("gid")
        if gid:
            self._write(
                "POST", f"/projects/{project_gid}/addCustomFieldSetting",
                {"custom_field": gid},
                f"attach field {name!r} to project",
            )
        return gid

    def section_map(self, project_gid: str) -> dict[str, str]:
        sections = self._paginate(f"/projects/{project_gid}/sections",
                                  {"opt_fields": "name"})
        return {s["name"]: s["gid"] for s in sections if s.get("name")}

    def create_section(self, project_gid: str, name: str) -> str | None:
        data = self._write("POST", f"/projects/{project_gid}/sections",
                           {"name": name}, f"create section {name!r}")
        return (data or {}).get("gid") if data else None

    # ---- tasks -----------------------------------------------------------
    def list_tasks(self, project_gid: str) -> list[dict]:
        return self._paginate(
            f"/projects/{project_gid}/tasks",
            {"opt_fields": "name,resource_subtype,"
                           "custom_fields.name,custom_fields.display_value,"
                           "custom_fields.enum_value.name,custom_fields.number_value,"
                           "memberships.section.name,memberships.section.gid"},
        )

    def create_task(self, project_gid: str, name: str,
                    custom_fields: dict[str, Any], section_gid: str | None,
                    section_name: str | None,
                    resource_subtype: str | None = None) -> str | None:
        body: dict[str, Any] = {"name": name, "projects": [project_gid]}
        if resource_subtype:
            body["resource_subtype"] = resource_subtype
        if custom_fields:
            body["custom_fields"] = custom_fields
        if section_gid:
            body["memberships"] = [{"project": project_gid, "section": section_gid}]
        data = self._write("POST", "/tasks", body,
                           f"create {resource_subtype or 'task'} {name!r} "
                           f"in section {section_name or '(none)'}")
        return (data or {}).get("gid") if data else None

    def update_task_fields(self, task_gid: str, name: str,
                           custom_fields: dict[str, Any]) -> None:
        if not custom_fields:
            return
        self._write("PUT", f"/tasks/{task_gid}", {"custom_fields": custom_fields},
                    f"update {name!r}: {custom_fields}")
