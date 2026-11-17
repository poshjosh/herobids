#!/usr/bin/env bash
# release-agent-image.sh — Release the agent image of the deployed commit to an environment.
#
# This is the one command the stale-pin banner (check-agent-image-pin.sh) tells you to run.
# It moves the hand-set NOMAD_AGENT_IMAGE pin to ghcr.io/poshjosh/herobids-agent:sha-<commit>
# after proving that image on a live agent node. It does not deploy code (use deploy.sh).
#
# Steps (it stops at the first failure and changes nothing until step 4):
#   1. Pick the commit: the one deployed on the server (or --sha for a rollback).
#   2. Check CI published the image (docker manifest inspect, from the control plane).
#   3. Probe the image on an agent node (probe-agent-image.sh, sandbox rows K0 to K7).
#   4. Set NOMAD_AGENT_IMAGE in infra/hetzner/.env.<env>, upload it (setup-env.sh), and
#      recreate the worker so it reads the new value. New agent launches use the image.
#   5. Optionally relaunch the running agents so they move to it too. Live-mode agents are
#      skipped (they may hold positions); include them with maintenance-restart-from-local.sh
#      --include-live.
# Staging and production use the same steps.
#
# Usage:
#   infra/hetzner/scripts/release-agent-image.sh --env <staging|production> [options] [<server-ip>]
#
# Options (after --env):
#   --dry-run       Steps 1 to 3 only: verify and probe, change nothing.
#   --sha <commit>  Release this 40-character commit instead of the deployed one. Use it to
#                   roll back: pass the previous pin's commit.
#   --relaunch      Relaunch running agents without asking.
#   --no-relaunch   Do not relaunch running agents and do not ask.
#   --yes, -y       Skip the confirmation before step 4.
#
# Examples:
#   infra/hetzner/scripts/release-agent-image.sh --env staging --dry-run
#   infra/hetzner/scripts/release-agent-image.sh --env staging
#   infra/hetzner/scripts/release-agent-image.sh --env production --sha <previous commit>
#
# Needs: ssh access to the control plane (as deploy.sh), and the control plane's key to the
# agent nodes. The pin lives in the gitignored infra/hetzner/.env.<env>; nothing here is
# committed.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="$(dirname "${SCRIPT_DIR}")"
source "${SCRIPT_DIR}/_ssh_opts.sh"
parse_env_flag "$@"
shift $((HEROBIDS_ENV_SHIFT)) 2>/dev/null || true
IMAGE_REPO="ghcr.io/poshjosh/herobids-agent"
DRY_RUN=false
SKIP_CONFIRM=false
RELAUNCH=ask
SHA=""
SERVER_IP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)     DRY_RUN=true; shift ;;
    --yes|-y)      SKIP_CONFIRM=true; shift ;;
    --relaunch)    RELAUNCH=yes; shift ;;
    --no-relaunch) RELAUNCH=no; shift ;;
    --sha)
      SHA="${2:-}"
      [[ -n "${SHA}" ]] || { echo "ERROR: --sha needs a value." >&2; exit 1; }
      shift 2 ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*)
      echo "ERROR: Unknown option: $1 (use --help)" >&2; exit 1 ;;
    *)
      [[ -z "${SERVER_IP}" ]] || { echo "ERROR: Unexpected argument: $1" >&2; exit 1; }
      SERVER_IP="$1"; shift ;;
  esac
