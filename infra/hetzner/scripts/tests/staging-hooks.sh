#!/usr/bin/env bash
# staging-hooks.sh — Staging-only failure injection hooks for validation testing.
#
# These hooks support the production validation plan at:
#   docs/features/2026/08/28/001-nomad-production-scale-in-readiness/002-production-validation-plan.md
#
# They override specific functions in scale-common.sh to simulate failure
# scenarios deterministically. This avoids relying on ad hoc live breakage
# or manual environment corruption.
#
# ┌──────────────────────────────────────────────────────────────────┐
# │  STAGING ONLY — do NOT source this file in production.          │
# │  The hooks are guarded: they refuse to activate when            │
# │  HEROBIDS_ENV=production.                                       │
# └──────────────────────────────────────────────────────────────────┘
#
# Usage:
#   # Source AFTER scale-common.sh (hooks override its functions)
#   source /opt/herobids/infra/hetzner/scripts/tests/staging-hooks.sh
#
#   # V4: Simulate drain timeout (validation plan step V4)
#   INJECT_DRAIN_TIMEOUT=true ENABLE_SCALE_IN=true \
#     /opt/herobids/infra/hetzner/scripts/scale-in.sh
#
#   # V5: Simulate Terraform apply failure (validation plan step V5)
#   INJECT_TF_APPLY_FAILURE=true ENABLE_SCALE_IN=true \
#     /opt/herobids/infra/hetzner/scripts/scale-in.sh
#
# Environment variables:
#   INJECT_DRAIN_TIMEOUT=true     Makes wait_for_drain_complete always return 1
#                                 (simulates a node that never finishes draining)
#   INJECT_TF_APPLY_FAILURE=true  Makes tf_apply_var always return 1
#                                 (simulates a Terraform apply failure)
#
# Both hooks:
#   - Log clearly that injection is active (grep for "[STAGING-HOOK]")
#   - Refuse to activate when HEROBIDS_ENV=production
#   - Are no-ops when their env var is unset or not "true"

set -euo pipefail

# ─── Production guard ─────────────────────────────────────────────────────────

if [[ "${HEROBIDS_ENV:-}" == "production" ]]; then
  echo "[STAGING-HOOK] FATAL: staging-hooks.sh must not be sourced in production (HEROBIDS_ENV=production)." >&2
  echo "[STAGING-HOOK] Refusing to activate failure injection hooks." >&2
  return 1 2>/dev/null || exit 1
fi

# ─── Drain timeout injection (V4) ─────────────────────────────────────────────

if [[ "${INJECT_DRAIN_TIMEOUT:-}" == "true" ]]; then
  echo "[STAGING-HOOK] Drain timeout injection ACTIVE — wait_for_drain_complete will always fail." >&2

  # Save the original function for reference
  if declare -f wait_for_drain_complete >/dev/null 2>&1; then
    eval "_original_$(declare -f wait_for_drain_complete)"
  fi

  wait_for_drain_complete() {
    local node_id="$1"
    local timeout_seconds="${2:-600}"
    echo "[STAGING-HOOK] Simulating drain timeout for node ${node_id} (injected failure)." >&2
    log "WARNING: [STAGING-HOOK] Node ${node_id} did not drain within ${timeout_seconds}s. Node will be excluded from the destroy set."
    return 1
  }
fi

# ─── Terraform apply failure injection (V5) ───────────────────────────────────

if [[ "${INJECT_TF_APPLY_FAILURE:-}" == "true" ]]; then
  echo "[STAGING-HOOK] Terraform apply failure injection ACTIVE — tf_apply_var will always fail." >&2

  if declare -f tf_apply_var >/dev/null 2>&1; then
    eval "_original_$(declare -f tf_apply_var)"
  fi

  tf_apply_var() {
    echo "[STAGING-HOOK] Simulating Terraform apply failure (injected failure)." >&2
    log "ERROR: [STAGING-HOOK] Terraform apply failed (injected by staging-hooks.sh)."
    return 1
  }
fi

# ─── Status report ─────────────────────────────────────────────────────────────

_hooks_active=0
[[ "${INJECT_DRAIN_TIMEOUT:-}" == "true" ]] && (( _hooks_active++ )) || true
[[ "${INJECT_TF_APPLY_FAILURE:-}" == "true" ]] && (( _hooks_active++ )) || true

if [[ ${_hooks_active} -eq 0 ]]; then
  echo "[STAGING-HOOK] Sourced but no hooks active (set INJECT_DRAIN_TIMEOUT or INJECT_TF_APPLY_FAILURE to 'true')." >&2
else
  echo "[STAGING-HOOK] ${_hooks_active} hook(s) active for staging validation." >&2
fi

unset _hooks_active
