// Claude Usage Monitor — options page.

const DEFAULTS = {
  threshold: 80,
  watchSession: true,
  watchWeekly: true,
  enableNative: true,
  enableToast: true,
};

const $ = (id) => document.getElementById(id);
const TOGGLES = ["watchSession", "watchWeekly", "enableNative", "enableToast"];

async function loadSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULTS, ...(settings || {}) };
}

function apply(s) {
  $("threshold").value = s.threshold;
  $("tval").textContent = s.threshold + "%";
  for (const k of TOGGLES) $(k).checked = !!s[k];
}

function collect() {
  const s = { threshold: parseInt($("threshold").value, 10) };
  for (const k of TOGGLES) s[k] = $(k).checked;
  return s;
}

let savedTimer = null;
async function save() {
  const s = collect();
  await chrome.storage.sync.set({ settings: s });
  const el = $("saved");
  el.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove("show"), 1400);
}

$("threshold").addEventListener("input", () => {
  $("tval").textContent = $("threshold").value + "%";
});
$("threshold").addEventListener("change", save);
for (const k of TOGGLES) $(k).addEventListener("change", save);

loadSettings().then(apply);
