# LSA Accessibility Report

Static site published via GitHub Pages, with a live Siteimprove dashboard refreshed weekly by a scheduled GitHub Action.

## Layout

- `index.html` — narrative accessibility report (manually authored, with live data wiring)
- `data.html` — live dashboard (searchable, filterable per-site view)
- `data/sites.json`, `data/rules.json` — snapshots written by the fetch script; consumed by both pages
- `data/site-tags.csv` — optional admin-configured site labels from the Siteimprove UI (see below)

## Admin-configured site labels (optional)

Siteimprove's site labels (e.g. `LSA`, `AEM`, `Humanities`, `WP-Sites`) live behind the management UI at `my2.us.siteimprove.com`, which requires session cookies — unreachable from a cron-driven workflow with the public API token.

To make those labels flow through anyway, export them once from the Siteimprove UI and check the file in:

1. In Siteimprove → **Settings → Sites** → look for an **Export** action (CSV / Excel)
2. Save the export at `data/site-tags.csv` with at minimum these columns (case-insensitive, any subset works):
   - `site_id` (preferred match key)
   - `url` (fallback match key)
   - `site_name` or `name` (last-resort match key)
   - `tags` or `labels` (comma-, pipe-, or semicolon-separated label names)
3. Commit the file. The next fetch run merges the labels onto each row as `tag:<label>` entries; the dashboard renders them as distinctive maize-on-blue chips.

Re-export and overwrite the file whenever the tag assignments change in Siteimprove.
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
