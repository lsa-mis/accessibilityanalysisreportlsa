// Focused integration check against a local preview; see README for Playwright setup.
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
    const snapshot = (date, count) => ({
      schema_version: 1, reporting_date: date, generated_at: `${date}T07:00:00Z`,
      rules: { 11: { title: "Test issue", level: "A" } },
      sites: [{
        key: "id:1", id: 1, site_name: "Test", url: "https://example.invalid",
        tags: ["tag:AEM"], target_percentage: 95, eligible: true, reasons: [],
        issues_reliable: true, pdfs_reliable: true, scan_status: "ok", pages: 10,
        pdf_count: 0, pdfs_with_issues: 0, pdf_total_issues: 0,
        by_level: Object.fromEntries(["A", "AA", "ARIA", "AAA", "BP"].map(level =>
          [level, { issues: level === "A" ? 1 : 0, occurrences: level === "A" ? count : 0 }])),
        rule_occurrences: { 11: count },
      }],
    });
    const snapshots = [snapshot("2026-11-05", 10), snapshot("2026-11-06", 7), snapshot("2026-11-16", 4)];
    for (const [i, s] of snapshots.entries()) {
      s.sites.push({
        ...s.sites[0], key: "id:2", id: 2, site_name: "Second",
        rule_occurrences: { 11: 100 },
        eligible: i !== 2, issues_reliable: i !== 2, scan_status: i === 2 ? "running" : "ok",
      });
    }
    await page.route("**/data/history/index.json", route => route.fulfill({ json: {
      schema_version: 1, entries: snapshots.map((s, i) => ({
        path: `history/test${i}.json.gz`, date: s.reporting_date, generated_at: s.generated_at,
        mean_target: 95, site_count: 2, eligible_count: s.sites.filter(site => site.eligible).length, rule_counts: true,
      })),
    } }));
    await page.route("**/data/history/test*.json.gz", route => {
      const index = Number(route.request().url().match(/test(\d)\.json\.gz$/)[1]);
      return route.fulfill({ body: gzipSync(JSON.stringify(snapshots[index])), contentType: "application/gzip" });
    });
    await page.route("**/data/departments.json", route => route.fulfill({ json: { by_id: {}, by_url: {} } }));
    await page.route("**/data/refresh-status.json", route => route.fulfill({ json: { success: true } }));
    await page.goto(`${base}/progress.html#issues`);
    await page.locator("#report").waitFor({ state: "visible" });
    await page.locator('button[data-platform="AEM"]').click();

    async function check(beforeDate, afterDate, beforeCount, afterCount) {
      assert.equal(await page.locator("#issues-before-date").innerText(), beforeDate);
      assert.equal(await page.locator("#issues-after-date").innerText(), afterDate);
      const cells = page.locator("#issues-body tr").first().locator("td");
      assert.equal(await cells.nth(1).innerText(), String(beforeCount));
      assert.equal(await cells.nth(2).innerText(), String(afterCount));
      assert.match(await cells.nth(3).innerText(), new RegExp(`−${beforeCount - afterCount}`));
      assert.match(await page.locator("#issues-caption").textContent(), new RegExp(`${beforeDate} to ${afterDate}`));
    }

    await check("November 5, 2026", "November 16, 2026", 110, 4);
    assert.match(await page.locator("#issues-note").innerText(), /2 of 2 sites on November 5, 2026; 1 of 2 on November 16, 2026/);
    assert.match(await page.locator("#issues-note").innerText(), /Site coverage differs/);
    assert.doesNotMatch(await page.locator("#issues-body").innerText(), /better|worse/);
    const partialDownloadPromise = page.waitForEvent("download");
    await page.locator("#export-issues-csv").click();
    const partialCsv = await readFile(await (await partialDownloadPromise).path(), "utf8");
    assert.match(partialCsv, /Site coverage differs/);
    assert.match(partialCsv, /"110","4","-106"/);
    await page.locator("#from-btn").click();
    await page.locator('#date-picker button[data-date="2026-11-06"]').click();
    await page.locator("#report").waitFor({ state: "visible" });
    await check("November 6, 2026", "November 16, 2026", 107, 4);
    await page.locator("#from-btn").click();
    await page.locator('#date-picker button[data-date="2026-11-05"]').click();
    await page.locator("#report").waitFor({ state: "visible" });
    await page.locator("#to-btn").click();
    await page.locator('#date-picker button[data-date="2026-11-06"]').click();
    await page.locator("#report").waitFor({ state: "visible" });
    await check("November 5, 2026", "November 6, 2026", 110, 107);
    assert.match(await page.locator("#issues-note").innerText(), /The same sites are counted/);
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#export-issues-csv").click();
    const csv = await readFile(await (await downloadPromise).path(), "utf8");
    assert.match(csv, /Occurrences on November 5, 2026/);
    assert.match(csv, /Occurrences on November 6, 2026/);
    assert.match(csv, /"110","107","-3"/);
    await page.route("**/data/history/test2.json.gz", route => route.fulfill({
      body: gzipSync(JSON.stringify({
        ...snapshots[2], sites: snapshots[2].sites.map(site => ({ ...site, issues_reliable: false })),
      })),
      contentType: "application/gzip",
    }));
    await page.reload();
    await page.locator("#report").waitFor({ state: "visible" });
    await page.locator('button[data-platform="AEM"]').click();
    const unavailableCells = page.locator("#issues-body tr").first().locator("td");
    assert.equal(await unavailableCells.nth(1).innerText(), "110");
    assert.equal(await unavailableCells.nth(2).innerText(), "—");
    assert.equal(await unavailableCells.nth(3).innerText(), "Not comparable");
    assert.match(await page.locator("#issues-note").innerText(), /0 of 2 on November 16, 2026/);
    assert.deepEqual(errors, []);
    console.log("Issue comparison date selection passed.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
