"""
Central configuration for the Siteimprove → Asana sync.

Everything that a maintainer might reasonably want to change lives here:
the source of Siteimprove data, the Asana project to target, how
platform tags map to board sections, which Asana fields get written, and
the safety switches that govern whether the sync writes at all.
"""

from __future__ import annotations

import os


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "").strip())
    except (ValueError, AttributeError):
        return default


def _env_str(name: str, default: str) -> str:
    """Like os.environ.get, but treats an empty value as missing. GitHub
    Actions injects unset repo variables as "" rather than leaving them
    absent, so a plain .get(name, default) would wrongly return ""."""
    val = os.environ.get(name, "")
    val = val.strip() if val else ""
    return val or default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "")
    raw = raw.strip() if raw else ""
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


# --------------------------------------------------------------------------
# Siteimprove data source
# --------------------------------------------------------------------------
# This package lives inside the accessibility report repo, so it reads
# data/sites.json straight from the local checkout — the single source of
# truth the refresh workflow just produced. That file is already complete:
# API-returned sites carry metrics, CSV-only inventory sites are appended
# as stubs at fetch time, and every row's tags have the CSV merge + URL
# inference applied. No network, no Pages-deploy race, no Siteimprove
# credentials, no separate CSV read.
#
# Override SITEIMPROVE_DATA_URL to point elsewhere (any http(s) URL or
# file://path) for testing.
from pathlib import Path as _Path  # noqa: E402

_REPO_ROOT = _Path(__file__).resolve().parent.parent
_DEFAULT_SITES = (_REPO_ROOT / "data" / "sites.json").as_uri()

SITEIMPROVE_DATA_URL = _env_str("SITEIMPROVE_DATA_URL", _DEFAULT_SITES)

# Tag overlay: at run time the sync re-reads the committed CSV export and
# overlays its tags onto the sites loaded from sites.json — so a fresh CSV
# push is reflected by running the sync alone, without waiting for the
# ~15-min fetch to regenerate sites.json. sites.json stays the source for
# metrics; the CSV is the authoritative source for tags. Set
# TAG_OVERLAY_FROM_CSV=false to disable and use sites.json's tags as-is.
TAG_OVERLAY_FROM_CSV = _env_bool("TAG_OVERLAY_FROM_CSV", True)
_DEFAULT_TAGS_CSV = (_REPO_ROOT / "data" / "site-tags.csv").as_uri()
SITE_TAGS_CSV_URL = _env_str("SITE_TAGS_CSV_URL", _DEFAULT_TAGS_CSV)

# Tags whose sites are skipped entirely — never created/updated/moved on
# the board. 'Rails' is excluded per request: the Rails section is the
# team's hand-curated custom-app tasks, so the sync leaves anything tagged
# Rails alone. 'Development' is NOT excluded (it routes to its Development
# section). (The dashboard has its own separate exclusions.)
EXCLUDED_TAGS = {"test sites", "rails"}

# --------------------------------------------------------------------------
# Asana target
# --------------------------------------------------------------------------
# The sync refuses to touch any project other than this one, matched by
# exact name. You can also pin ASANA_PROJECT_GID directly (skips the name
# lookup) — recommended once you know the gid, so a renamed project can't
# silently send the sync to the wrong board.
ASANA_PROJECT_NAME = _env_str(
    "ASANA_PROJECT_NAME", "External LSA Websites and Applications Inventory"
)
ASANA_PROJECT_GID = os.environ.get("ASANA_PROJECT_GID", "").strip() or None

# Optional: pin the workspace gid to disambiguate when the token can see
# multiple workspaces. Leave blank to auto-detect the project across all.
ASANA_WORKSPACE_GID = os.environ.get("ASANA_WORKSPACE_GID", "").strip() or None

ASANA_TOKEN = os.environ.get("ASANA_TOKEN", "").strip()