done
if [[ -t 1 ]]; then BOLD=$'\033[1m'; RED=$'\033[1;31m'; GREEN=$'\033[1;32m'; RESET=$'\033[0m'; else BOLD=''; RED=''; GREEN=''; RESET=''; fi
step() { echo ""; echo "${BOLD}── $* ──${RESET}"; }
die()  { echo "${RED}ERROR:${RESET} $*" >&2; exit 1; }
ENV_FILE="${TF_DIR}/.env.${HEROBIDS_ENV}"
[[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} not found. It is the gitignored env file deploy.sh uploads; the pin lives there."
if [[ -z "${SERVER_IP}" ]] && command -v terraform &>/dev/null; then
  SERVER_IP="$(terraform_output -raw server_ipv4 2>/dev/null || true)"
fi
[[ -n "${SERVER_IP}" ]] || die "Could not determine the server IP. Pass it as the last argument."
# shellcheck disable=SC2086
ssh_cp() { ssh ${SSH_OPTS} "root@${SERVER_IP}" "$@"; }
env_value() { { grep -E "^$1=" "$2" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2- | tr -d "\"'[:space:]"; }
echo "${BOLD}Release agent image: ${HEROBIDS_ENV} (${SERVER_IP})${RESET}"
[[ "${DRY_RUN}" == "true" ]] && echo "DRY RUN: verify and probe only, nothing will change."
# ─── 1. Pick the commit ──────────────────────────────────────────────────────
step "1/5 Pick the commit"
if [[ -z "${SHA}" ]]; then
  SHA="$(ssh_cp 'cd /opt/herobids && git rev-parse HEAD' | tr -d '[:space:]')" || die "Could not read the deployed commit from ${SERVER_IP}."
  echo "Deployed commit on the server: ${SHA}"
else
  echo "Using --sha ${SHA}"
fi
[[ "${SHA}" =~ ^[0-9a-f]{40}$ ]] || die "Commit must be a full 40-character lowercase hex sha, got: ${SHA}"
IMAGE="${IMAGE_REPO}:sha-${SHA}"
OLD_IMAGE="$(env_value NOMAD_AGENT_IMAGE "${ENV_FILE}")"
SERVER_IMAGE="$(ssh_cp "grep -E '^NOMAD_AGENT_IMAGE=' /opt/herobids/.env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d \"'[:space:]\"" || true)"
echo "Current pin (${ENV_FILE##*/}): ${OLD_IMAGE:-<unset>}"
if [[ "${SERVER_IMAGE}" != "${OLD_IMAGE}" ]]; then
  echo "${RED}WARNING:${RESET} the server's /opt/herobids/.env has a different pin (${SERVER_IMAGE:-<unset>}). The upload in step 4 replaces it with ${ENV_FILE##*/}."
fi
if [[ "${OLD_IMAGE}" == "${IMAGE}" && "${SERVER_IMAGE}" == "${IMAGE}" ]]; then
  echo "${GREEN}Already pinned to ${IMAGE}. Nothing to release.${RESET}"
  echo "Running agents keep their image until relaunched: maintenance-restart-from-local.sh --env ${HEROBIDS_ENV} --skip-deploy"
  exit 0
fi
# ─── 2. CI image exists ──────────────────────────────────────────────────────
step "2/5 Check the image is published"
if ! ssh_cp "docker manifest inspect '${IMAGE}' >/dev/null 2>&1"; then
  die "${IMAGE} is not in GHCR. Wait for GitHub Actions \"Build and Push Agent Image\" to finish for ${SHA:0:8}, or check that it succeeded. Nothing was changed."
fi
echo "OK: ${IMAGE}"
# ─── 3. Probe on an agent node ───────────────────────────────────────────────
step "3/5 Probe the image on an agent node"
NODES="$(ssh_cp 'bash -s' <<'REMOTE'
set -euo pipefail
export NOMAD_TOKEN="$(cat /etc/nomad.d/acl-token)"
control_ip="$(hostname -I | tr ' ' '\n' | grep -E '^10\.' | head -n 1 || true)"
nomad node status -json | python3 -c '
import json, sys
nodes = json.load(sys.stdin)
def pick(node_class):
    for n in nodes:
        if n.get("NodeClass") == node_class and n.get("Status") == "ready" and n.get("SchedulingEligibility") == "eligible":
            return n["Address"]
    return "none"
print("agent=%s browser=%s" % (pick("agent"), pick("browser")), end=" ")
'
echo "control=${control_ip:-none}"
REMOTE
)" || die "Could not list Nomad nodes on the control plane."
AGENT_IP="$(sed -n 's/.*agent=\([^ ]*\).*/\1/p' <<<"${NODES}")"
BROWSER_IP="$(sed -n 's/.*browser=\([^ ]*\).*/\1/p' <<<"${NODES}")"
CONTROL_IP="$(sed -n 's/.*control=\([^ ]*\).*/\1/p' <<<"${NODES}")"
IP_PATTERN='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
[[ "${AGENT_IP}" =~ ${IP_PATTERN} ]] || die "No ready, eligible agent node found (got: ${NODES}). Cannot probe. Nothing was changed."
[[ "${CONTROL_IP}" =~ ${IP_PATTERN} ]] || die "Could not find the control plane's private IP (got: ${NODES})."
[[ "${BROWSER_IP}" == "none" || "${BROWSER_IP}" =~ ${IP_PATTERN} ]] || die "Unexpected browser node address: ${BROWSER_IP}"
echo "Probing on agent node ${AGENT_IP} (control plane ${CONTROL_IP}, browser pool ${BROWSER_IP})"
if ssh_cp "ssh -i /root/.ssh/deploy_key -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@${AGENT_IP} 'bash -s -- ${IMAGE} ${CONTROL_IP} ${BROWSER_IP}'" < "${SCRIPT_DIR}/probe-agent-image.sh"; then
  echo "${GREEN}Probe passed.${RESET}"
else
  die "The probe failed (rows above). Do NOT release this image. The pin was not changed. Fix the image, or release a different commit with --sha."
fi
if [[ "${DRY_RUN}" == "true" ]]; then
  echo ""
  echo "${GREEN}DRY RUN complete.${RESET} A real run would set NOMAD_AGENT_IMAGE=${IMAGE} in ${ENV_FILE##*/}, upload it, and recreate the worker."
  exit 0
