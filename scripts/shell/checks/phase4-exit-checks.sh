#!/usr/bin/env bash
# phase4-exit-checks.sh — the grep-able Phase 4 exit checks EC-1..EC-4
# (docs/features/2026/10/03/004-phase4-skill-replacement-program/INVARIANTS.md).
#
# These assert herobids no longer owns trading skills and that the descriptor +
# signing machinery is gone from BOTH repos. The behavioural checks (EC-5..EC-17)
# are exercised by the test suites, not here.
#
# Scope (per INVARIANTS): herobids `apps packages scripts config`, excluding
# node_modules, dist and **/*.d.ts. docs/ is history and is excluded.
#
# Usage: scripts/shell/checks/phase4-exit-checks.sh
# Exit 0 = every check passes (0 forbidden hits). Exit 1 = at least one failed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HB_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TT_ROOT="${TRADERTON_DIR:-$(cd "${HB_ROOT}/.." && pwd)/traderton}"

if ! command -v rg >/dev/null 2>&1; then
  echo "FAIL: ripgrep (rg) is required for the exit checks" >&2
  exit 1
fi

FAILED=0

# rg over the herobids in-scope dirs, excluding generated/types. Returns matching
# lines (empty when clean). `|| true` so a no-match (rg exit 1) is not a failure.
hb_grep() {
  # Exclude this check script itself — its pattern strings would self-match.
  (cd "${HB_ROOT}" && rg -n "$1" apps packages scripts config \
    -g '!**/*.d.ts' -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/phase4-exit-checks.sh' 2>/dev/null) || true
}

tt_grep() {
  [[ -d "${TT_ROOT}" ]] || { echo "(traderton checkout not found at ${TT_ROOT} — skipping its EC-4 leg)"; return; }
  (cd "${TT_ROOT}" && rg -n "$1" packages scripts \
    -g '!**/*.d.ts' -g '!**/node_modules/**' -g '!**/dist/**' -g '!**/phase4-exit-checks.sh' 2>/dev/null) || true
}

check() {
  local id="$1"; shift
  local desc="$1"; shift
  local hits="$1"; shift
  # Optional allow-filter: lines matching it are permitted (e.g. family labels).
  local allow="${1:-}"
  if [[ -n "${allow}" ]]; then
    hits="$(printf '%s\n' "${hits}" | grep -vE "${allow}" || true)"
  fi
  hits="$(printf '%s' "${hits}" | sed '/^$/d')"
  if [[ -z "${hits}" ]]; then
    echo "PASS ${id}: ${desc}"
  else
    echo "FAIL ${id}: ${desc}"
    printf '%s\n' "${hits}" | sed 's/^/    /'
    FAILED=1
  fi
}

echo "── Phase 4 exit checks EC-1..EC-4 ──────────────────────────────────────────"

# EC-1 — herobids no longer owns the trading skill constants or system/* slugs.
check "EC-1" "no built-in trading skill constants or system/* trading slugs (herobids)" \
  "$(hb_grep 'TRADING_SKILL|BOT_MANAGEMENT_SKILL|RISK_MONITORING_SKILL|BUILTIN_TRADING_SOURCE_REFS|system/trading|system/bot-management|system/risk-monitoring')"

# EC-2 — no trading skill instruction text in herobids.
check "EC-2" "no trading skill instruction text (herobids)" \
  "$(hb_grep 'grouped by workflow phase|You have access to bot-management tools|You have access to risk-monitoring and alerting tools')"

# EC-3 — no hard-coded trading skill IDS. Family-label uses are allowed.
check "EC-3" "no hard-coded trading skill ids (family labels allowed) (herobids)" \
  "$(hb_grep "[sS]killIds?\b.*'(trading|bot-management|risk-monitoring)'|\bid === '(trading|bot-management|risk-monitoring)'")" \
  "hasSkillCapabilityFamily|selectedSkillsHaveCapabilityFamily|capabilityFamilies|family ===|readinessFamilies|registerBackendRefFamilies"

# EC-4 — descriptor + signing machinery gone from both repos; config dir removed.
check "EC-4a" "descriptor/signing machinery gone (herobids)" \
  "$(hb_grep 'trustedDescriptorSigningKeys|descriptorPinning|resolveDescriptorTools|DescriptorWrapper|generate-dev-descriptor|descriptor-conformance|\.descriptor\.json')"
if [[ -d "${HB_ROOT}/config/external-backends" ]]; then
  echo "FAIL EC-4a: config/external-backends/ still exists"
  FAILED=1
else
  echo "PASS EC-4a: config/external-backends/ removed"
fi
check "EC-4b" "descriptor/signing machinery gone + no BOUNDARY_MCP_DESCRIPTOR_PATH (traderton)" \
  "$(tt_grep 'trustedDescriptorSigningKeys|descriptorPinning|resolveDescriptorTools|DescriptorWrapper|generate-dev-descriptor|descriptor-conformance|\.descriptor\.json|BOUNDARY_MCP_DESCRIPTOR_PATH')"

echo "────────────────────────────────────────────────────────────────────────────"
if [[ "${FAILED}" -eq 0 ]]; then
  echo "All Phase 4 grep exit checks (EC-1..EC-4) PASS."
else
  echo "One or more Phase 4 grep exit checks FAILED (see above)."
fi
exit "${FAILED}"
