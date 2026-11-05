// "Change over the last month" strip on the live snapshot page. Compares the
// latest saved snapshot with the one a month earlier using ProgressCore, for
// the same platform/label/search filters, and links to the progress page.
(function () {
  "use strict";
  let resources, generation = 0;
  const snapshots = new Map();
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const longDate = d => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function pill(value, goodWhenUp, up, down, same) {
    if (value === null || value === undefined) return "";
    if (value === 0) return `<span class="pill pill-flat">${esc(same)}</span>`;
    const better = (value > 0) === goodWhenUp;
    return `<span class="pill ${better ? "pill-good" : "pill-bad"}">${value > 0 ? "↑" : "↓"} ${esc(value > 0 ? up : down)} (${better ? "better" : "worse"})</span>`;
  }

  async function render(load, filter) {
    const token = ++generation, target = document.getElementById("progress-widget-content");
    if (!target) return;
    const heading = document.getElementById("progress-widget-heading");
    const link = document.getElementById("progress-link"), query = new URLSearchParams();
    for (const value of filter.platforms) query.append("platform", value);
    for (const value of filter.tags) query.append("tag", value);
    if (filter.search) query.set("search", filter.search);
    if (link) link.href = "progress.html" + (String(query) ? "?" + query : "");
    try {
      if (!resources) resources = Promise.all([load("history/index"), load("departments"), load("refresh-status")]).catch(failure => { resources = null; throw failure; });
      const [index, mapping, status] = await resources;
      if (token !== generation) return;
      const dates = ProgressCore.daily(index.entries), latest = dates.at(-1);
      if (!latest) throw new Error("No saved snapshots yet.");
      // Compare with a month ago; if that snapshot isn't reliable (an older
      // import without scan quality details), use the first reliable one.
      const reliable = e => !!e && e.eligible_count > 0;
      let earlier = ProgressCore.baseline(dates, latest, "month"), fallback = false;
      if (!reliable(earlier)) {
        earlier = dates.find(e => reliable(e) && e.date < latest.date) || null;
        fallback = !!earlier;
      }
      const warning = ProgressClient.freshness(latest, status);
      if (!earlier) {
        if (heading) heading.textContent = "Change over time";
        target.textContent = `${warning} Changes appear once two reliable snapshots exist.`.trim();
        return;
      }
      const get = entry => {
        if (!snapshots.has(entry.path)) snapshots.set(entry.path, load(entry.path.replace(/\.json\.gz$/, "")).catch(failure => { snapshots.delete(entry.path); throw failure; }));
        return snapshots.get(entry.path);
      };
      const [before, after] = await Promise.all([get(earlier), get(latest)]);
      if (token !== generation) return;
      const r = ProgressCore.compare(before, after, mapping, filter);
      if (heading) heading.textContent = `Change since ${longDate(earlier.date)}${fallback ? " (first reliable data)" : ""}`;
      if (!r.matched) {
        target.innerHTML = `<span>No sites have reliable data on both dates yet.</span>${warning ? ` <span class="muted">${esc(warning)}</span>` : ""}`;
        return;
      }
      const net = r.newly_ready === null ? null : r.newly_ready - r.regressed;
      const pp = r.target.change === null ? null : Number(r.target.change.toFixed(2));
      const occ = r.headline_occurrences, occPct = occ.change === null || !occ.before ? null : Number((occ.change / occ.before * 100).toFixed(1));
      target.innerHTML = [
        pill(net, true, `${net} more site${net === 1 ? "" : "s"} ready for manual testing`, `${Math.abs(net || 0)} fewer site${net === -1 ? "" : "s"} ready for manual testing`, "Same number of sites ready for manual testing"),
        pill(pp, true, `Average score up ${Math.abs(pp || 0)} points`, `Average score down ${Math.abs(pp || 0)} points`, "Average score unchanged"),
        pill(occPct, false, `${Math.abs(occPct || 0)}% more issues found`, `${Math.abs(occPct || 0)}% fewer issues found`, "Same number of issues found"),
        `<span class="muted">Based on ${r.matched.toLocaleString("en-US")} matched sites.${warning ? " " + esc(warning) : ""}</span>`,
      ].join(" ");
    } catch (failure) {
      if (token === generation) target.textContent = `Progress history is unavailable: ${failure.message}`;
    }
  }
  window.ProgressWidget = { render };
})();
