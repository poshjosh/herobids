#!/usr/bin/env bash
# maintenance-restart-from-local.sh — Run the maintenance restart from your local machine.
#
# Auto-detects the server IP from Terraform and the SSH key from terraform.tfvars.
# Syncs the latest maintenance-restart.sh to the server first, then runs it and
# streams output back to your terminal.
#
# Usage:
#   infra/hetzner/scripts/maintenance-restart-from-local.sh [--env <staging|production>] [--skip-deploy] [--include-live] [--yes|-y] [<server-ip>]
#
# Options:
#   --env <name>     Target environment: staging or production (default: production).
#   --skip-deploy    Skip code pull and image rebuild — restart agents on current image.
#   --include-live   Also restart live-mode agents (skipped by default).
#   --yes|-y         Skip confirmation prompt.
#   <server-ip>      Override server IP (auto-detected from Terraform if omitted).
#
# Environment:
#   HEROBIDS_ENV   Deployment environment: staging | production (default: production).
#
# Examples:
#   infra/hetzner/scripts/maintenance-restart-from-local.sh --env staging    # staging maintenance
#   infra/hetzner/scripts/maintenance-restart-from-local.sh                  # deploy + restart agents
#   infra/hetzner/scripts/maintenance-restart-from-local.sh --skip-deploy    # restart agents only
#   infra/hetzner/scripts/maintenance-restart-from-local.sh --yes            # no confirmation prompt
#   infra/hetzner/scripts/maintenance-restart-from-local.sh --yes 1.2.3.4    # explicit IP, no prompt

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(dirname "$SCRIPT_DIR")"
source "${SCRIPT_DIR}/_ssh_opts.sh"

# ─── Parse environment flag first ────────────────────────────────────────────

parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true

# ─── Parse args ──────────────────────────────────────────────────────────────

REMOTE_ARGS=()
SERVER_IP=""
SKIP_CONFIRM=false

for arg in "$@"; do
  case "$arg" in
    --skip-deploy|--include-live) REMOTE_ARGS+=("$arg") ;;
    --yes|-y)  SKIP_CONFIRM=true ;;
    --help|-h)
      sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)
      echo "ERROR: Unknown option: $arg" >&2; exit 1 ;;
    *)
      [[ -n "${SERVER_IP}" ]] && { echo "ERROR: Unexpected argument: $arg" >&2; exit 1; }
      SERVER_IP="$arg" ;;
  esac
done

# ─── Resolve server IP ───────────────────────────────────────────────────────

if [[ -z "${SERVER_IP}" ]]; then
  if command -v terraform &>/dev/null; then
    SERVER_IP="$(cd "${TF_DIR}" && terraform output -raw server_ipv4 2>/dev/null || true)"
  fi
fi

if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: Could not determine server IP." >&2
  echo "  Run from the repo root, ensure terraform is in PATH, or pass the IP explicitly: $0 <ip>" >&2
  exit 1
fi

# ─── Confirmation ────────────────────────────────────────────────────────────

DEPLOY_NOTE="deploy + restart agents"
for a in "${REMOTE_ARGS[@]+"${REMOTE_ARGS[@]}"}"; do
  [[ "$a" == "--skip-deploy" ]] && DEPLOY_NOTE="restart agents only (no deploy)" && break
done

if [[ "${SKIP_CONFIRM}" != "true" ]]; then
  echo "Maintenance restart on ${SERVER_IP} (${HEROBIDS_ENV}) — ${DEPLOY_NOTE}"
  read -rp "Continue? [y/N] " CONFIRM
  [[ "${CONFIRM}" =~ ^[Yy] ]] || { echo "Aborted."; exit 0; }
fi

echo "==> Connecting to ${SERVER_IP} (${HEROBIDS_ENV})..."
echo ""

# ─── Sync latest script then run it ─────────────────────────────────────────
# Fetch and check out only maintenance-restart.sh from origin/main so the
# latest version runs, without a full reset that belongs to the script itself.

# shellcheck disable=SC2086
ssh ${SSH_OPTS} "root@${SERVER_IP}" HEROBIDS_ENV="${HEROBIDS_ENV}" bash -s -- "${REMOTE_ARGS[@]+"${REMOTE_ARGS[@]}"}" << 'REMOTE'
set -euo pipefail
cd /opt/herobids

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Environment: ${HEROBIDS_ENV}"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)]      Syncing maintenance-restart.sh from origin/main..."
git fetch --all --quiet
git checkout origin/main -- infra/hetzner/scripts/maintenance-restart.sh
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] OK   Script up to date."
echo ""

bash infra/hetzner/scripts/maintenance-restart.sh "$@"
REMOTE
