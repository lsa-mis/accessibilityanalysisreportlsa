// Progress over time page (progress.html). All comparison maths lives in
// ProgressCore; loading and the password gate live in ProgressClient.
(function () {
  "use strict";
  const core = ProgressCore, client = ProgressClient;
  const el = id => document.getElementById(id);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (v, digits = 0) => v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const pct = v => v === null || v === undefined ? "—" : fmt(v, 1) + "%";
  const signed = (v, digits = 0) => v === null || v === undefined ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "±") + fmt(Math.abs(v), digits);
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const longDate = d => d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}` : "—";
  const dayNum = d => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86400000;
  const comparable = e => !!e && e.eligible_count > 0;

  let entries = [], mapping = {}, fromE = null, toE = null, before = null, after = null, comparison = null;
  let sort = "site", direction = 1, generation = 0, period = "month", tab = "overview", siteFilter = "all", showAllSites = false;
  let trendMetric = "mean", picker = null, viewMonth = null, pickerOpener = null, exportTab = "summary";
  const platforms = new Set(), tags = new Set();
  let department = "", search = "";
  const cache = new Map();

  const filters = () => ({ platforms: [...platforms], tags: [...tags], department, search });
  const filterText = () => {
    const parts = [];
    parts.push(platforms.size ? "platform " + [...platforms].join(" or ") : "all platforms");
    if (tags.size) parts.push("labels " + [...tags].map(t => t.replace(/^tag:/, "")).join(" or "));
    parts.push(department ? "department " + department : "all departments");
    if (search) parts.push(`search “${search}”`);
    return parts.join(", ");
  };
  function error(message) { el("report-error").textContent = message; el("report-error").hidden = false; }

  async function snapshot(entry) {
    if (!cache.has(entry.path)) cache.set(entry.path, client.load(entry.path.replace(/\.json\.gz$/, "")).catch(failure => { cache.delete(entry.path); throw failure; }));
    return cache.get(entry.path);
  }

  // ------------------------------------------------------------ per-row metrics
  function metricRow(row, metric) {
    const old = row.before, current = row.after;
    if (metric === "target") return core.pair(old?.eligible ? old.target_percentage : null, current?.eligible ? current.target_percentage : null, row.matched ? 1 : 0);
    const value = site => site?.eligible && site.issues_reliable ? ["A", "AA", "ARIA"].reduce((n, level) => n + site.by_level[level][metric], 0) : null;
    return core.pair(value(old), value(current), row.matched ? 1 : 0);
  }
  const ready = s => !!s && core.wordpress(s) && s.eligible && s.target_percentage >= 98;
  function classify(row) {
    if (!row.before) return "new";
    if (!row.after) return "gone";
    if (!row.matched) return "needs";
    return "matched";
  }
  function crossing(row) {
    if (!row.matched || !core.wordpress(row.before) || !core.wordpress(row.after)) return "";
    const b = row.before.target_percentage, a = row.after.target_percentage;
    return b < 98 && a >= 98 ? "up" : b >= 98 && a < 98 ? "down" : "";
  }
  const SITE_FILTERS = [
    ["all", "All", () => true],
    ["improved", "Improved", r => r.matched && (metricRow(r, "target").change || 0) > 0.05],
    ["slipped", "Slipped", r => r.matched && (metricRow(r, "target").change || 0) < -0.05],
    ["up", "Reached 98%", r => crossing(r) === "up"],
    ["down", "Dropped below 98%", r => crossing(r) === "down"],
    ["needs", "Needs reliable data", r => classify(r) === "needs"],
    ["new", "New", r => classify(r) === "new"],
    ["gone", "Not seen", r => classify(r) === "gone"],
    ["matched", "Matched", r => r.matched],
  ];

  function pill(value, goodWhenUp, text) {
    if (value === null || value === undefined) return `<span class="pill pill-flat">Not comparable</span>`;
    const v = Number(value);
    if (v === 0) return `<span class="pill pill-flat">${escape(text)} (no change)</span>`;
    const better = (v > 0) === goodWhenUp;
    return `<span class="pill ${better ? "pill-good" : "pill-bad"}">${v > 0 ? "↑" : "↓"} ${escape(text)} (${better ? "better" : "worse"})</span>`;
  }

  // ------------------------------------------------------------ tabs
  const TABS = ["overview", "departments", "sites"];
  function setTab(name, focus) {
    tab = TABS.includes(name) ? name : "overview";
    for (const t of TABS) {
      el(`panel-${t}`).hidden = t !== tab;
      const b = document.querySelector(`.tab[data-tab="${t}"]`);
      if (b) b.setAttribute("aria-current", t === tab ? "page" : "false");
    }
    const hash = tab === "overview" ? "" : "#" + tab;
    if (location.hash !== hash) history.replaceState(null, "", location.pathname + location.search + hash);
    if (focus) el(`panel-${tab}`).focus();
  }

  // ------------------------------------------------------------ controls
  function renderControls() {
    el("from-btn").innerHTML = `<span class="sr-only">Start date: </span>${escape(longDate(fromE?.date))}`;
    el("to-btn").innerHTML = `<span class="sr-only">End date: </span>${escape(longDate(toE?.date))}`;
    el("from-btn").setAttribute("aria-expanded", String(picker === "from"));
    el("to-btn").setAttribute("aria-expanded", String(picker === "to"));
    el("span-label").textContent = fromE && toE ? `${dayNum(toE.date) - dayNum(fromE.date)} days apart` : "";
    for (const b of document.querySelectorAll("#shortcuts button")) b.setAttribute("aria-pressed", String(b.dataset.period === period));

    const counts = new Map();
    for (const s of [...(before?.sites || []), ...(after?.sites || [])].filter(core.visible)) {
      const p = core.platform(s);
      counts.set(p, (counts.get(p) || 0) + 1);
    }
    const order = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    el("filter-platform").innerHTML = `<button type="button" class="chip" data-platform="" aria-pressed="${!platforms.size}">All</button>` +
      order.map(p => `<button type="button" class="chip" data-platform="${escape(p)}" aria-pressed="${platforms.has(p)}">${escape(p)}</button>`).join("");
    if (el("search").value !== search) el("search").value = search;

    const active = [];
    for (const p of platforms) active.push([`Platform: ${p}`, () => platforms.delete(p)]);
    for (const t of tags) active.push([`Label: ${t.replace(/^tag:/, "")}`, () => tags.delete(t)]);
    if (department) active.push([`Department: ${department}`, () => { department = ""; }]);
    if (search) active.push([`Search: “${search}”`, () => { search = ""; }]);
    el("active-filters").hidden = !active.length;
    el("active-filters")._items = active;
    el("active-filter-chips").innerHTML = active.map(([label], i) =>
      `<button type="button" class="active-chip" data-index="${i}" aria-label="Remove filter ${escape(label)}">${escape(label)}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`).join("");

    const banner = el("not-comparable");
    const firstGood = entries.find(comparable);
    if (fromE && !comparable(fromE)) {
      banner.hidden = false;
      banner.innerHTML = `<strong>${escape(longDate(fromE.date))} can’t be compared yet.</strong> Snapshots before ${escape(longDate(firstGood?.date))} were imported from older history without the scan quality details needed for a fair comparison. They still appear in the trend, but not as progress.
        ${firstGood && firstGood !== toE ? ` <button type="button" class="btn btn-primary" id="use-first-comparable">Compare from ${escape(longDate(firstGood.date))} instead</button>` : ""}`;
    } else banner.hidden = true;
  }

  // ------------------------------------------------------------ calendar
  function renderPicker() {
    const box = el("date-picker");
    if (!picker) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    const byDate = new Map(entries.map(e => [e.date, e]));
    const [y, m] = viewMonth.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const firstMonth = entries[0].date.slice(0, 7), lastMonth = entries.at(-1).date.slice(0, 7);
    const lo = picker === "from" ? null : fromE?.date, hi = picker === "to" ? null : toE?.date;
    let count = 0;
    const cells = [];
    for (let i = 0; i < first.getUTCDay(); i++) cells.push(`<span aria-hidden="true"></span>`);
    for (let d = 1; d <= days; d++) {
      const date = `${viewMonth}-${String(d).padStart(2, "0")}`, e = byDate.get(date);
      const inRange = fromE && toE && date >= fromE.date && date <= toE.date;
      const label = `${longDate(date)}`;
      if (e && comparable(e) && (!lo || date > lo) && (!hi || date < hi)) {
        count++;
        const sel = date === fromE?.date ? " sel-from" : date === toE?.date ? " sel-to" : "";
        cells.push(`<button type="button" class="cal-day${sel}${inRange && !sel ? " in-range" : ""}" data-date="${date}" aria-label="${escape(label)}, snapshot available" ${sel ? 'aria-current="date"' : ""}>${d}</button>`);
      } else if (e && !comparable(e)) {
        cells.push(`<span class="cal-day old" title="${escape(label)}: older import, not comparable"><span aria-hidden="true">${d}</span><span class="sr-only">${escape(label)}, older import, not comparable</span></span>`);
      } else {
        const sel = date === fromE?.date ? " sel-from" : date === toE?.date ? " sel-to" : "";
        cells.push(`<span class="cal-day off${sel}${inRange && !sel ? " in-range" : ""}"><span aria-hidden="true">${d}</span><span class="sr-only">${escape(label)}, ${sel ? "selected" : "not available"}</span></span>`);
      }
    }
    box.innerHTML = `
      <div class="cal">
        <div class="cal-head">
          <button type="button" class="btn" id="cal-prev" aria-label="Previous month" ${viewMonth <= firstMonth ? "disabled" : ""}>‹</button>
          <div style="text-align:center">
            <h3 id="calendar-title" tabindex="-1">Choose the ${picker === "from" ? "start" : "end"} date</h3>
            <span class="muted" aria-live="polite">${MONTHS[m - 1]} ${y} · ${count} date${count === 1 ? "" : "s"} available</span>
          </div>
          <button type="button" class="btn" id="cal-next" aria-label="Next month" ${viewMonth >= lastMonth ? "disabled" : ""}>›</button>
        </div>
        <div class="cal-grid" aria-hidden="true">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => `<span class="cal-dow">${d}</span>`).join("")}</div>
        <div class="cal-grid" role="group" aria-label="${MONTHS[m - 1]} ${y}">${cells.join("")}</div>
      </div>
      <div class="cal-side">
        <p style="margin:0;font-weight:600">${picker === "from" ? "Only dates before the end date with a saved, comparable snapshot can be picked." : "Only dates after the start date with a saved, comparable snapshot can be picked."}</p>
        <ul class="cal-key">
          <li><span class="cal-day" style="border:2px solid var(--link);color:var(--navy);background:#fff" aria-hidden="true">12</span>Snapshot available</li>
          <li><span class="cal-day old" aria-hidden="true">12</span>Older import, not comparable</li>
          <li><span class="cal-day off" aria-hidden="true">12</span>No snapshot</li>
          <li><span class="cal-day in-range" style="border:2px solid var(--link)" aria-hidden="true">12</span>Inside the current comparison</li>
        </ul>
        <div class="pill-row"><button type="button" class="btn" id="cal-close">Done</button></div>
        <span class="muted">Press Escape to close.</span>
      </div>`;
  }
  function openPicker(which) {
    if (picker === which) { closePicker(); return; }
    pickerOpener = el(which === "from" ? "from-btn" : "to-btn");
    picker = which;
    viewMonth = (which === "from" ? fromE : toE).date.slice(0, 7);
    renderControls();
    renderPicker();
    el("calendar-title").focus();
  }
  function closePicker() {
    picker = null;
    renderControls();
    renderPicker();
    if (pickerOpener) pickerOpener.focus();
  }
  function shiftMonth(delta) {
    const [y, m] = viewMonth.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    viewMonth = d.toISOString().slice(0, 7);
    renderPicker();
    el("calendar-title").focus();
  }

  // ------------------------------------------------------------ trend
  function renderTrend() {
    const value = e => trendMetric === "mean" ? (comparable(e) ? e.mean_target : null) : (comparable(e) ? e.eligible_count : null);
    const vals = entries.map(value).filter(v => v !== null && v !== undefined);
    let lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1;
    const pad = (hi - lo) * 0.15 || 1; lo -= pad; hi += pad;
    const d0 = dayNum(entries[0].date), dN = dayNum(entries.at(-1).date) || d0 + 1;
    const span = Math.max(1, dN - d0);
    const x = e => (dayNum(e.date) - d0) / span * 100;
    const y = v => Math.max(5, Math.min(95, 100 - (v - lo) / (hi - lo) * 100));
    const show = v => trendMetric === "mean" ? pct(v) : fmt(v);
    let path = "", prev = null;
    entries.forEach(e => {
      const v = value(e);
      if (v === null || v === undefined) { prev = null; return; }
      const gap = prev && dayNum(e.date) - dayNum(prev.date) > 10;
      path += `${!prev || gap ? "M" : "L"}${(x(e) * 10).toFixed(1)} ${(y(v) * 2.4).toFixed(1)} `;
      prev = e;
    });
    const bands = [];
    const firstGood = entries.findIndex(comparable);
    if (firstGood > 0) bands.push([0, x(entries[firstGood]), "Older imports, not comparable"]);
    for (let i = 1; i < entries.length; i++) if (dayNum(entries[i].date) - dayNum(entries[i - 1].date) > 10) bands.push([x(entries[i - 1]), x(entries[i]) - x(entries[i - 1]), "No snapshots"]);
    const fx = fromE ? x(fromE) : 0, tx = toE ? x(toE) : 0;
    el("trend-plot").setAttribute("aria-label", `${trendMetric === "mean" ? "Average score" : "Sites with a reliable score"} for each saved snapshot, ${vals.length ? `ranging from ${show(Math.min(...vals))} to ${show(Math.max(...vals))}` : "with no comparable values yet"}. The data table below lists every snapshot and lets you start the comparison on any of them.`);
    el("trend-plot").innerHTML =
      bands.map(([l, w, t]) => `<div class="trend-band" style="left:${l.toFixed(2)}%;width:${w.toFixed(2)}%"><span>${t}</span></div>`).join("") +
      `<div class="trend-sel" aria-hidden="true" style="left:${fx.toFixed(2)}%;width:${Math.max(0, tx - fx).toFixed(2)}%"></div>` +
      `<svg viewBox="0 0 1000 240" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="#00508F" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>` +
      entries.map((e, i) => {
        const v = value(e), isFrom = e === fromE, isTo = e === toE;
        const cls = "pt" + (isFrom ? " from" : isTo ? " to" : v === null || v === undefined ? " na" : "");
        const label = `${longDate(e.date)}, ${v === null || v === undefined ? "not comparable" : show(v)}${isFrom ? ", current start date" : isTo ? ", current end date" : comparable(e) && toE && e.date < toE.date ? ", set as start date" : ""}`;
        // Dots are a mouse shortcut; the table below offers the same "start here" action with full-size buttons.
        return `<span class="${cls}" style="left:${x(e).toFixed(2)}%;top:${(v === null || v === undefined ? 92 : y(v)).toFixed(2)}%" data-index="${i}" title="${escape(label)}"></span>`;
      }).join("");
    el("trend-max").textContent = vals.length ? show(hi) : "";
    el("trend-min").textContent = vals.length ? show(lo) : "";
    const ticks = [];
    const start = new Date(entries[0].date + "T00:00:00Z"); start.setUTCDate(1);
    for (let d = new Date(start); dayNum(d.toISOString().slice(0, 10)) <= dN; d.setUTCMonth(d.getUTCMonth() + 1)) {
      const iso = d.toISOString().slice(0, 10), px = (dayNum(iso) - d0) / span * 100;
      if (px >= -1) ticks.push(`<span style="left:${Math.max(4, Math.min(96, px)).toFixed(2)}%">${SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}</span>`);
    }
    el("trend-x").innerHTML = ticks.join("");
    for (const b of document.querySelectorAll("#trend-metric button")) b.setAttribute("aria-pressed", String(b.dataset.metric === trendMetric));
    el("trend-body").innerHTML = [...entries].reverse().map(e => {
      const notes = [e === fromE ? "Start date" : "", e === toE ? "End date" : "", comparable(e) ? (e.historical ? "Imported snapshot" : "Nightly snapshot") : "Older import, not comparable"].filter(Boolean).join("; ");
      const canStart = comparable(e) && toE && e.date < toE.date && e !== fromE;
      return `<tr><td>${escape(longDate(e.date))}</td><td class="num tnum">${comparable(e) ? pct(e.mean_target) : "—"}</td><td class="num tnum">${comparable(e) ? `${fmt(e.eligible_count)} of ${fmt(e.site_count)}` : "—"}</td><td>${escape(notes)}</td>
        <td>${canStart ? `<button type="button" class="btn" data-start-index="${entries.indexOf(e)}" aria-label="Start the comparison on ${escape(longDate(e.date))}">Start here</button>` : ""}</td></tr>`;
    }).join("");
  }

  // ------------------------------------------------------------ report
  function atCounts(rows) {
    const m = rows.filter(r => r.matched);
    return { before: m.filter(r => r.before.target_percentage >= 98).length, after: m.filter(r => r.after.target_percentage >= 98).length };
  }

  function render() {
    renderControls();
    if (!before || !after) return;
    comparison = core.compare(before, after, mapping, filters());
    const c = comparison;
    el("report").hidden = false;
    el("live-status").textContent = `Comparing ${longDate(fromE.date)} to ${longDate(toE.date)}, ${filterText()}: ${c.matched} matched sites.`;
    el("comparison-context").textContent = `Snapshots pulled ${before.generated_at} and ${after.generated_at} (Detroit dates ${before.reporting_date} and ${after.reporting_date}). Showing ${filterText()}. Today’s department list is used for both dates.`;
    const at = atCounts(c.rows), occ = c.headline_occurrences;
    const occPct = occ.change === null || !occ.before ? null : occ.change / occ.before * 100;
    const pp = c.target.change;
    const setAside = c.added + c.removed + c.gaps;
    el("headline").textContent = c.matched
      ? `From ${longDate(fromE.date)} to ${longDate(toE.date)}, ${at.after === at.before ? "the same number of sites were at" : `${fmt(Math.abs(at.after - at.before))} ${at.after > at.before ? "more" : "fewer"} site${Math.abs(at.after - at.before) === 1 ? "" : "s"} reached`} 98% or higher (${fmt(at.before)} to ${fmt(at.after)}). The average score moved ${signed(pp, 2)} points${occPct === null ? ". Issue counts can’t be compared for these dates." : `, and detected issues ${occPct <= 0 ? "fell" : "rose"} ${fmt(Math.abs(occPct), 1)}%.`}`
      : `No sites have reliable data on both ${longDate(fromE.date)} and ${longDate(toE.date)}, so changes can’t be shown. Try a later start date.`;
    const card = (title, now, from, delta, note) => `<div class="card kpi"><h3>${escape(title)}</h3>
      <div class="pill-row" style="align-items:baseline"><span class="kpi-value tnum">${escape(now)}</span><span class="muted tnum">from ${escape(from)}</span></div>${delta}<span class="muted" style="font-size:14px">${escape(note)}</span></div>`;
    el("metrics").innerHTML = c.matched ? [
      card("Sites at 98% or higher", fmt(at.after), fmt(at.before), pill(at.after - at.before, true, `${signed(at.after - at.before)} sites`), `Of ${fmt(c.matched)} matched sites.`),
      card("Average score", pct(c.target.after), pct(c.target.before), pill(pp === null ? null : Number(pp.toFixed(2)), true, `${signed(pp, 2)} points`), `Mean of the same ${fmt(c.matched)} sites on both dates.`),
      card("Issues (occurrences)", fmt(occ.after), fmt(occ.before), pill(occPct === null ? null : Number(occPct.toFixed(1)), false, `${signed(occPct, 1)}% detected`), occ.count ? `Level A, AA and ARIA, for ${fmt(occ.count)} sites with comparable issue data. Not a count of verified fixes.` : "No sites have comparable issue data for these dates."),
      card("Sites in this comparison", fmt(c.matched), `${fmt(c.matched + setAside)} total`, `<span class="pill pill-flat">${fmt(setAside)} set aside</span>`, "New, missing or unreliable sites are left out of the changes. See “What’s counted”."),
    ].join("") : [
      card("Sites at 98% or higher", "—", "—", `<span class="pill pill-flat">Not comparable</span>`, "No sites have reliable data on both dates."),
      card("Average score", "—", "—", `<span class="pill pill-flat">Not comparable</span>`, "Unknown values are never shown as zero."),
      card("Issues (occurrences)", "—", "—", `<span class="pill pill-flat">Not comparable</span>`, "Choose a later start date to see changes."),
      card("Sites in this comparison", "0", `${fmt(setAside)} total`, `<span class="pill pill-flat">All set aside</span>`, "See “What’s counted” for reasons."),
    ].join("");

    el("wp-up").textContent = fmt(c.newly_ready);
    el("wp-down").textContent = fmt(c.regressed);
    el("wp-note").textContent = c.wordpress_matched
      ? `Out of ${fmt(c.wordpress_matched)} matched WordPress sites (labels WP, WP-Sites, WP-Courses and WP-DigitalScholarship; each site counted once). A site seen for the first time above 98% does not count as crossing.`
      : "Needs confirmed WordPress scores on both dates.";

    const total = c.matched + setAside || 1;
    const cov = [
      ["matched", "Matched", "Reliable data on both dates", c.matched, "#00274C"],
      ["needs", "Needs reliable data", "Estimated, failed check or older import", c.gaps, "#B05A0C"],
      ["new", "New sites", "First seen after the start date", c.added, "#4F7FB0"],
      ["gone", "No longer observed", "Not in the latest snapshot (not assumed retired)", c.removed, "#6B7684"],
    ];
    el("coverage-bar").innerHTML = cov.map(([, , , n, color]) => `<span style="width:${(n / total * 100).toFixed(2)}%;background:${color}"></span>`).join("");
    el("coverage").innerHTML = cov.map(([key, label, desc, n, color]) =>
      `<li><button type="button" class="cov-row" data-site-filter="${key}" aria-label="${escape(`${label}: ${n} sites. ${desc}. Show these sites.`)}">
        <span class="sw" style="background:${color}"></span><span class="grow"><strong>${escape(label)}</strong><span class="muted" style="font-size:14px">${escape(desc)}</span></span>
        <strong class="tnum">${fmt(n)}</strong></button></li>`).join("");

    const extra = [["Level AAA occurrences", c.aaa_occurrences], ["Level AAA kinds of issues", c.aaa_issues], ["Best-practice occurrences", c.bp_occurrences],
      ["Best-practice kinds of issues", c.bp_issues], ["PDFs", c.pdf_count], ["PDFs to fix", c.pdfs_with_issues], ["Problems reported inside PDFs", c.pdf_total_issues]];
    el("supplementary-metrics").innerHTML = extra.map(([label, p]) =>
      `<tr><th scope="row">${escape(label)}</th><td class="num tnum">${fmt(p.before)}</td><td class="num tnum">${fmt(p.after)}</td><td class="num tnum">${signed(p.change)}</td><td class="num tnum">${fmt(p.count)}</td></tr>`).join("");

    const notes = [...new Set([before.quality_note, after.quality_note].filter(Boolean))];
    if (c.matched && !occ.count) notes.push("Issue counts weren’t verified for these snapshots, so issue changes can’t be calculated.");
    el("quality-note").textContent = notes.join(" ");
    el("quality-note").hidden = !notes.length;

    renderDepartments();
    renderSites();
    renderTrend();
    renderPicker();
  }

  function renderDepartments() {
    const names = [...new Set(comparison.rows.map(row => row.department))].sort((a, b) => a === "Unmapped" ? 1 : b === "Unmapped" ? -1 : a.localeCompare(b));
    el("departments-body").innerHTML = names.length ? names.map(name => {
      const d = core.compare(before, after, mapping, { ...filters(), department: name });
      const at = atCounts(d.rows), occ = d.headline_occurrences;
      const occPct = occ.change === null || !occ.before ? null : occ.change / occ.before * 100;
      const ok = d.matched > 0;
      return `<tr>
        <th scope="row"><button type="button" class="name-btn department-link" data-department="${escape(name)}">${escape(name)}</button>${name === "Unmapped" ? '<span class="site-url">No department assigned yet in the mapping file</span>' : ""}</th>
        <td class="num tnum">${fmt(d.matched)}</td>
        <td class="tnum">${ok ? `${fmt(at.before)} → <strong>${fmt(at.after)}</strong>` : "—"}</td>
        <td><span class="tnum">${ok ? pct(d.target.after) : "—"}</span> ${ok ? pill(d.target.change === null ? null : Number(d.target.change.toFixed(2)), true, `${signed(d.target.change, 2)} points`) : ""}</td>
        <td><span class="tnum">${fmt(occ.after)}</span> ${occPct === null ? "" : pill(Number(occPct.toFixed(1)), false, `${signed(occPct, 1)}%`)}</td>
        <td class="num tnum">${fmt(d.gaps)}</td></tr>`;
    }).join("") : `<tr><td colspan="6" class="empty">No departments match these filters.</td></tr>`;
  }

  function renderSites() {
    const counts = Object.fromEntries(SITE_FILTERS.map(([k, , f]) => [k, comparison.rows.filter(f).length]));
    el("site-filters").innerHTML = SITE_FILTERS.filter(([k]) => k !== "matched" || siteFilter === "matched").map(([k, label]) =>
      `<button type="button" class="chip" data-site-filter="${k}" aria-pressed="${siteFilter === k}">${escape(label)} <span class="tnum">(${counts[k]})</span></button>`).join("");
    const fn = (SITE_FILTERS.find(f => f[0] === siteFilter) || SITE_FILTERS[0])[2];
    const rows = comparison.rows.filter(fn).sort((a, b) => {
      if (sort === "site") return direction * (a.site.site_name || a.site.url || "").localeCompare(b.site.site_name || b.site.url || "");
      const x = metricRow(a, sort).change, y = metricRow(b, sort).change;
      if (x === null) return y === null ? 0 : 1;
      if (y === null) return -1;
      return direction * (x - y);
    });
    for (const header of document.querySelectorAll("th[data-sort]")) {
      if (header.dataset.sort === sort) header.setAttribute("aria-sort", direction === 1 ? "ascending" : "descending");
      else header.removeAttribute("aria-sort");
      const b = header.querySelector("button");
      b.querySelector(".arrow")?.remove();
      if (header.dataset.sort === sort) b.insertAdjacentHTML("beforeend", `<span class="arrow" aria-hidden="true">${direction === 1 ? " ▲" : " ▼"}</span>`);
    }
    const shown = showAllSites ? rows : rows.slice(0, 100);
    const statusText = row => {
      const k = classify(row);
      if (k === "new") return "New since " + longDate(fromE.date);
      if (k === "gone") return "Not seen on " + longDate(toE.date);
      if (k === "needs") return "Needs reliable data" + (row.reason ? ": " + row.reason : "");
      return row.before.issues_reliable && row.after.issues_reliable ? "Matched" : "Matched (issue counts not verified)";
    };
    el("sites-body").innerHTML = shown.length ? shown.map(row => {
      const t = metricRow(row, "target"), o = metricRow(row, "occurrences");
      const safeURL = /^https?:\/\//i.test(row.site.url || "") ? row.site.url : "";
      return `<tr>
        <td><strong>${escape(row.site.site_name || row.site.url)}</strong>${ready(row.after) ? ' <span class="pill pill-ready">Ready for manual testing</span>' : ""}${safeURL ? `<a class="site-url" href="${escape(safeURL)}" target="_blank" rel="noopener">${escape(safeURL)}<span class="sr-only"> (opens in a new tab)</span></a>` : ""}</td>
        <td>${escape(row.department)}<span class="site-url">${escape(row.platform)}</span></td>
        <td class="num tnum">${pct(t.before)}</td><td class="num tnum">${pct(t.after)}</td>
        <td>${t.change === null ? "—" : pill(Number(t.change.toFixed(2)), true, `${signed(t.change, 2)} points`)}</td>
        <td class="num tnum">${fmt(o.after)}</td>
        <td>${o.change === null ? "—" : pill(o.change, false, signed(o.change))}</td>
        <td class="num tnum">${fmt(row.before?.pages)} → ${fmt(row.after?.pages)}</td>
        <td>${escape(statusText(row))}</td></tr>`;
    }).join("") : `<tr><td colspan="9" class="empty">No sites match these filters. <button type="button" class="link-btn" id="clear-from-table">Clear filters</button></td></tr>`;
    el("sites-count").textContent = `(${fmt(rows.length)})`;
    el("sites-caption").textContent = `Site comparison, ${(SITE_FILTERS.find(f => f[0] === siteFilter) || SITE_FILTERS[0])[1]}, ${filterText()}`;
    el("sites-show-all").hidden = showAllSites || rows.length <= 100;
    el("sites-show-all").textContent = `Show all ${fmt(rows.length)} sites`;
  }

  // ------------------------------------------------------------ loading
  async function loadComparison() {
    const token = ++generation;
    before = after = comparison = null;
    el("report").hidden = true;
    el("report-error").hidden = true;
    el("load-status").textContent = "Loading the selected snapshots…";
    renderControls();
    if (!fromE || !toE || fromE.date >= toE.date) {
      el("load-status").textContent = "Choose two saved dates, with the start before the end.";
      return;
    }
    try {
      const loaded = await Promise.all([snapshot(fromE), snapshot(toE)]);
      if (token !== generation) return;
      [before, after] = loaded;
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
    for (const p of query.getAll("platform")) platforms.add(p);
    for (const t of query.getAll("tag")) tags.add(t);
    department = query.get("department") || "";
    search = query.get("search") || "";
  }

  function choosePeriod(p) {
    period = p;
    if (p === "start") fromE = entries.find(comparable) || entries[0];
    else {
      const days = { week: 7, month: null, quarter: 91 }[p];
      const requested = days === null ? null : new Date((dayNum(toE.date) - days) * 86400000).toISOString().slice(0, 10);
      fromE = days === null ? core.baseline(entries, toE, "month") : entries.filter(e => e.date <= requested).at(-1) || null;
      if (!fromE) {
        el("date-note").textContent = `There is no saved snapshot from ${p === "week" ? "a week" : p === "month" ? "a month" : "three months"} before ${longDate(toE.date)}. Choose another start date.`;
        fromE = entries[0];
        return loadComparison();
      }
      const wanted = days === null ? core.baseline(entries, toE, "month") : null;
      const target = days === null ? null : requested;
      el("date-note").textContent = target && fromE.date !== target
        ? `No snapshot was saved exactly on ${longDate(target)}, so the closest earlier one (${longDate(fromE.date)}) is used.`
        : wanted ? `Compared with the last saved snapshot a month earlier: ${longDate(fromE.date)}.` : "";
    }
    if (p === "start") el("date-note").textContent = `The first snapshot that can be compared is ${longDate(fromE.date)}.`;
    return loadComparison();
  }

  // ------------------------------------------------------------ share / export
  function summary() {
    const c = comparison, at = atCounts(c.rows), occ = c.headline_occurrences;
    const occPct = occ.change === null || !occ.before ? null : occ.change / occ.before * 100;
    return [
      `LSA accessibility progress: ${longDate(fromE.date)} to ${longDate(toE.date)}`,
      `Showing ${filterText()}. Today’s department list is used for both dates.`,
      `Snapshots pulled ${before.generated_at} and ${after.generated_at}.`,
      "",
      c.matched ? `- Sites at 98% or higher: ${at.before} to ${at.after} (${signed(at.after - at.before)}) of ${c.matched} matched sites.` : "- No sites have reliable data on both dates; changes are not available.",
      c.matched ? `- Average score: ${pct(c.target.before)} to ${pct(c.target.after)} (${signed(c.target.change, 2)} percentage points).` : "",
      occ.count ? `- Detected Level A, AA and ARIA issues: ${fmt(occ.before)} to ${fmt(occ.after)} (${signed(occPct, 1)}%). Net detected change, not verified fixes.` : "- Issue counts can’t be compared for these dates.",
      c.wordpress_matched ? `- WordPress sites reaching 98%: ${fmt(c.newly_ready)}; dropping below: ${fmt(c.regressed)}.` : "",
      `- Set aside: ${c.added} new, ${c.removed} no longer observed, ${c.gaps} needing reliable data.`,
      "",
      el("quality-note").hidden ? "" : el("quality-note").textContent,
      el("refresh-warning").hidden ? "" : el("refresh-warning").textContent,
      "The score tracks progress; it is not proof of compliance or manual testing.",
    ].filter((line, i, all) => line !== "" || (all[i - 1] !== "" && i > 0)).join("\n");
  }
  function csvLines() {
    const rows = summary().split("\n").filter(Boolean).map(line => ["Report context", line]);
    rows.push([], ["Site", "URL", "Platform", "Department", "Score before", "Score now", "Score change (points)",
      "Issues before (A+AA+ARIA)", "Issues now", "Issue change", "Kinds of issues before", "Kinds of issues now", "Kinds of issues change",
      "Pages before", "Pages now", "Status", "Ready for manual testing", "Earlier last check", "Later last check"]);
    for (const row of comparison.rows) {
      const t = metricRow(row, "target"), o = metricRow(row, "occurrences"), i = metricRow(row, "issues");
      rows.push([row.site.site_name, row.site.url, row.platform, row.department, t.before, t.after, t.change, o.before, o.after, o.change,
        i.before, i.after, i.change, row.before?.pages, row.after?.pages, row.reason || (row.matched ? "Matched" : ""), ready(row.after) ? "Yes" : "",
        row.before?.last_crawl, row.after?.last_crawl]);
    }
    return rows.map(row => row.map(core.csvCell).join(","));
  }
  function exportCSV() {
    if (!comparison) return;
    const url = URL.createObjectURL(new Blob(["﻿" + csvLines().join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `lsa-progress-${before.reporting_date}-to-${after.reporting_date}.csv`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function openExport() {
    if (!comparison) return;
    SitePanel.open({
      title: "Share this comparison",
      closeLabel: "Close share panel",
      build(body) {
        const draw = () => {
          const text = exportTab === "csv" ? csvLines().join("\n") : summary();
          body.innerHTML = `
            <p class="muted" style="margin:0">Everything you share carries the dates, filters, matched-site count and caveats, so numbers can’t travel without context.</p>
            <div class="seg" role="group" aria-label="Format">
              <button type="button" data-export-tab="summary" aria-pressed="${exportTab === "summary"}">Summary</button>
              <button type="button" data-export-tab="csv" aria-pressed="${exportTab === "csv"}">CSV of sites</button>
            </div>
            <label for="export-text" style="font-weight:700">${exportTab === "csv" ? "CSV of every site in this comparison" : "Plain-language summary"}</label>
            <textarea id="export-text" class="export-text" readonly></textarea>
            <div class="pill-row">
              <button type="button" class="btn btn-primary" id="copy-summary">${exportTab === "csv" ? "Copy CSV" : "Copy summary"}</button>
              <button type="button" class="btn" id="panel-download">Download CSV</button>
              <button type="button" class="btn" id="print-report">Print report</button>
              <span id="copy-result" role="status" aria-live="polite" style="font-weight:600;color:var(--good)"></span>
            </div>`;
          body.querySelector("#export-text").value = text;
          body.querySelectorAll("[data-export-tab]").forEach(b => b.addEventListener("click", () => { exportTab = b.dataset.exportTab; draw(); body.querySelector(`[data-export-tab="${exportTab}"]`).focus(); }));
          body.querySelector("#copy-summary").addEventListener("click", async () => {
            try { await navigator.clipboard.writeText(text); body.querySelector("#copy-result").textContent = "Copied to clipboard."; }
            catch { body.querySelector("#copy-result").textContent = "Copy is blocked in this browser. Select the text above and copy it instead."; }
          });
          body.querySelector("#panel-download").addEventListener("click", exportCSV);
          body.querySelector("#print-report").addEventListener("click", () => { SitePanel.close(); setTimeout(() => window.print(), 50); });
        };
        draw();
      },
    });
  }

  // ------------------------------------------------------------ start
  async function start() {
    try {
      const [index, departments, status] = await Promise.all([client.load("history/index"), client.load("departments"), client.load("refresh-status")]);
      if (index.schema_version !== 1) throw new Error("Unsupported history schema.");
      entries = core.daily(index.entries); mapping = departments;
      if (!entries.length) { el("load-status").textContent = "No snapshots have been saved yet."; return; }
      toE = entries.at(-1);
      el("latest-date").textContent = longDate(toE.date);
      const warning = client.freshness(toE, status);
      el("refresh-warning").textContent = warning; el("refresh-warning").hidden = !warning;
      el("refresh-meta").textContent = `Latest snapshot pulled ${toE.generated_at}. Siteimprove data is pulled every night at 2 a.m. Detroit time.`;
      if (/^https:\/\//.test(status.run_url || "")) {
        const link = document.createElement("a"); link.href = status.run_url; link.textContent = " See the latest refresh run.";
        el("refresh-meta").append(link);
      }
      setTab(location.hash.slice(1));
      SiteSearch.init({
        sites: () => (comparison ? comparison.rows : []).map(row => {
          const s = row.after || row.before, t = row.after?.eligible ? row.after.target_percentage : null;
          return {
            label: s.site_name || s.url, sub: [s.url, row.platform, row.department, ready(row.after) ? "Ready for manual testing" : ""].filter(Boolean).join(" · "),
            pill: t === null ? "No score" : pct(t), pillClass: t === null ? "pill-flat" : t >= 95 ? "pill-good" : "pill-bad",
            search: `${s.site_name || ""} ${s.url || ""}`.toLowerCase(),
            run: () => { search = s.site_name || s.url; siteFilter = "all"; render(); setTab("sites"); el("sites-heading").focus(); },
          };
        }).sort((a, b) => a.label.localeCompare(b.label)),
        actions: () => [
          { label: "Compare with last week", run: () => choosePeriod("week") },
          { label: "Compare with last month", run: () => choosePeriod("month") },
          { label: "Show departments", run: () => setTab("departments", true) },
          { label: "Show sites that slipped", run: () => { siteFilter = "slipped"; render(); setTab("sites", true); } },
          { label: "Show WordPress sites that reached 98%", run: () => { siteFilter = "up"; render(); setTab("sites", true); } },
          { label: "Share or export this comparison", run: openExport },
          { label: "Clear search and filters", run: () => { platforms.clear(); tags.clear(); department = ""; search = ""; siteFilter = "all"; render(); } },
          { label: "Go to the live snapshot", run: () => { location.href = "data.html"; } },
        ],
      });
      await choosePeriod("month");
    } catch (failure) {
      el("load-status").textContent = "";
      error(`${failure.message}. Nothing has been made up: history must be collected or imported before progress can be shown.`);
    }
  }

  // ------------------------------------------------------------ events
  document.addEventListener("DOMContentLoaded", () => {
    el("from-btn").addEventListener("click", () => openPicker("from"));
    el("to-btn").addEventListener("click", () => openPicker("to"));
    el("date-picker").addEventListener("click", e => {
      const day = e.target.closest("button[data-date]");
      if (day) {
        const entry = entries.find(x => x.date === day.dataset.date);
        if (picker === "from") fromE = entry; else toE = entry;
        period = "custom";
        el("date-note").textContent = "";
        closePicker();
        loadComparison();
        return;
      }
      if (e.target.closest("#cal-prev")) shiftMonth(-1);
      else if (e.target.closest("#cal-next")) shiftMonth(1);
      else if (e.target.closest("#cal-close")) closePicker();
    });
    el("date-picker").addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); closePicker(); } });
    el("shortcuts").addEventListener("click", e => { const b = e.target.closest("button[data-period]"); if (b) choosePeriod(b.dataset.period); });
    el("filter-platform").addEventListener("click", e => {
      const b = e.target.closest("button[data-platform]");
      if (!b) return;
      const p = b.dataset.platform;
      if (!p) platforms.clear(); else if (platforms.has(p)) platforms.delete(p); else platforms.add(p);
      showAllSites = false;
      render();
    });
    el("search").addEventListener("input", e => { search = e.target.value; showAllSites = false; render(); });
    el("active-filter-chips").addEventListener("click", e => {
      const b = e.target.closest("button[data-index]");
      if (!b) return;
      const item = el("active-filters")._items[Number(b.dataset.index)];
      if (item) { item[1](); render(); el("search").focus(); }
    });
    const clearAll = () => { platforms.clear(); tags.clear(); department = ""; search = ""; siteFilter = "all"; render(); };
    el("clear-filters").addEventListener("click", clearAll);
    document.querySelector(".site-subnav__inner").addEventListener("click", e => { const b = e.target.closest(".tab[data-tab]"); if (b) setTab(b.dataset.tab); });
    window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));
    el("not-comparable").addEventListener("click", e => {
      if (!e.target.closest("#use-first-comparable")) return;
      fromE = entries.find(comparable); period = "custom"; loadComparison();
    });
    el("trend-body").addEventListener("click", e => {
      const b = e.target.closest("button[data-start-index]");
      if (!b) return;
      fromE = entries[Number(b.dataset.startIndex)]; period = "custom"; el("date-note").textContent = ""; loadComparison();
    });
    el("trend-plot").addEventListener("click", e => {
      const b = e.target.closest("[data-index]");
      if (!b) return;
      const entry = entries[Number(b.dataset.index)];
      if (!comparable(entry) || entry.date >= toE.date) return;
      fromE = entry; period = "custom"; el("date-note").textContent = ""; loadComparison();
    });
    el("trend-metric").addEventListener("click", e => { const b = e.target.closest("button[data-metric]"); if (b) { trendMetric = b.dataset.metric; renderTrend(); } });
    el("step-earlier").addEventListener("click", () => {
      const options = entries.filter(x => comparable(x) && x.date < fromE.date);
      if (options.length) { fromE = options.at(-1); period = "custom"; loadComparison(); }
    });
    el("step-later").addEventListener("click", () => {
      const next = entries.find(x => comparable(x) && x.date > fromE.date && x.date < toE.date);
      if (next) { fromE = next; period = "custom"; loadComparison(); }
    });
    el("toggle-trend-table").addEventListener("click", () => {
      const wrap = el("trend-table-wrap"), open = wrap.hidden;
      wrap.hidden = !open;
      el("toggle-trend-table").setAttribute("aria-expanded", String(open));
      el("toggle-trend-table").textContent = open ? "Hide data table" : "Show data as a table";
    });
    document.addEventListener("click", e => {
      const f = e.target.closest("[data-site-filter]");
      if (f) { siteFilter = f.dataset.siteFilter; showAllSites = false; render(); if (tab !== "sites") { setTab("sites"); el("sites-heading").focus(); } return; }
      const d = e.target.closest("[data-department]");
      if (d) { department = d.dataset.department; siteFilter = "all"; render(); setTab("sites"); el("sites-heading").focus(); return; }
      if (e.target.closest("#clear-from-table")) clearAll();
    });
    document.querySelectorAll("th[data-sort]").forEach(header => header.querySelector("button").addEventListener("click", () => {
      direction = sort === header.dataset.sort ? -direction : 1;
      sort = header.dataset.sort;
      if (comparison) renderSites();
    }));
    el("sites-show-all").addEventListener("click", () => { showAllSites = true; renderSites(); });
    el("export-csv").addEventListener("click", exportCSV);
    el("open-export").addEventListener("click", openExport);
    let printDetails = [];
    window.addEventListener("beforeprint", () => {
      printDetails = [...document.querySelectorAll("details")].map(detail => [detail, detail.open]);
      for (const [detail] of printDetails) detail.open = true;
    });
    window.addEventListener("afterprint", () => { for (const [detail, open] of printDetails) detail.open = open; });
    client.start(start);
  });
})();
