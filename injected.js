// Claude Usage Monitor — MAIN-world hook.
// Runs in the page's own JS context so it can observe the requests claude.ai
// itself makes. Whenever a response body looks like usage data (has a
// five_hour / seven_day window), we forward it to the content script, which
// relays it to the background worker. This is the most robust source because
// it uses whatever endpoint the app actually uses.
(function () {
  const TAG = "__cum_injected__";
  if (window[TAG]) return;
  window[TAG] = true;
  console.log("[CUM] injected.js MAIN-world hook loaded @", location.href);

  function looksLikeUsage(obj) {
    return (
      obj &&
      typeof obj === "object" &&
      (obj.five_hour || obj.seven_day || obj.seven_day_opus)
    );
  }

  // Paths that are config / feature-flags — never real spend. Excluded from scan.
  const PATH_BLOCK = /growthbook|feature|flag|experiment|statsig|segment|variant|ab_?test|launchdarkly/i;
  // Skip heavy / streaming / asset requests; scan everything else for numbers.
  const SKIP_URL = /completion|chat_conversation|\/messages|\/stream|\/upload|attachment|\/render|\/count_tokens|telemetry|\/track|ingest|sentry|\.(js|css|png|jpg|svg|woff|map)(\?|$)/i;

  // Collect ALL finite numeric leaves (path + value), minus feature-flag noise.
  // We capture everything so the user can point us at the exact spend field.
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

  function forward(url, obj) {
    const u = String(url || "");
    if (looksLikeUsage(obj)) {
      console.log("[CUM] injected: captured USAGE from", u);
      window.postMessage(
        { source: "cum-injected", kind: "usage", url: u, data: obj },
        "*"
      );
    }
    if (!SKIP_URL.test(u) && !PATH_BLOCK.test(u)) {
      const fields = scanNumbers(obj, "", [], 0);
      if (fields.length) {
        window.postMessage({ source: "cum-injected", kind: "fields", url: u, fields }, "*");
      }
    }
  }

  // --- fetch --------------------------------------------------------------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      return origFetch.apply(this, args).then((res) => {
        try {
          const url = (res && res.url) || (args[0] && args[0].url) || args[0];
          if (typeof url === "string" && SKIP_URL.test(url)) {
            return res; // skip heavy/streaming/asset requests
          }
          res.clone().json().then((obj) => forward(url, obj)).catch(() => {});
        } catch (_) {}
        return res;
      });
    };
  }

  // --- XMLHttpRequest -----------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__cum_url = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const ct = this.getResponseHeader("content-type") || "";
        if (ct.indexOf("json") === -1) return;
        const obj = JSON.parse(this.responseText);
        forward(this.__cum_url, obj);
      } catch (_) {}
    });
    return origSend.apply(this, args);
  };
})();
