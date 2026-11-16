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
        pdf_count: 1, pdfs_with_issues: 1, pdf_total_issues: 2,
        by_level: Object.fromEntries(["A", "AA", "ARIA", "AAA", "BP"].map(level =>
          [level, { issues: level === "A" ? 1 : 0, occurrences: level === "A" ? count : 0 }])),
        rule_occurrences: { 11: count },
      }],
    });
    const snapshots = [snapshot("2026-11-05", 10), snapshot("2026-11-06", 7), snapshot("2026-11-16", 4)];
    for (const [i, s] of snapshots.entries()) {
      s.sites[0].target_percentage = [91, 95, 97][i];
      s.sites.push({
        ...s.sites[0], key: "id:2", id: 2, site_name: "Second",
        target_percentage: 99, rule_occurrences: { 11: 100 }, pdf_count: 3,
        by_level: Object.fromEntries(["A", "AA", "ARIA", "AAA", "BP"].map(level =>
          [level, { issues: level === "A" ? 1 : 0, occurrences: level === "A" ? 100 : 0 }])),
        eligible: i !== 2, issues_reliable: i !== 2, scan_status: i === 2 ? "running" : "ok",
      });
      s.sites.push({
        ...s.sites[0], key: "id:3", id: 3, site_name: "WordPress",
        tags: ["tag:WP"], target_percentage: 60,
      });
    }
    await page.route("**/data/history/index.json", route => route.fulfill({ json: {
      schema_version: 1, entries: snapshots.map((s, i) => ({
        path: `history/test${i}.json.gz`, date: s.reporting_date, generated_at: s.generated_at,
        mean_target: 80, site_count: 3, eligible_count: s.sites.filter(site => site.eligible).length, rule_counts: true,
      })),
    } }));
    await page.route("**/data/history/test*.json.gz", route => {
      const index = Number(route.request().url().match(/test(\d)\.json\.gz$/)[1]);
      return route.fulfill({ body: gzipSync(JSON.stringify(snapshots[index])), contentType: "application/gzip" });
    });
    await page.route("**/data/departments.json", route => route.fulfill({ json: {
      by_id: { 1: "Test department", 2: "Test department", 3: "Other department" }, by_url: {},
    } }));
    await page.route("**/data/refresh-status.json", route => route.fulfill({ json: { success: true } }));
    await page.goto(`${base}/progress.html#issues`);
    await page.locator("#report").waitFor({ state: "visible" });
    await page.locator('button[data-platform="AEM"]').click();
    assert.equal(await page.locator("#inventory-before").innerText(), "2");
    assert.equal(await page.locator("#inventory-after").innerText(), "2");
    assert.equal(await page.locator("#inventory-change").innerText(), "No net change", "a running scan is not an inventory loss");
    assert.equal(await page.locator("#inventory-only-end").isDisabled(), true);
    assert.equal(await page.locator("#inventory-only-start").isDisabled(), true);

    async function checkOtherTabs(endDate, endIssues, endReliable, endReady) {
      await page.getByRole("button", { name: "Overview", exact: true }).click();
      assert.equal(await page.locator("#inventory-summary").isVisible(), true);
      const scoreCard = page.locator("#metrics .kpi").filter({ has: page.getByRole("heading", { name: "Average score", exact: true }) });
      assert.equal(await scoreCard.locator(".kpi-value").innerText(), "97.0%");
      assert.equal(await scoreCard.locator(".muted.tnum").innerText(), "from 95.0%");
      const readyCard = page.locator("#metrics .kpi").filter({ has: page.getByRole("heading", { name: "Sites ready for manual testing", exact: true }) });
      assert.equal(await readyCard.locator(".kpi-value").innerText(), String(endReady));
      assert.equal(await readyCard.locator(".muted.tnum").innerText(), "from 1");
      const issueCard = page.locator("#metrics .kpi").filter({ has: page.getByRole("heading", { name: "Issues (occurrences)", exact: true }) });
      assert.equal(await issueCard.locator(".muted.tnum").innerText(), "from 110");
      assert.equal(await issueCard.locator(".kpi-value").innerText(), String(endIssues));
      if (endReliable === 1) assert.doesNotMatch(await page.locator("#metrics").innerText(), /better|worse/);
      assert.match(await page.locator("#comparison-coverage").innerText(), /2 of 2 sites on November 5, 2026/);
      await page.locator("#extra-measures summary").click();
      const pdfCells = page.locator("#supplementary-metrics tr").filter({ has: page.getByRole("rowheader", { name: "PDFs", exact: true }) }).locator("td");
      assert.equal(await pdfCells.nth(0).innerText(), "4");
      assert.equal(await pdfCells.nth(1).innerText(), endReliable === 1 ? "1" : "4");
      await page.locator("#extra-measures summary").click();
      await page.waitForFunction(() => !document.getElementById("trend-plot").hasAttribute("aria-busy"));
      assert.match(await page.locator("#trend-summary").innerText(), /95\.0% on November 5, 2026, 97\.0%/);
      assert.match(await page.locator("#trend-summary").innerText(), /platform AEM/);
      await page.locator("#toggle-trend-table").click();
      const trendStart = page.locator("#trend-body tr").filter({ hasText: "November 5, 2026" });
      assert.equal(await trendStart.locator("td").nth(1).innerText(), "95.0%");
      assert.equal(await trendStart.locator("td").nth(2).innerText(), "2 of 2");
      await page.locator("#toggle-trend-table").click();

      await page.getByRole("button", { name: "Departments", exact: true }).click();
      assert.equal(await page.locator("#inventory-summary").isVisible(), true);
      const deptCells = page.locator("#departments-body tr").filter({ hasText: "Test department" }).locator("td");
      assert.equal(await deptCells.nth(1).innerText(), `1 → ${endReady}`);
      assert.match(await deptCells.nth(2).innerText(), /95\.0% → 97\.0%/);
      assert.match(await deptCells.nth(3).innerText(), new RegExp(`110 → ${endIssues}`));
      if (endReliable === 1) assert.doesNotMatch(await deptCells.nth(2).innerText(), /better|worse/);
      await page.getByRole("button", { name: "Sites", exact: true }).click();
      assert.equal(await page.locator("#inventory-summary").isVisible(), true);
      const siteCells = page.locator("#sites-body tr").filter({ hasText: "Second" }).locator("td");
      assert.equal(await siteCells.nth(2).innerText(), "99.0%");
      assert.equal(await siteCells.nth(3).innerText(), endReliable === 1 ? "—" : "99.0%");
      assert.equal(await siteCells.nth(5).innerText(), "100");
      assert.equal(await siteCells.nth(6).innerText(), endReliable === 1 ? "—" : "100");
      assert.match(await page.locator("#sites-table thead").innerText(), new RegExp(endDate));
      const csvPromise = page.waitForEvent("download");
      await page.locator("#export-csv").click();
      const csv = await readFile(await (await csvPromise).path(), "utf8");
      assert.match(csv, /Each date is counted independently/);
      assert.match(csv, /Average score: 95.0% to 97.0%/);
      assert.match(csv, /Issues on November 5, 2026/);
      assert.match(csv, /Site inventory: 2 on November 5, 2026 → 2 on/);
      await page.getByRole("button", { name: "Issues", exact: true }).click();
      assert.equal(await page.locator("#inventory-summary").isVisible(), true);
    }

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
    await checkOtherTabs("November 16, 2026", 4, 1, 1);
    assert.match(await page.locator("#issues-note").innerText(), /2 of 2 sites on November 5, 2026; 1 of 2 on November 16, 2026/);
    assert.match(await page.locator("#issues-note").innerText(), /Site coverage differs/);
    assert.doesNotMatch(await page.locator("#issues-body").innerText(), /better|worse/);
    const partialDownloadPromise = page.waitForEvent("download");
    await page.locator("#export-issues-csv").click();
    const partialCsv = await readFile(await (await partialDownloadPromise).path(), "utf8");
    assert.match(partialCsv, /Site coverage differs/);
    assert.match(partialCsv, /"110","4","-106"/);
    assert.match(partialCsv, /Site inventory: 2 on November 5, 2026 → 2 on November 16, 2026/);
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
    await checkOtherTabs("November 6, 2026", 107, 2, 2);
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
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.waitForFunction(() => !document.getElementById("trend-plot").hasAttribute("aria-busy"));
    // Search and department selection must reach the trend as well as the metric cards.
    await page.locator("#search").fill("Second");
    await page.waitForFunction(() => !document.getElementById("trend-plot").hasAttribute("aria-busy"));
    assert.match(await page.locator("#trend-summary").innerText(), /search “Second”/);
    assert.equal(await page.locator("#trend-plot .pt").count(), 2, "no fabricated zero point for the running scan");
    await page.locator("#toggle-trend-table").click();
    const unavailableTrend = page.locator("#trend-body tr").filter({ hasText: "November 16, 2026" });
    assert.equal(await unavailableTrend.locator("td").nth(1).innerText(), "—");
    assert.equal(await unavailableTrend.locator("td").nth(2).innerText(), "0 of 1");
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await page.waitForFunction(() => !document.getElementById("trend-plot").hasAttribute("aria-busy"));
    assert.match(await page.locator("#trend-summary").innerText(), /83\.3% on November 5, 2026, 78\.5%/);
    await page.getByRole("button", { name: "Departments", exact: true }).click();
    await page.getByRole("button", { name: "Test department", exact: true }).click();
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.waitForFunction(() => !document.getElementById("trend-plot").hasAttribute("aria-busy"));
    assert.match(await page.locator("#trend-summary").innerText(), /95\.0% on November 5, 2026, 97\.0%/);
    assert.match(await page.locator("#trend-summary").innerText(), /department Test department/);
    await page.goto(`${base}/progress.html?tag=tag%3AWP`);
    await page.locator("#report").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.getElementById("trend-plot").hasAttribute("aria-busy"));
    assert.match(await page.locator("#trend-summary").innerText(), /60\.0% on November 5, 2026, 60\.0%/);
    assert.match(await page.locator("#trend-summary").innerText(), /labels WP/);
    await page.route("**/data/history/test1.json.gz", async route => {
      await new Promise(resolve => setTimeout(resolve, 200));
      await route.fulfill({ body: gzipSync(JSON.stringify(snapshots[1])), contentType: "application/gzip" });
    });
    await page.goto(`${base}/progress.html`);
    await page.locator("#report").waitFor({ state: "visible" });
    await page.locator("#search").fill("Second");
    await page.locator("#search").fill("WordPress");
    await page.waitForFunction(() => !document.getElementById("trend-plot").hasAttribute("aria-busy"));
    assert.match(await page.locator("#trend-summary").innerText(), /60\.0% on November 5, 2026, 60\.0%/);
    assert.match(await page.locator("#trend-summary").innerText(), /search “WordPress”/);
    await page.route("**/data/history/test1.json.gz", route => route.fulfill({ status: 500, body: "Fixture failure" }));
    await page.reload();
    await page.locator("#report").waitFor({ state: "visible" });
    await page.locator("#trend-plot").filter({ hasText: /Filtered trend is unavailable:.*HTTP 500/ }).waitFor();

    // Inventory additions/removals are distinct from scan reliability and follow filters.
    const inventoryStart = { ...snapshots[0], sites: snapshots[0].sites.slice(0, 2) };
    const added = id => ({ ...snapshots[2].sites[0], key: `id:${id}`, id, site_name: `Added ${id}` });
    const inventoryEnd = { ...snapshots[2], sites: [
      { ...snapshots[2].sites[0], eligible: false, issues_reliable: false, scan_status: "running" },
      snapshots[2].sites[2], added(4), added(5),
    ] };
    await page.route("**/data/history/test0.json.gz", route => route.fulfill({
      body: gzipSync(JSON.stringify(inventoryStart)), contentType: "application/gzip",
    }));
    await page.route("**/data/history/test2.json.gz", route => route.fulfill({
      body: gzipSync(JSON.stringify(inventoryEnd)), contentType: "application/gzip",
    }));
    await page.route("**/data/history/test1.json.gz", route => route.fulfill({
      body: gzipSync(JSON.stringify(snapshots[1])), contentType: "application/gzip",
    }));
    await page.goto(`${base}/progress.html?inventory=1#issues`);
    await page.locator("#report").waitFor({ state: "visible" });
    assert.equal(await page.locator("#inventory-before").innerText(), "2");
    assert.equal(await page.locator("#inventory-after").innerText(), "4");
    assert.equal(await page.locator("#inventory-change").innerText(), "2 more sites");
    assert.equal(await page.locator("#inventory-only-end").innerText(), "View sites only at end (3)");
    assert.equal(await page.locator("#inventory-only-start").innerText(), "View sites only at start (1)");
    await page.locator("#inventory-only-end").click();
    assert.match(page.url(), /#sites$/);
    assert.equal(await page.locator("#sites-body tr").count(), 3);
    assert.match(await page.locator("#sites-body").innerText(), /Added 4/);
    assert.equal(await page.evaluate(() => document.activeElement.id), "sites-heading");
    await page.locator("#inventory-only-start").click();
    assert.equal(await page.locator("#sites-body tr").count(), 1);
    assert.match(await page.locator("#sites-body").innerText(), /Second/);
    assert.equal(await page.locator("#inventory-change").innerText(), "2 more sites", "site detail subfilters do not redefine inventory");
    await page.locator('button[data-platform="AEM"]').click();
    assert.equal(await page.locator("#inventory-after").innerText(), "3");
    assert.equal(await page.locator("#inventory-change").innerText(), "1 more site");
    await page.getByRole("button", { name: "Departments", exact: true }).click();
    await page.getByRole("button", { name: "Test department", exact: true }).click();
    assert.equal(await page.locator("#inventory-before").innerText(), "2");
    assert.equal(await page.locator("#inventory-after").innerText(), "1");
    assert.equal(await page.locator("#inventory-change").innerText(), "1 fewer site");
    await page.locator("#search").fill("no-match");
    assert.equal(await page.locator("#inventory-before").innerText(), "0");
    assert.equal(await page.locator("#inventory-after").innerText(), "0");
    assert.equal(await page.locator("#inventory-change").innerText(), "No net change");
    assert.equal(await page.locator("#inventory-only-end").isDisabled(), true);
    await page.locator("#clear-filters").click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.emulateMedia({ media: "print" });
    assert.equal(await page.locator("#inventory-summary").isVisible(), true);
    assert.deepEqual(errors, []);
    console.log("All Progress tabs, inventory changes, filtered trend, daily coverage, and exports passed.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
