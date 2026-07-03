// Claude Usage Monitor — background service worker
// Coordinates polling, storage, the toolbar badge, and threshold notifications.

const DEFAULT_SETTINGS = {
  threshold: 80,          // percent
  watchSession: true,     // 5-hour window
  watchWeekly: true,      // 7-day window
  enableNative: true,     // native Chrome notification
  enableToast: true,      // in-page animated toast
};

const REFRESH_ALARM = "cum-refresh";
const REFRESH_MINUTES = 1;

// ---- settings helpers -------------------------------------------------------

async function getSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

// ---- lifecycle --------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get("settings");
  if (!stored.settings) {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  }
  ensureAlarm();
  refreshUsage();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshUsage();
});

function ensureAlarm() {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_MINUTES });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) refreshUsage();
});

// ---- messaging --------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "USAGE_CAPTURED" && msg.data) {
    // The page's own fetch was intercepted by injected.js and forwarded here.
    handleUsage(msg.data);
    return;
  }

  if (msg.type === "NUMBERS_CAPTURED" && msg.fields && msg.fields.length) {
    mergeFields(msg.fields);
    return;
  }

  if (msg.type === "GET_STATE") {
    (async () => {
      const [{ usage, updatedAt, fieldMap }, settings] = await Promise.all([
        chrome.storage.local.get(["usage", "updatedAt", "fieldMap"]),
        getSettings(),
      ]);
      const fields = Object.entries(fieldMap || {}).map(([path, value]) => ({ path, value }));
      sendResponse({
        usage: usage || null,
        updatedAt: updatedAt || null,
        fields,
        settings,
      });
    })();
    return true; // async response
  }

  if (msg.type === "REQUEST_REFRESH") {
    (async () => {
      const data = await refreshUsage();
      sendResponse({ ok: !!data });
    })();
    return true;
  }
});

// React to settings changes immediately (re-evaluate badge & thresholds).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.settings) {
    reevaluate();
  }
});

// ---- direct same-origin fetch (no tab required) -----------------------------
// With host_permissions for claude.ai, the service worker can hit the usage
// endpoints itself using the user's logged-in cookies. This is the primary
// source: the badge/popup then reflect usage from ANY client sharing the pool
// (claude.ai, Desktop, and Claude Code in the terminal) without a claude.ai tab
// open and without a manual refresh.

const CLAUDE_ORIGIN = "https://claude.ai";
const JSON_HEADERS = { accept: "application/json, text/plain, */*" };

async function tryJson(path) {
  try {
    const url = path.startsWith("http") ? path : CLAUDE_ORIGIN + path;
    const res = await fetch(url, { credentials: "include", headers: JSON_HEADERS });
    if (!res.ok) {
      console.log("[CUM] bg: GET", path, "->", res.status);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn("[CUM] bg: GET", path, "FAILED", e && e.message);
    return null;
  }
}

function usageShaped(o) {
  return o && typeof o === "object" && (o.five_hour || o.seven_day || o.seven_day_opus);
}

let cachedOrgId = null;
async function getOrgId() {
  if (cachedOrgId) return cachedOrgId;
  const orgs = await tryJson("/api/organizations");
  if (Array.isArray(orgs) && orgs.length) {
    const chat = orgs.find(
      (o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat")
    );
    cachedOrgId = (chat || orgs[0]).uuid;
  }
  return cachedOrgId;
}

// Fetch usage straight from the worker. Returns usage-shaped data or null
// (null typically means the browser isn't logged into claude.ai).
async function fetchUsageDirect() {
  const orgId = await getOrgId();
  const candidates = [];
  if (orgId) {
    candidates.push(`/api/organizations/${orgId}/usage`);
    candidates.push(`/api/organizations/${orgId}/usage_limits`);
  }
  candidates.push("/api/usage", "/api/bootstrap");

  for (const url of candidates) {
    const obj = await tryJson(url);
    if (usageShaped(obj)) return obj;
    if (obj && typeof obj === "object") {
      for (const v of Object.values(obj)) if (usageShaped(v)) return v;
    }
  }
  return null;
}

// Merge captured numeric fields (spend etc.) into storage, from any source.
async function mergeFields(fields) {
  const { fieldMap = {} } = await chrome.storage.local.get("fieldMap");
  for (const f of fields) fieldMap[f.path] = f.value; // merge by path
  // Cap to keep storage small; keep the most recently seen entries.
  const paths = Object.keys(fieldMap);
  if (paths.length > 800) {
    for (const p of paths.slice(0, paths.length - 800)) delete fieldMap[p];
  }
  await chrome.storage.local.set({ fieldMap, fieldsUpdatedAt: Date.now() });
}

// Feature-flag / config noise that is never real spend — excluded from the scan.
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

// Fetch billing/usage endpoints from the worker and extract numbers, so the
// extra-usage spend populates without a tab open (mirrors content.fetchSpend).
async function refreshSpendDirect() {
  const org = await getOrgId();
  if (!org) return;
  const base = `/api/organizations/${org}`;
  const urls = [
    `${base}/usage`,
    `${base}/billing`,
    `${base}/extra_usage`,
    `${base}/credits`,
    `${base}/credit`,
    `${base}/settings`,
    `${base}/subscription`,
  ];
  const seen = new Set();
  const all = [];
  for (const u of urls) {
    const obj = await tryJson(u);
    if (!obj) continue;
    for (const f of scanNumbers(obj, "", [], 0)) {
      if (!seen.has(f.path)) { seen.add(f.path); all.push(f); }
    }
  }
  if (all.length) await mergeFields(all);
}

// ---- core: fetch, store, badge, notify --------------------------------------

async function refreshUsage() {
  // 1. Direct same-origin fetch from the worker — needs no tab open, so it
  //    keeps the badge current even when you're only in the terminal.
  try {
    const direct = await fetchUsageDirect();
    if (direct && (direct.five_hour || direct.seven_day)) {
      console.log("[CUM] bg: refreshUsage got data via direct fetch");
      await handleUsage(direct);
      refreshSpendDirect().catch(() => {}); // opportunistic, fire-and-forget
      return direct;
    }
    console.log("[CUM] bg: direct fetch returned no usage; trying open tabs");
  } catch (e) {
    console.warn("[CUM] bg: direct fetch failed", e && e.message);
  }

  // 2. Fallback: ask an open claude.ai tab's content script to fetch it in the
  //    page context (covers the case where the worker's own cookies are refused).
  try {
    const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });
    console.log("[CUM] bg: refreshUsage found", tabs.length, "claude.ai tab(s)");
    for (const tab of tabs) {
      try {
        const data = await chrome.tabs.sendMessage(tab.id, { type: "FETCH_USAGE" });
        console.log("[CUM] bg: tab", tab.id, "(discarded=" + tab.discarded + ", status=" + tab.status + ") responded:", data ? "data" : "no data");
        if (data && (data.five_hour || data.seven_day)) {
          await handleUsage(data);
          return data;
        }
      } catch (e) {
        console.warn("[CUM] bg: sendMessage to tab", tab.id, "failed —", e && e.message);
        // content script not ready in this tab; try the next one
      }
    }
  } catch (e) {
    console.warn("[CUM] bg: refresh failed", e);
  }
  return null;
}

