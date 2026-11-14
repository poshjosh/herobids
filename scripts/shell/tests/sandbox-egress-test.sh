#!/usr/bin/env bash
# sandbox-egress-test.sh — behaviour of scripts/sandbox-egress.sh, no Docker or root needed.
#
# Runs the real script with stub `iptables`/`ip6tables` on PATH. The stub behaves like the
# real tool for the one case that matters here: `-d <value>` fails with "host/network not
# found" when the value is not an IP address or CIDR (iptables tries to resolve it as a
# hostname, and a Docker hostname such as "browser-pool" does not resolve).
#
# Covers bug 2026/11/14 001: a hostname in SANDBOX_ALLOWED_HOSTS must not stop the rules
# from installing, and must never become an allow rule.
#
# Exit code: 0 if all checks pass, 1 if any check fails.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
EGRESS="${EGRESS_SCRIPT:-${ROOT}/scripts/sandbox-egress.sh}"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
STUB_BIN="${TMP}/bin"
mkdir -p "${STUB_BIN}"

# Stub iptables/ip6tables: log every call; fail like the real tool on an unresolvable -d.
for tool in iptables ip6tables; do
  cat > "${STUB_BIN}/${tool}" <<'STUB'
#!/bin/sh
tool=$(basename "$0")
echo "${tool} $*" >> "${IPT_LOG}"
[ "${IPT_FAIL_ALL:-0}" = 1 ] && { echo "${tool}: forced failure" >&2; exit 1; }
prev=""
for arg in "$@"; do
  if [ "$prev" = "-d" ]; then
    case "$arg" in
      *[!0-9a-fA-F:./%]*)
        echo "${tool} v1.8.13 (nf_tables): host/network \`$arg' not found" >&2
        exit 1 ;;
    esac
  fi
  prev="$arg"
done
exit 0
STUB
  chmod +x "${STUB_BIN}/${tool}"
done

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  ✗ $1"; [ -n "${2:-}" ] && echo "      $2"; }

# run_egress <SANDBOX_ALLOWED_HOSTS value | "-" for unset> [extra env assignment]
# Sets RUN_EXIT, RUN_STDERR, IPT_CALLS (file) and MARKER_FILE for the assertions.
run_egress() {
  local hosts="$1"; shift
  RUN_DIR="$(mktemp -d "${TMP}/run.XXXXXX")"
  export IPT_LOG="${RUN_DIR}/ipt.log"
  : > "${IPT_LOG}"
  MARKER_FILE="${RUN_DIR}/sandbox-egress-ready"
  local -a env_args=(
    "PATH=${STUB_BIN}:${PATH}"
    "SANDBOX_MARKER_DIR=${RUN_DIR}"
    "SANDBOX_AGENT_USER=$(id -un)"
    "IPT_LOG=${IPT_LOG}"
  )
  [ "${hosts}" != "-" ] && env_args+=("SANDBOX_ALLOWED_HOSTS=${hosts}")
  [ $# -gt 0 ] && env_args+=("$@")
  RUN_EXIT=0
  env "${env_args[@]}" sh "${EGRESS}" 2> "${RUN_DIR}/stderr" || RUN_EXIT=$?
  RUN_STDERR="$(cat "${RUN_DIR}/stderr")"
}

has_rule() { grep -qF -- "$1" "${IPT_LOG}"; }

echo "━━━ sandbox-egress.sh ━━━"

# ─── The bug: a hostname must not stop the rules installing ───────────────────
run_egress "browser-pool"
[ "${RUN_EXIT}" -eq 0 ] && pass "hostname-only allowlist: script succeeds" \
  || fail "hostname-only allowlist: script succeeds" "exit ${RUN_EXIT}: ${RUN_STDERR}"
[ -f "${MARKER_FILE}" ] && pass "hostname-only allowlist: ready marker is written" \
  || fail "hostname-only allowlist: ready marker is written"
case "${RUN_STDERR}" in
  *"ignoring SANDBOX_ALLOWED_HOSTS entry 'browser-pool'"*) pass "hostname-only allowlist: warns that the entry is ignored" ;;
  *) fail "hostname-only allowlist: warns that the entry is ignored" "stderr: ${RUN_STDERR}" ;;
