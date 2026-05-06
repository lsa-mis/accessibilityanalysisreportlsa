# LSA Accessibility Report

Static site published via GitHub Pages, with a live Siteimprove dashboard refreshed weekly by a scheduled GitHub Action.

## Layout

- `index.html` — narrative accessibility report (manually authored, with live data wiring)
- `data.html` — live dashboard (searchable, filterable per-site view)
- `data/sites.json`, `data/rules.json` — snapshots written by the fetch script; consumed by both pages
- `data/site-tags.csv` — optional admin-configured site labels from the Siteimprove UI (see below)

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
- `scripts/fetch_siteimprove.py` — pulls site list and per-site accessibility summary from the Siteimprove API
- `.github/workflows/fetch-siteimprove.yml` — runs the fetch on a schedule and commits any changes
- `.github/workflows/pages.yml` — deploys the site to GitHub Pages on every push to `main`

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

The schedule is `0 11 * * 1` (Mondays at 11:00 UTC ≈ 07:00 ET). Edit `.github/workflows/fetch-siteimprove.yml` to change cadence.

## Rotating the API token

If the token is ever exposed, rotate it in Siteimprove (Settings → API users), then update the `SITEIMPROVE_API_KEY` secret in GitHub. No code change needed.
