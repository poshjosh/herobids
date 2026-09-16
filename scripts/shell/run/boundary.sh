#!/usr/bin/env bash
# boundary.sh — reusable traderton-boundary bring-up library (cross-stack tests).
#
# Factored out of scripts/shell/run/with-boundary.sh so there is ONE definition
# of "stand up the traderton boundary + wait for /health/ready + wire the
# herobids api/worker to it + tear down what we started". Source it from any
# script that starts herobids api/worker in the cross-stack world:
#
#   source "${ROOT}/scripts/shell/run/boundary.sh"
#   ensure_boundary_up                 # before starting api/worker
#   docker compose -f "${ROOT}/docker-compose.yaml" -f "${HEROBIDS_OVERLAY}" \
#     up -d --build api worker         # api/worker get the boundary overlay
#   boundary_teardown_if_started       # from your EXIT trap
#
# What the boundary is:
#   The traderton stack (trading engine + venues behind the HMAC REST boundary)
#   is RE-USED (no third combined compose) under compose project
#   `traderton_xstack` from $TRADERTON_DIR/docker-compose.yml plus the
#   herobids-side overlay docker/traderton-xstack.override.yml, which remaps
#   the traderton stack's published host ports (postgres 5433, redis 6380) so
#   it can sit beside herobids' own 5432/6379. NOTE: the remap uses the
#   `!override` YAML tag (requires Docker Compose >= 2.24) so compose REPLACES
#   traderton's `ports:` list instead of MERGING it — without it, 5432/6379
#   stay published and collide with herobids. The two composes sit on separate
#   Docker networks, so herobids api/worker reach the boundary at
#   host.docker.internal:8080, NOT localhost. They get that URL (+ extra_hosts)
#   from docker/xstack.override.yml, which `herobids_compose` applies — an
#   api/worker compose operation that omits the overlay resolves an UNWIRED
#   service config (no TRADERTON_BOUNDARY_URL → the trading tools fail closed).
#
# Exposed API:
#   boundary_compose <args>        — compose wrapper for the traderton_xstack stack
#   herobids_compose <args>        — herobids compose WITH the boundary overlay
#                                    (use for every api/worker operation)
#   ensure_boundary_up             — preflight + bring up + wait for /health/ready
#   boundary_wait_ready [retries]  — poll /health/ready (~45×2s default budget)
#   boundary_teardown_if_started   — exit-trap helper: `down` if this script
#                                    created the stack, `stop` if it only
#                                    started it, no-op if it was already
#                                    serving (or never touched)
#
# Lifecycle invariants (mirrored by with-boundary.sh and the test entrypoints):
#   - UNCONDITIONAL: there is no opt-in flag. Trading is ALWAYS behind the
#     boundary now and herobids' trading tools fail closed without it, so any
#     tier that stands up api/worker also stands up the boundary.
#   - Already-serving: if ${BOUNDARY_URL}/health/ready answers before we touch
#     anything, the stack is reused and NEVER torn down.
#   - created-vs-started: if no `traderton_xstack` containers existed before
#     the up, we created them → `down --timeout 20` on exit; if some existed
#     (stopped), we only started them → `stop` on exit. Tracked in
#     TRADERTON_STARTED / TRADERTON_CREATED (initialized here; the caller's
#     EXIT trap must call boundary_teardown_if_started).
#
# Requirements:
#   - docker (with compose plugin >= 2.24 — see the port-remap overlay note
#     above)
#   - curl
#   - a traderton checkout at $TRADERTON_DIR (default: ../traderton relative to
#     the herobids repo root) — ensure_boundary_up preflight-fails with a clear
#     error otherwise.
#
# Matching credentials: the HMAC triple + CREDENTIAL_ENCRYPTION_KEY live in the
# (gitignored) .env files of BOTH repos and MUST match — see with-boundary.sh's
# header for the exact keys and the leaked-state cleanup commands.

set -euo pipefail

# ─── Resolve roots + paths (guarded so callers may pre-set ROOT/TRADERTON_DIR) ─

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
TRADERTON_DIR="${TRADERTON_DIR:-$(cd "${ROOT}/.." && pwd)/traderton}"

TRADERTON_PROJECT="traderton_xstack"
TRADERTON_COMPOSE="${TRADERTON_DIR}/docker-compose.yml"
TRADERTON_OVERLAY="${ROOT}/docker/traderton-xstack.override.yml"
HEROBIDS_OVERLAY="${ROOT}/docker/xstack.override.yml"

BOUNDARY_URL="http://localhost:8080"

# ─── State tracking (consumed by boundary_teardown_if_started in the caller's
# ─── EXIT trap) ───────────────────────────────────────────────────────────────