function normalize(data) {
  const pick = (w) =>
    w && typeof w.utilization === "number"
      ? { utilization: w.utilization, resets_at: w.resets_at || null }
      : null;
  return {
    five_hour: pick(data.five_hour),
    seven_day: pick(data.seven_day),
    seven_day_opus: pick(data.seven_day_opus),
  };
}

async function handleUsage(raw) {
  const usage = normalize(raw);
  console.log("[CUM] bg: storing usage", usage);
  await chrome.storage.local.set({ usage, updatedAt: Date.now() });
  const settings = await getSettings();
  updateBadge(usage, settings);
  await checkThresholds(usage, settings);
}

// Recompute badge & thresholds from cached data (e.g. after a settings change).
async function reevaluate() {
  const { usage } = await chrome.storage.local.get("usage");
  if (!usage) return;
  const settings = await getSettings();
  updateBadge(usage, settings);
  await checkThresholds(usage, settings);
}

function watchedWindows(usage, settings) {
  const list = [];
  if (settings.watchSession && usage.five_hour)
    list.push({ key: "session", label: "5-hour session", win: usage.five_hour });
  if (settings.watchWeekly && usage.seven_day)
    list.push({ key: "weekly", label: "weekly", win: usage.seven_day });
  return list;
}

function updateBadge(usage, settings) {
  const windows = watchedWindows(usage, settings);
  if (!windows.length) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  const max = Math.max(...windows.map((w) => w.win.utilization));
  const pct = Math.round(max);
  chrome.action.setBadgeText({ text: String(pct) });

  let color = "#22c55e"; // green
  if (pct >= settings.threshold) color = "#ef4444"; // red
  else if (pct >= Math.max(0, settings.threshold - 15)) color = "#f59e0b"; // orange
  chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ color: "#ffffff" });
  }
}

// Fire once per window per limit-cycle. State keyed to each window's resets_at.
async function checkThresholds(usage, settings) {
  const { notified = {} } = await chrome.storage.local.get("notified");
  const windows = watchedWindows(usage, settings);

  for (const { key, label, win } of windows) {
    const prev = notified[key];
    const cycleChanged = !prev || prev.resets_at !== win.resets_at;
    if (cycleChanged) {
      // New limit cycle — reset the notified flag for this window.
      notified[key] = { resets_at: win.resets_at, fired: false };
    }

    const over = win.utilization >= settings.threshold;

    if (!over) {
      // Dropped back below threshold — allow a future re-alert this cycle.
      notified[key].fired = false;
      continue;
    }

    if (over && !notified[key].fired) {
      notified[key].fired = true;
      fireAlerts({ key, label, win, settings });
    }
  }

  await chrome.storage.local.set({ notified });
}

function fireAlerts({ key, label, win, settings }) {
  const pct = Math.round(win.utilization);
  const resetTxt = formatReset(win.resets_at);
  const title = `Claude ${label} usage at ${pct}%`;
  const message =
    `You've reached ${pct}% of your ${label} limit` +
    (resetTxt ? ` — resets ${resetTxt}.` : ".");

  if (settings.enableNative) {
    chrome.notifications.create(`cum-${key}-${win.resets_at}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: 2,
    });
  }

  if (settings.enableToast) {
    // Show the animated toast on any open claude.ai tab.
    chrome.tabs.query({ url: "https://claude.ai/*" }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs
          .sendMessage(tab.id, {
            type: "SHOW_TOAST",
            payload: { label, pct, resets_at: win.resets_at },
          })
          .catch(() => {});
      }
    });
  }
}

function formatReset(iso) {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (isNaN(ts)) return "";
  const diff = ts - Date.now();
  if (diff <= 0) return "soon";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `in ${hrs} h`;
  const days = Math.round(hrs / 24);
  return `in ${days} d`;
}
