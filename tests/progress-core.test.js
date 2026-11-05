const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../progress-core.js");
function site(key, target = 97, occurrences = 10) {
  return {
    key, id: key, site_name: String(key), url: `https://example.edu/${key}`,
    target_percentage: target, eligible: true, reasons: [], tags: ["tag:WP-Sites"],
    scan_status: "ok", issues_reliable: true, pdfs_reliable: true,
    pdf_count: 2, pdfs_with_issues: 1, pdf_total_issues: 3,
    by_level: Object.fromEntries(["A", "AA", "ARIA", "AAA", "BP"].map(l => [l, { issues: 1, occurrences }])),
  };
}
const compare = (b, a, mapping, filter) => core.compare({ sites: b }, { sites: a }, mapping, filter);
test("headline differences exclude AAA/BP and count rule/site pairs", () => {
  const c = compare([site(1, 97, 10)], [site(1, 98, 5)]);
  assert.deepEqual(c.headline_occurrences, { before: 30, after: 15, change: -15, count: 1 });
  assert.equal(c.headline_issues.before, 3);
  assert.equal(c.aaa_occurrences.before, 10);
  assert.equal(c.bp_occurrences.before, 10);
  assert.equal(c.target.change, 1);
  assert.equal(c.pdf_total_issues.before, 3);
});
test("inventory changes are not remediation", () => {
  const c = compare([site(1), site(2)], [site(1), site(3)]);
  assert.equal(c.matched, 1);
  assert.equal(c.added, 1);
  assert.equal(c.removed, 1);
  assert.equal(c.headline_occurrences.change, 0);
});
test("unknown cohorts are null, legitimate zero remains zero", () => {
  const unknown = compare([site(1)], [{ ...site(1), eligible: false, reasons: ["failed"] }]);
  assert.equal(unknown.headline_occurrences.change, null);
  assert.equal(unknown.target.change, null);
  assert.equal(unknown.gaps, 1);
  assert.equal(compare([site(1, 0, 0)], [site(1, 0, 0)]).headline_occurrences.change, 0);
});
test("legacy endpoint provenance does not become false remediation", () => {
  const c = compare([{ ...site(1), issues_reliable: false }], [site(1, 98)]);
  assert.equal(c.target.change, 1);
  assert.equal(c.headline_occurrences.change, null);
  assert.equal(c.headline_occurrences.count, 0);
});
test("ready line: 98% boundaries for WordPress and other platforms; no first-observation crossing", () => {
  for (const tag of ["WP", "WP-Sites", "WP-Courses", "WP-DigitalScholarship", "RSE", "Omeka", "Custom Sites"]) {
    const b = { ...site(1, 97.99), tags: [`tag:${tag}`] };
    const a = { ...site(1, 98), tags: [`tag:${tag}`] };
    assert.equal(compare([b], [a]).newly_ready, 1);
    assert.equal(compare([a], [b]).regressed, 1);
    assert.equal(compare([a], [{ ...a, target_percentage: 98.01 }]).newly_ready, 0);
  }
  assert.equal(compare([], [site(1, 99)]).newly_ready, null);
});
test("ready line: AEM sites cross at 93%", () => {
  const aem = (target) => ({ ...site(1, target), tags: ["tag:LSA", "tag:AEM"] });
  assert.equal(core.readyThreshold(aem(90)), 93);
  assert.equal(core.readyThreshold(site(1)), 98);
  assert.equal(compare([aem(92.99)], [aem(93)]).newly_ready, 1);
  assert.equal(compare([aem(93)], [aem(92.9)]).regressed, 1);
  assert.equal(compare([aem(95)], [aem(98)]).newly_ready, 0, "already past the AEM line");
  assert.equal(core.ready(aem(93)), true);
  assert.equal(core.ready(aem(92.99)), false);
  assert.equal(core.ready({ ...aem(95), target_estimated: true }), false);
});
test("manual handoff excludes estimates, failures, missing targets and 97.5", () => {
  for (const changes of [{ target_estimated: true }, { scan_status: "failed" }, { target_percentage: null }, { errors: ["failure"] }]) {
    assert.equal(core.reliable({ ...site(1, 98), ...changes }), false);
  }
  assert.equal(core.reliable(site(1, 98)), true);
  assert.equal(core.wordpress({ ...site(1), tags: ["tag:RSE", "tag:WP-Courses"] }), true);
  assert.equal(core.wordpress({ ...site(1), tags: ["tag:AEM"] }), false);
  assert.equal(core.ready(site(1, 97.5)), false);
  assert.equal(core.ready(site(1, 98)), true);
  assert.equal(core.ready({ ...site(1, 98), scan_status: "failed" }), false);
});
test("department assignment uses latest mapping for both dates", () => {
  const c = compare([site(1)], [site(1, 98)], { by_id: { 1: "History" } }, { department: "History" });
  assert.equal(c.matched, 1);
  assert.equal(c.rows[0].department, "History");
  assert.equal(core.department(site(2), {}), "Unmapped");
  assert.equal(core.department(site(2), { by_url: { "example.edu/2": "English" } }), "English");
});
test("platform/tag filters preserve OR semantics and exclusions", () => {
  const sites = [site(1), { ...site(2), tags: ["tag:AEM"] }, { ...site(3), tags: ["tag:Development", "tag:WP"] }];
  assert.equal(compare(sites, sites, {}, { platforms: ["WordPress", "AEM"] }).matched, 2);
  assert.equal(compare(sites, sites, {}, { tags: ["tag:AEM"] }).matched, 1);
  assert.equal(compare(sites, sites, {}, { search: "/1" }).matched, 1);
});
test("month shortcuts clamp month-end and leap dates, never go forward", () => {
  const e = date => ({ date, generated_at: date + "T07:00:00Z", path: date });
  assert.equal(core.baseline([e("2026-02-28"), e("2026-03-01")], e("2026-03-31"), "month").date, "2026-02-28");
  assert.equal(core.baseline([e("2024-02-29")], e("2024-03-31"), "month").date, "2024-02-29");
  assert.equal(core.baseline([e("2026-11-02")], e("2026-11-05"), "week"), null);
  assert.equal(core.baseline([e("2026-10-03")], e("2026-11-05"), "month").date, "2026-10-03");
});
test("daily selection preserves actual latest same-date observation", () => {
  const entries = [
    { date: "2026-11-05", generated_at: "2026-11-05T07:00:00Z", path: "a" },
    { date: "2026-11-05", generated_at: "2026-11-05T08:00:00Z", path: "b" },
  ];
  assert.equal(core.daily(entries)[0].path, "b");
});
test("CSV escaping prevents formulas but preserves numeric reductions", () => {
  assert.equal(core.csvCell('=HYPERLINK("x")'), `"\'=HYPERLINK(""x"")"`);
  assert.equal(core.csvCell(-300), '"-300"');
  assert.equal(core.csvCell("a,b\nc"), '"a,b\nc"');
});
