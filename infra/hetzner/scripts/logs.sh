#!/usr/bin/env bash
# logs.sh — Stream container logs from the Hetzner server.
#
# Runs `docker compose logs -f` on the server against the production compose
# files. Any extra arguments are forwarded to the logs command, allowing
# filtering by service name.
#
# Usage:
#   infra/hetzner/scripts/logs.sh [<server-ip>] [-- <docker-compose-args>]
#   infra/hetzner/scripts/logs.sh                    # all services, auto-detect IP
#   infra/hetzner/scripts/logs.sh 1.2.3.4            # explicit IP, all services
#   infra/hetzner/scripts/logs.sh -- api worker       # filter by service names
#   infra/hetzner/scripts/logs.sh 1.2.3.4 -- api     # explicit IP + service filter
#
# Examples:
#   ./logs.sh
#   ./logs.sh 1.2.3.4
#   ./logs.sh -- api worker
#   ./logs.sh 1.2.3.4 -- api

set -euo pipefail

# ─── Resolve directories ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(dirname "$SCRIPT_DIR")"

# ─── Parse arguments ─────────────────────────────────────────────────────────

SERVER_IP=""
LOG_ARGS=()
DOUBLE_DASH_SEEN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      echo "Usage: $0 [<server-ip>] [-- <docker-compose-logs-args>]" >&2
      echo "" >&2
      echo "Arguments before -- are treated as the server IP." >&2
      echo "Arguments after -- are forwarded to 'docker compose logs'." >&2
      echo "" >&2
      echo "Examples:" >&2
      echo "  $0                    # all services, auto-detect IP" >&2
      echo "  $0 1.2.3.4            # all services, explicit IP" >&2
      echo "  $0 -- api worker      # filter by service names" >&2
      echo "  $0 1.2.3.4 -- api     # explicit IP + service filter" >&2
      exit 0
      ;;
    --)
      DOUBLE_DASH_SEEN=true
      shift
      ;;
    *)
      if [[ "${DOUBLE_DASH_SEEN}" == "true" ]]; then
        LOG_ARGS+=("$1")
      elif [[ -z "${SERVER_IP}" ]]; then
        SERVER_IP="$1"
      else
        # If we already have an IP and haven't seen --, treat remaining args as log args.
        LOG_ARGS+=("$1")
      fi
      shift
      ;;
  esac
done

# ─── Determine server IP (if not provided explicitly) ────────────────────────

if [[ -z "${SERVER_IP}" ]]; then
  if command -v terraform &>/dev/null; then
    SERVER_IP="$(cd "${TF_DIR}" && terraform output -raw server_ipv4 2>/dev/null || true)"
  fi
fi

if [[ -z "${SERVER_IP}" ]]; then
  echo "ERROR: No server IP provided." >&2
  echo "" >&2
  echo "Usage: $0 [<server-ip>] [-- <docker-compose-logs-args>]" >&2
  echo "  Or run from the terraform directory to auto-detect:" >&2
  echo "    cd infra/hetzner && terraform output -raw server_ipv4" >&2
  echo "" >&2
  echo "terraform not found in PATH; provide server IP as argument: $0 <ip>" >&2
  exit 1
fi

# ─── Stream logs ─────────────────────────────────────────────────────────────

echo "==> Streaming logs from ${SERVER_IP}..."

CMD="docker compose -f /opt/herobids/docker-compose.yaml -f /opt/herobids/docker-compose.prod.yaml logs -f"
if [[ ${#LOG_ARGS[@]} -gt 0 ]]; then
  echo "    Filtering by: ${LOG_ARGS[*]}"
  CMD="${CMD} ${LOG_ARGS[*]}"
fi
ssh -t "root@${SERVER_IP}" "${CMD}"
