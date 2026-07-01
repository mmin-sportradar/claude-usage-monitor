// Claude Usage Monitor — content script (isolated world, runs on claude.ai).
// Responsibilities:
//   1. Inject the MAIN-world hook (injected.js) and relay captured usage to bg.
//   2. Provide same-origin authenticated fetchUsage() on demand.
//   3. Render the animated in-page toast when the background asks.

(function () {
  console.log("[CUM] content.js loaded @", location.href);
  // Remember the endpoints the app actually used, so we can re-fetch them later.
  let discoveredUsageUrl = null;
  let discoveredSpendUrl = null;

  const PATH_BLOCK = /growthbook|feature|flag|experiment|statsig|segment|variant|ab_?test|launchdarkly/i;

  function scanNumbers(obj, path, out, depth) {
    if (!obj || typeof obj !== "object" || depth > 7 || out.length >= 600) return out;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      const p = path ? path + "." + k : k;
      if (PATH_BLOCK.test(p)) continue;
      if (typeof v === "number" && isFinite(v)) out.push({ path: p, value: v });
      else if (v && typeof v === "object") scanNumbers(v, p, out, depth + 1);
    }
    return out;
  }

  // --- 1. relay usage captured by the MAIN-world hook (injected.js) ------
  // injected.js is registered as a MAIN-world content script in the manifest
  // (run_at document_start) so it hooks fetch/XHR before the app uses them,
  // without tripping claude.ai's CSP.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== "cum-injected") return;
    if (msg.kind === "usage") {
      console.log("[CUM] content: relaying captured usage ->", msg.url);
      if (msg.url && /usage/i.test(msg.url)) discoveredUsageUrl = msg.url;
      chrome.runtime.sendMessage({ type: "USAGE_CAPTURED", data: msg.data }).catch(() => {});
    } else if (msg.kind === "fields" && msg.fields && msg.fields.length) {
      if (msg.url) discoveredSpendUrl = msg.url;
      chrome.runtime
        .sendMessage({ type: "NUMBERS_CAPTURED", fields: msg.fields, url: msg.url || "" })
        .catch(() => {});
    }
  });

  // --- 2. same-origin fetch ----------------------------------------------
  const JSON_HEADERS = { accept: "application/json, text/plain, */*" };

  async function tryJson(url) {
    try {
      const res = await fetch(url, { credentials: "include", headers: JSON_HEADERS });
      console.log("[CUM] content: GET", url, "->", res.status);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.warn("[CUM] content: GET", url, "FAILED", e && e.message);
      return null;
    }
  }

  function usageShaped(obj) {
    return obj && typeof obj === "object" &&
      (obj.five_hour || obj.seven_day || obj.seven_day_opus);
  }

  async function getOrgId() {
    const orgs = await tryJson("/api/organizations");
    if (Array.isArray(orgs) && orgs.length) {
      // Prefer an org that actually has a chat/claude capability, else first.
      const chat = orgs.find(
        (o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat")
      );
      return (chat || orgs[0]).uuid;
    }
    return null;
  }

  async function fetchUsage() {
    // Best: re-hit the exact endpoint the app used, if we've seen it.
    if (discoveredUsageUrl) {
      const obj = await tryJson(discoveredUsageUrl);
      if (usageShaped(obj)) return obj;
    }

    // Otherwise try known candidate endpoints (same-origin, cookies attached).
    const orgId = await getOrgId();
    const candidates = [];
    if (orgId) {
      candidates.push(`/api/organizations/${orgId}/usage`);
      candidates.push(`/api/organizations/${orgId}/usage_limits`);
    }
    candidates.push("/api/usage");
    candidates.push("/api/bootstrap");

    for (const url of candidates) {
      const obj = await tryJson(url);
      if (usageShaped(obj)) return obj;
      // bootstrap-style payloads may nest the usage object
      if (obj && typeof obj === "object") {
        for (const v of Object.values(obj)) {
          if (usageShaped(v)) return v;
        }
      }
    }
    return null;
  }

  // Proactively fetch billing/usage endpoints (same-origin) and extract numbers,
  // so the spend populates without the user visiting any page.
  async function fetchSpend() {
    const urls = [];
    if (discoveredSpendUrl) urls.push(discoveredSpendUrl);
    const org = await getOrgId();
    if (org) {
      const base = `/api/organizations/${org}`;
      urls.push(
        `${base}/usage`,
        `${base}/billing`,
        `${base}/extra_usage`,
        `${base}/credits`,
        `${base}/credit`,
        `${base}/settings`,
        `${base}/subscription`
      );
    }
    let all = [];
    const seen = new Set();
    for (const u of urls) {
      const obj = await tryJson(u);
      if (!obj) continue;
      for (const f of scanNumbers(obj, "", [], 0)) {
        if (!seen.has(f.path)) { seen.add(f.path); all.push(f); }
      }
    }
    return all.length ? { fields: all, url: discoveredSpendUrl || urls[0] } : null;
  }

  // --- 3. messaging from background --------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "FETCH_USAGE") {
      console.log("[CUM] content: FETCH_USAGE received, fetching same-origin…");
      // Opportunistically refresh spend too (fire-and-forget).
      fetchSpend()
        .then((s) => {
          if (s) chrome.runtime.sendMessage({ type: "NUMBERS_CAPTURED", fields: s.fields, url: s.url }).catch(() => {});
        })
        .catch(() => {});
      fetchUsage()
        .then((data) => {
          console.log("[CUM] content: fetchUsage result:", data ? "USAGE FOUND" : "null (no usage-shaped response)", data);
          sendResponse(data);
        })
        .catch((e) => {
          console.warn("[CUM] content: fetchUsage threw", e);
          sendResponse(null);
        });
      return true; // async
    }
    if (msg.type === "SHOW_TOAST" && msg.payload) {
      showToast(msg.payload);
    }
  });

  // --- toast (shadow DOM, fully isolated) --------------------------------
  let toastHost = null;

  function ensureHost() {
    if (toastHost && document.body.contains(toastHost)) return toastHost.shadowRoot;
    toastHost = document.createElement("div");
    toastHost.id = "cum-toast-host";
    // Keep the host out of the page's layout/stacking influence.
    toastHost.style.cssText =
      "position:fixed;top:0;right:0;z-index:2147483647;pointer-events:none;";
    const root = toastHost.attachShadow({ mode: "open" });
    root.innerHTML = TOAST_CSS + '<div id="stack"></div>';
    (document.body || document.documentElement).appendChild(toastHost);
    return root;
  }

  function showToast({ label, pct, resets_at }) {
    const root = ensureHost();
    const stack = root.getElementById("stack");

    const critical = pct >= 90;
    const card = document.createElement("div");
    card.className = "toast " + (critical ? "crit" : "warn");

    const reset = resetText(resets_at);
    card.innerHTML = `
      <div class="accent"></div>
      <button class="close" aria-label="Dismiss">&times;</button>
      <div class="body">
        <div class="row">
          <span class="spark">${critical ? "&#9888;" : "&#9889;"}</span>
          <span class="title">Claude ${escapeHtml(label)} usage</span>
        </div>
        <div class="pct">${pct}%</div>
        <div class="bar"><div class="fill"></div></div>
        ${reset ? `<div class="reset">Resets ${escapeHtml(reset)}</div>` : ""}
      </div>`;

    stack.appendChild(card);

    // Trigger enter + bar animations on next frame.
    requestAnimationFrame(() => {
      card.classList.add("in");
      const fill = card.querySelector(".fill");
      if (fill) fill.style.width = Math.min(100, pct) + "%";
    });

    const dismiss = () => {
      card.classList.remove("in");
      card.classList.add("out");
      setTimeout(() => card.remove(), 450);
    };
    card.querySelector(".close").addEventListener("click", dismiss);
    setTimeout(dismiss, 9000);
  }

  function resetText(iso) {
    if (!iso) return "";
    const ts = Date.parse(iso);
    if (isNaN(ts)) return "";
    const diff = ts - Date.now();
    if (diff <= 0) return "soon";
    const m = Math.round(diff / 60000);
    if (m < 60) return `in ${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `in ${h} h`;
    return `in ${Math.round(h / 24)} d`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  const TOAST_CSS = `<style>
    :host { all: initial; }
    #stack {
      position: fixed; top: 18px; right: 18px;
      display: flex; flex-direction: column; gap: 12px;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .toast {
      position: relative; width: 300px; pointer-events: auto;
      background: linear-gradient(180deg, #201c18 0%, #17130f 100%);
      color: #f5efe7; border: 1px solid rgba(255,255,255,0.08);
      border-radius: 14px; overflow: hidden;
      box-shadow: 0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.2);
      transform: translateX(120%); opacity: 0;
      transition: transform .5s cubic-bezier(.16,1,.3,1), opacity .4s ease;
    }
    .toast.in  { transform: translateX(0); opacity: 1; }
    .toast.out { transform: translateX(120%); opacity: 0; }
    .accent {
      position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
      background: #f59e0b;
    }
    .toast.crit .accent { background: #ef4444; }
    .toast.warn { animation: cum-glow-w 2.4s ease-in-out infinite; }
    .toast.crit { animation: cum-glow-c 1.8s ease-in-out infinite; }
    @keyframes cum-glow-w {
      0%,100% { box-shadow: 0 12px 40px rgba(0,0,0,.45), 0 0 0 1px rgba(245,158,11,.15); }
      50%     { box-shadow: 0 12px 44px rgba(0,0,0,.5), 0 0 22px 2px rgba(245,158,11,.35); }
    }
    @keyframes cum-glow-c {
      0%,100% { box-shadow: 0 12px 40px rgba(0,0,0,.45), 0 0 0 1px rgba(239,68,68,.2); }
      50%     { box-shadow: 0 12px 48px rgba(0,0,0,.55), 0 0 26px 3px rgba(239,68,68,.45); }
    }
    .body { padding: 14px 16px 16px 20px; }
    .row { display: flex; align-items: center; gap: 8px; }
    .spark { font-size: 15px; }
    .title { font-size: 13px; font-weight: 600; letter-spacing: .2px; color: #e8ddce; }
    .pct { font-size: 30px; font-weight: 700; margin: 4px 0 10px; line-height: 1; }
    .toast.warn .pct { color: #fbbf24; }
    .toast.crit .pct { color: #f87171; }
    .bar {
      height: 7px; border-radius: 99px; background: rgba(255,255,255,0.1);
      overflow: hidden;
    }
    .fill {
      height: 100%; width: 0%; border-radius: 99px;
      background: linear-gradient(90deg, #f59e0b, #ef4444);
      transition: width 1s cubic-bezier(.16,1,.3,1);
    }
    .toast.warn .fill { background: linear-gradient(90deg, #fbbf24, #f59e0b); }
    .reset { margin-top: 9px; font-size: 11.5px; color: #b9ab98; }
    .close {
      position: absolute; top: 8px; right: 10px;
      background: none; border: none; color: #9a8d7b;
      font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 5px;
      border-radius: 6px;
    }
    .close:hover { color: #fff; background: rgba(255,255,255,0.08); }
    @media (prefers-reduced-motion: reduce) {
      .toast { transition: opacity .2s ease; transform: none; }
      .toast.in { transform: none; } .toast.out { transform: none; }
      .toast.warn, .toast.crit { animation: none; }
      .fill { transition: none; }
    }
  </style>`;
})();
