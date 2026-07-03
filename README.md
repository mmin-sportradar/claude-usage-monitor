# Claude Usage Monitor

A Chrome (Manifest V3) extension that tracks your Claude **5-hour session** and
**7-day weekly** usage and alerts you when you cross a threshold (default **80%**).
It reads usage through your existing claude.ai login — no API key, no external server,
nothing leaves your browser.

---

## ⚡ Quick start for teammates

**A) Browser extension** (usage badge, popup, 80% alerts)
1. Unzip this folder somewhere permanent (don't delete it — Chrome loads from this path).
2. Open `chrome://extensions` → turn on **Developer mode** (top-right).
3. Click **Load unpacked** → select this unzipped folder.
4. Open **claude.ai** and log in. The toolbar badge fills in; click it for the dashboard.

**B) Terminal statusline** (optional — shows usage + session cost in Claude Code)
```bash
bash install-statusline.sh      # requires python3; open a NEW Claude Code session after
```

That's it. No accounts, no API keys — it uses your own logged-in session and stores
everything locally.

---

## Features

- **Live toolbar badge** — shows current usage %, colored green → orange → red.
- **Popup dashboard** — animated ring meters for both limits with "resets in…" countdowns.
- **80% alerts** — a native Chrome notification **and** an animated in-page toast on claude.ai.
  Fires once per limit cycle; re-arms when the window resets.
- **Options page** — adjustable threshold and toggles for which limits to watch and how to
  be notified.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right) on.
3. Click **Load unpacked** and select this folder (`Usage conductor`).
4. Open **claude.ai** and log in. The badge populates once the page reports usage.
5. Click the toolbar icon for the dashboard, or the ⚙ button for settings.

## How it gets the data

Three complementary sources, all using your logged-in session:

1. **Direct poll (`background.js`)** — every ~1 minute the background worker fetches the usage
   endpoint itself, using the claude.ai host permission and your existing cookies. This needs
   **no claude.ai tab open**, so the badge stays current even when you're only working in the
   terminal (Claude Code) — terminal usage counts against the same shared 5h/7d pool.
2. **Passive capture (`injected.js`)** — runs in any open claude.ai page and watches the usage
   requests claude.ai itself makes, so the badge also updates right after you send messages there.
3. **Tab fallback (`content.js`)** — if the worker's own request is refused, it asks an open
   claude.ai tab to fetch usage in the page context.

Because of source 1, updates no longer require a claude.ai tab; you only need to be **logged
into claude.ai in this browser**. If you're logged out, the popup shows the last cached values.

### Extra-usage spend in the popup

If you have **extra usage** enabled (consumption billing past your plan limit, shown at
`claude.ai/settings/usage`), the popup displays the **dollar amount spent this cycle**,
read automatically from claude.ai's own field `spend.used.amount_minor` (divided by
`spend.used.exponent`, so minor units → dollars). It shows `$0.00` until you actually spend
into extra usage. No setup — it just displays.

> **Not the same as the terminal `$`.** The dollar figure in the Claude Code statusline is your
> *Claude Code token cost* (reconstructed at API rates, summed across all sessions for the day) —
> how much your terminal usage would cost at API rates. That data lives in Claude Code's local
> transcripts and can't be read by a browser extension. The extension's number is your claude.ai
> *extra-usage billing*, which is a separate thing.

### If usage never appears

Claude's internal usage endpoint isn't a documented public API, so its exact path can change.
To confirm/adjust:

1. On claude.ai, open **DevTools → Network**, then visit **Settings → Usage**.
2. Find the request whose JSON response contains `five_hour` / `seven_day`.
3. If its path differs from the candidates in `content.js` (`fetchUsage()`), add it there.
   (The passive capture in `injected.js` usually catches it automatically regardless.)

## Terminal statusline (Claude Code)

Because Claude's usage limits are a **single shared pool** across claude.ai, Claude Desktop,
and Claude Code, the same numbers can be shown right in your Claude Code statusline.
`statusline-usage.sh` reads the `rate_limits` data Claude Code passes on stdin (no API key,
no token handling) and renders both meters with the same green/orange/red threshold as the
extension:

```
⚡ 5h ▉▉▉░░░░░ 34%·39m  ⚠ 7d ▉▉▉▉▉▉▉░ 83%·2d  today $28.90
```

The trailing `today $28.90` is your **total Claude Code spend across *all* sessions/windows
for the current local day** — not just the window you're looking at. Claude Code only hands the
statusline the *current* session's `cost.total_cost_usd`, so to get a true daily total the script
reconstructs per-message cost from the token usage recorded in the transcripts under
`~/.claude/projects/*/*.jsonl` (input/output/cache tokens × per-model rates) and sums today's
across every session. Results are cached per file (by mtime+size), so only transcripts that
changed since the last render are re-parsed — it stays fast (~0.1s) even with many sessions.

> This is a **reconstruction** at standard published API rates, so it's close to — but won't
> exactly match — the per-session number Claude Code shows internally (which uses its own pricing
> table and, on Pro/Max plans, is notional API-equivalent cost, not money billed to you).

Installed to `~/.claude/statusline-usage.sh` and registered in `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "~/.claude/statusline-usage.sh", "padding": 1 }
```

Notes:
- The `rate_limits` fields only appear for **Pro/Max** subscribers and **after the first
  reply** in a session — until then the statusline shows a short "usage n/a" hint.
- It takes effect in a **new Claude Code session**.
- Change the threshold with `CLAUDE_USAGE_THRESHOLD` (defaults to 80).

## Sharing with other people

The extension and the statusline are **independent** and shared separately.

**Chrome extension** (browser):
1. Send them this folder (zip it, or share the repo).
2. They open `chrome://extensions`, enable Developer mode, click **Load unpacked**, pick the folder.
   (For a click-to-install experience for many people, it would need publishing to the Chrome
   Web Store — a separate step, not required for personal/team use.)

**Statusline** (Claude Code terminal) — *not* part of the extension; each person installs it once:
```bash
bash install-statusline.sh
```
This copies `statusline-usage.sh` to `~/.claude/` and adds the `statusLine` entry to their
`~/.claude/settings.json` (backing up any existing one, and refusing to overwrite a different
statusline they already use). It requires `python3`. They then open a **new** Claude Code session.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 config, permissions, script registration |
| `background.js` | Polling, storage, badge, threshold + notification logic |
| `injected.js` | MAIN-world hook that captures the app's own usage requests |
| `content.js` | Same-origin `fetchUsage()` + the animated in-page toast |
| `popup.html/.css/.js` | Toolbar dashboard with animated meters |
| `options.html/.js` | Settings (threshold, limits, notification toggles) |
| `statusline-usage.sh` | Claude Code terminal statusline (usage + session spend) |
| `install-statusline.sh` | One-command installer for the statusline (for sharing) |
| `icons/` | Extension icons |

No data is collected or transmitted anywhere.
