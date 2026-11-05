// Accessible side panel used for site details and the share/export panel.
// Opens from the right, keeps keyboard focus inside, closes on Escape, on the
// close button (pinned top right) or on a click outside, then returns focus.
(function () {
  "use strict";
  let current = null;

  function focusable(root) {
    return [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])')]
      .filter(el => el.offsetParent !== null || el === document.activeElement);
  }

  function close() {
    if (!current) return;
    const { overlay, opener, onClose } = current;
    current = null;
    overlay.remove();
    document.body.style.overflow = "";
    if (typeof onClose === "function") onClose();
    if (opener && document.contains(opener) && opener.focus) opener.focus();
  }

  // opts: { title, label (for the close button), build(bodyEl, headExtraEl), onClose }
  function open(opts) {
    close();
    const opener = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "overlay overlay--side no-print";
    const panel = document.createElement("div");
    panel.className = "side-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const titleId = "panel-title-" + Math.random().toString(36).slice(2, 8);
    panel.setAttribute("aria-labelledby", titleId);

    const head = document.createElement("div");
    head.className = "side-panel__head";
    const headText = document.createElement("div");
    headText.style.minWidth = "0";
    const h = document.createElement("h2");
    h.id = titleId;
    h.textContent = opts.title || "";
    headText.appendChild(h);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "close-btn";
    closeBtn.setAttribute("aria-label", opts.closeLabel || "Close");
    closeBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    closeBtn.addEventListener("click", close);
    head.append(headText, closeBtn);

    const body = document.createElement("div");
    body.className = "side-panel__body";
    panel.append(head, body);
    overlay.appendChild(panel);
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    panel.addEventListener("keydown", e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return;
      const items = focusable(panel);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    if (typeof opts.build === "function") opts.build(body, headText);
    document.body.appendChild(overlay);
    document.body.style.overflow = "hidden";
    current = { overlay, opener, onClose: opts.onClose };
    closeBtn.focus();
    return { close, body };
  }

  window.SitePanel = { open, close, isOpen: () => !!current };
})();
