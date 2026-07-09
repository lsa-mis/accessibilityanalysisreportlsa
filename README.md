# LSA Accessibility Data and Automations

Data pipeline, live dashboards, and workflow automations for LSA's web-accessibility program (ADA Title II, deadline April 24, 2027). Siteimprove data is refreshed on a weekend schedule, published to GitHub Pages, and pushed onward to the team's Asana board — all automatically.

## Structure

```
index.html            Narrative accessibility report (published via Pages)
data.html             Live dashboard — searchable, filterable per-site view
favicon.svg           Shared favicon for both pages
data/
  sites.json          Per-site snapshot written by the fetch (consumed by both pages + Asana sync)
  rules.json          Cross-site rule rollups (global + per-tag)
  site-tags.csv       Admin site labels exported from the Siteimprove UI
scripts/
  fetch_siteimprove.py   Pulls per-site accessibility data from the Siteimprove API
  merge_site_tags.py     Tag-only refresh; re-applies the CSV onto sites.json (no API)
asana_sync/           Siteimprove → Asana board sync (fields, sections, task creation)
source-data/          Original analysis spreadsheets (manual exports)
.github/workflows/
  fetch-siteimprove.yml  Refresh data — Sat & Sun 11:00 UTC + manual
  sync-asana.yml         Chained to the refresh via workflow_run + manual
  merge-site-tags.yml    Fires on push to data/site-tags.csv
  pages.yml              Deploys the site on every push to main
```

## Automation flow

```
Sat & Sun 11:00 UTC  Refresh Siteimprove data
   ├─ commits data/sites.json + data/rules.json
   ├─ triggers Pages deploy (dashboard + report go live)
   └─ workflow_run → Sync Siteimprove → Asana
        └─ updates fields / sections, creates missing tasks
```

## Site tags (CSV-driven)

Tags are sourced **exclusively** from `data/site-tags.csv` — an export of the admin-configured site labels in Siteimprove. No heuristic / URL-derived tags are emitted; if the CSV doesn't list a site, that row simply has no tags.

### Update flow

1. In Siteimprove → **Settings → Sites** → **Export** (CSV)
2. Save / replace `data/site-tags.csv`. Columns (case-insensitive, any subset works):
   - `site_id` (preferred match key)
   - `url` (fallback)
   - `site_name` or `name` (last resort)
   - `tags` or `labels` — comma-, pipe-, or semicolon-separated label names
3. `git commit data/site-tags.csv && git push`
4. The **Merge site tags** workflow (`.github/workflows/merge-site-tags.yml`) auto-runs on that push, re-applies the CSV onto `data/sites.json` (no API calls), commits the refreshed snapshot, and Pages redeploys. Total round trip: ~30 seconds.

### Why CSV instead of API

Siteimprove's site labels live behind the management UI at `my2.us.siteimprove.com`, which requires session cookies. The public API token returns 302 (redirect to login) for that endpoint. Until Siteimprove exposes labels in the public v2 API or grants the API user a management scope, the CSV is the cleanest single source of truth.

### Manual merge

If you want to re-apply the CSV without pushing (e.g., to verify locally before committing):

```bash
python scripts/merge_site_tags.py
```

### Keep the CSV fresh

`data/site-tags.csv` is a **manual snapshot** of Siteimprove's admin labels. Nothing in this repo refreshes it on its own — the public API token can't reach the management endpoint. If someone retags a site in Siteimprove and the CSV doesn't get re-exported, the dashboard won't know.

**Recommended cadence:** re-export once a month, or whenever you know the tagging changed (new department site rolled out, platform migration, restructuring of WP-Sites groups, etc.).

**To check how stale the CSV is:**

```bash
git log -1 --format='%ar  (%ad)' --date=short -- data/site-tags.csv
# Example output:  3 weeks ago  (2026-04-15)
```

**Refresh procedure** (same three steps as above):

1. Siteimprove → **Settings → Sites → Export** → CSV
2. Save / overwrite `data/site-tags.csv`
3. `git commit data/site-tags.csv && git push` — the merge workflow does the rest

The scheduled fetch at `.github/workflows/fetch-siteimprove.yml` (Saturdays and Sundays, 11:00 UTC) **always reads whatever CSV is in the repo** when it runs. So a stale CSV will keep producing stale tags on every snapshot. The cron does not refresh the CSV itself.

## Running the fetch script locally

Use this to verify credentials and inspect the data shape before relying on the cron.

1. Create a virtualenv and install deps:

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r scripts/requirements.txt
   ```

2. Create a local `.env` file (gitignored) with your Siteimprove credentials:

   ```bash
   SITEIMPROVE_EMAIL=lsa-web-services-comm@umich.edu
   SITEIMPROVE_API_KEY=your-token-here
   ```

3. Export the vars and run the script:

   ```bash
   set -a; source .env; set +a
   python scripts/fetch_siteimprove.py
   ```

   The script writes `data/sites.json` and prints progress to stderr.

4. View the dashboard locally:

   ```bash
   python3 -m http.server 8000
   ```

   Then open <http://localhost:8000/data.html>.

## Configuring the scheduled run

The workflow reads credentials from repo secrets. In GitHub:

1. Settings → Secrets and variables → Actions → **New repository secret**
2. Add two secrets:
   - `SITEIMPROVE_EMAIL` — the API username (an email address)
   - `SITEIMPROVE_API_KEY` — the API token
3. Trigger a first run: Actions tab → **Refresh Siteimprove data** → **Run workflow**

The schedule is `0 11 * * 6,0` (Saturdays and Sundays at 11:00 UTC ≈ 07:00 ET). Edit `.github/workflows/fetch-siteimprove.yml` to change cadence. The Asana sync chains automatically after each successful refresh — no separate schedule.

## Rotating the API token

If the token is ever exposed, rotate it in Siteimprove (Settings → API users), then update the `SITEIMPROVE_API_KEY` secret in GitHub. No code change needed.

## Asana sync (same repo)

The `asana_sync/` package pushes the fresh Siteimprove data to the Asana project **External LSA Websites and Applications Inventory** — updating each site's `Added to Siteimprove` / `Siteimprove Issues Remediation (98%)` / `Siteimprove Target %` fields and creating tasks (in the right platform section) for sites not yet on the board.

- **Chained automatically:** `.github/workflows/sync-asana.yml` runs via `workflow_run` whenever **Refresh Siteimprove data** finishes successfully. It reads `data/sites.json` + `data/site-tags.csv` directly from the checkout — no URLs, no Pages-deploy wait.
- **Credentials:** add an Asana Personal Access Token as the repo secret `ASANA_TOKEN` (a user/service account that can edit that project).
- **Safety:** writes are gated by the `DRY_RUN` repo variable (default `true`). Set it to `false` to let scheduled/chained runs write to the board. Manual runs (Actions → Run workflow) use the *Dry run* checkbox.
- **Tuning (optional repo variables):** `ASANA_PROJECT_GID`, `CREATE_MISSING` (create tasks for missing sites), `MAX_CREATES`, `CREATE_MISSING_FIELDS` (auto-create the `Siteimprove Target %` number field), `REMEDIATION_THRESHOLD`.
- **Run locally:** `ASANA_TOKEN=… DRY_RUN=true python -m asana_sync.sync` (reads the repo's local data files by default).
