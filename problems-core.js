// Pure helpers for the "Common problems" tab. Works in the browser
// (window.ProblemsCore) and in Node tests (module.exports).
//
// rules.json global rows may carry `sites: [[siteId, occurrences, pages], ...]`
// (added to the nightly fetch). Older snapshots only have totals, in which
// case per-site lists are unavailable and totals cover every site.
(function (root) {
  "use strict";

  const FALLBACK_AUDIENCE = "unsorted";

  function guidanceFor(rule, guide) {
    const g = guide && guide.rules ? guide.rules[String(rule.rule_id)] : null;
    if (g) return g;
    return { audience: FALLBACK_AUDIENCE, fixedIn: "Not yet categorised", plain: rule.title || "Unnamed check", why: "", fix: [] };
  }

  // Siteimprove's Title II target covers Level A, AA and ARIA. Best practices
  // sit outside it, so a best-practice check is compared with every level.
  const TARGET_LEVELS = ["A", "AA", "ARIA"];
  const inScope = (level, scope) => scope === "all" ? level !== "AAA" : TARGET_LEVELS.includes(level);
  const scopeOf = level => TARGET_LEVELS.includes(level) ? "target" : "all";

  function pct(part, total) {
    if (part === null || part === undefined || !total) return null;
    return Math.min(100, Math.round(part / total * 1000) / 10);
  }

  // A site's own occurrences in scope (decorated lvl_* fields, else by_level).
  function siteOccurrences(site, scope) {
    if (!site || site.issues_available === false) return null;
    const levels = scope === "all" ? [...TARGET_LEVELS, "BP"] : TARGET_LEVELS;
    const field = { A: "lvl_a", AA: "lvl_aa", ARIA: "lvl_aria", BP: "lvl_bp" };
    return levels.reduce((n, l) => n + (site[field[l]] ?? site.by_level?.[l]?.occurrences ?? 0), 0);
  }

  // This problem's share of everything in scope for the sites in view:
  // occurrences, pages checked and sites. rows: aggregate() output for the
  // same sites; sitesInView: the filtered site list.
  function shares(row, rows, sitesInView) {
    const scope = scopeOf(row.level);
    const withData = (sitesInView || []).filter(s => s.issues_available !== false);
    const occTotal = rows.filter(r => inScope(r.level, scope)).reduce((n, r) => n + r.occurrences, 0);
    const pagesTotal = withData.reduce((n, s) => n + (typeof s.pages === "number" ? s.pages : 0), 0);
    const part = (issue, total) => ({ issue, total, pct: pct(issue, total) });
    return {
      scope,
      occurrences: part(row.occurrences, occTotal),
      pages: row.hasSiteData ? part(row.pages, pagesTotal) : null,
      sites: row.hasSiteData ? part(row.sitesAffected, withData.length) : null,
    };
  }

  function audienceName(key, guide) {
    if (key === FALLBACK_AUDIENCE) return "Not yet categorised";
    return (guide && guide.audiences && guide.audiences[key]) || key;
  }

  // rules: rulesData.rules; siteIndex: Map(id -> site) of the sites currently
  // in view (already filtered). Returns one row per rule, AAA excluded to
  // match the rest of the dashboard.
  function aggregate(rules, siteIndex, guide) {
    const rows = [];
    for (const rule of rules || []) {
      if (rule.level === "AAA") continue;
      const g = guidanceFor(rule, guide);
      const hasSiteData = Array.isArray(rule.sites);
      const scope = scopeOf(rule.level);
      let sites = [], occurrences, pages = null, every = null;
      if (hasSiteData) {
        for (const [id, occ, pg] of rule.sites) {
          const site = siteIndex.get(String(id));
          if (!site) continue;
          const total = typeof site.pages === "number" ? site.pages : null;
          sites.push({ site, occurrences: occ || 0, pages: pg || 0, everywhere: !!(total && pg >= total * 0.8),
            siteShare: pct(occ || 0, siteOccurrences(site, scope)) });
        }
        sites.sort((a, b) => b.occurrences - a.occurrences);
        occurrences = sites.reduce((n, s) => n + s.occurrences, 0);
        pages = sites.reduce((n, s) => n + s.pages, 0);
        every = sites.filter(s => s.everywhere).length;
      } else {
        occurrences = rule.total_occurrences || 0;
      }
      rows.push({
        id: String(rule.rule_id), rule, guidance: g, audience: g.audience || FALLBACK_AUDIENCE,
        name: g.plain || rule.title || "Unnamed check", level: rule.level || "",
        hasSiteData, sites, sitesAffected: hasSiteData ? sites.length : (rule.sites_affected || 0),
        occurrences, pages, every,
      });
    }
    return rows.filter(r => r.sitesAffected > 0 || r.occurrences > 0);
  }

  function sortRows(rows, by) {
    return rows.slice().sort((a, b) => by === "occurrences"
      ? b.occurrences - a.occurrences || b.sitesAffected - a.sitesAffected
      : b.sitesAffected - a.sitesAffected || b.occurrences - a.occurrences);
  }

  // One card per audience: topics, unique sites (when per-site data exists)
  // and share of all occurrences in view.
  function audiences(rows, guide) {
    const total = rows.reduce((n, r) => n + r.occurrences, 0) || 0;
    const keys = Object.keys((guide && guide.audiences) || {});
    if (rows.some(r => r.audience === FALLBACK_AUDIENCE)) keys.push(FALLBACK_AUDIENCE);
    return keys.map(key => {
      const mine = rows.filter(r => r.audience === key);
      const perSite = mine.length > 0 && mine.every(r => r.hasSiteData);
      const ids = new Set();
      if (perSite) mine.forEach(r => r.sites.forEach(s => ids.add(String(s.site.id))));
      const occ = mine.reduce((n, r) => n + r.occurrences, 0);
      return { key, label: audienceName(key, guide), topics: mine.length, sites: perSite ? ids.size : null,
        share: total ? Math.round(occ / total * 100) : 0, occurrences: occ };
    }).filter(a => a.topics > 0);
  }

  function groupCounts(sites, keyOf, limit) {
    const counts = new Map();
    for (const s of sites) for (const k of [].concat(keyOf(s.site))) if (k) counts.set(k, (counts.get(k) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit || 5)
      .map(([label, count]) => ({ label, count }));
  }

  function brief(row, guide, totalSites, context, share) {
    const g = row.guidance;
    const lines = [
      `Training brief: ${row.name}`,
      `Siteimprove check: ${row.rule.title || row.name}${row.level ? " (" + row.level + ")" : ""}`,
      `Who to train: ${audienceName(row.audience, guide)} · fixed in: ${g.fixedIn}`,
      row.hasSiteData
        ? `Found on ${row.sitesAffected} of ${totalSites} sites, ${row.occurrences.toLocaleString("en-US")} times${row.every ? `; on almost every page of ${row.every} sites` : ""}.`
        : `Found on ${row.sitesAffected} sites, ${row.occurrences.toLocaleString("en-US")} times (all sites; per-site detail not yet available).`,
    ];
    if (share && share.occurrences.pct !== null) {
      const of = share.scope === "target" ? "target issues (Level A, AA and ARIA)" : "all issues";
      lines.push(`Share: ${share.occurrences.pct}% of ${of}` +
        (share.pages && share.pages.pct !== null ? ` and ${share.pages.pct}% of pages checked` : "") + " in these sites.");
    }
    if (context) lines.push(`Scope: ${context}`);
    if (g.why) lines.push(`Why it matters: ${g.why}`);
    if ((g.fix || []).length) lines.push("How to fix:", ...g.fix.map(f => `- ${f}`));
    if (row.sites.length) {
      lines.push("Sites with the most cases:");
      for (const s of row.sites.slice(0, 10)) lines.push(`- ${s.site.site_name || s.site.url}${s.site.url ? " (" + s.site.url + ")" : ""}: ${s.occurrences.toLocaleString("en-US")}${s.siteShare === null ? "" : ` (${s.siteShare}% of the site's ${share && share.scope === "all" ? "issues" : "target issues"})`}`);
    }
    lines.push("Counts are detected occurrences from Siteimprove, not verified fixes.");
    return lines.join("\n");
  }

  const api = { aggregate, sortRows, audiences, groupCounts, brief, guidanceFor, audienceName, shares, siteOccurrences, TARGET_LEVELS, FALLBACK_AUDIENCE };
  root.ProblemsCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
