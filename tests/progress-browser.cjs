// Optional integration checks against a local preview; see README for setup.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { gzipSync } = require("node:zlib");
const { readFile } = require("node:fs/promises");
const base = process.env.PREVIEW_URL || "http://127.0.0.1:8765";

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/progress.html`);
    await page.locator("#report").waitFor({ state: "visible" });
    assert.match(await page.locator("#refresh-warning").innerText(), /Historical import/);
    assert.match(await page.locator("#quality-note").innerText(), /Historical issue/);
    await page.locator("#to-btn").click();
    await page.locator("#calendar-title").waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.id), "calendar-title");
    assert.equal(await page.locator("#date-picker button.cal-day").count() >= 1, true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#date-picker").isVisible(), false);
    await page.getByRole("button", { name: "Last week", exact: true }).click();
    await page.locator("#report").waitFor({ state: "visible" });
    assert.match(await page.locator("#date-note").innerText(), /snapshot|Reliable data/);
    await page.getByRole("button", { name: "Sites", exact: true }).click();
    assert.match(page.url(), /#sites$/);
    await page.locator("#search").fill("no-match-integration-fixture");
    assert.match(await page.locator("#sites-body").innerText(), /No sites match/);
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    assert.equal(await page.locator("#sites-body tr").count() > 1, true);

    await page.goto(`${base}/data.html`);
    await page.locator(".ready-row").first().waitFor({ state: "attached" });
    const ready = await page.evaluate(() => ({
      count: readySites(state.sites).length,
      valid: readySites(state.sites).every(s => ProgressCore.reliable(s) && s.target_percentage >= (ProgressCore.platform(s) === "AEM" ? 93 : 98)),
    }));
    assert.equal(ready.valid, true);
    assert.equal(ready.count > 0, true);
    const unavailable = await page.evaluate(() => {
      const row = decorate([{ id: 1, url: "https://example.invalid", tags: ["tag:WP"], issues_available: false }])[0];
      return row.lvl_a === null && selectedOccurrences(row) === null;
    });
    assert.equal(unavailable, true, "missing metrics must not render as zero");
    await page.locator("#progress-widget-content").filter({ hasText: /matched sites|both dates|reliable snapshots/ }).waitFor();
    // Ctrl/Cmd+K search opens a site's details panel; Escape closes it and focus returns.
    await page.locator("#search").click();
    await page.keyboard.press("Control+k");
    await page.locator("#site-search-input").waitFor();
    await page.keyboard.type("a");
    await page.keyboard.press("Enter");
    await page.locator(".side-panel").waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Close site details");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".side-panel").count(), 0);
    await page.getByRole("button", { name: /^Common problems/ }).click();
    assert.match(page.url(), /#problems$/);
    await page.locator("#problem-list .problem-btn").first().waitFor();
    await page.goto(`${base}/data.html#sites`);
    await page.locator("#panel-sites").waitFor({ state: "visible" });
    assert.equal(await page.locator("#sites-body tr").count() > 1, true);

    const encryptedRequests = [];
    page.on("request", request => {
      if (request.url().includes("/_site/data/")) encryptedRequests.push(request.url());
    });
    await page.goto(`${base}/_site/progress.html`);
    await page.locator("#password").fill("incorrect-fixture-password");
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await page.locator("#gate-error").filter({ hasText: /Unable to decrypt/ }).waitFor();
    assert.equal(await page.locator("body").getAttribute("class"), "locked");
    await page.locator("#password").fill(process.env.PREVIEW_PASSWORD || "staging-validation-only");
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await page.locator("#report").waitFor({ state: "visible" });
    assert.match(await page.locator("#comparison-context").innerText(), /Detroit/);
    assert(encryptedRequests.some(url => /history\/.*\.enc\.json$/.test(url)));
    assert(encryptedRequests.every(url => url.endsWith(".enc.json")));
    assert.equal(await page.locator("#report-error").isVisible(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (process.env.PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.PREVIEW_SCREENSHOT });
    await page.goto(`${base}/_site/data.html`);
    await page.locator(".ready-row").first().waitFor({ state: "attached" });
    assert.equal(await page.locator("body").getAttribute("class"), "");
    assert.equal(errors.length, 0, errors.join("\n"));

    const fixture = await browser.newPage();
    fixture.on("pageerror", error => errors.push(error.message));
    const site = (id, target, n) => ({
      key: `id:${id}`, id, site_name: "Test " + id, url: `https://example.invalid/${id}`,
      tags: ["tag:WP-Sites"], target_percentage: target, eligible: true, reasons: [],
      issues_reliable: true, pdfs_reliable: true, scan_status: "ok", pages: 10,
      pdf_count: 1, pdfs_with_issues: 1, pdf_total_issues: 2,
      by_level: Object.fromEntries(["A", "AA", "ARIA", "AAA", "BP"].map(l => [l, { issues: 1, occurrences: n }])),
    });
    const first = { schema_version: 1, generated_at: "2026-10-01T07:00:00Z", reporting_date: "2026-10-01", sites: [site(1, 97, 10), site(2, 95, 10)] };
    const last = { schema_version: 1, generated_at: "2026-11-01T07:00:00Z", reporting_date: "2026-11-01", sites: [site(1, 98, 5), site(3, 99, 5)] };
    await fixture.route("**/data/history/index.json", route => route.fulfill({ json: {
      schema_version: 1, entries: [first, last].map((s, i) => ({
        path: `history/test${i}.json.gz`, date: s.reporting_date, generated_at: s.generated_at,
        mean_target: 97, site_count: 2, eligible_count: 2,
      })),
    } }));
    await fixture.route("**/data/history/test*.json.gz", route => route.fulfill({
      body: gzipSync(JSON.stringify(route.request().url().includes("test0") ? first : last)),
      contentType: "application/gzip",
    }));
    await fixture.route("**/data/departments.json", route => route.fulfill({ json: { by_id: { 1: "Test department" }, by_url: {} } }));
    await fixture.route("**/data/refresh-status.json", route => route.fulfill({ json: { success: false } }));
    await fixture.goto(`${base}/progress.html`);
    await fixture.locator("#report").waitFor({ state: "visible" });
    assert.match(await fixture.locator("#coverage").innerText(), /Matched[\s\S]*1/);
    assert.match(await fixture.locator("#metrics").innerText(), /15\s*from 30/);
    assert.equal(await fixture.locator("#wp-up").innerText(), "1");
    assert.match(await fixture.locator("#refresh-warning").innerText(), /latest refresh failed/);
    await fixture.getByRole("button", { name: "Test department", exact: true }).click();
    assert.equal(await fixture.locator("#sites-body tr").count(), 1);
    await fixture.getByRole("button", { name: "Occurrence change", exact: true }).click();
    assert.equal(await fixture.locator('th[data-sort="occurrences"]').getAttribute("aria-sort"), "ascending");
    const downloadPromise = fixture.waitForEvent("download");
    await fixture.getByRole("button", { name: "Export comparison CSV" }).click();
    const download = await downloadPromise;
    const csv = await readFile(await download.path(), "utf8");
    assert.match(csv, /"30","15","-15"/);
    assert.match(csv, /2026-10-01T07:00:00Z/);
    assert.match(csv, /department list/);
    await fixture.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await fixture.getByRole("button", { name: "Overview", exact: true }).click();
    await fixture.getByRole("button", { name: "Share or export", exact: true }).click();
    await fixture.getByRole("button", { name: "Copy summary", exact: true }).click();
    assert.match(await fixture.evaluate(() => navigator.clipboard.readText()), /30 to 15/);
    await fixture.keyboard.press("Escape");
    await fixture.emulateMedia({ media: "print" });
    await fixture.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
    assert.equal(await fixture.locator("#supplementary-metrics").isVisible(), true);
    assert.equal(await fixture.locator("#open-export").isVisible(), false);
    assert.equal((await fixture.pdf()).length > 1000, true);
    await fixture.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log("Browser integration passed: history, calendar, tabs, Ctrl/Cmd+K search, site panel, filters, manual handoff, encrypted gzip, password rejection/reuse, responsive layout, matched changes, department drilldown, CSV/copy/print, and failed-refresh warning.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