esac
has_rule "-d browser-pool" && fail "hostname is never turned into an allow rule" \
  || pass "hostname is never turned into an allow rule"

# ─── Blocking still applies when an entry is ignored ──────────────────────────
has_rule "-d 10.0.0.0/8 -j REJECT" && has_rule "-d 172.16.0.0/12 -j REJECT" \
  && has_rule "-d 192.168.0.0/16 -j REJECT" \
  && pass "private ranges are still rejected after an entry is ignored" \
  || fail "private ranges are still rejected after an entry is ignored"

# ─── Valid entries still work, mixed with a bad one ───────────────────────────
run_egress "browser-pool, 10.0.0.5 ,172.18.0.0/24,fd00::5"
[ "${RUN_EXIT}" -eq 0 ] && pass "mixed allowlist: script succeeds" \
  || fail "mixed allowlist: script succeeds" "exit ${RUN_EXIT}: ${RUN_STDERR}"
grep -qF "iptables -A HEROBIDS_SANDBOX_EGRESS -d 10.0.0.5 -j ACCEPT" "${IPT_LOG}" \
  && pass "IPv4 address is allowed" || fail "IPv4 address is allowed"
grep -qF "iptables -A HEROBIDS_SANDBOX_EGRESS -d 172.18.0.0/24 -j ACCEPT" "${IPT_LOG}" \
  && pass "IPv4 CIDR is allowed" || fail "IPv4 CIDR is allowed"
grep -qF "ip6tables -A HEROBIDS_SANDBOX_EGRESS -d fd00::5 -j ACCEPT" "${IPT_LOG}" \
  && pass "IPv6 address is allowed on ip6tables" || fail "IPv6 address is allowed on ip6tables"
if grep -E '^iptables .*-d fd00::5' "${IPT_LOG}" >/dev/null; then
  fail "IPv6 address is not added to iptables"
else
  pass "IPv6 address is not added to iptables"
fi
[ "$(printf '%s' "${RUN_STDERR}" | grep -c "ignoring SANDBOX_ALLOWED_HOSTS")" -eq 1 ] \
  && pass "an ignored entry is reported once, not once per IP family" \
  || fail "an ignored entry is reported once, not once per IP family" "stderr: ${RUN_STDERR}"

# ─── Odd input never reaches iptables ─────────────────────────────────────────
run_egress '10.0.0.5;touch /tmp/pwned,$(id),*'
[ "${RUN_EXIT}" -eq 0 ] && pass "shell metacharacters in an entry: script succeeds" \
  || fail "shell metacharacters in an entry: script succeeds" "exit ${RUN_EXIT}: ${RUN_STDERR}"
has_rule "touch" && fail "shell metacharacters in an entry: nothing reaches iptables" \
  || pass "shell metacharacters in an entry: nothing reaches iptables"

# ─── No allowlist: quiet and unchanged ────────────────────────────────────────
run_egress "-"
[ "${RUN_EXIT}" -eq 0 ] && [ -f "${MARKER_FILE}" ] && pass "no allowlist: rules install and marker is written" \
  || fail "no allowlist: rules install and marker is written" "exit ${RUN_EXIT}: ${RUN_STDERR}"
case "${RUN_STDERR}" in
  *ignoring*) fail "no allowlist: no warning" "stderr: ${RUN_STDERR}" ;;
  *) pass "no allowlist: no warning" ;;
esac

# ─── Fail closed is preserved for real iptables failures ──────────────────────
run_egress "10.0.0.5" "IPT_FAIL_ALL=1"
[ "${RUN_EXIT}" -ne 0 ] && pass "real iptables failure: script exits non-zero" \
  || fail "real iptables failure: script exits non-zero"
[ ! -f "${MARKER_FILE}" ] && pass "real iptables failure: no ready marker (fail closed)" \
  || fail "real iptables failure: no ready marker (fail closed)"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
