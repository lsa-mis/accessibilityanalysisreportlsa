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
# This package lives inside the accessibility report repo, so it reads the
# data files the refresh workflow just produced — directly from the local
# checkout (data/sites.json, data/site-tags.csv). No network, no Pages-deploy
# race, no Siteimprove credentials. The refresh runs, commits fresh data,
# then triggers the Asana sync in the same repo, which reads these files.
#
# Override SITEIMPROVE_DATA_URL / INVENTORY_URL to point elsewhere (any
# http(s) URL or file://path) for testing.
from pathlib import Path as _Path  # noqa: E402

_REPO_ROOT = _Path(__file__).resolve().parent.parent
_DEFAULT_SITES = (_REPO_ROOT / "data" / "sites.json").as_uri()
_DEFAULT_TAGS = (_REPO_ROOT / "data" / "site-tags.csv").as_uri()

SITEIMPROVE_DATA_URL = _env_str("SITEIMPROVE_DATA_URL", _DEFAULT_SITES)

# The full site inventory (CSV export). This is the primary list of sites
# the sync reconciles against — it includes sites Siteimprove hasn't scored
# and carries the authoritative platform tags (Omeka, RSE, Google-Sites)
# that drive section placement. sites.json above only enriches it with
# metrics (target %, score) where a site was scored.
INVENTORY_URL = _env_str("INVENTORY_URL", _DEFAULT_TAGS)
# Tags whose sites are skipped entirely (non-production environments).
EXCLUDED_TAGS = {"test sites", "development"}

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
# Sections — created if missing, in this order. The matcher decides which
# section a Siteimprove site belongs to based on its tags (case-insensitive,
# 'tag:' prefix stripped before matching). First section whose ANY matcher
# hits wins; order matters. Sites that match nothing land in FALLBACK_SECTION.
# --------------------------------------------------------------------------
#
# Order = matching precedence, most-specific platform first. This matters
# because sites carry overlapping tags: every Omeka site is tagged
# 'lsa, omeka, rse', and 'rse' (Research Software Engineering — the
# maintaining team) is NOT a platform. So real platforms (Omeka, Google
# Sites, AEM, WordPress) are checked before Rails, and 'rse' only routes a
# site to Rails when no real platform tag matched. Result:
#   omeka + rse              -> Omeka
#   rse + wp-digitalscholar  -> WordPress
#   rse alone                -> Rails
# Section creation order on the board follows this list; reorder sections in
# Asana afterward if you prefer a different visual order.
SECTIONS: list[dict] = [
    {"name": "Omeka",        "match": ["omeka"]},
    {"name": "Google Sites", "match": ["google sites", "google-sites", "gsites"]},
    {"name": "AEM",          "match": ["aem"]},
    {"name": "WordPress",    "match": ["wp", "wp-sites", "wp-courses",
                                       "wp-digitalscholarship", "wordpress"]},
    {"name": "Rails",        "match": ["rails", "rse"]},
    {"name": "dotNet",       "match": ["dotnet", ".net", "asp.net"]},
]
# Sites whose tags match none of the above still need a home so they aren't
# silently dropped. Set to None to skip creating uncategorised sites instead.
FALLBACK_SECTION: str | None = "Uncategorized"

# A WordPress site can also carry 'wp-courses'; we want the broad bucket.
# Matching is "any tag in match list", so WordPress catches all wp-* tags.

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
FIELD_WRITES: dict[str, str] = {
    # field name on the board : logical value key (see sync.derive_field_values)
    "Added to Siteimprove": "added_to_siteimprove",
    "Siteimprove Issues Remediation (98%)": "remediation_met",
}

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
