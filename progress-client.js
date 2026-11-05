(function () {
  "use strict";
  const passwordKey = "lsa-dashboard-password";
  let key = null, encrypted = true;
  const bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
  const local = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  async function decode(data, compression) {
    if (compression) {
      if (compression !== "gzip" || !globalThis.DecompressionStream) throw new Error("This history requires a browser with gzip decompression support.");
      data = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    }
    return JSON.parse(new TextDecoder().decode(data));
  }
  async function decrypt(cryptoKey, payload) {
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(payload.iv) }, cryptoKey, bytes(payload.ct));
    return decode(data, payload.compression);
  }
  async function request(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) {
      const error = new Error(`Unable to load ${url}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  }
  async function load(name) {
    if (!/^(?:history\/)?[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid data resource");
    if (encrypted) return decrypt(key, await (await request(`data/${name}.enc.json`)).json());
    const compressed = name.startsWith("history/") && name !== "history/index";
    return decode(await (await request(`data/${name}${compressed ? ".json.gz" : ".json"}`)).arrayBuffer(), compressed ? "gzip" : "");
  }
  async function start(onReady) {
    const form = document.getElementById("gate-form");
    const error = document.getElementById("gate-error");
    let payload;
    try {
      payload = await (await request("data/sites.enc.json")).json();
    } catch (failure) {
      if (local() && failure.status === 404) {
        encrypted = false;
        document.body.classList.remove("locked");
        await onReady();
      } else error.textContent = failure.message;
      return;
    }
    async function unlock(password) {
      const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
      const candidate = await crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt: bytes(payload.salt), iterations: payload.iterations },
        base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      await decrypt(candidate, payload);
      key = candidate;
      try { sessionStorage.setItem(passwordKey, password); } catch { /* Storage may be disabled. */ }
      document.body.classList.remove("locked");
    }
    let saved;
    try { saved = sessionStorage.getItem(passwordKey); } catch { /* Storage may be disabled. */ }
    if (saved) {
      try { await unlock(saved); } catch { error.textContent = "Saved password could not unlock this deployment. Enter the current password."; }
      if (key) { await onReady(); return; }
    }
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const button = form.querySelector("button");
      button.disabled = true;
      error.textContent = "";
      try { await unlock(form.elements.password.value); }
      catch { error.textContent = "Unable to decrypt this dashboard. Check the password and try again."; }
      finally { button.disabled = false; }
      if (key) await onReady();
    });
    form.elements.password.focus();
  }
  function freshness(latest, status) {
    if (status.historical_only) return "Historical import only. The new daily refresh has not run yet; collection gaps are preserved.";
    if (!status.success) return "The latest refresh failed. Showing the last successful observation; no snapshot was created for the failed attempt.";
    if (Date.now() - new Date(latest.generated_at).getTime() > 30 * 60 * 60 * 1000)
      return "Data is overdue: the last successful observation is more than 30 hours old. Collection time is not scan time.";
    return "";
  }
  window.ProgressClient = { load, start, decrypt, decode, freshness };
})();
