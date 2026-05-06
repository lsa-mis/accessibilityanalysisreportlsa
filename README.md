# LSA Accessibility Report

Static site published via GitHub Pages, with a live Siteimprove dashboard refreshed weekly by a scheduled GitHub Action.

## Layout

- `index.html` — narrative accessibility report (manually authored)
- `accessibiltiyreport/` — supplemental report pages, including `data.html` (the live dashboard)
- `data/sites.json` — snapshot written by the fetch script; consumed by `data.html`
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

   Then open <http://localhost:8000/accessibiltiyreport/data.html>.

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
