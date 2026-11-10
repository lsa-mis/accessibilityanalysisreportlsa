# LSA Accessibility Data and Automations

Data pipeline, live dashboards, and workflow automations for LSA's web-accessibility program (ADA Title II, deadline April 24, 2027). The refresh workflow schedules Siteimprove collection daily at 2 a.m. America/Detroit, publishes encrypted data to GitHub Pages, and chains successful refreshes to the team's Asana board. Workflow changes on a staging branch do not change production until integrated into `main`.

## Structure

```
index.html            Narrative accessibility report (not published for now; the Pages root redirects to data.html)
data.html             Live snapshot page (markup only): Overview, Common problems,
                      Ready for manual testing and All sites tabs
dashboard.js          Live snapshot logic: password gate, filters, tabs, site table, exports
dashboard.css         Shared page components (cards, tabs content, problem views)
site-shell.css        Shared look for both pages: colour tokens (WCAG AAA checked), header, tabs, buttons
site-search.js        Ctrl+K / Cmd+K site search used on both pages
site-panel.js         Accessible side panel (site details, share/export)
problems-core.js      Common problems maths: per-site rule counts, audiences, training brief
rule-guidance.js      DRAFT who-fixes-it / how-to-fix guidance per Siteimprove rule, for team review
progress.html         Progress over time page: Overview, Departments, Sites and Issues tabs, calendar date picker
progress-core.js      Shared comparison, eligibility, and metric definitions
progress-client.js    Shared encrypted-data reader and progress-page password gate
progress-page.js      Progress page controls, tables, and exports
progress-widget.js    Live-dashboard historical comparison widget
progress.css          Progress page and print styles
favicon.svg           Shared favicon for both pages
data/
  sites.json          Per-site snapshot written by the fetch (consumed by both pages + Asana sync):
                      scores, target % (estimated when Siteimprove has none), pages scanned, scan status
  rules.json          Cross-site rule rollups (global + per-tag). Global rows also list
                      "sites": [[site_id, occurrences, pages], ...] for the Common problems tab
  site-tags.csv       Admin site labels exported from the Siteimprove UI
  site-departments.csv Maintained primary-department assignments
  departments.json    Validated mapping generated from the department CSV
  history/            Compact immutable gzip observations (per-site scores, counts and
                      occurrences of each Siteimprove rule) and date/trend index
  refresh-status.json Last publication attempt (separate from last-good data)
scripts/
  fetch_siteimprove.py   Pulls per-site accessibility data from the Siteimprove API
  progress_history.py    Validates history/mapping; imports Git snapshots
  publish_progress.py   Publishes data and merged history atomically
asana_sync/           Siteimprove → Asana board sync (fields, sections, task creation)
source-data/          Original analysis spreadsheets (manual exports)
.github/workflows/
  fetch-siteimprove.yml  Refresh data — daily 02:00 Detroit + manual
  sync-asana.yml         Chained to the refresh via workflow_run + manual
  pages.yml              Deploys the site on every push to main
```

## Automation flow