TRADERTON_STARTED="${TRADERTON_STARTED:-false}"   # we brought the boundary up
TRADERTON_CREATED="${TRADERTON_CREATED:-false}"   # its containers did NOT exist before

# ─── Message helpers ──────────────────────────────────────────────────────────
# Namespaced colours + [boundary] prefix so they never clobber a sourcing
# script's own log/ok/warn/err — and stay readable when interleaved with it.

if [[ -t 1 ]]; then
  B_GREEN='\033[0;32m'; B_YELLOW='\033[0;33m'; B_RED='\033[0;31m'; B_CYAN='\033[0;36m'; B_RESET='\033[0m'
else
  B_GREEN=''; B_YELLOW=''; B_RED=''; B_CYAN=''; B_RESET=''
fi

boundary_log()  { echo -e "${B_CYAN}[boundary]${B_RESET} $*"; }
boundary_ok()   { echo -e "${B_GREEN}[boundary]${B_RESET} $*"; }
boundary_warn() { echo -e "${B_YELLOW}[boundary]${B_RESET} $*"; }
boundary_err()  { echo -e "${B_RED}[boundary]${B_RESET} $*" >&2; }

# ─── Compose wrappers ─────────────────────────────────────────────────────────

boundary_compose() {          # the traderton stack (project traderton_xstack)
  docker compose -p "${TRADERTON_PROJECT}" \
    -f "${TRADERTON_COMPOSE}" -f "${TRADERTON_OVERLAY}" "$@"
}

herobids_compose() {          # herobids stack + the boundary overlay
  docker compose -f "${ROOT}/docker-compose.yaml" -f "${HEROBIDS_OVERLAY}" "$@"
}

# ─── Wait for /health/ready ───────────────────────────────────────────────────
# Budget ~45 × 2s — the first `--build` builds the traderton migrate + boundary
# images, which is slow.

boundary_wait_ready() {
  local retries="${1:-45}"
  boundary_log "Waiting for the traderton boundary (${BOUNDARY_URL}/health/ready)…"
  while [[ ${retries} -gt 0 ]]; do
    if curl -sf "${BOUNDARY_URL}/health/ready" > /dev/null 2>&1; then
      boundary_ok "traderton boundary is ready."
      return 0
    fi
    sleep 2
    (( retries-- ))
  done
  boundary_err "traderton boundary did not become ready at ${BOUNDARY_URL}/health/ready."
  return 1
}

# ─── Bring up (unconditional — no flag gates this) ────────────────────────────

ensure_boundary_up() {
  # Preflight: fail with a clear error if the traderton checkout is missing.
  if [[ ! -f "${TRADERTON_COMPOSE}" ]]; then
    boundary_err "traderton compose not found at: ${TRADERTON_COMPOSE}"
    boundary_err "Set TRADERTON_DIR to your traderton checkout (currently: ${TRADERTON_DIR})."
    return 1
  fi

  # Was the boundary already serving before we touched anything? If so, reuse
  # it (and never tear it down).
  if curl -sf "${BOUNDARY_URL}/health/ready" > /dev/null 2>&1; then
    boundary_log "Boundary already ready at ${BOUNDARY_URL} — reusing it (will not tear down)."
  else
    # Did any traderton_xstack container already exist? If not, we created them
    # and may fully `down`; if some existed (stopped), we only `stop`.
    local pre_existed=true
    if [[ -z "$(boundary_compose ps -aq 2>/dev/null)" ]]; then
      pre_existed=false
    fi
    # Track state BEFORE the up: if the up itself fails (set -e), the caller's
    # EXIT trap still tears down whatever exists — `down` if we created the
    # containers, `stop` if we merely started pre-existing ones.
    TRADERTON_STARTED=true
    if [[ "${pre_existed}" == "false" ]]; then
      TRADERTON_CREATED=true
    fi
    boundary_log "Building and starting the traderton boundary stack (host ports remapped: pg 5433, redis 6380)…"
    boundary_compose up -d --build
  fi

  boundary_wait_ready
}

# ─── Teardown (call from the sourcing script's EXIT trap) ─────────────────────

boundary_teardown_if_started() {
  if [[ "${TRADERTON_STARTED}" == "true" ]]; then
    if [[ "${TRADERTON_CREATED}" == "true" ]]; then
      boundary_warn "Tearing down traderton boundary stack (created by this script)…"
      boundary_compose down --timeout 20 2>/dev/null || true
    else
      boundary_warn "Stopping traderton boundary stack (started — not created — by this script)…"
      boundary_compose stop 2>/dev/null || true
    fi
  fi
}
