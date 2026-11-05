(function () {
  "use strict";
  let resources, generation = 0;
  const snapshots = new Map();
  async function render(load, filter) {
    const token = ++generation, target = document.getElementById("progress-widget-content");
    if (!target) return;
    const link = document.getElementById("progress-link"), query = new URLSearchParams();
    for (const value of filter.platforms) query.append("platform", value);
    for (const value of filter.tags) query.append("tag", value);
    if (filter.search) query.set("search", filter.search);
    link.href = "progress.html?" + query;
    try {
      if (!resources) resources = Promise.all([load("history/index"), load("departments"), load("refresh-status")]).catch(failure => { resources = null; throw failure; });
      const [index, mapping, status] = await resources;
      if (token !== generation) return;
      const dates = ProgressCore.daily(index.entries), latest = dates.at(-1);
      if (!latest) throw new Error("No saved observations yet.");
      const earlier = ProgressCore.baseline(dates, latest, "month");
      const warning = ProgressClient.freshness(latest, status);
      if (!earlier) { target.textContent = `${warning} No month-earlier observation yet. Open progress reporting to select two available dates.`; return; }
      const get = entry => {
        if (!snapshots.has(entry.path)) snapshots.set(entry.path, load(entry.path.replace(/\.json\.gz$/, "")).catch(failure => { snapshots.delete(entry.path); throw failure; }));
        return snapshots.get(entry.path);
      };
      const [before, after] = await Promise.all([get(earlier), get(latest)]);
      if (token !== generation) return;
      const result = ProgressCore.compare(before, after, mapping, filter), change = result.headline_occurrences.change;
      target.textContent = `${earlier.date} → ${latest.date}: ${result.matched} matched reliable target sites; mean target change ${result.target.change === null ? "unavailable" : result.target.change.toFixed(2) + " pp"}; occurrence net change ${change === null ? "unavailable (no verified comparable issue cohort)" : (change > 0 ? "+" : "") + change.toLocaleString()}. ${warning}`;
    } catch (failure) {
      if (token === generation) target.textContent = `Progress history unavailable: ${failure.message}`;
    }
  }
  window.ProgressWidget = { render };
})();
