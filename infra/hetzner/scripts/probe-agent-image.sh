#!/usr/bin/env bash
# probe-agent-image.sh — Probe an agent image's sandbox on a live Nomad agent node.
#
# Runs ON an agent node (release-agent-image.sh pipes it there over SSH). It runs the
# image directly with Docker the way Nomad would (NET_ADMIN and nothing else) and checks
# the sandbox behaviour from the sandbox plan, rows K0 to K7
# (docs/features/2026/11/12/001-hetzner-scale-path/sandbox-shell-access.md, S3):
#
#   K0  the image pulls and contains the sandbox scripts and the entrypoint
#   K1  with NET_ADMIN the egress marker is written
#   K2  the agent user cannot reach the control plane's private IP (Postgres, 5432)
#   K3  the agent user can reach the public internet
#   K4  the agent user can reach an allowlisted private IP (the browser pool)
#   K5  root can reach the control plane (proves K2's block is the rules, not the network)
#   K6  without NET_ADMIN a sandboxed command is refused with exit 97
#   K7  a failing rule install stops the container ("refusing to start")
#
# It checks the sandbox, not the whole agent. K8 (loopback listeners) stays a manual
# check. Exit 0 when every row passes, 1 otherwise.
#
# Usage (on the node):
#   probe-agent-image.sh <image> <control-plane-private-ip> [<browser-pool-private-ip>]
#
# Without a browser pool IP, K4 is skipped and reported as SKIP.
set -uo pipefail
IMAGE="${1:-}"
CONTROL_IP="${2:-}"
BROWSER_IP="${3:-}"
if [[ -z "${IMAGE}" || -z "${CONTROL_IP}" ]]; then
  echo "Usage: $0 <image> <control-plane-private-ip> [<browser-pool-private-ip>]" >&2
  exit 2
fi
IP_PATTERN='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
if [[ ! "${CONTROL_IP}" =~ ${IP_PATTERN} ]] || { [[ -n "${BROWSER_IP}" && "${BROWSER_IP}" != "none" ]] && [[ ! "${BROWSER_IP}" =~ ${IP_PATTERN} ]]; }; then
  echo "ERROR: IP arguments must be IPv4 addresses." >&2
  exit 2
fi
[[ "${BROWSER_IP}" == "none" ]] && BROWSER_IP=""
BROWSER_PORT="${BROWSER_PORT:-3100}"
MARKER=/run/herobids/sandbox-egress-ready
FAILED=0
report() { # <row> <PASS|FAIL|SKIP> <what> [<detail>]
  printf '  %-4s %-5s %s%s\n' "$1" "$2" "$3" "${4:+  ($4)}"
  [[ "$2" == "FAIL" ]] && FAILED=1
  return 0
}
# tcp_probe <host> <port>: prints CONNECT or BLOCKED, for use inside the container.
tcp_probe() { printf 'nc -z -w 4 %s %s >/dev/null 2>&1 && echo CONNECT || echo BLOCKED' "$1" "$2"; }
# as_agent <docker args...> -- <shell command>: run a command as the sandboxed agent user,
# the way the worker runs standard-mode commands.
as_agent() {
  local cmd="${*: -1}"
  local -a docker_args=("${@:1:$#-1}")
  timeout 60 docker run --rm --cap-add NET_ADMIN ${docker_args[@]+"${docker_args[@]}"} "${IMAGE}" \
    /usr/local/bin/sandbox-exec.sh sudo -u agent sh -c "${cmd}" 2>&1 | tail -n 1
}
as_root() {
  timeout 60 docker run --rm --cap-add NET_ADMIN "${IMAGE}" sh -c "$1" 2>&1 | tail -n 1
}
echo "Probing ${IMAGE}"
echo "  control plane ${CONTROL_IP}:5432, browser pool ${BROWSER_IP:-none}:${BROWSER_PORT}"
if ! timeout 300 docker pull "${IMAGE}" >/dev/null 2>&1; then
  report K0 FAIL "image pulls on this node" "docker pull failed; check ghcr.io login and the tag"
  echo "Result: FAIL"
  exit 1
fi
if timeout 60 docker run --rm --entrypoint sh "${IMAGE}" -c \
  'test -x /usr/local/bin/sandbox-exec.sh && test -x /usr/local/bin/sandbox-egress.sh && test -x /usr/local/bin/agent-entrypoint.sh' >/dev/null 2>&1; then
  report K0 PASS "image pulls and has the sandbox scripts and entrypoint"
else
  report K0 FAIL "image has sandbox-exec.sh, sandbox-egress.sh and agent-entrypoint.sh"
fi
if timeout 60 docker run --rm --cap-add NET_ADMIN "${IMAGE}" test -f "${MARKER}" >/dev/null 2>&1; then
  report K1 PASS "egress marker written with NET_ADMIN"
else
  report K1 FAIL "egress marker written with NET_ADMIN"
fi
result="$(as_agent "$(tcp_probe "${CONTROL_IP}" 5432)")"
[[ "${result}" == "BLOCKED" ]] && report K2 PASS "agent user blocked from control plane ${CONTROL_IP}:5432" || report K2 FAIL "agent user blocked from control plane ${CONTROL_IP}:5432" "got: ${result}"
result="$(as_agent "$(tcp_probe example.com 443)")"
[[ "${result}" == "CONNECT" ]] && report K3 PASS "agent user reaches the public internet" || report K3 FAIL "agent user reaches the public internet" "got: ${result}"
if [[ -n "${BROWSER_IP}" ]]; then
  result="$(as_agent -e "SANDBOX_ALLOWED_HOSTS=${BROWSER_IP}" "$(tcp_probe "${BROWSER_IP}" "${BROWSER_PORT}")")"
  [[ "${result}" == "CONNECT" ]] && report K4 PASS "agent user reaches the allowlisted browser pool" || report K4 FAIL "agent user reaches the allowlisted browser pool ${BROWSER_IP}:${BROWSER_PORT}" "got: ${result}"
else
  report K4 SKIP "no browser pool node found"
fi
result="$(as_root "$(tcp_probe "${CONTROL_IP}" 5432)")"
[[ "${result}" == "CONNECT" ]] && report K5 PASS "root reaches control plane (rules, not the network, did the K2 block)" || report K5 FAIL "root reaches control plane ${CONTROL_IP}:5432" "got: ${result}"
timeout 60 docker run --rm "${IMAGE}" /usr/local/bin/sandbox-exec.sh true >/dev/null 2>&1
rc=$?
[[ ${rc} -eq 97 ]] && report K6 PASS "without NET_ADMIN a sandboxed command is refused (exit 97)" || report K6 FAIL "without NET_ADMIN a sandboxed command is refused (exit 97)" "exit ${rc}"
out="$(timeout 60 docker run --rm --cap-add NET_ADMIN -e SANDBOX_AGENT_USER=nonexistent "${IMAGE}" true 2>&1)"
rc=$?
if [[ ${rc} -ne 0 && "${out}" == *"refusing to start"* ]]; then
  report K7 PASS "container refuses to start when the rules cannot install"
else
  report K7 FAIL "container refuses to start when the rules cannot install" "exit ${rc}"
fi
if [[ ${FAILED} -eq 0 ]]; then
  echo "Result: PASS"
  exit 0
fi
echo "Result: FAIL"
exit 1
