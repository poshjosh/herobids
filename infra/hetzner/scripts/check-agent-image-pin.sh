#!/usr/bin/env bash
# check-agent-image-pin.sh — Print a loud banner when the pinned agent image
# (NOMAD_AGENT_IMAGE) does not match the commit that is deployed.
#
# To fix a stale pin, run the command the banner prints: release-agent-image.sh. It
# probes the image on a live agent node, moves the pin and recreates the worker.
#
# Why: staging and production pin agents to an immutable
# ghcr.io/poshjosh/herobids-agent:sha-<commit> tag so a human (or a probe) decides
# when a new agent image reaches agents. The pin is only set by hand, so it goes
# stale silently while the worker and API move on. This script makes that visible.
# It never changes anything and always exits 0 (warn only).
#
# Runs ON the server, from the checked-out repo (push.sh and maintenance-restart.sh
# call it after the code is updated; deploy.sh runs it again over SSH so the banner
# is the last thing you read).
#
# Reads NOMAD_AGENT_IMAGE and RUNTIME_BACKEND from the environment, else from
# <repo>/.env (the file setup-env.sh uploads).
#
# Usage:
#   infra/hetzner/scripts/check-agent-image-pin.sh
#
# Environment:
#   HEROBIDS_ENV    staging | production. Names the environment in the banner and in the
#                   release command it prints.
#   HEROBIDS_ROOT   Repo root (default: two levels above this script's directory).
#   NO_COLOR        Set to turn off the bold too (plain text).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${HEROBIDS_ROOT:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
ENV_NAME="${HEROBIDS_ENV:-<env>}"
RELEASE_CMD="infra/hetzner/scripts/release-agent-image.sh --env ${ENV_NAME}"
# Files that make up the sandbox and the image entrypoint. Their behaviour is what the
# release command's probe checks on a live node, so list them when they changed.
SANDBOX_PATHS=(docker/Dockerfile.agent scripts/sandbox-exec.sh scripts/sandbox-egress.sh scripts/agent-entrypoint.sh)
if [[ -n "${NO_COLOR:-}" ]]; then
  ALERT=''; RESET=''
else
  ALERT=$'\033[1m'         # bold only: no colour, so it is not read as an error
  RESET=$'\033[0m'
fi
env_file_value() {
  { grep -E "^$1=" "${ROOT}/.env" 2>/dev/null || true; } | tail -n 1 | cut -d= -f2- | tr -d "\"'[:space:]"
}
# banner <line>... — full-width block in bold text. No colour: a stale pin is a
# to-do, not an error.
banner() {
  local bar line
  bar="$(printf '!%.0s' $(seq 1 78))"
  echo ""
  echo "${ALERT}${bar}${RESET}"
  for line in "$@"; do
    printf '%s%-78s%s\n' "${ALERT}" "!!  ${line}" "${RESET}"
  done
  echo "${ALERT}${bar}${RESET}"
}
# The one thing to do next, in plain text under the banner.
how_to_release() {
  cat <<EOF

TO RELEASE THE LATEST AGENT IMAGE, run this from your machine (repo root):

    ${RELEASE_CMD}

It does everything, and changes nothing unless every check passes:
  1. takes the commit deployed on ${ENV_NAME} and checks CI published its image
  2. probes that image on a live agent node (sandbox checks K0 to K7)
  3. sets NOMAD_AGENT_IMAGE in infra/hetzner/.env.${ENV_NAME}, uploads it, and
     recreates the worker (new agent launches use the image)
  4. asks whether to relaunch running agents (they keep the old image until then)
Add --dry-run to only verify and probe. If the probe fails it stops and the pin stays.
More: infra/hetzner/docs/deploy.md, "Agent image pin".
EOF
}
backend="${RUNTIME_BACKEND:-$(env_file_value RUNTIME_BACKEND)}"
if [[ "${backend}" != "nomad" ]]; then
  echo "[agent-image-pin] RUNTIME_BACKEND=${backend:-unset}: agents run the image built on this host. Nothing to check."
  exit 0
fi
image="${NOMAD_AGENT_IMAGE:-$(env_file_value NOMAD_AGENT_IMAGE)}"
if [[ -z "${image}" ]]; then
  banner \
    "AGENT IMAGE IS NOT PINNED  (${ENV_NAME})" \
    "NOMAD_AGENT_IMAGE is not set, so new agents launch on :latest." \
    "That is whatever CI built last, with no probe. Pin it." \
    "" \
    "TO FIX, RUN:  ${RELEASE_CMD}"
  how_to_release
  exit 0
fi
if [[ ! "${image}" =~ :sha-([0-9a-f]{40})$ ]]; then
  banner \
    "AGENT IMAGE PIN IS NOT A sha-<commit> TAG  (${ENV_NAME})" \
    "Pinned: ${image##*/}" \
    "Only an immutable sha tag can be compared with the deployed commit." \
    "" \
    "TO FIX, RUN:  ${RELEASE_CMD}"
  how_to_release
  exit 0
fi
pinned_sha="${BASH_REMATCH[1]}"
if ! cd "${ROOT}" 2>/dev/null || ! deployed_sha="$(git rev-parse HEAD 2>/dev/null)"; then
  echo "[agent-image-pin] Cannot read git history in ${ROOT}. Skipping the check."
  exit 0
fi
if [[ "${pinned_sha}" == "${deployed_sha}" ]]; then
  echo "[agent-image-pin] OK: agent image is pinned to the deployed commit ${deployed_sha:0:8}."
  exit 0
fi
if ! git cat-file -e "${pinned_sha}^{commit}" 2>/dev/null; then
  banner \
    "AGENT IMAGE PIN POINTS AT A COMMIT THIS CHECKOUT DOES NOT HAVE  (${ENV_NAME})" \
    "Pinned:   ${pinned_sha:0:8}" \
    "Deployed: ${deployed_sha:0:8}" \
    "Cannot tell how far behind the pin is." \
    "" \
    "TO FIX, RUN:  ${RELEASE_CMD}"
  how_to_release
  exit 0
fi
if ! git merge-base --is-ancestor "${pinned_sha}" "${deployed_sha}" 2>/dev/null; then
  banner \
    "AGENT IMAGE PIN IS NOT AN ANCESTOR OF THE DEPLOYED COMMIT  (${ENV_NAME})" \
    "Pinned:   ${pinned_sha:0:8}" \
    "Deployed: ${deployed_sha:0:8}" \
    "A rollback or another branch. Agents and worker are on different lines." \
    "" \
    "TO FIX, RUN:  ${RELEASE_CMD}"
  how_to_release
  exit 0
fi
behind="$(git rev-list --count "${pinned_sha}..${deployed_sha}")"
pinned_date="$(git log -1 --format=%cs "${pinned_sha}")"
banner \
  "AGENT IMAGE PIN IS STALE  (${ENV_NAME})" \
  "New agents launch on ${pinned_sha:0:8} (${pinned_date})." \
  "The worker and API run ${deployed_sha:0:8}, ${behind} commit(s) ahead." \
  "Agents are missing every fix and feature in those commits." \
  "" \
  "TO FIX, RUN:  ${RELEASE_CMD}"
echo ""
echo "Pinned image:  ${image}"
changed="$(git diff --name-only "${pinned_sha}" "${deployed_sha}" -- "${SANDBOX_PATHS[@]}" || true)"
if [[ -n "${changed}" ]]; then
  echo "Sandbox/entrypoint files changed since the pin (the release command probes them on a live node):"
  echo "${changed}" | sed 's/^/  /'
else
  echo "Sandbox/entrypoint files changed since the pin: none."
fi
how_to_release
exit 0
