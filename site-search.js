// Site search shared by both dashboard pages. Opens from any
// [data-open-search] button or with Ctrl+K / Cmd+K, lists matching sites and
// quick actions, and is driven with the arrow keys, Enter and Escape.
(function () {
  "use strict";
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  const shortcut = isMac ? "⌘K" : "Ctrl+K";
  let config = null, overlay = null, input = null, results = null, status = null;
  let items = [], index = 0, opener = null;

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "className") node.className = v; else node.setAttribute(k, v);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function build() {
    overlay = el("div", { className: "overlay overlay--center no-print", hidden: "" });
    const dialog = el("div", { className: "search-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Search sites" });
    const bar = el("div", { className: "search-dialog__bar" });
    bar.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3F4A58" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
    const label = el("label", { for: "site-search-input", className: "sr-only" }, "Search sites");
    input = el("input", { id: "site-search-input", type: "text", autocomplete: "off", placeholder: "Type a site name or web address", "aria-describedby": "site-search-help", "aria-controls": "site-search-results" });
    const esc = el("button", { type: "button", className: "btn" }, "Esc");
    esc.appendChild(el("span", { className: "sr-only" }, " close"));
    esc.addEventListener("click", close);
    bar.append(label, input, esc);
    const help = el("p", { id: "site-search-help", className: "sr-only" }, "Use the up and down arrow keys to highlight a result, Enter to open it, Escape to close.");
    results = el("div", { id: "site-search-results", className: "search-dialog__results" });
    const foot = el("div", { className: "search-dialog__foot" });
    foot.innerHTML = `<span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span><span>Open anywhere with <kbd>${shortcut}</kbd></span>`;
    status = el("p", { className: "sr-only", "aria-live": "polite" });
    dialog.append(bar, help, results, foot, status);
    overlay.appendChild(dialog);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    input.addEventListener("input", () => { index = 0; render(); });
    input.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
  }

  function onKey(e) {
    if (e.key === "ArrowDown") { e.preventDefault(); if (items.length) { index = (index + 1) % items.length; highlight(); } }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (items.length) { index = (index - 1 + items.length) % items.length; highlight(); } }
    else if (e.key === "Enter") { e.preventDefault(); run(index); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { e.preventDefault(); input.focus(); }
  }

  function run(i) {
    const item = items[i];
    if (!item) return;
    close(false);
    item.run();
  }

  function highlight() {
    results.querySelectorAll(".search-opt").forEach((b, i) => b.setAttribute("aria-current", i === index ? "true" : "false"));
    const active = results.querySelectorAll(".search-opt")[index];
    if (active) active.scrollIntoView({ block: "nearest" });
    const item = items[index];
    status.textContent = items.length ? `${items.length} results. Highlighted: ${item.label}` : "No results";
  }

  function section(title, list, offset) {
    if (!list.length) return;
    results.appendChild(el("h3", {}, title));
    const ul = el("ul");
    list.forEach((item, i) => {
      const li = el("li");
      const b = el("button", { type: "button", className: "search-opt", "aria-current": "false" });
      const text = el("span", { style: "flex:1;min-width:0" });
      text.appendChild(el("strong", {}, item.label));
      if (item.sub) text.appendChild(el("span", { className: "sub" }, item.sub));
      b.appendChild(text);
      if (item.pill) b.appendChild(el("span", { className: "pill " + (item.pillClass || "pill-flat") }, item.pill));
      b.addEventListener("click", () => run(offset + i));
      li.appendChild(b);
      ul.appendChild(li);
    });
    results.appendChild(ul);
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    const sites = (config.sites() || []).filter(s => !q || s.search.includes(q)).slice(0, 7);
    const actions = (config.actions ? config.actions() : []).filter(a => !q || a.label.toLowerCase().includes(q)).slice(0, q ? 5 : 4);
    items = sites.concat(actions);
    results.textContent = "";
    if (!items.length) {
      results.appendChild(el("p", { className: "empty" }, `No sites or actions match “${input.value}”.`));
    } else {
      section("Sites", sites, 0);
      section("Actions", actions, sites.length);
    }
    index = Math.min(index, Math.max(0, items.length - 1));
    highlight();
  }

  function open() {
    if (!config) return;
    if (!overlay) build();
    opener = document.activeElement;
    overlay.hidden = false;
    input.value = "";
    index = 0;
    render();
    input.focus();
  }

  function close(restore = true) {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    if (restore && opener && document.contains(opener) && opener.focus) opener.focus();
  }

  // cfg: { sites: () => [{label, sub, pill, pillClass, search, run}], actions: () => [{label, run}] }
  function init(cfg) {
    config = cfg;
    document.querySelectorAll("[data-open-search]").forEach(b => {
      b.addEventListener("click", open);
      const k = b.querySelector("kbd");
      if (k) k.textContent = shortcut;
      b.setAttribute("aria-keyshortcuts", "Control+K Meta+K");
    });
    document.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
        if (document.body.classList.contains("locked")) return;
        e.preventDefault();
        if (overlay && !overlay.hidden) close(); else open();
      }
    });
  }

  window.SiteSearch = { init, open, close, shortcut };
})();
