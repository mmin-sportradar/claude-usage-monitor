#!/usr/bin/env bash
# Claude Usage Monitor — Claude Code statusline.
# Shows 5-hour session and 7-day weekly usage, colored by threshold, with
# reset countdowns. Data comes from Claude Code on stdin (rate_limits.*).
# Threshold matches the browser extension; override with CLAUDE_USAGE_THRESHOLD.
input=$(cat)
printf '%s' "$input" | THRESHOLD="${CLAUDE_USAGE_THRESHOLD:-80}" python3 -c '
import sys, json, time, os

th = float(os.environ.get("THRESHOLD", "80"))
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)

RESET = "\033[0m"
DIM   = "\033[38;5;245m"
BRAND = "\033[38;5;209m"   # claude-ish coral for the bolt

def color(p):
    if p >= th:            return "\033[38;5;203m"  # red
    if p >= max(0, th-15): return "\033[38;5;214m"  # orange
    return "\033[38;5;114m"                          # green

def bar(p, n=8):
    f = max(0, min(n, int(round(p / 100.0 * n))))
    return "▉" * f + "░" * (n - f)

def countdown(ts):
    try:
        diff = float(ts) - time.time()
    except Exception:
        return ""
    if diff <= 0: return "now"
    m = int(diff // 60)
    if m < 60:  return f"{m}m"
    h = m // 60
    if h < 48:  return f"{h}h"
    return f"{h // 24}d"

def seg(label, win):
    if not isinstance(win, dict): return None
    p = win.get("used_percentage")
    if p is None: return None
    c = color(p)
    warn = "⚠ " if p >= th else ""
    cd = countdown(win.get("resets_at"))
    s = f"{c}{warn}{label} {bar(p)} {p:.0f}%{RESET}"
    if cd: s += f"{DIM}·{cd}{RESET}"
    return s

rl = d.get("rate_limits") or {}
parts = [x for x in (seg("5h", rl.get("five_hour")),
                     seg("7d", rl.get("seven_day"))) if x]

# Session spend (USD) — provided by Claude Code as cost.total_cost_usd.
cost = (d.get("cost") or {}).get("total_cost_usd")
spend = ""
if isinstance(cost, (int, float)) and cost > 0:
    spend = f"  {DIM}\033[38;5;150m${cost:.2f}{RESET}"

bolt = f"{BRAND}⚡{RESET}"
if parts:
    print(f"{bolt} " + "  ".join(parts) + spend)
else:
    model = (d.get("model") or {}).get("display_name", "")
    hint = f"{DIM}usage n/a (Pro/Max, after first reply){RESET}"
    print((f"{bolt} {model}  {hint}" if model else f"{bolt} {hint}") + spend)
'
