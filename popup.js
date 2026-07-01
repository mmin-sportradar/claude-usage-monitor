// Claude Usage Monitor — popup dashboard.

const WINDOWS = [
  { key: "five_hour", title: "Session", sub: "5-hour rolling window" },
  { key: "seven_day", title: "Weekly", sub: "7-day rolling window" },
];

const R = 33;                       // ring radius
const CIRC = 2 * Math.PI * R;       // circumference

let settings = { threshold: 80 };

function colorFor(pct) {
  if (pct >= settings.threshold) return "var(--red)";
  if (pct >= Math.max(0, settings.threshold - 15)) return "var(--orange)";
  return "var(--green)";
}

function resetText(iso) {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (isNaN(ts)) return "";
  const diff = ts - Date.now();
  if (diff <= 0) return "resetting…";
  const m = Math.round(diff / 60000);
  if (m < 60) return `resets in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `resets in ${h}h ${m % 60}m`;
  return `resets in ${Math.round(h / 24)} d`;
}

function ago(ts) {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "updated just now";
  const m = Math.round(s / 60);
  if (m < 60) return `updated ${m} min ago`;
  return `updated ${Math.round(m / 60)} h ago`;
}

function meterEl(win, data) {
  const has = data && typeof data.utilization === "number";
  const pct = has ? Math.round(data.utilization) : 0;
  const col = colorFor(pct);

  const el = document.createElement("div");
  el.className = "meter";
  el.innerHTML = `
    <div class="ring">
      <svg width="76" height="76" viewBox="0 0 76 76">
        <circle class="track" cx="38" cy="38" r="${R}" fill="none" stroke-width="7"></circle>
        <circle class="prog" cx="38" cy="38" r="${R}" fill="none" stroke-width="7"
          stroke="${col}" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"></circle>
      </svg>
      <div class="label"><span class="val">${has ? pct : "—"}</span><span class="unit">%</span></div>
    </div>
    <div class="info">
      <div class="win">${win.title}</div>
      <div class="sub">${win.sub}</div>
      <div class="reset">${has ? `<span class="dot" style="background:${col};color:${col}"></span>${resetText(data.resets_at)}` : ""}</div>
    </div>`;

  // Animate the ring sweep on next frame.
  const prog = el.querySelector(".prog");
  requestAnimationFrame(() => {
    prog.style.strokeDashoffset = String(CIRC * (1 - Math.min(100, pct) / 100));
  });
  return el;
}

function render(usage, updatedAt) {
  const meters = document.getElementById("meters");
  const empty = document.getElementById("empty");
  meters.innerHTML = "";

  const hasAny = usage && (usage.five_hour || usage.seven_day);
  empty.classList.toggle("hidden", !!hasAny);
  meters.classList.toggle("hidden", !hasAny);

  if (hasAny) {
    for (const w of WINDOWS) meters.appendChild(meterEl(w, usage[w.key]));
  }
  document.getElementById("updated").textContent = ago(updatedAt);
}

let spendField = null;   // optional manual override { path, scale }, from storage.sync
let allFields = [];      // [{path, value}] every number captured from claude.ai

function fmtMoney(n) {
  return "$" + Number(n).toFixed(2);
}

function findField(suffix) {
  return allFields.find((f) => f.path === suffix || f.path.endsWith("." + suffix));
}

function currentSpend() {
  // User's manual override wins, if they set one.
  if (spendField) {
    const f = allFields.find((x) => x.path === spendField.path);
    if (f) return { value: f.value / (spendField.scale || 1), path: f.path, locked: true };
  }
  // Canonical claude.ai extra-usage spend: spend.used.amount_minor / 10^exponent.
  const minor = findField("spend.used.amount_minor");
  if (minor) {
    const exp = findField("spend.used.exponent");
    return {
      value: minor.value / Math.pow(10, exp ? exp.value : 2),
      path: minor.path,
      locked: true,
    };
  }
  // Fallbacks seen in claude.ai payloads.
  const usedDollars = findField("amber_ladder.used_dollars");
  if (usedDollars) return { value: usedDollars.value, path: usedDollars.path, locked: true };
  const usedCredits = findField("extra_usage.used_credits");
  if (usedCredits) return { value: usedCredits.value, path: usedCredits.path, locked: true };
  return null;
}

function renderSpend() {
  const el = document.getElementById("spend");
  if (!allFields.length && !spendField) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  const cur = currentSpend();

  const pctF = findField("spend.percent");
  const subtitle = cur
    ? "extra-usage billing, this cycle" + (pctF ? ` · ${Math.round(pctF.value)}% of cap` : "")
    : "open claude.ai to load";
  el.innerHTML = `
    <div class="top">
      <span class="lbl">Extra&nbsp;usage spent</span>
      <span class="amt">${cur ? fmtMoney(cur.value) : "—"}</span>
    </div>
    <div class="src">${subtitle}</div>`;
}

async function load() {
  const [state, sync] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_STATE" }),
    chrome.storage.sync.get("spendField"),
  ]);
  if (sync && sync.spendField) spendField = sync.spendField;
  if (state && state.settings) settings = state.settings;
  allFields = state && state.fields ? state.fields : [];
  render(state ? state.usage : null, state ? state.updatedAt : null);
  renderSpend();
}

async function refresh() {
  const btn = document.getElementById("refresh");
  btn.classList.add("spinning");
  await chrome.runtime.sendMessage({ type: "REQUEST_REFRESH" });
  await load();
  btn.classList.remove("spinning");
}

document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("settings").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// Live-update: re-render the instant the background stores fresh usage,
// so the popup loads new numbers automatically without a manual refresh.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.usage || changes.updatedAt || changes.fieldMap)) load();
});

// Keep polling while the popup stays open (e.g. watching usage climb live).
const poll = setInterval(() => {
  chrome.runtime.sendMessage({ type: "REQUEST_REFRESH" }).catch(() => {});
}, 15000);
window.addEventListener("unload", () => clearInterval(poll));

load();
// Auto-refresh once on open to get the freshest data if a claude.ai tab is open.
chrome.runtime.sendMessage({ type: "REQUEST_REFRESH" }).then(load).catch(() => {});
