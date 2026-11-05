// Live snapshot page (data.html) for the LSA Web Accessibility Data Dashboard.
// Classic script on purpose: tests reach `state`, `decorate`, `readySites`
// and `selectedOccurrences` as globals.
const POLL_INTERVAL_MS = 10000;
let pollHandle = null;

const state = {
  sites: [],
  search: "",
  levelFilters: new Set(),    // empty = no level filter
  statusFilters: new Set(),   // kept for compatibility; no longer shown
  scanFilters: new Set(),     // empty = any last-check result
  tagFilters: new Set(),
  platformFilters: new Set(),
  targetGroup: null,          // "at" | "near" | "below" | null
  sortKey: "site_name",
  sortDir: "asc",
  tab: "overview",
  allColumns: false,
  showAllRows: false,
  problemAudience: null,
  problemSort: "sites",
  problemSelected: null,
  problemShowAll: false,
  missingFilter: "all",
  moreFilters: false,
};

const fmtNumber = (v) => v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US");
const fmtPct = (v) => v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(1) + "%";
const fmtScore = (v) => {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isNaN(n) ? "—" : n.toFixed(1);
};

function median(values) {
  const arr = values.filter(v => v !== null && v !== undefined && !Number.isNaN(v)).map(Number).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function mean(values) {
  const arr = values.filter(v => v !== null && v !== undefined && !Number.isNaN(v)).map(Number);
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function longDate(v) {
  if (!v) return "an unknown date";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

const escapeHtml = (str) =>
  String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Test Sites / Development sites are dropped from every view.
const EXCLUDED_TAG_NAMES = new Set(["test sites", "development"]);

// Platform buckets, in the same order as asana_sync/config.py SECTIONS.
const PLATFORM_RULES = [
  ["RSE",          { exact: ["rse", "internal"] }],
  ["AEM",          { exact: ["aem"] }],
  ["Omeka",        { exact: ["omeka"] }],
  ["Google Sites", { exact: ["google-sites", "google sites", "gsites"] }],
  ["WordPress",    { exact: ["wp", "wordpress"], prefix: ["wp-"] }],
  ["Rails",        { exact: ["rails"] }],
  ["dotNet",       { exact: ["dotnet", ".net", "asp.net"] }],
  ["Development",  { exact: ["development"] }],
  ["Custom Sites", { exact: ["custom sites", "custom-sites"] }],
];

function prettyTag(t) {
  const ix = t.indexOf(":");
  return ix >= 0 ? t.slice(ix + 1) : t;
}

function platformFor(tags) {
  const plain = (tags || []).map(t => prettyTag(t).trim().toLowerCase());
  const set = new Set(plain);
  for (const [name, rule] of PLATFORM_RULES) {
    if ((rule.exact || []).some(k => set.has(k))) return name;
    if ((rule.prefix || []).some(p => plain.some(t => t.startsWith(p)))) return name;
  }
  return "Uncategorized";
}

function isExcludedSite(site) {
  return (site.tags || []).some(t => EXCLUDED_TAG_NAMES.has(prettyTag(t).trim().toLowerCase()));
}

let excludedSiteCount = 0;

function decorate(sites) {
  excludedSiteCount = 0;
  const out = [];
  for (const s of sites) {
    if (isExcludedSite(s)) { excludedSiteCount++; continue; }
    const a = s.by_level?.A?.occurrences ?? 0;
    const aa = s.by_level?.AA?.occurrences ?? 0;
    const aaa = s.by_level?.AAA?.occurrences ?? 0;
    const aria = s.by_level?.ARIA?.occurrences ?? s.other_conformance?.aria?.occurrences ?? 0;
    const bp = s.by_level?.BP?.occurrences ?? s.other_conformance?.si?.occurrences ?? 0;
    const hasErr = !!(s.errors && s.errors.length);
    const tags = Array.isArray(s.tags) ? s.tags : [];
    out.push({
      ...s,
      lvl_a: s.issues_available === false ? null : a,
      lvl_aa: s.issues_available === false ? null : aa,
      lvl_aaa: s.issues_available === false ? null : aaa,
      lvl_aria: s.issues_available === false ? null : aria,
      lvl_bp: s.issues_available === false ? null : bp,
      tags,
      platform: platformFor(tags),
      status: hasErr ? "error" : (s.pages || s.pages_with_issues ? "ok" : "no-data"),
      scan: s.scan_status ? String(s.scan_status).replace(/\s+/g, "-") : "",
    });
  }
  return out;
}

// Readable site names: Siteimprove often uses the address as the name, so
// drop "https://", "www." and a trailing slash, and fall back to the address.
function cleanAddress(value) {
  return String(value || "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
}
function siteLabel(s) {
  const name = String(s.site_name || "").trim();
  if (!name) return cleanAddress(s.url) || "(unnamed site)";
  return /^(https?:\/\/|www\.)/i.test(name) || /^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(name) ? cleanAddress(name) : name;
}
// The address under the name, only when it adds something.
function siteAddressLine(s) {
  const address = cleanAddress(s.url);
  return address && address !== siteLabel(s) ? `<span class="site-url">${escapeHtml(address)}</span>` : "";
}

const hasTarget = (s) => typeof s.target_percentage === "number" && Number.isFinite(s.target_percentage);
function targetGroupOf(s) {
  if (!hasTarget(s)) return "none";
  if (s.target_percentage >= 100) return "at";
  if (s.target_percentage >= 95) return "near";
  return "below";
}
const GROUPS = {
  at: { label: "Meets the goal", range: "100%", pill: "pill-goal", bar: "#FFCB05" },
  near: { label: "Close", range: "95% to 99.9%", pill: "pill-good", bar: "#8DBDF0" },
  below: { label: "Needs work", range: "below 95%", pill: "pill-risk", bar: "#F29B9B" },
  none: { label: "No score yet", range: "", pill: "pill-flat", bar: "#9AA4B0" },
};

// `skip` leaves one filter group out, so that group's chips can count what
// each choice would show given every other active filter.
function matchesBaseFilters(s, ignoreTarget, skip) {
  const levels = state.levelFilters;
  if (skip !== "level" && levels.size > 0) {
    const hit = (levels.has("A") && s.lvl_a > 0) || (levels.has("AA") && s.lvl_aa > 0) ||
      (levels.has("ARIA") && s.lvl_aria > 0) || (levels.has("BP") && s.lvl_bp > 0);
    if (!hit) return false;
  }
  if (state.statusFilters.size > 0 && !state.statusFilters.has(s.status)) return false;
  if (skip !== "scan" && state.scanFilters.size > 0 && !state.scanFilters.has(s.scan)) return false;
  if (skip !== "platform" && state.platformFilters.size > 0 && !state.platformFilters.has(s.platform)) return false;
  if (skip !== "tags" && state.tagFilters.size > 0 && ![...state.tagFilters].some(t => (s.tags || []).includes(t))) return false;
  if (!ignoreTarget && state.targetGroup && targetGroupOf(s) !== state.targetGroup) return false;
  const search = state.search.trim().toLowerCase();
  if (search && !`${s.site_name || ""} ${s.url || ""}`.toLowerCase().includes(search)) return false;
  return true;
}

function applyFilters() {
  return state.sites.filter(s => matchesBaseFilters(s, false));
}

// Sum across the levels the user chose; with no level filter, every visible
// level (A + AA + ARIA + BP). Null when issue data is missing for the site.
function selectedOccurrences(s) {
  if (s.issues_available === false) return null;
  if (state.levelFilters.size === 0) return (s.lvl_a || 0) + (s.lvl_aa || 0) + (s.lvl_aria || 0) + (s.lvl_bp || 0);
  let sum = 0;
  if (state.levelFilters.has("A")) sum += s.lvl_a || 0;
  if (state.levelFilters.has("AA")) sum += s.lvl_aa || 0;
  if (state.levelFilters.has("ARIA")) sum += s.lvl_aria || 0;
  if (state.levelFilters.has("BP")) sum += s.lvl_bp || 0;
  return sum;
}

// "Issues (occurrences)" headline: Level A + AA + ARIA unless a level filter is set.
function headlineIssues(s) {
  if (s.issues_available === false) return null;
  if (state.levelFilters.size) return selectedOccurrences(s);
  return (s.lvl_a || 0) + (s.lvl_aa || 0) + (s.lvl_aria || 0);
}

// Manual-testing handoff (a program threshold, not a compliance claim): the
// shared rule in ProgressCore — AEM sites at a confirmed 93%+, every other
// platform at 98%+.
const readyLine = (s) => ProgressCore.readyThreshold(s);
function readySites(filteredSites) {
  return filteredSites
    .filter(s => ProgressCore.ready(s))
    .sort((a, b) => (a.pages || 0) - (b.pages || 0) || (b.target_percentage || 0) - (a.target_percentage || 0));
}
const isReady = (s) => readySites([s]).length === 1;

const SCAN_WORDS = { ok: "Worked", failed: "Failed", stale: "Not checked recently", running: "In progress", "no-status": "Unknown", "": "Unknown" };
const LEVEL_NAMES = { A: "Level A (basic)", AA: "Level AA (required)", ARIA: "ARIA (screen reader code)", BP: "Best practices (optional)" };

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
let toastTimer = null;
function toast(message) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

function download(filename, lines) {
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
const csvRow = (cells) => cells.map(ProgressCore.csvCell).join(",");
const stamp = () => new Date().toISOString().slice(0, 10);

function readyTag(s) {
  return isReady(s) ? ' <span class="pill pill-ready">Ready for manual testing</span>' : "";
}

// ---------------------------------------------------------------- filters UI
function pillButton(value, label, pressed, extra) {
  return `<button type="button" class="chip" data-value="${escapeHtml(value)}" aria-pressed="${pressed}">${escapeHtml(label)}${extra || ""}</button>`;
}

// Filter counts follow the tab: Ready for manual testing counts only ready
// sites, Missing data only sites with missing data, every other tab all
// sites. Each group's counts also respect the other active filters, so the
// number on a chip is exactly what selecting it would show on this tab.
function filterScope() {
  if (state.tab === "missing") return state.sites.filter(s => missingReasons(s).length);
  if (state.tab === "ready") return state.sites.filter(s => ProgressCore.ready(s));
  return state.sites;
}

function chipGroup(id, options, selected, base) {
  const count = (v) => `<span class="tnum">(${v.toLocaleString("en-US")})</span>`;
  // Hide choices with nothing to show here, but never hide one that is selected.
  const shown = options.filter(o => o.n > 0 || selected.has(o.value));
  $(id).innerHTML = pillButton("", "All", selected.size === 0, " " + count(base.length)) +
    shown.map(o => pillButton(o.value, o.label, selected.has(o.value), " " + count(o.n))).join("");
}

function renderFilterPills() {
  const scope = filterScope();
  const facet = (skip) => scope.filter(s => matchesBaseFilters(s, false, skip));
  const tally = (sites, keyOf) => {
    const m = new Map();
    for (const site of sites) for (const k of [].concat(keyOf(site))) m.set(k, (m.get(k) || 0) + 1);
    return m;
  };

  const pBase = facet("platform"), pCounts = tally(pBase, x => x.platform);
  const allPlatforms = [...new Set(state.sites.map(x => x.platform))]
    .sort((a, b) => (pCounts.get(b) || 0) - (pCounts.get(a) || 0) || a.localeCompare(b));
  chipGroup("filter-platform", allPlatforms.map(p => ({ value: p, label: p, n: pCounts.get(p) || 0 })), state.platformFilters, pBase);

  const sBase = facet("scan"), sCounts = tally(sBase, x => x.scan);
  chipGroup("filter-scan", [["ok", "Worked"], ["failed", "Failed"], ["stale", "Not checked recently"], ["running", "In progress"], ["no-status", "Unknown"]]
    .map(([v, l]) => ({ value: v, label: l, n: sCounts.get(v) || 0 })), state.scanFilters, sBase);

  const tBase = facet("tags"), tCounts = tally(tBase, x => x.tags || []);
  const allTags = [...new Set(state.sites.flatMap(x => x.tags || []))].filter(t => !EXCLUDED_TAG_NAMES.has(prettyTag(t).toLowerCase()))
    .sort((a, b) => (tCounts.get(b) || 0) - (tCounts.get(a) || 0) || a.localeCompare(b));
  chipGroup("filter-tags", allTags.map(t => ({ value: t, label: prettyTag(t), n: tCounts.get(t) || 0 })), state.tagFilters, tBase);

  const lBase = facet("level");
  const field = { A: "lvl_a", AA: "lvl_aa", ARIA: "lvl_aria", BP: "lvl_bp" };
  chipGroup("filter-level", ["A", "AA", "ARIA", "BP"].map(l => ({ value: l, label: LEVEL_NAMES[l], n: lBase.filter(x => x[field[l]] > 0).length })), state.levelFilters, lBase);
}

function wireFilterGroup(id, set) {
  $(id).addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value]");
    if (!btn) return;
    const v = btn.dataset.value;
    if (!v) set.clear();
    else if (set.has(v)) set.delete(v);
    else set.add(v);
    state.showAllRows = false;
    renderAll();
    // The chips are redrawn with new counts; keep keyboard focus on the one pressed.
    const again = $(id).querySelector(`button[data-value="${CSS.escape(v)}"]`) || $(id).querySelector('button[data-value=""]');
    if (again) again.focus();
  });
}

function activeFilters() {
  const out = [];
  if (state.targetGroup) out.push({ label: `Score: ${GROUPS[state.targetGroup].label}`, clear: () => { state.targetGroup = null; } });
  for (const p of state.platformFilters) out.push({ label: `Platform: ${p}`, clear: () => state.platformFilters.delete(p) });
  for (const v of state.scanFilters) out.push({ label: `Last check: ${SCAN_WORDS[v] || v}`, clear: () => state.scanFilters.delete(v) });
  for (const t of state.tagFilters) out.push({ label: `Label: ${prettyTag(t)}`, clear: () => state.tagFilters.delete(t) });
  for (const l of state.levelFilters) out.push({ label: `Issue type: ${LEVEL_NAMES[l]}`, clear: () => state.levelFilters.delete(l) });
  if (state.search.trim()) out.push({ label: `Search: “${state.search.trim()}”`, clear: () => { state.search = ""; } });
  return out;
}

function clearAllFilters() {
  state.targetGroup = null;
  state.search = "";
  for (const set of [state.platformFilters, state.scanFilters, state.tagFilters, state.levelFilters, state.statusFilters]) set.clear();
  state.showAllRows = false;
  renderFilterPills();
  renderAll();
}

function renderActiveFilters(count) {
  const list = activeFilters();
  const box = $("active-filters");
  box.hidden = list.length === 0;
  $("active-filter-chips").innerHTML = list.map((f, i) =>
    `<button type="button" class="active-chip" data-index="${i}" aria-label="Remove filter ${escapeHtml(f.label)}">${escapeHtml(f.label)}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`).join("");
  box._filters = list;
  $("filter-status").textContent = `${count.toLocaleString("en-US")} sites shown${list.length ? ", filtered by " + list.map(f => f.label).join(", ") : ""}.`;
}

function filterDescription() {
  const list = activeFilters();
  return list.length ? list.map(f => f.label).join("; ") : "All sites";
}

// ---------------------------------------------------------------- tabs
const TABS = ["overview", "problems", "ready", "sites", "missing"];
function setTab(tab, focus) {
  if (!TABS.includes(tab)) tab = "overview";
  const changed = state.tab !== tab;
  state.tab = tab;
  if (changed && state.sites.length) renderFilterPills();
  for (const t of TABS) {
    $(`panel-${t}`).hidden = t !== tab;
    const b = document.querySelector(`.tab[data-tab="${t}"]`);
    if (b) b.setAttribute("aria-current", t === tab ? "page" : "false");
  }
  const hash = tab === "overview" ? "" : "#" + tab;
  if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
  if (focus) $(`panel-${tab}`).focus();
}

// ---------------------------------------------------------------- overview
function renderHero(baseSites) {
  // Same rule as the previous compliance band: only sites whose last check returned data.
  const scored = baseSites.filter(s => s.status === "ok" && hasTarget(s));
  const counts = { at: 0, near: 0, below: 0 };
  for (const s of scored) counts[targetGroupOf(s)]++;
  const total = scored.length;
  $("hero-at").textContent = counts.at.toLocaleString("en-US");
  $("hero-total").textContent = total.toLocaleString("en-US");
  $("hero-sub").textContent = total
    ? `${(counts.at / total * 100).toFixed(1)}% of scored sites. ${counts.near.toLocaleString("en-US")} more are close (95%+).`
    : "No sites have a score yet.";
  $("hero-bar").innerHTML = ["at", "near", "below"].map(k =>
    `<span style="width:${total ? (counts[k] / total * 100).toFixed(2) : 0}%;background:${GROUPS[k].bar}"></span>`).join("");
  $("hero-groups").innerHTML = ["at", "near", "below"].map(k =>
    `<button type="button" class="group-btn" data-group="${k}" aria-pressed="${state.targetGroup === k}">
      <span class="swatch" style="background:${GROUPS[k].bar}"></span>
      <span class="group-text"><strong>${GROUPS[k].label}</strong><span>${GROUPS[k].range}</span></span>
      <span class="group-count tnum">${counts[k].toLocaleString("en-US")}</span></button>`).join("");
  const days = Math.ceil((Date.UTC(2027, 3, 24) - Date.now()) / 86400000);
  $("hero-days").textContent = days > 0 ? `${days} days left` : "Deadline reached";
}

function renderSummary(filtered) {
  const scored = filtered.filter(hasTarget);
  const failed = filtered.filter(s => s.scan === "failed" || s.status === "error").length;
  const issueSites = filtered.filter(s => s.issues_available !== false);
  const pdfSites = filtered.filter(s => s.pdfs_available !== false);
  const avg = mean(scored.map(s => s.target_percentage));
  const med = median(scored.map(s => s.target_percentage));
  const pagesTotal = filtered.reduce((n, s) => n + (s.pages || 0), 0);
  const pagesIssues = filtered.reduce((n, s) => n + (s.pages_with_issues || 0), 0);
  const occ = issueSites.length ? issueSites.reduce((n, s) => n + (headlineIssues(s) || 0), 0) : null;
  const pdf = pdfSites.length ? pdfSites.reduce((n, s) => n + (s.pdfs_with_issues || 0), 0) : null;
  const cards = [
    ["Sites", fmtNumber(filtered.length), `${fmtNumber(scored.length)} have a score. ${fmtNumber(failed)} checks failed.`],
    ["Average score", avg === null ? "—" : avg.toFixed(1) + "%", med === null ? "No sites have a score" : `Half of sites score ${med.toFixed(1)}% or more`],
    ["Pages with issues", fmtNumber(pagesIssues), `out of ${fmtNumber(pagesTotal)} pages checked`],
    ["Issues (occurrences)", fmtNumber(occ), `Each time a required check fails on a page.${pdf === null ? "" : " Also " + fmtNumber(pdf) + " PDFs to fix."}`],
  ];
  $("summary-cards").innerHTML = cards.map(([t, v, sub]) =>
    `<div class="card kpi"><h3>${escapeHtml(t)}</h3><span class="kpi-value tnum">${escapeHtml(v)}</span><span class="muted">${escapeHtml(sub)}</span></div>`).join("");

  // A quiet pointer to the Missing data tab instead of a warning banner.
  const missing = filtered.filter(s => missingReasons(s).length).length;
  const note = $("notice-missing-metrics");
  note.hidden = !missing;
  note.innerHTML = missing ? `${fmtNumber(missing)} site${missing === 1 ? " has" : "s have"} missing data, left out of these totals. <button type="button" class="link-btn" data-go-tab="missing">See which sites</button>` : "";
}

function renderFar(filtered) {
  const list = filtered.filter(s => hasTarget(s) && !s.target_estimated).sort((a, b) => a.target_percentage - b.target_percentage).slice(0, 8);
  $("far-list").innerHTML = list.length ? list.map((s, i) => {
    const gap = 100 - s.target_percentage;
    const meta = [s.platform, s.pages ? `${fmtNumber(s.pages)} page${s.pages === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    return `<li class="far-row">
      <span class="far-rank tnum" aria-hidden="true">${i + 1}</span>
      <div class="far-main">
        <button type="button" class="name-btn" data-site="${escapeHtml(s.id)}">${escapeHtml(siteLabel(s))}</button>
        <span class="far-meta">${escapeHtml(meta)}</span>
        <span class="bar far-bar" aria-hidden="true"><span style="width:${Math.max(1, s.target_percentage).toFixed(1)}%;background:#7A3300"></span></span>
      </div>
      <div class="far-score">
        <strong class="tnum">${fmtPct(s.target_percentage)}</strong>
        <span class="tnum">${fmtNumber(Number(gap.toFixed(1)))} points to go</span>
      </div>
    </li>`;
  }).join("")
    : `<li class="empty">No sites with a confirmed score match these filters.</li>`;
}

function renderLevels(filtered) {
  const sites = filtered.filter(s => s.issues_available !== false);
  const rows = [["A", "lvl_a", "#00274C"], ["AA", "lvl_aa", "#00508F"], ["ARIA", "lvl_aria", "#4F7FB0"], ["BP", "lvl_bp", "#6B7684"]]
    .map(([k, f, c]) => ({ k, c, n: sites.reduce((n, s) => n + (s[f] || 0), 0) }));
  // Bars show each type's share of all issues, so the bar length matches the percentage in the label.
  const total = rows.reduce((n, r) => n + r.n, 0) || 1;
  $("levels-list").innerHTML = sites.length ? rows.map(r =>
    `<li><div class="level-head"><strong>${LEVEL_NAMES[r.k]}</strong><span class="tnum">${fmtNumber(r.n)} <span class="muted">(${Math.round(r.n / total * 100)}%)</span></span></div>
      <span class="bar" aria-hidden="true"><span style="width:${(r.n / total * 100).toFixed(1)}%;background:${r.c}"></span></span></li>`).join("")
    : `<li class="empty">Issue counts are not available for these sites.</li>`;
}

// ---------------------------------------------------------------- problems
let rulesData = null;
let siteRuleIndex = null; // site id -> [{rule, occurrences}]

function problemRows(filtered) {
  if (!rulesData || !Array.isArray(rulesData.rules)) return null;
  const index = new Map(filtered.map(s => [String(s.id), s]));
  return ProblemsCore.aggregate(rulesData.rules, index, window.RuleGuidance);
}

function renderTopProblems(rows) {
  const box = $("top-problems");
  if (!rows) { box.innerHTML = `<li class="empty">Problem data is not available yet.</li>`; return; }
  const top = ProblemsCore.sortRows(rows, "sites").slice(0, 5);
  box.innerHTML = top.map(r =>
    `<li><button type="button" class="problem-row chev" data-problem="${escapeHtml(r.id)}">
      <span class="pill pill-flat level-pill">${escapeHtml(r.level)}</span>
      <span class="problem-name">${escapeHtml(r.name)}</span>
      <span class="tnum problem-nums"><strong>${fmtNumber(r.sitesAffected)} sites</strong><br><span class="muted">${fmtNumber(r.occurrences)} times</span></span>
    </button></li>`).join("");
}

function renderProblems(rows, filteredCount) {
  const guide = window.RuleGuidance;
  const note = $("problem-note");
  if (!rows) {
    $("aud-cards").innerHTML = "";
    $("problem-list").innerHTML = `<li class="empty">Problem data is not available yet.</li>`;
    $("problem-detail").hidden = true;
    note.hidden = true;
    return;
  }
  const perSite = rows.length > 0 && rows.every(r => r.hasSiteData);
  note.hidden = perSite;
  note.textContent = perSite ? "" : "Site lists start after the next nightly refresh. Until then, totals cover all sites.";

  const auds = ProblemsCore.audiences(rows, guide);
  $("aud-cards").innerHTML = auds.map(a =>
    `<button type="button" class="aud-btn" data-audience="${escapeHtml(a.key)}" aria-pressed="${state.problemAudience === a.key}">
      <strong><span>${escapeHtml(a.label)}</span><span class="chev" aria-hidden="true"></span></strong>
      <span>${a.topics} topic${a.topics === 1 ? "" : "s"}${a.sites === null ? "" : " · " + fmtNumber(a.sites) + " sites"}</span>
      <span>${a.share}% of all problems found</span>
      <span class="hint">${state.problemAudience === a.key ? "Showing only these. Select again to show all." : "Show only these topics"}</span></button>`).join("");
  $("aud-reset").hidden = !state.problemAudience;

  for (const b of document.querySelectorAll("#problem-sort button")) b.setAttribute("aria-pressed", String(b.dataset.sort === state.problemSort));
  const list = ProblemsCore.sortRows(rows.filter(r => !state.problemAudience || r.audience === state.problemAudience), state.problemSort);
  const max = Math.max(1, ...list.map(r => state.problemSort === "sites" ? r.sitesAffected : r.occurrences));
  const selected = list.find(r => r.id === state.problemSelected) || list[0];
  $("problem-list").innerHTML = list.length ? list.map(r => {
    const v = state.problemSort === "sites" ? r.sitesAffected : r.occurrences;
    return `<li><button type="button" class="problem-btn" data-problem="${escapeHtml(r.id)}" aria-pressed="${selected && r.id === selected.id}">
      <span class="problem-btn__top"><strong>${escapeHtml(r.name)}</strong><span class="pill-row" style="flex:none"><span class="pill pill-flat">${escapeHtml(r.level)}</span><span class="chev" aria-hidden="true"></span></span></span>
      <span class="bar" aria-hidden="true"><span style="width:${(v / max * 100).toFixed(1)}%"></span></span>
      <span class="problem-btn__meta"><strong class="tnum">${fmtNumber(r.sitesAffected)} sites</strong>${perSite && filteredCount ? ` (${Math.round(r.sitesAffected / filteredCount * 100)}%)` : ""}
        <span class="muted">· ${fmtNumber(r.occurrences)} times · ${escapeHtml(ProblemsCore.audienceName(r.audience, guide))}</span></span>
    </button></li>`;
  }).join("") : `<li class="empty">No problems match.</li>`;

  const detail = $("problem-detail");
  detail.hidden = !selected;
  if (!selected) return;
  const g = selected.guidance;
  const theme = g.fixedIn === "Site theme";
  const sites = selected.sites;
  const shown = state.problemShowAll ? sites : sites.slice(0, 8);
  const byPlatform = ProblemsCore.groupCounts(sites, s => s.platform, 6);
  const byArea = ProblemsCore.groupCounts(sites, s => (s.tags || []).map(prettyTag).filter(t => !/^(wp|wp-.*|aem|lsa|custom sites|google-sites|omeka|cpanel|openshift|rails)$/i.test(t)), 6);
  const bars = (items, color) => items.length ? items.map(i => {
    const mx = items[0].count || 1;
    return `<li class="mini-bar"><span>${escapeHtml(i.label)}</span><span class="bar" aria-hidden="true"><span style="width:${(i.count / mx * 100).toFixed(1)}%;background:${color}"></span></span><strong class="tnum">${i.count}</strong></li>`;
  }).join("") : `<li class="muted">Not available yet.</li>`;
  detail.innerHTML = `
    <div class="detail-head">
      <div class="stack" style="gap:8px;max-width:62ch">
        <h2 id="problem-title" tabindex="-1">${escapeHtml(selected.name)}</h2>
        <p class="muted" style="margin:0;font-size:14px">Siteimprove check: ${escapeHtml(selected.rule.title || "")}</p>
        <div class="pill-row">
          <span class="pill pill-flat">${escapeHtml(selected.level)}</span>
          <span class="pill pill-good">Who fixes it: ${escapeHtml(ProblemsCore.audienceName(selected.audience, guide))}</span>
          <span class="pill pill-flat">Fixed in: ${escapeHtml(g.fixedIn)}</span>
        </div>
      </div>
      <div class="pill-row no-print">
        <button type="button" class="btn btn-primary" id="copy-brief">Copy training brief</button>
        <button type="button" class="btn" id="download-problem-sites" ${sites.length ? "" : "disabled"}>Download site list</button>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-box"><span class="label">Sites with it now</span><span class="value tnum">${fmtNumber(selected.sitesAffected)}</span>${perSite ? `<span class="muted">out of ${fmtNumber(filteredCount)} sites in view</span>` : ""}</div>
      <div class="stat-box"><span class="label">Times found</span><span class="value tnum">${fmtNumber(selected.occurrences)}</span></div>
      ${perSite ? `<div class="stat-box"><span class="label">Pages affected</span><span class="value tnum">${fmtNumber(selected.pages)}</span></div>
      <div class="stat-box"><span class="label">On almost every page</span><span class="value tnum">${fmtNumber(selected.every)}</span><span class="muted">sites, usually a theme fix</span></div>` : ""}
    </div>
    <div class="stack" style="gap:8px">
      <h3>Top sites with this problem</h3>
      <p class="muted" style="margin:0;font-size:14px">Sites with the most cases first. Good places to start, or to invite to a training session. Select a site for its details.</p>
      ${sites.length ? `<div class="table-scroll" tabindex="0" role="region" aria-label="Sites with the most cases, scrolls sideways">
        <table class="data-table"><caption class="sr-only">Sites with the most cases of ${escapeHtml(selected.name)}</caption>
          <thead><tr><th scope="col">Site</th><th scope="col">Platform</th><th scope="col" class="num">Times found</th><th scope="col" class="num">Pages affected</th><th scope="col">On almost every page</th></tr></thead>
          <tbody>${shown.map(x => `<tr><td><button type="button" class="name-btn" data-site="${escapeHtml(x.site.id)}">${escapeHtml(siteLabel(x.site))}</button>${readyTag(x.site)}</td>
            <td>${escapeHtml(x.site.platform)}</td><td class="num tnum">${fmtNumber(x.occurrences)}</td>
            <td class="num tnum">${fmtNumber(x.pages)} of ${fmtNumber(x.site.pages)}</td><td>${x.everywhere ? "Yes" : "No"}</td></tr>`).join("")}</tbody></table></div>
        ${!state.problemShowAll && sites.length > 8 ? `<button type="button" class="btn" id="problem-show-all" style="align-self:flex-start">Show all ${fmtNumber(sites.length)} sites</button>` : ""}`
      : `<p class="notice" style="margin:0">The list of top sites for each problem starts with the next nightly data refresh (2 a.m. Detroit time), the first one that records which sites have each problem.</p>`}
    </div>
    <div class="two-col">
      <div class="soft-box"><h3>Why it matters</h3><p>${escapeHtml(g.why || "Guidance for this check has not been written yet.")}</p>
        <p><strong>Training tip:</strong> ${theme
          ? "Usually in the site theme: one developer or designer fix covers every page."
          : "Fixed page by page: train the editors of the sites below."}</p></div>
      <div class="soft-box"><h3>How to fix it</h3>${(g.fix || []).length ? `<ul>${g.fix.map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : "<p class=\"muted\">No steps written yet.</p>"}</div>
    </div>
    <div class="two-col">
      <div><h3>Sites by platform</h3><ul class="mini-bars">${bars(byPlatform, "#00508F")}</ul></div>
      <div><h3>Sites by area</h3><ul class="mini-bars">${bars(byArea, "#4F7FB0")}</ul></div>
    </div>
`;
  $("copy-brief").addEventListener("click", async () => {
    const text = ProblemsCore.brief(selected, guide, filteredCount, filterDescription());
    try { await navigator.clipboard.writeText(text); toast(`Training brief copied for “${selected.name}”.`); }
    catch (_) { toast("Copy is blocked in this browser. Select and copy the text from the CSV instead."); }
  });
  const dl = $("download-problem-sites");
  if (dl && sites.length) dl.addEventListener("click", () => {
    download(`lsa-problem-${selected.id}-${stamp()}-${sites.length}sites.csv`, [
      csvRow([`Problem: ${selected.name}`, `Siteimprove check: ${selected.rule.title || ""}`, `Filters: ${filterDescription()}`]),
      csvRow(["Site", "URL", "Platform", "Times found", "Pages affected", "Pages checked", "On almost every page", "Ready for manual testing"]),
      ...sites.map(x => csvRow([x.site.site_name || "", x.site.url || "", x.site.platform, x.occurrences, x.pages, x.site.pages ?? "", x.everywhere ? "Yes" : "No", isReady(x.site) ? "Yes" : "No"])),
    ]);
  });
  const more = $("problem-show-all");
  if (more) more.addEventListener("click", () => { state.problemShowAll = true; renderAll(); });
}

// ---------------------------------------------------------------- ready tab
// ---------------------------------------------------------------- missing data
const MISSING = {
  never: "Never scanned by Siteimprove",
  failed: "Last check failed",
  running: "Check in progress",
  score: "No score yet",
  issues: "Issue counts not collected",
  pdfs: "PDF counts not collected",
};
function missingReasons(s) {
  const out = [];
  const never = !s.pages && (s.scan === "no-status" || s.scan === "");
  if (never) out.push("never");
  if (s.scan === "failed") out.push("failed");
  if (s.scan === "running") out.push("running");
  if (!hasTarget(s)) out.push("score");
  if (s.issues_available === false) out.push("issues");
  if (s.pdfs_available === false) out.push("pdfs");
  return out;
}

function renderMissing(filtered) {
  const rows = filtered.map(s => ({ s, reasons: missingReasons(s) })).filter(r => r.reasons.length);
  const counts = {};
  for (const r of rows) for (const k of r.reasons) counts[k] = (counts[k] || 0) + 1;
  const keys = Object.keys(MISSING).filter(k => counts[k]);
  if (state.missingFilter !== "all" && !counts[state.missingFilter]) state.missingFilter = "all";
  $("missing-filters").innerHTML = `<button type="button" class="chip" data-missing="all" aria-pressed="${state.missingFilter === "all"}">All <span class="tnum">(${rows.length})</span></button>` +
    keys.map(k => `<button type="button" class="chip" data-missing="${k}" aria-pressed="${state.missingFilter === k}">${MISSING[k]} <span class="tnum">(${counts[k]})</span></button>`).join("");
  const shown = rows.filter(r => state.missingFilter === "all" || r.reasons.includes(state.missingFilter))
    .sort((a, b) => b.reasons.length - a.reasons.length || siteLabel(a.s).localeCompare(siteLabel(b.s)));
  $("missing-list").innerHTML = shown.length ? shown.map(({ s, reasons }) =>
    `<tr><td><button type="button" class="name-btn" data-site="${escapeHtml(s.id)}">${escapeHtml(siteLabel(s))}</button>${siteAddressLine(s)}</td>
      <td>${escapeHtml(s.platform)}</td>
      <td><span class="pill-row">${reasons.map(k => `<span class="pill ${k === "never" || k === "failed" ? "pill-bad" : "pill-flat"}">${MISSING[k]}</span>`).join("")}</span></td>
      <td>${escapeHtml(SCAN_WORDS[s.scan] || "Unknown")}${s.last_crawl ? `<span class="site-url">${escapeHtml(longDate(s.last_crawl))}</span>` : ""}</td>
      <td class="num tnum">${s.pages ? fmtNumber(s.pages) : "—"}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No sites with missing data match these filters.</td></tr>`;
  $("missing-caption").textContent = `Sites with missing data${state.missingFilter === "all" ? "" : ": " + MISSING[state.missingFilter]}, ${filterDescription()}`;
  $("tab-count-missing").textContent = `(${rows.length.toLocaleString("en-US")})`;
  return rows;
}

function exportMissingCSV() {
  const rows = applyFilters().map(s => ({ s, reasons: missingReasons(s) })).filter(r => r.reasons.length);
  download(`lsa-missing-data-${stamp()}-${rows.length}sites.csv`, [
    csvRow(["Site name", "URL", "Site ID", "Platform", "What's missing", "Last check", "Last checked", "Pages checked", "Errors recorded"]),
    ...rows.map(({ s, reasons }) => csvRow([s.site_name || "", s.url || "", s.id ?? "", s.platform, reasons.map(k => MISSING[k]).join("; "),
      SCAN_WORDS[s.scan] || "", s.last_crawl || "", s.pages ?? "", (s.errors || []).join("; ")])),
  ]);
}

function renderReady(filtered) {
  const ready = readySites(filtered);
  $("ready-count").textContent = fmtNumber(ready.length);
  $("ready-pages").textContent = fmtNumber(ready.reduce((n, s) => n + (s.pages || 0), 0));
  $("ready-list").innerHTML = ready.length ? ready.map(s =>
    `<tr class="ready-row"><td><button type="button" class="name-btn" data-site="${escapeHtml(s.id)}">${escapeHtml(siteLabel(s))}</button>${siteAddressLine(s)}</td>
      <td>${escapeHtml(s.platform)}</td><td class="num tnum">${fmtPct(s.target_percentage)} <span class="muted">(line ${readyLine(s)}%)</span></td><td class="num tnum">${fmtNumber(s.pages)}</td><td>${escapeHtml(longDate(s.last_crawl))}</td></tr>`).join("")
    : `<tr><td colspan="5" class="empty">No sites have reached their ready line with these filters.</td></tr>`;
  const byPlatform = {};
  for (const s of ready) byPlatform[s.platform] = (byPlatform[s.platform] || 0) + 1;
  $("ready-breakdown").textContent = ready.length ? "By platform: " + Object.entries(byPlatform).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n.toLocaleString("en-US")}`).join(", ") + "." : "";
}

function exportReadyCSV() {
  const ready = readySites(applyFilters());
  download(`lsa-ready-for-manual-testing-${stamp()}-${ready.length}sites.csv`, [
    csvRow(["Site name", "URL", "Site ID", "Platform", "Score (Title II target %)", "Ready line %", "Pages checked", "Last checked", "Labels"]),
    ...ready.map(s => csvRow([s.site_name || "", s.url || "", s.id ?? "", s.platform, s.target_percentage ?? "", readyLine(s), s.pages ?? "", s.last_crawl || "", (s.tags || []).map(prettyTag).join(", ")])),
  ]);
}

// ---------------------------------------------------------------- site table
const KEY_COLUMNS = [
  ["site_name", "Site", "string"], ["platform", "Platform", "string"], ["target_percentage", "Score", "number"],
  ["pages", "Pages checked", "number"], ["issues", "Issues (occurrences)", "number"],
];
const EXTRA_COLUMNS = [
  ["score", "Overall score", "number"], ["scan", "Last check", "string"], ["issue_types", "Kinds of issues", "number"],
  ["lvl_a", "Level A", "number"], ["lvl_aa", "Level AA", "number"], ["lvl_aria", "ARIA", "number"], ["lvl_bp", "Best practices", "number"],
  ["pdfs_with_issues", "PDFs to fix", "number"], ["misspellings", "Spelling errors", "number"],
];
const sortValue = (s, key) => key === "issues" ? headlineIssues(s) : s[key];
function compareSites(a, b) {
  const col = [...KEY_COLUMNS, ...EXTRA_COLUMNS].find(c => c[0] === state.sortKey) || KEY_COLUMNS[0];
  const av = sortValue(a, state.sortKey), bv = sortValue(b, state.sortKey);
  const dir = state.sortDir === "asc" ? 1 : -1;
  if (col[2] === "number") {
    const an = typeof av === "number", bn = typeof bv === "number";
    if (!an && !bn) return 0;
    if (!an) return 1;
    if (!bn) return -1;
    return (av - bv) * dir;
  }
  return String(av ?? "").localeCompare(String(bv ?? ""), undefined, { sensitivity: "base" }) * dir;
}

function scoreCell(s) {
  if (!hasTarget(s)) return `<span class="muted">—</span> <span class="pill pill-flat">No score</span>`;
  const g = GROUPS[targetGroupOf(s)];
  return `<span class="tnum">${fmtPct(s.target_percentage)}</span>${s.target_estimated ? ' <span class="muted">(estimated)</span>' : ""} <span class="pill ${g.pill}">${g.label}</span>`;
}

function renderTable(filtered) {
  const cols = state.allColumns ? [...KEY_COLUMNS, ...EXTRA_COLUMNS] : KEY_COLUMNS;
  $("sites-head").innerHTML = "<tr>" + cols.map(([key, label, type]) => {
    const active = state.sortKey === key;
    const sort = active ? (state.sortDir === "asc" ? "ascending" : "descending") : "none";
    return `<th scope="col" aria-sort="${sort}" class="${type === "number" ? "num" : ""}"><button type="button" class="sort-btn" data-key="${key}">${escapeHtml(label)}<span aria-hidden="true" class="${active ? "" : "sort-hint"}">${active ? (state.sortDir === "asc" ? " ▲" : " ▼") : " ↕"}</span></button></th>`;
  }).join("") + "</tr>";
  const sorted = filtered.slice().sort(compareSites);
  const rows = state.showAllRows ? sorted : sorted.slice(0, 100);
  $("sites-body").innerHTML = rows.length ? rows.map(s => {
    const cells = [
      `<td><button type="button" class="name-btn" data-site="${escapeHtml(s.id)}">${escapeHtml(siteLabel(s))}</button>${readyTag(s)}${siteAddressLine(s)}</td>`,
      `<td>${escapeHtml(s.platform)}</td>`,
      `<td>${scoreCell(s)}</td>`,
      `<td class="num tnum">${s.scan === "failed" ? "—" : fmtNumber(s.pages)}</td>`,
      `<td class="num tnum">${fmtNumber(headlineIssues(s))}</td>`,
    ];
    if (state.allColumns) cells.push(
      `<td class="num tnum">${fmtScore(s.score)}</td>`,
      `<td>${escapeHtml(SCAN_WORDS[s.scan] || s.scan)}${s.last_crawl ? `<span class="site-url">${escapeHtml(longDate(s.last_crawl))}</span>` : ""}</td>`,
      `<td class="num tnum">${fmtNumber(s.issue_types)}</td>`,
      `<td class="num tnum">${fmtNumber(s.lvl_a)}</td>`, `<td class="num tnum">${fmtNumber(s.lvl_aa)}</td>`,
      `<td class="num tnum">${fmtNumber(s.lvl_aria)}</td>`, `<td class="num tnum">${fmtNumber(s.lvl_bp)}</td>`,
      `<td class="num tnum">${s.pdfs_available === false ? "—" : `${fmtNumber(s.pdfs_with_issues)} / ${fmtNumber(s.pdf_count)}`}</td>`,
      `<td class="num tnum">${fmtNumber(s.misspellings)}</td>`);
    return `<tr>${cells.join("")}</tr>`;
  }).join("") : `<tr><td colspan="${cols.length}" class="empty">No sites match these filters. <button type="button" class="link-btn" data-clear-filters>Clear all filters</button></td></tr>`;
  $("row-count").textContent = `${rows.length.toLocaleString("en-US")} of ${filtered.length.toLocaleString("en-US")} sites shown`;
  $("show-all-rows").hidden = state.showAllRows || sorted.length <= 100;
  $("show-all-rows").textContent = `Show all ${sorted.length.toLocaleString("en-US")} sites`;
  $("sites-table").setAttribute("aria-label", `Sites, ${filterDescription()}, sorted by ${(cols.find(c => c[0] === state.sortKey) || KEY_COLUMNS[0])[1]} ${state.sortDir === "asc" ? "ascending" : "descending"}`);
  for (const b of document.querySelectorAll("#column-toggle button")) b.setAttribute("aria-pressed", String((b.dataset.cols === "all") === state.allColumns));
}

function exportCSV() {
  const filtered = applyFilters().sort(compareSites);
  const cols = [
    ["Site name", s => s.site_name || ""], ["URL", s => s.url || ""], ["Site ID", s => s.id ?? ""],
    ["Labels", s => (s.tags || []).map(prettyTag).join(", ")], ["Platform", s => s.platform || ""],
    ["Score (Title II target %)", s => s.target_percentage ?? ""], ["Score estimated", s => s.target_estimated ? "yes" : ""],
    ["Ready for manual testing", s => isReady(s) ? "yes" : ""], ["Overall score (DCI)", s => s.score ?? ""],
    ["Pages checked", s => s.pages ?? ""], ["Last check", s => SCAN_WORDS[s.scan] || s.scan_status || ""], ["Last checked", s => s.last_crawl || ""],
    ["Pages with issues", s => s.pages_with_issues ?? ""], ["Kinds of issues", s => s.issue_types ?? ""],
    ["Level A occurrences", s => s.lvl_a ?? ""], ["Level AA occurrences", s => s.lvl_aa ?? ""], ["ARIA occurrences", s => s.lvl_aria ?? ""],
    ["Best practice occurrences", s => s.lvl_bp ?? ""], ["Issues (occurrences)", s => headlineIssues(s) ?? ""],
    ["PDFs", s => s.pdf_count ?? ""], ["PDFs to fix", s => s.pdfs_with_issues ?? ""], ["Spelling errors", s => s.misspellings ?? ""],
  ];
  download(`lsa-accessibility-${stamp()}${activeFilters().length ? "-filtered" : ""}-${filtered.length}sites.csv`, [
    csvRow(cols.map(([h]) => h)),
    ...filtered.map(s => csvRow(cols.map(([, fn]) => fn(s)))),
  ]);
}

// ---------------------------------------------------------------- site details
function siteProblems(site) {
  if (!rulesData || !Array.isArray(rulesData.rules)) return null;
  if (!siteRuleIndex) {
    siteRuleIndex = new Map();
    for (const rule of rulesData.rules) {
      if (!Array.isArray(rule.sites) || rule.level === "AAA") continue;
      for (const [id, occ] of rule.sites) {
        const key = String(id);
        if (!siteRuleIndex.has(key)) siteRuleIndex.set(key, []);
        siteRuleIndex.get(key).push({ rule, occurrences: occ });
      }
    }
  }
  if (!rulesData.rules.some(r => Array.isArray(r.sites))) return null;
  return (siteRuleIndex.get(String(site.id)) || []).sort((a, b) => b.occurrences - a.occurrences).slice(0, 5);
}

function openSite(id) {
  const s = state.sites.find(x => String(x.id) === String(id));
  if (!s) return;
  SitePanel.open({
    title: siteLabel(s),
    closeLabel: "Close site details",
    build(body, head) {
      if (s.url) {
        const a = document.createElement("a");
        a.href = s.url; a.target = "_blank"; a.rel = "noopener"; a.className = "site-url";
        a.textContent = s.url + " (opens in a new tab)";
        head.appendChild(a);
      }
      const g = GROUPS[targetGroupOf(s)];
      const problems = siteProblems(s);
      body.innerHTML = `
        <div class="pill-row">
          <span class="pill ${g.pill}">${g.label}${hasTarget(s) ? " · score " + fmtPct(s.target_percentage) : ""}</span>
          ${isReady(s) ? '<span class="pill pill-ready">Ready for manual testing</span>' : ""}
          <span class="pill pill-flat">${escapeHtml(s.platform)}</span>
          <span class="pill pill-flat">Last check: ${escapeHtml(SCAN_WORDS[s.scan] || "Unknown")}</span>
        </div>
        <div class="stat-grid stat-grid--2">
          <div class="stat-box"><span class="label">Score</span><span class="value tnum">${fmtPct(s.target_percentage)}</span>${s.target_estimated ? '<span class="muted">Estimated</span>' : ""}</div>
          <div class="stat-box"><span class="label">Overall score (includes optional checks)</span><span class="value tnum">${fmtScore(s.score)}</span></div>
          <div class="stat-box"><span class="label">Pages checked</span><span class="value tnum">${s.scan === "failed" ? "—" : fmtNumber(s.pages)}</span></div>
          <div class="stat-box"><span class="label">Pages with issues</span><span class="value tnum">${fmtNumber(s.pages_with_issues)}</span></div>
          <div class="stat-box"><span class="label">PDFs to fix</span><span class="value tnum">${s.pdfs_available === false ? "—" : `${fmtNumber(s.pdfs_with_issues)} of ${fmtNumber(s.pdf_count)}`}</span></div>
          <div class="stat-box"><span class="label">Spelling errors</span><span class="value tnum">${fmtNumber(s.misspellings)}</span></div>
        </div>
        <section><h3>Issues by type</h3><ul class="kv-list">
          ${["A", "AA", "ARIA", "BP"].map(k => `<li><span>${LEVEL_NAMES[k]}</span><strong class="tnum">${fmtNumber(s["lvl_" + k.toLowerCase()])}</strong></li>`).join("")}
        </ul></section>
        ${problems && problems.length ? `<section><h3>Biggest problems on this site</h3><ul class="kv-list">
          ${problems.map(p => { const gd = ProblemsCore.guidanceFor(p.rule, window.RuleGuidance); return `<li><span>${escapeHtml(gd.plain || p.rule.title)}</span><strong class="tnum">${fmtNumber(p.occurrences)}</strong></li>`; }).join("")}
        </ul></section>` : ""}
        <p class="muted" style="margin:0">Last checked ${escapeHtml(longDate(s.last_crawl))}. Labels: ${escapeHtml((s.tags || []).map(prettyTag).join(", ") || "none")}.</p>
        <div class="pill-row"><a class="btn" href="progress.html?search=${encodeURIComponent(s.site_name || s.url || "")}#sites">See progress over time</a></div>`;
    },
  });
}

// ---------------------------------------------------------------- render
function renderAll() {
  renderFilterPills();
  const filtered = applyFilters();
  const base = state.sites.filter(s => matchesBaseFilters(s, true));
  renderHero(base);
  renderSummary(filtered);
  renderFar(filtered);
  renderLevels(filtered);
  const rows = problemRows(filtered);
  renderTopProblems(rows);
  renderProblems(rows, filtered.length);
  renderReady(filtered);
  renderMissing(filtered);
  renderTable(filtered);
  renderActiveFilters(filtered.length);
  const readyN = readySites(filtered).length;
  $("tab-count-problems").textContent = rows ? `(${rows.length})` : "";
  $("tab-count-ready").textContent = `(${readyN.toLocaleString("en-US")})`;
  $("tab-count-sites").textContent = `(${filtered.length.toLocaleString("en-US")})`;
  if (window.ProgressWidget) ProgressWidget.render(fetchData, {
    platforms: [...state.platformFilters], tags: [...state.tagFilters], search: state.search.trim(),
  });
}

async function loadRulesQuietly() {
  try { return await fetchData("rules"); } catch (_) { return null; }
}

async function load() {
  try {
    const [data, rulesPayload] = await Promise.all([fetchData("sites"), loadRulesQuietly()]);
    state.sites = decorate(Array.isArray(data.sites) ? data.sites : []);
    rulesData = rulesPayload;
    siteRuleIndex = null;
    $("generated-at").textContent = longDate(data.generated_at);
    const anyTarget = state.sites.some(hasTarget);
    $("notice-stale").hidden = !(state.sites.length > 0 && !anyTarget);
    $("notice-live").hidden = !data.in_progress;
    const exc = $("exclusion-note");
    exc.textContent = excludedSiteCount ? `${excludedSiteCount.toLocaleString("en-US")} test and development site${excludedSiteCount === 1 ? " is" : "s are"} always hidden.` : "Test and development sites are always hidden.";
    if (data.in_progress) { if (!pollHandle) pollHandle = setInterval(load, POLL_INTERVAL_MS); }
    else if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
    renderFilterPills();
    renderAll();
  } catch (err) {
    $("sites-body").innerHTML = `<tr><td colspan="5" class="empty">Failed to load data: ${escapeHtml(err.message)}</td></tr>`;
    toast(`Failed to load data: ${err.message}`);
  }
}

// ---------------------------------------------------------------- wiring
function wire() {
  wireFilterGroup("filter-platform", state.platformFilters);
  wireFilterGroup("filter-scan", state.scanFilters);
  wireFilterGroup("filter-tags", state.tagFilters);
  wireFilterGroup("filter-level", state.levelFilters);
  $("more-filters-toggle").addEventListener("click", () => {
    state.moreFilters = !state.moreFilters;
    $("more-filters").hidden = !state.moreFilters;
    $("more-filters-toggle").setAttribute("aria-expanded", String(state.moreFilters));
    $("more-filters-toggle").textContent = state.moreFilters ? "Fewer filters" : "More filters";
  });
  $("active-filter-chips").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-index]");
    if (!b) return;
    const f = $("active-filters")._filters[Number(b.dataset.index)];
    if (f) { f.clear(); renderFilterPills(); renderAll(); $("filter-heading").focus(); }
  });
  $("clear-filters").addEventListener("click", clearAllFilters);
  $("hero-groups").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-group]");
    if (!b) return;
    state.targetGroup = state.targetGroup === b.dataset.group ? null : b.dataset.group;
    state.showAllRows = false;
    renderAll();
  });
  document.querySelector(".site-subnav__inner").addEventListener("click", (e) => {
    const b = e.target.closest(".tab[data-tab]");
    if (b) setTab(b.dataset.tab);
  });
  window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));
  $("see-all-problems").addEventListener("click", () => setTab("problems", true));
  document.addEventListener("click", (e) => {
    const site = e.target.closest("[data-site]");
    if (site) { openSite(site.dataset.site); return; }
    const problem = e.target.closest("[data-problem]");
    if (problem) {
      state.problemSelected = problem.dataset.problem;
      state.problemShowAll = false;
      if (state.tab !== "problems") setTab("problems");
      renderAll();
      const t = $("problem-title");
      if (t) {
        const box = $("problem-detail").getBoundingClientRect();
        if (problem.closest("#top-problems") || box.top < 0 || box.top > innerHeight * 0.6) $("problem-detail").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        if (problem.closest("#top-problems")) t.focus();
      }
      return;
    }
    const go = e.target.closest("[data-go-tab]");
    if (go) { setTab(go.dataset.goTab, true); return; }
    const reason = e.target.closest("[data-missing]");
    if (reason) { state.missingFilter = reason.dataset.missing; renderAll(); return; }
    if (e.target.closest("[data-clear-filters]")) clearAllFilters();
  });
  $("aud-cards").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-audience]");
    if (!b) return;
    state.problemAudience = state.problemAudience === b.dataset.audience ? null : b.dataset.audience;
    state.problemSelected = null;
    state.problemShowAll = false;
    renderAll();
  });
  $("aud-reset").addEventListener("click", () => { state.problemAudience = null; renderAll(); });
  $("problem-sort").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]");
    if (!b) return;
    state.problemSort = b.dataset.sort;
    renderAll();
  });
  $("sites-head").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-key]");
    if (!b) return;
    const key = b.dataset.key;
    const type = ([...KEY_COLUMNS, ...EXTRA_COLUMNS].find(c => c[0] === key) || [])[2];
    if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else { state.sortKey = key; state.sortDir = type === "number" && key !== "target_percentage" ? "desc" : "asc"; }
    renderAll();
    const again = document.querySelector(`#sites-head button[data-key="${key}"]`);
    if (again) again.focus();
  });
  $("column-toggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cols]");
    if (!b) return;
    state.allColumns = b.dataset.cols === "all";
    renderAll();
  });
  $("show-all-rows").addEventListener("click", () => { state.showAllRows = true; renderAll(); });
  $("export-csv").addEventListener("click", exportCSV);
  $("export-ready").addEventListener("click", exportReadyCSV);
  $("export-missing").addEventListener("click", exportMissingCSV);
  $("search").addEventListener("input", (e) => { state.search = e.target.value; state.showAllRows = false; renderAll(); });

  SiteSearch.init({
    sites: () => state.sites.map(s => ({
      label: siteLabel(s),
      sub: [s.url, s.platform, isReady(s) ? "Ready for manual testing" : ""].filter(Boolean).join(" · "),
      pill: hasTarget(s) ? fmtPct(s.target_percentage) : "No score",
      pillClass: GROUPS[targetGroupOf(s)].pill,
      search: `${s.site_name || ""} ${s.url || ""}`.toLowerCase(),
      run: () => openSite(s.id),
    })).sort((a, b) => a.label.localeCompare(b.label)),
    actions: () => [
      { label: "Show common problems", run: () => setTab("problems", true) },
      { label: "Show sites ready for manual testing", run: () => setTab("ready", true) },
      { label: "Show sites with missing data", run: () => setTab("missing", true) },
      { label: "Show all sites", run: () => setTab("sites", true) },
      { label: "Show WordPress sites", run: () => { state.platformFilters.clear(); state.platformFilters.add("WordPress"); renderFilterPills(); renderAll(); } },
      { label: "Show sites that need work (below 95%)", run: () => { state.targetGroup = "below"; renderAll(); setTab("sites", true); } },
      { label: "Show sites where the last check failed", run: () => { state.scanFilters.clear(); state.scanFilters.add("failed"); renderFilterPills(); renderAll(); setTab("sites", true); } },
      { label: "Download the site list (CSV spreadsheet)", run: exportCSV },
      { label: "See progress over time", run: () => { location.href = "progress.html"; } },
      { label: "Clear all filters", run: clearAllFilters },
    ],
  });
  setTab(location.hash.slice(1));
}

// ---------------------------------------------------------------- password gate
// Pages publishes only encrypted snapshots (data/<name>.enc.json written by
// scripts/encrypt_data.py). On a loopback host with no encrypted files the
// plain JSON is loaded and the gate is skipped.
const PASSWORD_KEY = "lsa-dashboard-password";
let dataKey = null;
let encrypted = true;

function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function fetchEncrypted(name) {
  const res = await fetch(`data/${name}.enc.json`, { cache: "no-cache" });
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function deriveKey(password, payload) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: b64ToBytes(payload.salt), iterations: payload.iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

async function decryptPayload(key, payload) {
  return ProgressClient.decrypt(key, payload);
}

async function fetchData(name) {
  if (!/^(?:history\/)?[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid data resource");
  if (!encrypted) {
    const compressed = name.startsWith("history/") && name !== "history/index";
    const res = await fetch(`data/${name}${compressed ? ".json.gz" : ".json"}`, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return ProgressClient.decode(await res.arrayBuffer(), compressed ? "gzip" : "");
  }
  return decryptPayload(dataKey, await fetchEncrypted(name));
}

async function tryUnlock(password, payload) {
  try {
    const key = await deriveKey(password, payload);
    await decryptPayload(key, payload);
    dataKey = key;
    return true;
  } catch (_) {
    return false;
  }
}

function storePassword(password) { try { sessionStorage.setItem(PASSWORD_KEY, password); } catch (_) {} }
function storedPassword() { try { return sessionStorage.getItem(PASSWORD_KEY); } catch (_) { return null; } }

function unlockPage() {
  document.body.classList.remove("locked");
  load();
}

async function startGate() {
  let payload;
  try {
    payload = await fetchEncrypted("sites");
  } catch (error) {
    if (error.status === 404 && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
      encrypted = false;
      unlockPage();
    } else {
      $("gate-error").textContent = `Unable to load encrypted dashboard: ${error.message}`;
    }
    return;
  }
  const saved = storedPassword();
  if (saved && await tryUnlock(saved, payload)) { unlockPage(); return; }
  const form = $("gate-form"), input = $("gate-password"), error = $("gate-error"), button = form.querySelector("button");
  input.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    if (!input.value) { error.textContent = "Enter the password."; input.focus(); return; }
    button.disabled = true;
    button.textContent = "Unlocking…";
    const ok = await tryUnlock(input.value, payload);
    button.disabled = false;
    button.textContent = "Unlock";
    if (ok) { storePassword(input.value); unlockPage(); }
    else { error.textContent = "Incorrect password. Try again."; input.select(); }
  });
}

wire();
startGate();
