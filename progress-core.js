(function (root) {
  "use strict";
  const excluded = new Set(["test sites", "development"]);
  const numeric = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const labels = s => (s.tags || []).map(t => t.replace(/^tag:/, "").trim().toLowerCase());
  const wordpress = s => labels(s).some(t => t === "wp" || t === "wordpress" || t.startsWith("wp-"));
  const visible = s => !labels(s).some(t => excluded.has(t));
  function reliable(s) {
    return visible(s) && numeric(s.target_percentage) && !s.target_estimated &&
      !(s.errors || []).length && ["ok", "stale"].includes(s.scan_status);
  }
  function platform(s) {
    const tags = labels(s);
    for (const [name, keys] of [
      ["RSE", ["rse", "internal"]], ["AEM", ["aem"]], ["Omeka", ["omeka"]],
      ["Google Sites", ["google-sites", "google sites", "gsites"]],
    ]) if (tags.some(t => keys.includes(t))) return name;
    if (wordpress(s)) return "WordPress";
    for (const [name, keys] of [
      ["Rails", ["rails"]], ["dotNet", ["dotnet", ".net", "asp.net"]],
      ["Custom Sites", ["custom sites", "custom-sites"]],
    ]) if (tags.some(t => keys.includes(t))) return name;
    return "Uncategorized";
  }
  // Manual-testing handoff line (a program threshold, not a compliance claim):
  // LSA AEM sites are ready at a confirmed 93%, every other platform at 98%.
  const READY_THRESHOLDS = { AEM: 93, default: 98 };
  const readyThreshold = s => READY_THRESHOLDS[platform(s)] ?? READY_THRESHOLDS.default;
  const ready = s => reliable(s) && s.target_percentage >= readyThreshold(s);
  function urlKey(value) {
    try {
      const u = new URL(value);
      return (u.hostname.replace(/^www\./, "") + (u.port ? ":" + u.port : "") + u.pathname).replace(/\/+$/, "");
    } catch { return ""; }
  }
  function department(s, mapping) {
    return mapping.by_id?.[String(s.id)] || mapping.by_url?.[urlKey(s.url)] || "Unmapped";
  }
  function sum(sites, levels, metric) {
    return sites.reduce((total, s) => total + levels.reduce((n, l) => n + s.by_level[l][metric], 0), 0);
  }
  function pair(before, after, count) {
    return { before, after, change: before === null || after === null ? null : after - before, count };
  }
  function selectedSites(snapshot, mapping = {}, filter = {}) {
    return snapshot.sites.filter(s => visible(s) &&
      (!filter.platform || platform(s) === filter.platform) &&
      (!(filter.platforms || []).length || filter.platforms.includes(platform(s))) &&
      (!filter.department || department(s, mapping) === filter.department) &&
      (!(filter.tags || []).length || filter.tags.some(t => (s.tags || []).includes(t))) &&
      (!filter.search || `${s.site_name} ${s.url}`.toLowerCase().includes(filter.search.toLowerCase())));
  }
  function compare(before, after, mapping = {}, filter = {}) {
    const accepts = s => visible(s) &&
      (!filter.platform || platform(s) === filter.platform) &&
      (!(filter.platforms || []).length || filter.platforms.includes(platform(s))) &&
      (!filter.department || department(s, mapping) === filter.department) &&
      (!(filter.tags || []).length || filter.tags.some(t => (s.tags || []).includes(t))) &&
      (!filter.search || `${s.site_name} ${s.url}`.toLowerCase().includes(filter.search.toLowerCase()));
    const b = new Map(before.sites.filter(visible).map(s => [s.key, s]));
    const a = new Map(after.sites.filter(visible).map(s => [s.key, s]));
    const rows = [...new Set([...b.keys(), ...a.keys()])].map(key => {
      const old = b.get(key), current = a.get(key), site = current || old;
      return {
        key, before: old, after: current, site,
        department: department(site, mapping), platform: platform(site),
        matched: !!(old?.eligible && current?.eligible),
        reason: !old ? "Added / first observed" : !current ? "No longer observed" :
          !old.eligible || !current.eligible ? [...new Set([...(old.reasons || []), ...(current.reasons || [])])].join("; ") : "",
      };
    }).filter(row => accepts(row.site));
    const matched = rows.filter(r => r.matched);
    const issueRows = matched.filter(r => r.before.issues_reliable && r.after.issues_reliable);
    const pdfRows = matched.filter(r => r.before.pdfs_reliable && r.after.pdfs_reliable);
    const mean = side => matched.length ? matched.reduce((n, r) => n + r[side].target_percentage, 0) / matched.length : null;
    const result = {
      rows, matched: matched.length, total_before: rows.filter(r => r.before).length,
      total_after: rows.filter(r => r.after).length,
      added: rows.filter(r => !r.before).length, removed: rows.filter(r => !r.after).length,
      gaps: rows.filter(r => r.before && r.after && !r.matched).length,
      target: pair(mean("before"), mean("after"), matched.length),
      // Crossings of each site's own ready line (93% AEM, 98% others), using
      // confirmed targets on both dates; a first observation is never a crossing.
      ready_matched: matched.length,
      newly_ready: matched.length ? matched.filter(r => r.before.target_percentage < readyThreshold(r.before) && r.after.target_percentage >= readyThreshold(r.after)).length : null,
      regressed: matched.length ? matched.filter(r => r.before.target_percentage >= readyThreshold(r.before) && r.after.target_percentage < readyThreshold(r.after)).length : null,
    };
    for (const [name, levels] of [["headline", ["A", "AA", "ARIA"]], ["aaa", ["AAA"]], ["bp", ["BP"]]]) {
      for (const metric of ["issues", "occurrences"]) {
        result[`${name}_${metric}`] = pair(
          issueRows.length ? sum(issueRows.map(r => r.before), levels, metric) : null,
          issueRows.length ? sum(issueRows.map(r => r.after), levels, metric) : null, issueRows.length
        );
      }
    }
    for (const metric of ["pdf_count", "pdfs_with_issues", "pdf_total_issues"]) {
      const eligible = pdfRows.filter(r => numeric(r.before[metric]) && numeric(r.after[metric]));
      result[metric] = pair(
        eligible.length ? eligible.reduce((n, r) => n + r.before[metric], 0) : null,
        eligible.length ? eligible.reduce((n, r) => n + r.after[metric], 0) : null, eligible.length
      );
    }
    return result;
  }
  function datedPair(before, after, value) {
    const oldKeys = new Set(before.map(s => s.key));
    const matched = after.filter(s => oldKeys.has(s.key)).length;
    return {
      ...pair(before.length ? value(before) : null, after.length ? value(after) : null, matched),
      before_count: before.length, after_count: after.length,
      same_sites: before.length > 0 && matched === before.length && matched === after.length,
    };
  }
  function compareDates(before, after, mapping = {}, filter = {}) {
    const old = selectedSites(before, mapping, filter), current = selectedSites(after, mapping, filter);
    const result = compare({ sites: old }, { sites: current }, mapping);
    const oldKeys = new Set(before.sites.map(s => s.key)), currentKeys = new Set(after.sites.map(s => s.key));
    for (const row of result.rows) {
      if (!row.before && oldKeys.has(row.key)) row.reason = "Outside the start-date filters";
      if (!row.after && currentKeys.has(row.key)) row.reason = "Outside the end-date filters";
    }
    const oldEligible = old.filter(s => s.eligible), currentEligible = current.filter(s => s.eligible);
    const mean = sites => sites.reduce((n, s) => n + s.target_percentage, 0) / sites.length;
    result.target = datedPair(oldEligible, currentEligible, mean);
    result.ready = datedPair(oldEligible, currentEligible, sites => sites.filter(s => s.target_percentage >= readyThreshold(s)).length);
    const oldIssues = oldEligible.filter(s => s.issues_reliable), currentIssues = currentEligible.filter(s => s.issues_reliable);
    for (const [name, levels] of [["headline", ["A", "AA", "ARIA"]], ["aaa", ["AAA"]], ["bp", ["BP"]]]) {
      for (const metric of ["issues", "occurrences"]) {
        result[`${name}_${metric}`] = datedPair(oldIssues, currentIssues, sites => sum(sites, levels, metric));
      }
    }
    for (const metric of ["pdf_count", "pdfs_with_issues", "pdf_total_issues"]) {
      result[metric] = datedPair(
        oldEligible.filter(s => s.pdfs_reliable && numeric(s[metric])),
        currentEligible.filter(s => s.pdfs_reliable && numeric(s[metric])),
        sites => sites.reduce((n, s) => n + s[metric], 0)
      );
    }
    return result;
  }
  // Each date keeps its own verified totals and filters, independent of the other date.
  function issueChanges(before, after, mapping = {}, filter = {}) {
    const available = snapshot => {
      const sites = selectedSites(snapshot, mapping, filter);
      return { total: sites.length, sites: sites.filter(s => s.eligible && s.issues_reliable && s.rule_occurrences) };
    };
    const old = available(before), current = available(after);
    const oldKeys = new Set(old.sites.map(s => s.key));
    const matched = current.sites.filter(s => oldKeys.has(s.key)).length;
    const totals = new Map();
    for (const [side, data] of [["before", old], ["after", current]]) for (const site of data.sites) {
      for (const [id, n] of Object.entries(site.rule_occurrences)) {
        if (!totals.has(id)) totals.set(id, { before: 0, after: 0, sites_before: 0, sites_after: 0 });
        totals.get(id)[side] += n;
        if (n > 0) totals.get(id)[`sites_${side}`] += 1;
      }
    }
    const info = id => (after.rules || {})[id] || (before.rules || {})[id] || {};
    return {
      before_count: old.sites.length, after_count: current.sites.length,
      before_total: old.total, after_total: current.total,
      matched, same_sites: old.sites.length > 0 && matched === old.sites.length && matched === current.sites.length,
      rules: [...totals].map(([id, t]) => ({
        id, title: info(id).title || `Rule ${id}`, level: info(id).level || "", ...t,
        before: old.sites.length ? t.before : null, after: current.sites.length ? t.after : null,
        sites_before: old.sites.length ? t.sites_before : null, sites_after: current.sites.length ? t.sites_after : null,
        change: old.sites.length && current.sites.length ? t.after - t.before : null,
      })),
    };
  }
  function daily(entries) {
    const dates = new Map();
    for (const e of [...entries].sort((a, b) => a.generated_at.localeCompare(b.generated_at))) dates.set(e.date, e);
    return [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  // The Progress page only offers snapshots from this date on. Earlier files stay in the archive.
  const TRACKING_START = "2026-11-05";
  function since(entries, date = TRACKING_START) {
    return entries.filter(e => e.date >= date);
  }
  function baseline(entries, latest, period) {
    const d = new Date(latest.date + "T12:00:00Z");
    if (period === "month") {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - 1);
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, end));
    } else d.setUTCDate(d.getUTCDate() - (period === "week" ? 7 : 1));
    const requested = d.toISOString().slice(0, 10);
    return daily(entries).filter(e => e.date <= requested).at(-1) || null;
  }
  function csvCell(value) {
    let text = String(value ?? "");
    if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  }
  const api = { numeric, labels, wordpress, visible, reliable, platform, readyThreshold, ready, READY_THRESHOLDS, department, compare, compareDates, issueChanges, daily, since, TRACKING_START, baseline, csvCell, pair };
  root.ProgressCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