```
Daily 02:00 Detroit  Refresh Siteimprove data (best-effort start)
   ├─ validates and commits latest snapshots + dated history + status
   ├─ triggers Pages deploy (dashboard goes live)
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
4. Tags take effect at the **next data refresh** — the daily fetch reads the committed CSV, or trigger **Actions → Refresh Siteimprove data → Run workflow** on `main` to apply immediately (also refreshes scores and re-runs the Asana sync).

### Why CSV instead of API

Siteimprove's site labels live behind the management UI at `my2.us.siteimprove.com`, which requires session cookies. The public API token returns 302 (redirect to login) for that endpoint. Until Siteimprove exposes labels in the public v2 API or grants the API user a management scope, the CSV is the cleanest single source of truth.

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
3. `git commit data/site-tags.csv && git push`, then trigger **Refresh Siteimprove data** on `main` (or wait for the daily run)

The scheduled fetch at `.github/workflows/fetch-siteimprove.yml` (daily, 2 a.m. Detroit) **always reads whatever CSV is in the repo** when it runs. So a stale CSV will keep producing stale tags on every snapshot. The cron does not refresh the CSV itself.

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

   The script writes `data/sites.json` and `data/rules.json` after collection succeeds and prints progress to stderr. Set `SITEIMPROVE_OUTPUT_DIR` to an isolated directory for staging collection; no API refresh is necessary to preview existing historical observations.

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

The schedule is `0 2 * * *` with `timezone: America/Detroit`. GitHub Actions adjusts for daylight saving; during spring-forward the skipped 2 a.m. advances to the next valid time. Scheduled start times can be delayed; they are not completion-time guarantees. The refresh reads existing Siteimprove results and does not request recrawls. The Asana sync chains automatically after each successful refresh, daily, with its existing dry-run/write safeguards.

Refresh, Pages deployment, and chained Asana writes are guarded to `main`. Do not dispatch live workflows to validate staging changes.

## Dated progress reporting

Both pages share one header (search, Live snapshot | Progress over time) with their own tabs directly below it. The live snapshot's **Common problems** tab groups Siteimprove rules by who fixes them (content editors, designers, web developers, PDF authors), lists the sites with the most cases, and copies a training brief; its guidance text in `rule-guidance.js` is a draft for the team to edit. Site lists per problem need a `rules.json` written by the updated fetch; older files fall back to totals with a note.

The dashboard links to `progress.html` for leadership and department reporting, not editor task management. Choose any two saved dates with the calendar (only comparable snapshots can be picked; older imports are shown struck through) or use the last week/month/3 months/since-tracking-began shortcuts. The default compares the latest saved date with one month earlier, using the nearest available observation **on or before** that baseline. Missing dates are not interpolated. Multiple observations on one day are retained; the date selector uses the latest valid observation on that date.

The summary widget follows platform, label, and search filters; the live dashboard's status/scan filters do not redefine historical cohorts. The separate portfolio-history trend is explicitly unfiltered and shows changing coverage.
Platform/label filters use the later observation's labels for the matched cohort;
no-longer-observed sites use their earlier labels.

### Definitions and data quality

- **Headline measures:** WCAG A + AA + ARIA, with AAA, best practices, and PDF measures separate.
- **Occurrences:** detected instances. **Issue types:** failing rule/site pairs; summing them does not produce a portfolio-distinct rule count.
- **Changes by issue (Issues tab):** occurrences of each Siteimprove rule on the two dates, shown under the plain-language title from `rule-guidance.js` (rule 53, Siteimprove's "Headings are not structured", reads "Heading levels are skipped") with Siteimprove's own title beneath. Only matched sites whose per-rule counts were archived on both dates are counted (`ProgressCore.issueChanges`), so the Level A + AA + ARIA rows add up to the headline occurrences. Level AAA is a separate filter, as on the Common problems tab. Per-rule counts exist from the November 5, 2026 observation on.
- **Net change:** later minus earlier, with before/after counts displayed. A reduction is not proof of fixes: pages, scan scope, and newly discovered issues can change.
- **Matched cohorts:** compare only sites with reliable metrics on both dates. Target and issue/PDF cohorts may differ; each reports its denominator. Added/first-observed and no-longer-observed sites are separate inventory changes, not remediation.
- **Reliable targets:** numeric, not estimated, no recorded data errors, and a usable scan (`ok` or the existing `stale` status). Failed/running/unknown scans and missing scores stay in the data-gap group with reasons. The existing 14-day scan-staleness classification remains visible through scan metadata; collection time is never presented as scan time.
- **Ready-line crossings:** each site is measured against its own manual-testing line: **93% for LSA AEM sites, 98% for every other platform** (`ProgressCore.readyThreshold`). Confirmed targets on both dates must cross that line; a newly observed site above 98% is not counted as a crossing. No comparable cohort means unknown, not zero.
- **Ready for manual testing:** a confirmed Title II target of at least 93% for LSA AEM sites or 98% for every other platform (`ProgressCore.ready`); it excludes estimates and unusable scans, and does not assert compliance.
- **Collection failures:** exhausted core API/network failures do not replace last-good data or create a history entry. Per-site unsupported/forbidden metrics (HTTP 403/404), and sites Siteimprove has never scanned (HTTP 400, 0 pages), remain unavailable rather than becoming zero; they do not fail the run. Rate limits, server errors and authentication failures still do, and the log names the status code and request for each failed site. Failed-attempt status is published separately where possible; observations older than 30 hours also show an overdue warning.

CSV, copyable summaries, and print reports use the same selected dates/filters and calculation logic. CSV exports escape spreadsheet formulas in text fields while preserving numerical reductions.

### Department mapping

Maintain `data/site-departments.csv` with these headers:

```csv
site_id,url,department
```

Provide a Siteimprove ID, a canonical site URL, or both, and one nonempty primary department per row. Duplicate IDs/normalized URLs are rejected. IDs take precedence, with normalized URL fallback; protocol, `www.`, and trailing slashes are ignored, but paths are case-sensitive. URLs containing query strings or fragments are rejected as ambiguous.

The supplied file intentionally has no invented assignments. Until the team provides mappings, sites appear under **Unmapped**. The latest validated mapping is applied to both comparison dates, describing current responsibility rather than historical department ownership. A refresh or backfill validates the CSV and generates `departments.json`.

### History storage, backfill, and local checks

`data/history/*.json.gz` stores immutable compact observations; `data/history/index.json` contains their actual timestamps and trend summaries. History is retained indefinitely. The collection helper prints its size and warns above 500 MiB; review repository/Pages capacity and deployment size as history grows.

Import compatible snapshots from Git without calling Siteimprove:

```bash
python3 scripts/progress_history.py --backfill
```

This command uses the available local Git history, skips incompatible/in-progress snapshots with an explicit diagnostic, deduplicates repeat imports, and preserves gaps. Collection timestamps come from snapshot metadata, not commit dates. Historical snapshots do not record successful issue/PDF endpoint collection, and some predate scan metadata; their unsupported deltas remain unavailable. New verified issue-count comparisons require observations collected with the updated pipeline. Backfill never creates fake evidence of success for those metrics.

Archive a newly collected complete snapshot:

```bash
python3 scripts/progress_history.py
```

The archive step also reads the `rules.json` written by the same collection run (matched on `generated_at`) and stores each site's occurrences per rule as `rule_occurrences`, with rule titles and levels under `rules`. A site only gets per-rule counts when its issue counts are verified and the per-rule counts add up to its per-level totals; otherwise they stay unavailable and the run logs a warning.

Observations archived before that step existed can be given their per-rule counts from the `rules.json` that the same run committed to Git:

```bash
python3 scripts/progress_history.py --backfill-rule-counts
```

An enriched observation replaces its file (the name carries a content digest); every value already archived stays as it was. Observations whose run recorded only portfolio totals per rule (before November 5, 2026) are left untouched.

Both commands accept `--data-dir` for isolated output (that directory must contain the mapping CSV, and the normal archive command also needs `sites.json`). Department data can remain empty for local previews.

Focused checks, requiring the existing Python dependencies plus `cryptography` used by the Pages encryption step:

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.js
```

Optional Chromium integration checks use Playwright installed outside the
repository (for example in a temporary tooling directory). Install `playwright`
there and run its `playwright install chromium` command. With a loopback
preview server running, build `_site/` using the Pages workflow's asset-copy
and encryption steps with the non-production password
`staging-validation-only`, then run:

```bash
NODE_PATH=/absolute/path/to/tooling/node_modules node tests/progress-browser.cjs
```

`PREVIEW_URL` and `PREVIEW_PASSWORD` override the local URL and test password.
The browser check makes no Siteimprove/Asana calls and dispatches no workflows.

Run `python3 -m http.server 8000 --bind 127.0.0.1` and open `/progress.html` or `/data.html` for a local preview. Plain-data fallback is allowed only on loopback hosts after an encrypted file returns 404, never after an authentication/network failure or on a published host.

### Publication and access

The collection runs in an isolated output directory. Publication uses a fresh temporary Git worktree on latest `main`, merges immutable history, rebuilds the index, and pushes one commit; rejected pushes replay against the newest `main` without discarding concurrent history. Failures publish attempt metadata separately without changing last-good snapshots. Asana chains only successful main-branch refreshes.

The dashboard is published at <https://lsa-mis.github.io/accessibilityanalysisreportlsa/dashboard/> (live snapshot; progress at `dashboard/progress.html`). The site root and the old `data.html` / `progress.html` addresses redirect there, keeping query strings and `#tab` links.

Pages publishes both pages, their scripts and stylesheets (the explicit `cp` list in `.github/workflows/pages.yml` must include any new asset), and **encrypted** latest/history/mapping/status resources, never plaintext dashboard JSON, CSV, or gzip archives. All resources share the deployment's salt/key. Historical payloads stay gzip-compressed inside encryption and are decompressed in the browser; a modern browser supporting Web Crypto and `DecompressionStream` is required. Only selected snapshot details are loaded, not the complete archive.

The existing shared password permits portfolio-wide access; audience/department filters are not access controls. Repository access permissions are unchanged.

## Rotating the API token

If the token is ever exposed, rotate it in Siteimprove (Settings → API users), then update the `SITEIMPROVE_API_KEY` secret in GitHub. No code change needed.

## Asana sync (same repo)

The `asana_sync/` package pushes the fresh Siteimprove data to the Asana project **External LSA Websites and Applications Inventory** — updating each site's `Added to Siteimprove` / `Siteimprove Issues Remediation (98%)` / `Siteimprove Target %` fields and creating tasks (in the right platform section) for sites not yet on the board.

- **Number of Pages:** pages Siteimprove scanned in its last crawl (the API's count, or the CSV export's *Pages crawled in last scan* when the API has none). This column was added by hand; the sync fills it but never creates it.
- **Estimated Target %:** for sites Siteimprove hasn't calculated a target for yet (it reports target score and target % as 0 while the accessibility score is real), the fetch estimates the target % as the median target % of the 50 sites with the closest accessibility score. Back-tested against ~1,500 sites with a real target, it averages about 1 point off. Estimated values carry `(estimate)` on the dashboard, `Target % (estimate)` in the task's `Siteimprove Tags` and `Siteimprove Scan inProgress` in Accessibility Project Status, and never set the 98% remediation field. A real target from Siteimprove replaces the estimate automatically.
- **Accessibility Project Status:**
  - `Archived`: a sync-created task (Source = Siteimprove API or CSV export) whose site is no longer in the Siteimprove data. The task stays open.
  - `Private`: the Siteimprove API returns the site but with no accessibility score (it can't scan it, e.g. it needs a login).
  - `Siteimprove Scan inProgress`: Siteimprove hasn't calculated a site target yet (Target % is an estimate).
  - Private and Scan inProgress are cleared once they no longer apply; Archived is never cleared automatically. The sync only replaces a blank value or one of these three, so statuses people set (In Progress, On Hold, …) and the Rails section are left alone. The options must already exist on the board. `Status (Accessibility)` is unchanged: new tasks still get `active`.

- **Chained automatically:** `.github/workflows/sync-asana.yml` runs via `workflow_run` whenever **Refresh Siteimprove data** finishes successfully on `main`. It reads `data/sites.json` directly from the checkout — the single source of truth (the fetch already folds in CSV-only sites and tags), no URLs, no Pages-deploy wait.
- **Credentials:** add an Asana Personal Access Token as the repo secret `ASANA_TOKEN` (a user/service account that can edit that project).
- **Safety:** writes are gated by the `DRY_RUN` repo variable (default `true`). Set it to `false` to let scheduled/chained runs write to the board. Manual runs (Actions → Run workflow) use the *Dry run* checkbox.
- **Tuning (optional repo variables):** `ASANA_PROJECT_GID`, `CREATE_MISSING` (create tasks for missing sites), `MAX_CREATES`, `CREATE_MISSING_FIELDS` (auto-create the `Siteimprove Target %` number field), `REMEDIATION_THRESHOLD`.
- **Run locally:** `ASANA_TOKEN=… DRY_RUN=true python -m asana_sync.sync` (reads the repo's local data files by default).

### Siteimprove API diagnostic

`.github/workflows/siteimprove-diagnostic.yml` (manual, read-only) prints the raw Siteimprove API responses — site detail, site target, groups, crawl status — for a sample of sites (or the site IDs you enter) to the run log. Use it to check what the API actually returns before changing how a field is read. It writes nothing.

### DS/RSE a11y board

A separate, **manual-only** workflow — `.github/workflows/sync-asana-dsrse.yml` (Actions → *Sync Siteimprove → DS/RSE a11y board* → Run workflow, *Dry run* on by default) — runs `python -m asana_sync.dsrse_sync`. For every site tagged **RSE**, **WP-DigitalScholarship** or **Omeka**, it updates `Siteimprove Target %` on the **DS/RSE a11y** Asana board.

- **Matching:** each site is matched to the task whose **Public URL** column holds the same URL (scheme, `www.` and trailing slash ignored). A URL found on more than one task is logged and skipped.
- **Update-only:** writes only `Siteimprove Target %`, and only when the value changed. It never creates, moves, renames, completes or deletes tasks, and never adds fields or sections. Sites with no matching task are just listed in the log.
- **Settings:** `DSRSE_PROJECT_GID` (default `1219897101076354`), `DSRSE_URL_FIELD` (default `Public URL`); `ASANA_TOKEN` is shared with the inventory sync. Not chained to the daily refresh. The token's account must be able to edit this board.
- **Run locally:** `ASANA_TOKEN=… DRY_RUN=true python -m asana_sync.dsrse_sync`.
