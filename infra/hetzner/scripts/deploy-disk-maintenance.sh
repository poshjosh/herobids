#!/usr/bin/env bash
# Installs and runs herobids-disk-maintenance on a control plane over SSH.
# Usage: deploy-disk-maintenance.sh --env staging|production
set -euo pipefail

ENV_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "${ENV_NAME}" in
  staging) HOST=138.199.172.202 ;;
  production) HOST=167.233.213.107 ;;
  *) echo "usage: $0 --env staging|production" >&2; exit 2 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SSH_OPTS=(-i "${HOME}/.ssh/herobids_deploy_key")
REMOTE_SCRIPT=/usr/local/sbin/herobids-disk-maintenance

scp "${SSH_OPTS[@]}" "${SCRIPT_DIR}/disk-maintenance.sh" "root@${HOST}:${REMOTE_SCRIPT}"
# shellcheck disable=SC2029 # REMOTE_SCRIPT is a constant; client-side expansion is intended
ssh "${SSH_OPTS[@]}" "root@${HOST}" \
  "chmod 0755 ${REMOTE_SCRIPT} && ${REMOTE_SCRIPT} --install && ${REMOTE_SCRIPT}"
