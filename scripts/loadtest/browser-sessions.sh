#!/usr/bin/env bash
# browser-sessions.sh — browser-pool load test (Hetzner scale-path plan, task 4.4).
# STAGING ONLY. Drives N concurrent Browserless sessions and records the pool's
# /pressure plus per-action latency, so the sessions-per-node ceiling can be measured.
#
# Uses only curl + jq (no new dependency): each "session" is a Browserless REST
# /function call that opens a typical page, takes a snapshot, clicks, and waits a
# few seconds — the shape of an agent thinking between actions. N such calls run
# concurrently; after each ramp step the script samples /pressure.
#
# Deliberately not a CDP/WebSocket client: adding playwright/puppeteer/ws just for
# a load test is unjustified (AGENTS.md: no deps without justification), and the
# REST /function path exercises the same session lifecycle.
#
# Run from anywhere that can reach the pool (e.g. the control plane on the private
# network, or an agent node). The pool listens on <host>:3100.
#
# Usage:
#   browser-sessions.sh --host H [options]
#
# Options:
#   --host H            Browser-pool host (required), e.g. 10.0.0.7.
#   --port P            Port (default 3100).
#   --token T           Browserless token, if the pool requires one (default none).
#   --steps "A B C"     Concurrency steps to ramp through (default "2 5 10 20").
#   --think-min S       Min think time per action, seconds (default 5).
#   --think-max S       Max think time per action, seconds (default 15).
#   --actions N         Actions per session before it exits (default 3).
#   --url URL           Page each session opens (default https://example.com).
#   --help              Show this help.
#
# Output: one CSV row per ramp step on stdout:
#   step,concurrency,pressure_running,pressure_queued,pressure_recently_rejected,cpu,memory,p95_action_ms

set -euo pipefail

HOST=""
PORT=3100
TOKEN=""
STEPS="2 5 10 20"
THINK_MIN=5
THINK_MAX=15
ACTIONS=3
PAGE_URL="https://example.com"

die() { echo "ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --steps) STEPS="${2:-}"; shift 2 ;;
    --think-min) THINK_MIN="${2:-}"; shift 2 ;;
    --think-max) THINK_MAX="${2:-}"; shift 2 ;;
    --actions) ACTIONS="${2:-}"; shift 2 ;;
    --url) PAGE_URL="${2:-}"; shift 2 ;;
    --help|-h) sed -n '2,37p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "${HOST}" ]] || die "--host is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v jq >/dev/null 2>&1 || die "jq is required"

BASE="http://${HOST}:${PORT}"
QS=""
[[ -n "${TOKEN}" ]] && QS="?token=${TOKEN}"

# The function body Browserless runs per session. It opens the page, takes an
# accessibility snapshot, clicks the body, and "thinks" between actions.
build_function_js() {
  cat <<JS
export default async ({ page }) => {
  const url = ${PAGE_URL@Q};
  const actions = ${ACTIONS};
  const thinkMin = ${THINK_MIN}, thinkMax = ${THINK_MAX};
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < actions; i++) {
    await page.accessibility.snapshot().catch(() => {});
    await page.click('body').catch(() => {});
    const think = (thinkMin + Math.random() * (thinkMax - thinkMin)) * 1000;
    await new Promise((r) => setTimeout(r, think));
  }
  return { data: 'ok', type: 'application/json' };
};
JS
}

FUNCTION_JS="$(build_function_js)"

# run_one_session — one REST /function call; prints the wall-clock ms it took.
run_one_session() {
  local start end
  start="$(date +%s%3N)"
  curl -sS --max-time 180 \
    -H 'Content-Type: application/javascript' \
    --data-binary "${FUNCTION_JS}" \
    "${BASE}/function${QS}" >/dev/null 2>&1 || true
  end="$(date +%s%3N)"
  echo "$(( end - start ))"
}

sample_pressure() {
  # Browserless /pressure returns { pressure: { running, queued, recentlyRejected, cpu, memory, ... } }
  curl -sS --max-time 10 "${BASE}/pressure${QS}" 2>/dev/null \
    | jq -r '.pressure // . | [ (.running // 0), (.queued // 0), (.recentlyRejected // 0), (.cpu // 0), (.memory // 0) ] | @csv' \
    2>/dev/null || echo "0,0,0,0,0"
}

p95() {
  # p95 of whitespace/newline-separated integers on stdin.
  sort -n | awk '{ a[NR] = $1 } END { if (NR == 0) { print 0; exit } idx = int(0.95 * NR); if (idx < 1) idx = 1; print a[idx] }'
}

echo "step,concurrency,pressure_running,pressure_queued,pressure_recently_rejected,cpu,memory,p95_action_ms"
step=0
for n in ${STEPS}; do
  step=$(( step + 1 ))
  [[ "${n}" =~ ^[0-9]+$ ]] || die "step '${n}' is not an integer"
  tmp="$(mktemp -d)"
  # Launch n concurrent sessions, each writing its latency to a file.
  for (( s = 0; s < n; s++ )); do
    ( run_one_session > "${tmp}/${s}.ms" ) &
  done
  # Sample pressure mid-flight (after a short warm-up).
  sleep 3
  pressure="$(sample_pressure)"
  wait
  latencies="$(cat "${tmp}"/*.ms 2>/dev/null)"
  p95_ms="$(printf '%s\n' ${latencies} | p95)"
  rm -rf "${tmp}"
  echo "${step},${n},${pressure},${p95_ms}"
done

echo "# Ceiling = highest concurrency with queued=0, recentlyRejected=0, and p95 < 2x the 2-session p95." >&2