# --------------------------------------------------------------------------
# Sections — created if missing, in this order. Each section lists the tags
# that route a site to it (case-insensitive, 'tag:' prefix stripped). A
# section may also list "prefix" matchers (e.g. 'wp-' catches WP-Sites,
# WP-Courses, WP-DigitalScholarship, and any future WP-*). The FIRST section
# whose ANY matcher hits wins, so ORDER = precedence. Sites that match
# nothing land in FALLBACK_SECTION. Tags not named here (LSA, department
# labels, etc.) are ignored for routing.
# --------------------------------------------------------------------------
#
# Precedence rationale — sites carry overlapping tags:
#   omeka + rse                -> Omeka       (Omeka before RSE Sites)
#   rse + wp-digitalscholarship-> RSE Sites   (RSE before WordPress: "if
#                                              both, only RSE")
#   rse alone                  -> RSE Sites
#   wp-digitalscholarship only -> WordPress
# So Omeka is checked before RSE Sites, and RSE Sites before WordPress.
SECTIONS: list[dict] = [
    {"name": "AEM",          "match": ["aem"]},
    {"name": "Omeka",        "match": ["omeka"]},
    {"name": "RSE Sites",    "match": ["rse"]},
    {"name": "Google Sites", "match": ["google-sites", "google sites", "gsites"]},
    {"name": "WordPress",    "match": ["wp", "wordpress"], "prefix": ["wp-"]},
    {"name": "dotNet",       "match": ["dotnet", ".net", "asp.net"]},
    {"name": "Development",  "match": ["development"]},
    # Strictly tag-driven: ONLY an explicit 'Custom Sites' tag set in
    # Siteimprove routes here. Inferred tags (e.g. the URL-derived
    # 'External') deliberately do NOT — no guess-based categorization.
    {"name": "Custom Sites", "match": ["custom sites", "custom-sites"]},
]

# Junk-task cleanup: earlier runs created tasks for login-gateway URLs
# (weblogin.umich.edu SSO redirects etc.) that the pipeline now filters out.
# Those tasks match no site row, so they'd linger in Uncategorized forever.
# When enabled, the sync marks them COMPLETED (never deletes — completion is
# visible and reversible) so they drop off the active board.
JUNK_TASK_CLEANUP = _env_bool("JUNK_TASK_CLEANUP", True)

# All site tasks the sync manages are Asana MILESTONES: new tasks are
# created with resource_subtype=milestone, and existing URL-matched tasks
# that are still plain tasks get converted (diffed — already-milestones are
# never rewritten). Set MILESTONE_TASKS=false to revert to plain tasks.
MILESTONE_TASKS = _env_bool("MILESTONE_TASKS", True)

# Sections the sync must never manage. 'Rails' holds the team's manually
# curated custom-app tasks (JIRA sprints, story points); a Siteimprove
# 'Rails' tag is deliberately NOT routed, and tasks currently sitting in a
# protected section are never re-sectioned out of it — even when their
# Siteimprove tags would place them elsewhere. Field updates (target %,
# Source, …) still apply to URL-matched tasks wherever they live.
PROTECTED_SECTIONS = {"Rails"}
# Sites whose tags match none of the above still need a home so they aren't
# silently dropped. Set to None to skip creating uncategorised sites instead.
FALLBACK_SECTION: str | None = "Uncategorized"

# --------------------------------------------------------------------------
# Field writes — the Asana custom fields the sync is allowed to set, keyed
# by the EXACT field name shown on the board. Each entry says how to derive
# the value from a Siteimprove site record. Anything not listed here is
# never touched (so JIRA-synced columns, Notes, Editor's Email, etc. are
# safe). Field names are resolved to gids at runtime; a name that doesn't
# exist on the board is logged and skipped, not an error.
# --------------------------------------------------------------------------
REMEDIATION_THRESHOLD = _env_float("REMEDIATION_THRESHOLD", 98.0)

# Enum fields are written by option NAME (resolved to the option gid at
# runtime). Booleans map to the literal option names "True"/"False" as seen
# on the board.
# Data-provenance field: records where each task's data came from.
SOURCE_FIELD = _env_str("SOURCE_FIELD", "Source")
SOURCE_OPTION_API = "Siteimprove API"
SOURCE_OPTION_CSV = "Siteimprove CSV export"

