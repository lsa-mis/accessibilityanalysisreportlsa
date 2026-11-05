const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../problems-core.js");

const guide = {
  audiences: { editors: "Content editors", developers: "Web developers" },
  rules: {
    "1": { audience: "editors", fixedIn: "Page content", plain: "Link text is unclear", why: "Why.", fix: ["Fix it."] },
    "2": { audience: "developers", fixedIn: "Site theme", plain: "Landmarks missing", why: "Why 2.", fix: [] },
  },
};
const site = (id, pages, extra = {}) => ({ id, site_name: "Site " + id, url: `https://example.invalid/${id}`, pages, platform: "WordPress", tags: ["tag:WP", "tag:Humanities"], ...extra });
const sites = new Map([site(10, 100), site(11, 10), site(12, 5)].map(s => [String(s.id), s]));
const rules = [
  { rule_id: 1, title: "Link text", level: "A", sites_affected: 3, total_occurrences: 60, sites: [[10, 40, 30], [11, 15, 9], [99, 5, 1]] },
  { rule_id: 2, title: "Landmarks", level: "ARIA", sites_affected: 1, total_occurrences: 30, sites: [[12, 30, 5]] },
  { rule_id: 3, title: "AAA only", level: "AAA", sites_affected: 1, total_occurrences: 9, sites: [[10, 9, 1]] },
  { rule_id: 4, title: "Unsorted check", level: "AA", sites_affected: 1, total_occurrences: 1, sites: [[11, 1, 1]] },
];

test("aggregate keeps only sites in view, drops AAA and marks theme-wide problems", () => {
  const rows = P.aggregate(rules, sites, guide);
  assert.deepEqual(rows.map(r => r.id), ["1", "2", "4"]);
  const link = rows.find(r => r.id === "1");
  assert.equal(link.sitesAffected, 2, "site 99 is filtered out");
  assert.equal(link.occurrences, 55);
  assert.equal(link.pages, 39);
  assert.deepEqual(link.sites.map(s => s.site.id), [10, 11]);
  assert.equal(link.every, 1, "site 11 has it on 9 of 10 pages");
  assert.equal(rows.find(r => r.id === "2").every, 1);
  assert.equal(rows.find(r => r.id === "4").audience, P.FALLBACK_AUDIENCE);
});

test("rules without per-site data fall back to totals and no site lists", () => {
  const rows = P.aggregate([{ rule_id: 1, title: "Link text", level: "A", sites_affected: 7, total_occurrences: 70 }], sites, guide);
  assert.equal(rows[0].hasSiteData, false);
  assert.equal(rows[0].sitesAffected, 7);
  assert.equal(rows[0].occurrences, 70);
  assert.equal(rows[0].pages, null, "unknown stays null, never zero");
  assert.deepEqual(rows[0].sites, []);
});

test("sorting and audience summaries", () => {
  const rows = P.aggregate(rules, sites, guide);
  assert.deepEqual(P.sortRows(rows, "sites").map(r => r.id), ["1", "2", "4"]);
  assert.deepEqual(P.sortRows(rows, "occurrences").map(r => r.id), ["1", "2", "4"]);
  const auds = P.audiences(rows, guide);
  const editors = auds.find(a => a.key === "editors");
  assert.equal(editors.topics, 1);
  assert.equal(editors.sites, 2);
  assert.equal(editors.share, Math.round(55 / 86 * 100));
  assert.ok(auds.some(a => a.key === P.FALLBACK_AUDIENCE && a.label === "Not yet categorised"));
});

test("group counts and training brief", () => {
  const link = P.aggregate(rules, sites, guide).find(r => r.id === "1");
  assert.deepEqual(P.groupCounts(link.sites, s => s.platform), [{ label: "WordPress", count: 2 }]);
  const brief = P.brief(link, guide, 3, "All sites");
  assert.match(brief, /Training brief: Link text is unclear/);
  assert.match(brief, /Who to train: Content editors/);
  assert.match(brief, /Found on 2 of 3 sites, 55 times/);
  assert.match(brief, /- Fix it\./);
  assert.match(brief, /Site 10 \(https:\/\/example\.invalid\/10\): 40/);
  assert.match(brief, /not verified fixes/);
});