fi
# ─── 4. Move the pin ─────────────────────────────────────────────────────────
step "4/5 Move the pin"
echo "  from: ${OLD_IMAGE:-<unset>}"
echo "    to: ${IMAGE}"
echo "This uploads ${ENV_FILE##*/} to ${SERVER_IP} and recreates the worker container (a few seconds)."
if [[ "${SKIP_CONFIRM}" != "true" ]]; then
  read -rp "Continue? [y/N] " CONFIRM
  [[ "${CONFIRM}" =~ ^[Yy] ]] || { echo "Aborted. Nothing was changed."; exit 0; }
fi
BACKUP="$(mktemp)"
trap 'rm -f "${BACKUP}"' EXIT
cp "${ENV_FILE}" "${BACKUP}"
restore_env_file() { cat "${BACKUP}" > "${ENV_FILE}"; echo "Restored ${ENV_FILE##*/} to its previous content."; }
NEW_FILE="$(mktemp)"
awk -v new="NOMAD_AGENT_IMAGE=${IMAGE}" '
  /^NOMAD_AGENT_IMAGE=/ { if (!done) { print new; done = 1 }; next }
  { print }
  END { if (!done) print new }
' "${ENV_FILE}" > "${NEW_FILE}"
cat "${NEW_FILE}" > "${ENV_FILE}"
rm -f "${NEW_FILE}"
if ! "${SCRIPT_DIR}/setup-env.sh" --env "${HEROBIDS_ENV}" "${SERVER_IP}" --file "${ENV_FILE}"; then
  restore_env_file
  die "Upload failed. The server's env file was not changed."
fi
echo "Recreating the worker so it reads the new value..."
if ! ssh ${SSH_OPTS} "root@${SERVER_IP}" COMPOSE_OVERLAY="${COMPOSE_OVERLAY}" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/herobids
# Same NPM_TOKEN handling as push.sh: compose reads it for the build secret definition.
if [[ -z "${NPM_TOKEN:-}" ]]; then
  NPM_TOKEN="$(grep -E '^NPM_TOKEN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
fi
export NPM_TOKEN
docker compose -f docker-compose.yaml -f "${COMPOSE_OVERLAY}" up -d --force-recreate --no-deps worker
REMOTE
then
  die "Could not recreate the worker. The env file on the server already has the new pin; re-run this command, or run: docker compose up -d --force-recreate --no-deps worker (on the server)."
fi
ACTUAL=""
for _ in $(seq 1 20); do
  ACTUAL="$(ssh ${SSH_OPTS} "root@${SERVER_IP}" COMPOSE_OVERLAY="${COMPOSE_OVERLAY}" \
    'cd /opt/herobids && docker compose -f docker-compose.yaml -f "${COMPOSE_OVERLAY}" exec -T worker printenv NOMAD_AGENT_IMAGE' 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "${ACTUAL}" == "${IMAGE}" ]] && break
  sleep 2
done
[[ "${ACTUAL}" == "${IMAGE}" ]] || die "The worker reports NOMAD_AGENT_IMAGE='${ACTUAL}', expected ${IMAGE}. Check: docker compose logs worker (on the server)."
echo "${GREEN}Worker is running with ${IMAGE}.${RESET} New agent launches use it."
# ─── 5. Relaunch running agents ──────────────────────────────────────────────
step "5/5 Move running agents to the new image"
echo "Running agents keep their old image until relaunched. A relaunch stops and restarts each"
echo "running agent (live-mode agents are skipped; add --include-live via maintenance-restart-from-local.sh)."
if [[ "${RELAUNCH}" == "ask" ]]; then
  read -rp "Relaunch running agents now? [y/N] " ANSWER
  [[ "${ANSWER}" =~ ^[Yy] ]] && RELAUNCH=yes || RELAUNCH=no
fi
if [[ "${RELAUNCH}" == "yes" ]]; then
  "${SCRIPT_DIR}/maintenance-restart-from-local.sh" --env "${HEROBIDS_ENV}" --skip-deploy --yes "${SERVER_IP}"
else
  echo "Skipped. Relaunch later with:"
  echo "  infra/hetzner/scripts/maintenance-restart-from-local.sh --env ${HEROBIDS_ENV} --skip-deploy"
fi
echo ""
ssh_cp "cd /opt/herobids && HEROBIDS_ENV=${HEROBIDS_ENV} infra/hetzner/scripts/check-agent-image-pin.sh" || true
echo ""
echo "${GREEN}Released ${IMAGE} to ${HEROBIDS_ENV}.${RESET}"
if [[ "${OLD_IMAGE}" =~ :sha-[0-9a-f]{40}$ ]]; then
  echo "Roll back with: infra/hetzner/scripts/release-agent-image.sh --env ${HEROBIDS_ENV} --sha ${OLD_IMAGE##*:sha-}"
fi