FIELD_WRITES: dict[str, str] = {
    # field name on the board : logical value key (see sync.derive_field_values)
    "Added to Siteimprove": "added_to_siteimprove",
    "Siteimprove Issues Remediation (98%)": "remediation_met",
    SOURCE_FIELD: "source",
}

# Enum fields the sync may CREATE when CREATE_MISSING_FIELDS is on
# (name -> ordered option names). Existing fields are never altered — if a
# 'Source' field already exists on the board, its options are used as-is
# and options we can't resolve are logged and skipped.
CREATABLE_ENUM_FIELDS: dict[str, list[str]] = {
    SOURCE_FIELD: [SOURCE_OPTION_API, SOURCE_OPTION_CSV],
}

# Tag mirror: each task gets Siteimprove's tag list verbatim in a text
# custom field (e.g. "AEM, LSA, Research"), kept in sync on every run —
# including clearing it if the site is untagged in Siteimprove. Text field
# chosen over native Asana tags deliberately: it batches like every other
# field write; native tags would need per-task-per-tag API calls and create
# workspace-global tag entities.
TAGS_FIELD = _env_str("TAGS_FIELD", "Siteimprove Tags")
TEXT_FIELD_WRITES: dict[str, str] = {
    TAGS_FIELD: "tags_text",
}
CREATABLE_TEXT_FIELDS: list[str] = [TAGS_FIELD]

# Numeric custom fields written as raw numbers (the board field must be of
# type 'number'). Keyed by board field name -> logical value key. The target
# percentage (e.g. 97.59) is the natural one. If the field doesn't exist on
# the board it's skipped — unless CREATE_MISSING_FIELDS is on, in which case
# the sync creates it as a number field and attaches it to the project.
TARGET_PCT_FIELD = _env_str("TARGET_PCT_FIELD", "Siteimprove Target %")
NUMBER_FIELD_WRITES: dict[str, str] = {
    TARGET_PCT_FIELD: "target_percentage",
}
NUMBER_FIELD_PRECISION = _env_int("NUMBER_FIELD_PRECISION", 1)

# Allow the sync to create a missing number field (modifies the board
# schema — that's why it's opt-in). Off by default so the first runs only
# touch fields a human already added.
CREATE_MISSING_FIELDS = _env_bool("CREATE_MISSING_FIELDS", False)

# Set a Status (Accessibility) value on newly-created tasks only (we don't
# overwrite a human-set status on existing tasks). Blank = don't set it.
NEW_TASK_STATUS_ACCESSIBILITY = _env_str("NEW_TASK_STATUS_ACCESSIBILITY", "active")
STATUS_ACCESSIBILITY_FIELD = "Status (Accessibility)"

# --------------------------------------------------------------------------
# Safety switches
# --------------------------------------------------------------------------
# DRY_RUN: when true (the default), the sync logs every create/update it
# WOULD perform and writes nothing. Flip the DRY_RUN repo variable to
# "false" to go live.
DRY_RUN = _env_bool("DRY_RUN", True)

# CREATE_MISSING: create Asana tasks for Siteimprove sites with no match.
CREATE_MISSING = _env_bool("CREATE_MISSING", True)

# Hard ceiling on creations per run — a backstop against a bad match run
# dumping thousands of tasks. The full LSA portfolio is ~1,400 sites, so
# the default comfortably covers a first full sync while still capping a
# runaway. Lower it for a cautious first live run.
MAX_CREATES = _env_int("MAX_CREATES", 2000)

# Update existing tasks' fields when they differ from Siteimprove.
UPDATE_EXISTING = _env_bool("UPDATE_EXISTING", True)

# Polite pacing for the Asana API (requests/minute vary by plan; 150/min is
# the free-tier ceiling). Sleep between write calls to stay under it.
ASANA_WRITE_DELAY_SECONDS = _env_float("ASANA_WRITE_DELAY_SECONDS", 0.4)
