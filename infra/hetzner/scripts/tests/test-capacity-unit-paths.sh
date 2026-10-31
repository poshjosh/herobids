#!/usr/bin/env bash
# test-capacity-unit-paths.sh — every systemd unit that runs the autoscale
# scripts can write the capacity state directory (H4).
#
# Static check over infra/hetzner/cloud-init.yaml. Each unit body is extracted
# from its `- path: /etc/systemd/system/<name>.service` entry. Units whose
# ExecStart runs scale-out.sh, scale-in.sh or check-placement-failures.sh must
# list /var/lib/herobids-autoscale as a ReadWritePaths token. Without it,
# ProtectSystem=strict makes the in-flight record unwritable and the
# capacity guard fails closed on every run.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-unit-paths.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

CLOUD_INIT="${TESTS_DIR}/../../cloud-init.yaml"
STATE_DIR="/var/lib/herobids-autoscale"
UNITS_DIR="${TEST_TMPDIR}/units"
mkdir -p "${UNITS_DIR}"

# Writes each service unit body to UNITS_DIR/<name>.service.
extract_units() {
  awk -v dir="${UNITS_DIR}" '
    /^  - path: \/etc\/systemd\/system\/.*\.service$/ {
      name = $3
      sub(".*/", "", name)
      out = dir "/" name
      printf "" > out
      next
    }
    /^  - path: / { out = ""; next }
    out != "" { print >> out }
  ' "${CLOUD_INIT}"
}

# unit_paths_has <unit-file> <path> — true when the path is a whole token of a
# ReadWritePaths= line (so /var/lib/herobids-autoscale-other does not match).
unit_paths_has() {
  local unit="$1" want="$2" line
  while IFS= read -r line; do
    local value="${line#*=}"
    local token
    for token in ${value}; do
      [[ "${token}" == "${want}" ]] && return 0
    done
  done < <(grep -E '^[[:space:]]*ReadWritePaths=' "${unit}" || true)
  return 1
}

# ═════════════════════════════════════════════════════════════════════════════

test_begin "capacity unit paths: cloud-init.yaml can be parsed into service units (non-vacuous)"

assert_success "cloud-init.yaml exists" test -f "${CLOUD_INIT}"
extract_units
UNIT_COUNT="$(find "${UNITS_DIR}" -name '*.service' | wc -l | tr -d ' ')"
assert_eq "$(( UNIT_COUNT >= 3 ))" "1" "at least three service units are extracted"
assert_success "the autoscale service unit is extracted" test -f "${UNITS_DIR}/nomad-autoscale.service"

test_end || SUITE_FAILED=1

test_begin "capacity unit paths: the set of units that run the scale scripts is the expected set"

SCRIPTED=""
for unit in "${UNITS_DIR}"/*.service; do
  [[ -e "${unit}" ]] || continue
  if grep -qE '^[[:space:]]*ExecStart=.*/(scale-out|scale-in|check-placement-failures)\.sh' "${unit}"; then
    SCRIPTED+="$(basename "${unit}") "
  fi
done
SCRIPTED="${SCRIPTED% }"

assert_eq "${SCRIPTED}" \
  "nomad-autoscale.service nomad-placement-failure-watcher.service nomad-scale-in.service" \
  "exactly the autoscale, placement watcher and scale-in units run the scale scripts"

test_end || SUITE_FAILED=1

test_begin "capacity unit paths: every unit that runs a scale script lists the state dir in ReadWritePaths (H4)"

for name in nomad-autoscale nomad-placement-failure-watcher nomad-scale-in; do
  unit="${UNITS_DIR}/${name}.service"
  if [[ -f "${unit}" ]] && unit_paths_has "${unit}" "${STATE_DIR}"; then
    _pass "${name}.service lists ${STATE_DIR} in ReadWritePaths"
  else
    _fail "${name}.service lists ${STATE_DIR} in ReadWritePaths" \
      "expected a ReadWritePaths token: ${STATE_DIR}" \
      "  actual: $(grep -E '^[[:space:]]*ReadWritePaths=' "${unit}" 2>/dev/null || echo '(no ReadWritePaths line)')"
  fi
done

test_end || SUITE_FAILED=1

test_begin "capacity unit paths: the state dir check matches whole tokens only"

PROBE="${TEST_TMPDIR}/probe.service"
printf 'ReadWritePaths=/var/run /var/lib/herobids-autoscale-other\n' > "${PROBE}"
assert_failure "a longer sibling path does not satisfy the state dir" unit_paths_has "${PROBE}" "${STATE_DIR}"
printf 'ReadWritePaths=/var/run %s\n' "${STATE_DIR}" > "${PROBE}"
assert_success "the exact state dir token satisfies the check" unit_paths_has "${PROBE}" "${STATE_DIR}"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════

echo ""
echo "═══ Capacity unit paths suite complete ═══"
exit "${SUITE_FAILED:-0}"
