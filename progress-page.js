(function () {
  "use strict";
  const core = ProgressCore, client = ProgressClient;
  const el = id => document.getElementById(id);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, digits = 0) => v === null || v === undefined ? "Unknown" : v.toLocaleString(undefined, { maximumFractionDigits: digits });
  const signed = (v, digits = 0) => v === null ? "Unavailable" : (v > 0 ? "+" : "") + fmt(v, digits);
  const triplet = (p, digits = 0) => `${fmt(p.before, digits)} / ${fmt(p.after, digits)} / ${signed(p.change, digits)}`;
  let entries = [], mapping = {}, before, after, comparison, sort = "site", direction = 1, generation = 0;
  const cache = new Map();
  const selected = id => [...el(id).selectedOptions].map(o => o.value);
  const filters = () => ({ platforms: selected("platform"), tags: selected("tags"), department: el("department").value, search: el("search").value });
  const scopeText = () => {
    const f = filters();
    return `Platforms: ${f.platforms.join(", ") || "all"}; labels: ${f.tags.map(t => t.replace(/^tag:/, "")).join(", ") || "all"}; department: ${f.department || "all"}; search: ${f.search || "none"}. Latest department mapping applied to both dates. Platform/label filters use later-observation labels (earlier labels for no-longer-observed sites).`;
  };
  function error(message) { el("report-error").textContent = message; el("report-error").hidden = false; }
  function options(id, values, placeholder) {
    const previous = selected(id);
    el(id).replaceChildren();
    if (placeholder) el(id).add(new Option(placeholder, ""));
    for (const value of [...new Set(values)].sort()) el(id).add(new Option(value.replace(/^tag:/, ""), value));
    for (const option of el(id).options) option.selected = previous.includes(option.value);
  }
  async function snapshot(entry) {
    if (!cache.has(entry.path)) cache.set(entry.path, client.load(entry.path.replace(/\.json\.gz$/, "")).catch(failure => { cache.delete(entry.path); throw failure; }));
    return cache.get(entry.path);
  }
  function metricRow(row, metric) {
    const old = row.before, current = row.after;
    if (metric === "target") return core.pair(old?.eligible ? old.target_percentage : null, current?.eligible ? current.target_percentage : null, row.matched ? 1 : 0);
    const value = site => site?.eligible && site.issues_reliable
      ? ["A", "AA", "ARIA"].reduce((n, level) => n + site.by_level[level][metric], 0) : null;
    return core.pair(value(old), value(current), row.matched ? 1 : 0);
  }
  function siteTable() {
    const rows = [...comparison.rows].sort((a, b) => {
      if (sort === "site") return direction * (a.site.site_name || a.site.url).localeCompare(b.site.site_name || b.site.url);
      const x = metricRow(a, sort).change, y = metricRow(b, sort).change;
      if (x === null) return y === null ? 0 : 1;
      if (y === null) return -1;
      return direction * (x - y);
    });
    for (const header of document.querySelectorAll("th[data-sort]")) {
      if (header.dataset.sort === sort) header.setAttribute("aria-sort", direction === 1 ? "ascending" : "descending");
      else header.removeAttribute("aria-sort");
    }
    el("sites-body").innerHTML = rows.length ? rows.map(row => {
      const target = metricRow(row, "target"), occurrences = metricRow(row, "occurrences"), issues = metricRow(row, "issues");
      const safeURL = /^https?:\/\//i.test(row.site.url) ? row.site.url : "";
      const quality = [row.reason, row.matched && (!row.before.issues_reliable || !row.after.issues_reliable) ? "Issue endpoint provenance unavailable; count changes excluded" : ""].filter(Boolean).join("; ") || "Comparable";
      return `<tr><td>${escape(row.site.site_name)}${safeURL ? `<small><a href="${escape(safeURL)}" target="_blank" rel="noopener">${escape(row.site.url)}</a></small>` : ""}</td>
        <td>${escape(row.platform)}<small>${escape(row.department)}</small></td>
        <td class="num">${fmt(target.before, 2)} / ${fmt(target.after, 2)}</td><td class="num">${signed(target.change, 2)}</td>
        <td class="num">${fmt(occurrences.before)} / ${fmt(occurrences.after)}</td><td class="num">${signed(occurrences.change)}</td>
        <td class="num">${triplet(issues)}</td><td class="num">${fmt(row.before?.pages)} / ${fmt(row.after?.pages)}</td>
        <td>${escape(quality)}<small>Earlier crawl: ${escape(row.before?.last_crawl || "Unknown")}<br>Later crawl: ${escape(row.after?.last_crawl || "Unknown")}</small></td></tr>`;
    }).join("") : '<tr><td colspan="9">No sites match these filters.</td></tr>';
  }
  function render() {
    if (!before || !after) return;
    comparison = core.compare(before, after, mapping, filters());
    const c = comparison;
    el("report").hidden = false;
    el("comparison-context").textContent = `Earlier: ${before.generated_at} (${before.reporting_date} Detroit) — Later: ${after.generated_at} (${after.reporting_date} Detroit).`;
    el("scope-context").textContent = scopeText();
    el("coverage").textContent = `Inventory ${c.total_before} → ${c.total_after}; ${c.matched} matched reliable target sites; ${c.headline_occurrences.count} comparable issue sites; ${c.added} added/first observed; ${c.removed} no longer observed; ${c.gaps} present on both dates but lacking reliable targets.`;
    const metrics = [
      ["Mean Title II target %", c.target, 2, "Matched target cohort; change in percentage points"],
      ["A + AA + ARIA occurrences", c.headline_occurrences, 0, "Detected instances; negative change = net reduction"],
      ["A + AA + ARIA issue types", c.headline_issues, 0, "Failing rule/site pairs, not distinct portfolio rules"],
      ["AAA occurrences", c.aaa_occurrences, 0, "Separate from headline"],
      ["AAA issue types", c.aaa_issues, 0, "Separate from headline"],
      ["Best-practice occurrences", c.bp_occurrences, 0, "Separate from headline"],
      ["Best-practice issue types", c.bp_issues, 0, "Separate from headline"],
      ["PDFs", c.pdf_count, 0, "Comparable PDF data only"],
      ["PDFs with issues", c.pdfs_with_issues, 0, "Separate PDF measure"],
      ["PDF-reported issue count", c.pdf_total_issues, 0, "Not added to web occurrence totals"],
    ];
    el("metrics").innerHTML = metrics.slice(0, 3).map(([label, p, digits, note]) => `<div class="card"><h3>${label}</h3>
      <div>${fmt(p.before, digits)} → ${fmt(p.after, digits)}</div><div class="number">${signed(p.change, digits)}${digits ? " pp" : ""}</div>
      <div class="note">${note}. Comparable sites: ${p.count}.</div></div>`).join("") +
      `<div class="card"><h3>WordPress 98% crossings</h3><div class="number">${fmt(c.newly_ready)} newly ≥98%</div><div>${fmt(c.regressed)} fell below 98%</div><p class="note">${c.wordpress_matched} comparable WordPress sites. Counts only, not editor action lists.</p></div>`;
    el("supplementary-metrics").innerHTML = metrics.slice(3).map(([label, p]) =>
      `<tr><th scope="row">${label}</th><td>${fmt(p.before)}</td><td>${fmt(p.after)}</td><td>${signed(p.change)}</td><td>${p.count}</td></tr>`).join("");
    const notes = [...new Set([before.quality_note, after.quality_note].filter(Boolean))];
    if (!c.matched) notes.push("No comparable target cohort for this selection.");
    if (!c.headline_occurrences.count) notes.push("No verified comparable issue-count cohort; reductions cannot be calculated.");
    el("quality-note").textContent = notes.join(" ");
    el("quality-note").hidden = !notes.length;
    const departments = [...new Set(c.rows.map(row => row.department))].sort();
    el("departments-body").innerHTML = departments.length ? departments.map(name => {
      const d = core.compare(before, after, mapping, { ...filters(), department: name });
      return `<tr><td><button class="department-link" data-department="${escape(name)}">${escape(name)}</button></td><td>${d.matched}</td><td>${signed(d.target.change, 2)}</td><td>${d.headline_occurrences.count}</td><td>${triplet(d.headline_occurrences)}</td><td>${triplet(d.headline_issues)}</td></tr>`;
    }).join("") : '<tr><td colspan="6">No departments match these filters.</td></tr>';
    siteTable();
  }
  async function updateDates() {
    const token = ++generation;
    before = after = null;
    comparison = null;
    el("report").hidden = true;
    el("report-error").hidden = true;
    el("load-status").textContent = "Loading selected observations...";
    const earlier = entries.find(e => e.date === el("before-date").value);
    const later = entries.find(e => e.date === el("after-date").value);
    if (!earlier || !later || earlier.date >= later.date) {
      el("load-status").textContent = "Choose two saved dates, with the earlier observation before the later one.";
      return;
    }
    try {
      const loaded = await Promise.all([snapshot(earlier), snapshot(later)]);
      if (token !== generation) return;
      [before, after] = loaded;
      const sites = [...before.sites, ...after.sites];
      options("department", sites.map(s => core.department(s, mapping)), "All departments");
      options("platform", sites.map(core.platform));
      options("tags", sites.flatMap(s => s.tags || []));
      applyURLFilters();
      el("load-status").textContent = "";
      render();
    } catch (failure) {
      if (token === generation) { el("load-status").textContent = ""; error(failure.message); }
    }
  }
  let initialFilters = true;
  function applyURLFilters() {
    if (!initialFilters) return;
    initialFilters = false;
    const query = new URLSearchParams(location.search);
    for (const [id, name] of [["platform", "platform"], ["tags", "tag"], ["department", "department"]]) {
      const values = query.getAll(name);
      for (const option of el(id).options) option.selected = values.includes(option.value);
    }
    el("search").value = query.get("search") || "";
  }
  function shortcut(period) {
    const later = entries.find(e => e.date === el("after-date").value);
    if (!later) return;
    const earlier = core.baseline(entries, later, period);
    el("date-note").textContent = earlier
      ? `Previous-${period} shortcut: selected actual available date ${earlier.date}, on or before the requested baseline.`
      : `No saved observation exists on or before the previous-${period} baseline. Choose another available date.`;
    el("before-date").value = earlier?.date || "";
    updateDates();
  }
  function summary() {
    const c = comparison;
    return [
      `LSA accessibility progress: ${before.generated_at} → ${after.generated_at}.`,
      scopeText(),
      `Inventory before/after: ${c.total_before}/${c.total_after}. Matched target sites: ${c.matched}; comparable issue sites: ${c.headline_occurrences.count}.`,
      `Title II target mean: ${triplet(c.target, 2)} percentage points (change).`,
      ...[["A + AA + ARIA occurrences", "headline_occurrences"], ["A + AA + ARIA issue types (rule/site pairs)", "headline_issues"],
        ["AAA occurrences", "aaa_occurrences"], ["AAA issue types", "aaa_issues"], ["Best-practice occurrences", "bp_occurrences"],
        ["Best-practice issue types", "bp_issues"], ["PDF count", "pdf_count"], ["PDFs with issues", "pdfs_with_issues"], ["PDF-reported issues", "pdf_total_issues"]]
        .map(([label, key]) => `${label} before / after / signed net change: ${triplet(c[key])}; comparable sites: ${c[key].count}.`),
      `WordPress newly ≥98%: ${fmt(c.newly_ready)}; below 98% again: ${fmt(c.regressed)}; comparable WordPress sites: ${c.wordpress_matched}.`,
      `Added/first observed: ${c.added}; no longer observed: ${c.removed}; matched-identity data gaps: ${c.gaps}.`,
      el("definitions").textContent,
      el("quality-note").textContent,
      el("refresh-warning").textContent,
    ].filter(Boolean).join("\n");
  }
  function exportCSV() {
    if (!comparison) return;
    const rows = summary().split("\n").map(line => ["Report context", line]);
    rows.push([], ["Site", "URL", "Platform", "Primary department", "Target before", "Target after", "Target change (pp)",
      "A+AA+ARIA occurrences before", "Occurrences after", "Net occurrence change", "Issue types before", "Issue types after", "Net issue-type change",
      "Pages before", "Pages after", "Quality", "Earlier last crawl", "Later last crawl"]);
    for (const row of comparison.rows) {
      const t = metricRow(row, "target"), o = metricRow(row, "occurrences"), i = metricRow(row, "issues");
      const quality = [row.reason, row.matched && (!row.before.issues_reliable || !row.after.issues_reliable) ? "Issue endpoint provenance unavailable" : ""].filter(Boolean).join("; ");
      rows.push([row.site.site_name, row.site.url, row.platform, row.department, t.before, t.after, t.change, o.before, o.after, o.change,
        i.before, i.after, i.change, row.before?.pages, row.after?.pages, quality, row.before?.last_crawl, row.after?.last_crawl]);
    }
    const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map(row => row.map(core.csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `lsa-progress-${before.reporting_date}-to-${after.reporting_date}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function start() {
    try {
      const [index, departments, status] = await Promise.all([client.load("history/index"), client.load("departments"), client.load("refresh-status")]);
      if (index.schema_version !== 1) throw new Error("Unsupported history schema.");
      entries = core.daily(index.entries); mapping = departments;
      if (!entries.length) { el("load-status").textContent = "No validated observations have been saved yet."; return; }
      const latest = entries.at(-1), warning = client.freshness(latest, status);
      el("refresh-warning").textContent = warning; el("refresh-warning").hidden = !warning;
      el("refresh-meta").textContent = `Latest observation: ${latest.generated_at}. Daily refresh is scheduled for 2 a.m. Detroit after production integration.`;
      if (/^https:\/\//.test(status.run_url || "")) {
        const link = document.createElement("a"); link.href = status.run_url; link.textContent = " View refresh run";
        el("refresh-meta").append(link);
      }
      for (const id of ["before-date", "after-date"]) {
        el(id).add(new Option("Choose a saved date", ""));
        for (const entry of entries) el(id).add(new Option(`${entry.date}${entry.historical ? " (historical import)" : ""}`, entry.date));
      }
      el("after-date").value = latest.date;
      const baseline = core.baseline(entries, latest, "month");
      el("before-date").value = baseline?.date || "";
      el("date-note").textContent = baseline ? `Monthly baseline uses actual saved date ${baseline.date}.` : "There is not yet a month-earlier baseline. Choose any two available dates.";
      el("trend-panel").hidden = false;
      el("trend-body").innerHTML = [...entries].reverse().map(e => `<tr><td>${escape(e.date)}</td><td>${fmt(e.mean_target, 2)} ${e.mean_target === null ? "" : `<meter min="0" max="100" value="${Math.min(e.mean_target, 100)}" aria-label="${escape(e.date)} mean target ${e.mean_target.toFixed(2)} percent"></meter>`}</td><td>${e.eligible_count} / ${e.site_count}</td><td>${e.historical ? "Historical import" : "Collected observation"}</td></tr>`).join("");
      await updateDates();
    } catch (failure) {
      el("load-status").textContent = "";
      error(`${failure.message}. No comparison has been fabricated; history must be collected or backfilled before reporting.`);
    }
  }
  for (const id of ["before-date", "after-date"]) el(id).addEventListener("change", updateDates);
  for (const id of ["department", "platform", "tags"]) el(id).addEventListener("change", render);
  el("search").addEventListener("input", render);
  document.querySelectorAll("[data-period]").forEach(button => button.addEventListener("click", () => shortcut(button.dataset.period)));
  document.querySelectorAll("th[data-sort]").forEach(header => header.querySelector("button").addEventListener("click", () => {
    direction = sort === header.dataset.sort ? -direction : 1;
    sort = header.dataset.sort; if (comparison) siteTable();
  }));
  el("departments-body").addEventListener("click", event => {
    const button = event.target.closest("[data-department]");
    if (button) { el("department").value = button.dataset.department; render(); el("sites-heading").scrollIntoView(); }
  });
  el("clear-filters").addEventListener("click", () => {
    for (const id of ["platform", "tags"]) for (const option of el(id).options) option.selected = false;
    el("department").value = ""; el("search").value = ""; render();
  });
  el("export-csv").addEventListener("click", exportCSV);
  el("copy-summary").addEventListener("click", async () => {
    if (!comparison) return;
    try { await navigator.clipboard.writeText(summary()); el("copy-result").textContent = "Summary copied."; }
    catch { el("copy-result").textContent = "Clipboard access failed. Use Print report to save or copy the report instead."; }
  });
  el("print-report").addEventListener("click", () => window.print());
  let printDetails = [];
  window.addEventListener("beforeprint", () => {
    printDetails = [...document.querySelectorAll("details")].map(detail => [detail, detail.open]);
    for (const [detail] of printDetails) detail.open = true;
  });
  window.addEventListener("afterprint", () => {
    for (const [detail, open] of printDetails) detail.open = open;
  });
  client.start(start);
})();
