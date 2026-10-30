#!/usr/bin/env bash
# test-render-autoscale-settings.sh — Unit tests for render-autoscale-settings.sh.
#
# Covers the P1 convergence contract for demand-aware autoscale settings:
#   - defaults render the spec values (demand gate disabled);
#   - fresh render and convergence re-render over stale content are byte-identical;
#   - re-running with unchanged input is a no-op;
#   - invalid input is rejected and never overwrites the existing output;
#   - shell metacharacters in values are never executed;
#   - stale Environment= overrides in systemd units/drop-ins fail loudly;
#   - allowlisted keys in the secrets file fail with a migrate message;
#   - a final line without a trailing newline is read, not dropped.
#
# Run: bash infra/hetzner/scripts/tests/test-render-autoscale-settings.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDERER="${TESTS_DIR}/../render-autoscale-settings.sh"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

SUITE_FAILED=0

# Defaults must match the Terraform variable defaults in variables.tf.
DEFAULT_INPUT="${TEST_TMPDIR}/defaults.input"
cat > "${DEFAULT_INPUT}" << 'EOF'
NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS=2
NOMAD_DEMAND_OBSERVATION_INTERVAL_SECONDS=60
NOMAD_AUTOSCALE_DEMAND_ENABLED=false
NOMAD_NODE_PROVISIONING_TIMEOUT_SECONDS=600
NOMAD_SCALE_OUT_INCREMENT_MAX=2
EOF

EXPECTED_DEFAULT_OUTPUT="NOMAD_AUTOSCALE_DEMAND_ENABLED=false
NOMAD_SCALE_OUT_INCREMENT_MAX=2
NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS=2
NOMAD_DEMAND_OBSERVATION_INTERVAL_SECONDS=60
NOMAD_NODE_PROVISIONING_TIMEOUT_SECONDS=600
"

# Run the renderer and capture its exit code without tripping set -e. The
# secrets file is pointed at a path that does not exist so a real host's
# /etc/herobids/autoscale.env never leaks into the tests (later args win).
run_renderer() {
  local rc=0
  bash "${RENDERER}" --secrets-file "${TEST_TMPDIR}/no-secrets.env" "$@" >"${TEST_TMPDIR}/last-stdout" 2>"${TEST_TMPDIR}/last-stderr" || rc=$?
  return "${rc}"
}

# ═════════════════════════════════════════════════════════════════════════════
# Defaults and parity
# ═════════════════════════════════════════════════════════════════════════════

test_begin "Renderer: defaults and fresh-boot vs convergence parity"

FRESH_OUT="${TEST_TMPDIR}/fresh/autoscale-settings.env"
run_renderer --input "${DEFAULT_INPUT}" --output "${FRESH_OUT}" || true
assert_eq "$(cat "${FRESH_OUT}")" "${EXPECTED_DEFAULT_OUTPUT%$'\n'}" "fresh render produces the spec defaults in allowlist order"
assert_matches "$(stat -f '%Lp' "${FRESH_OUT}" 2>/dev/null || stat -c '%a' "${FRESH_OUT}")" "^644$" "settings file is mode 0644 (not the 0600 secrets file)"
assert_contains "$(cat "${FRESH_OUT}")" "NOMAD_AUTOSCALE_DEMAND_ENABLED=false" "demand-aware scale-out is disabled by default"

# Convergence: an existing host already has an older, different settings file.
CONV_OUT="${TEST_TMPDIR}/conv/autoscale-settings.env"
mkdir -p "$(dirname "${CONV_OUT}")"
cat > "${CONV_OUT}" << 'EOF'
NOMAD_AUTOSCALE_DEMAND_ENABLED=true
NOMAD_SCALE_OUT_INCREMENT_MAX=5
NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS=9
NOMAD_DEMAND_OBSERVATION_INTERVAL_SECONDS=30
NOMAD_NODE_PROVISIONING_TIMEOUT_SECONDS=1200
EOF
run_renderer --input "${DEFAULT_INPUT}" --output "${CONV_OUT}" || true
assert_contains "$(cat "${TEST_TMPDIR}/last-stdout")" "written" "re-render over stale content reports a write"
assert_success "fresh and convergence outputs are byte-identical" cmp -s "${FRESH_OUT}" "${CONV_OUT}"

# Second run with unchanged input must be a no-op.
run_renderer --input "${DEFAULT_INPUT}" --output "${CONV_OUT}" || true
assert_contains "$(cat "${TEST_TMPDIR}/last-stdout")" "unchanged" "re-running with unchanged input is a no-op"

# Input order must not change the rendered bytes.
REORDERED_INPUT="${TEST_TMPDIR}/reordered.input"
cat > "${REORDERED_INPUT}" << 'EOF'
NOMAD_SCALE_OUT_INCREMENT_MAX=2
NOMAD_NODE_PROVISIONING_TIMEOUT_SECONDS=600
NOMAD_AUTOSCALE_DEMAND_ENABLED=false
NOMAD_DEMAND_OBSERVATION_INTERVAL_SECONDS=60
NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS=2
EOF
REORDER_OUT="${TEST_TMPDIR}/reorder/autoscale-settings.env"
run_renderer --input "${REORDERED_INPUT}" --output "${REORDER_OUT}" || true
assert_success "input key order does not change rendered output" cmp -s "${FRESH_OUT}" "${REORDER_OUT}"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Invalid input rejected; existing output untouched
# ═════════════════════════════════════════════════════════════════════════════

test_begin "Renderer: invalid input is rejected and never overwrites output"

GOOD_OUT="${TEST_TMPDIR}/invalid/autoscale-settings.env"
mkdir -p "$(dirname "${GOOD_OUT}")"
printf 'SENTINEL=keep\n' > "${GOOD_OUT}"

# assert_rejected <description> <input-content> <expected-message-fragment>
assert_rejected() {
  local desc="$1" content="$2" fragment="$3" input rc=0
  input="${TEST_TMPDIR}/bad.input"
  printf '%s' "${content}" > "${input}"
  run_renderer --input "${input}" --output "${GOOD_OUT}" || rc=$?
  assert_neq "${rc}" "0" "${desc}: exits non-zero"
  assert_contains "$(cat "${TEST_TMPDIR}/last-stderr")" "${fragment}" "${desc}: error names the problem"
  assert_eq "$(cat "${GOOD_OUT}")" "SENTINEL=keep" "${desc}: existing output left untouched"
}

VALID_LINES="NOMAD_AUTOSCALE_DEMAND_ENABLED=false
NOMAD_SCALE_OUT_INCREMENT_MAX=2
NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS=2
NOMAD_DEMAND_OBSERVATION_INTERVAL_SECONDS=60
NOMAD_NODE_PROVISIONING_TIMEOUT_SECONDS=600
"

assert_rejected "unknown key" "${VALID_LINES}UNKNOWN_KEY=1
" "unknown key"
assert_rejected "duplicate key" "${VALID_LINES}NOMAD_SCALE_OUT_INCREMENT_MAX=3
" "duplicate key"
assert_rejected "missing required key" "NOMAD_AUTOSCALE_DEMAND_ENABLED=false
NOMAD_SCALE_OUT_INCREMENT_MAX=2
" "missing required key"
assert_rejected "malformed line (no =)" "${VALID_LINES}garbage
" "expected KEY=VALUE"
assert_rejected "lowercase key" "${VALID_LINES}nomad_scale_out_increment_max=2
" "expected KEY=VALUE"
assert_rejected "boolean not true/false" "$(printf '%s' "${VALID_LINES}" | sed 's/DEMAND_ENABLED=false/DEMAND_ENABLED=yes/')
" "invalid value for NOMAD_AUTOSCALE_DEMAND_ENABLED"
assert_rejected "integer zero" "$(printf '%s' "${VALID_LINES}" | sed 's/INCREMENT_MAX=2/INCREMENT_MAX=0/')
" "invalid value for NOMAD_SCALE_OUT_INCREMENT_MAX"
assert_rejected "integer with letters" "$(printf '%s' "${VALID_LINES}" | sed 's/INTERVAL_SECONDS=60/INTERVAL_SECONDS=6x/')
" "invalid value for NOMAD_DEMAND_OBSERVATION_INTERVAL_SECONDS"
assert_rejected "integer with trailing space" "$(printf '%s' "${VALID_LINES}" | sed 's/CONSECUTIVE_OBSERVATIONS=2/CONSECUTIVE_OBSERVATIONS=2 /')
" "invalid value for NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS"
assert_rejected "negative integer" "$(printf '%s' "${VALID_LINES}" | sed 's/PROVISIONING_TIMEOUT_SECONDS=600/PROVISIONING_TIMEOUT_SECONDS=-600/')
" "invalid value for NOMAD_NODE_PROVISIONING_TIMEOUT_SECONDS"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Shell metacharacters are data, never code
# ═════════════════════════════════════════════════════════════════════════════

test_begin "Renderer: shell metacharacters are never executed"

MARKER="${TEST_TMPDIR}/pwned"
INJECT_INPUT="${TEST_TMPDIR}/inject.input"
# The payload must stay literal in the fixture; the renderer must never expand it.
# shellcheck disable=SC2016
printf 'NOMAD_AUTOSCALE_DEMAND_ENABLED=$(touch %s)\n' "${MARKER}" > "${INJECT_INPUT}"
INJECT_OUT="${TEST_TMPDIR}/inject/autoscale-settings.env"
rc=0
run_renderer --input "${INJECT_INPUT}" --output "${INJECT_OUT}" || rc=$?
assert_neq "${rc}" "0" "command substitution in value is rejected"
assert_failure "injected command did not run (no marker file)" test -e "${MARKER}"
assert_failure "no output written for rejected injection" test -e "${INJECT_OUT}"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Stale Environment= overrides fail loudly
# ═════════════════════════════════════════════════════════════════════════════

test_begin "Renderer: stale Environment= overrides are detected"

SYSD="${TEST_TMPDIR}/systemd"
mkdir -p "${SYSD}/nomad-autoscale.service.d"
STALE_OUT="${TEST_TMPDIR}/stale/autoscale-settings.env"

# A drop-in pinning a different value silently loses to EnvironmentFile= at runtime,
# so the renderer must refuse rather than mask it.
printf '[Service]\nEnvironment=NOMAD_SCALE_OUT_INCREMENT_MAX=5\n' > "${SYSD}/nomad-autoscale.service.d/20-operator.conf"
rc=0
run_renderer --input "${DEFAULT_INPUT}" --output "${STALE_OUT}" --systemd-dir "${SYSD}" || rc=$?
assert_neq "${rc}" "0" "conflicting drop-in override fails"
assert_contains "$(cat "${TEST_TMPDIR}/last-stderr")" "stale override" "error names the stale override"
assert_contains "$(cat "${TEST_TMPDIR}/last-stderr")" "NOMAD_SCALE_OUT_INCREMENT_MAX=5" "error shows the stale value"
assert_failure "no settings file written when a stale override is found" test -e "${STALE_OUT}"

# An override that agrees with the input is harmless and must not block convergence.
printf '[Service]\nEnvironment=NOMAD_SCALE_OUT_INCREMENT_MAX=2\n' > "${SYSD}/nomad-autoscale.service.d/20-operator.conf"
rc=0
run_renderer --input "${DEFAULT_INPUT}" --output "${STALE_OUT}" --systemd-dir "${SYSD}" || rc=$?
assert_eq "${rc}" "0" "matching override does not block rendering"

# A conflicting value in a unit file itself is also caught.
printf '[Service]\nEnvironment="NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS=7" "FOO=bar"\n' > "${SYSD}/nomad-autoscale.service"
rc=0
run_renderer --input "${DEFAULT_INPUT}" --output "${STALE_OUT}" --systemd-dir "${SYSD}" || rc=$?
assert_neq "${rc}" "0" "conflicting value inside a unit file's quoted Environment= fails"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Secrets-file collisions fail loudly (settings must not be masked)
# ═════════════════════════════════════════════════════════════════════════════

test_begin "Renderer: allowlisted keys in the secrets file are rejected"

SECRETS="${TEST_TMPDIR}/secrets/autoscale.env"
mkdir -p "$(dirname "${SECRETS}")"
COLLIDE_OUT="${TEST_TMPDIR}/collide/autoscale-settings.env"

# The secrets file loads after the settings file, so a colliding key would win.
printf 'HCLOUD_TOKEN=x\nNOMAD_SCALE_OUT_INCREMENT_MAX=5\n' > "${SECRETS}"
rc=0
run_renderer --input "${DEFAULT_INPUT}" --output "${COLLIDE_OUT}" --secrets-file "${SECRETS}" || rc=$?
assert_neq "${rc}" "0" "secrets-file collision fails"
assert_contains "$(cat "${TEST_TMPDIR}/last-stderr")" "migrate" "collision message tells the operator to migrate"
assert_contains "$(cat "${TEST_TMPDIR}/last-stderr")" "NOMAD_SCALE_OUT_INCREMENT_MAX" "collision message names the key"
assert_failure "no settings file written on secrets collision" test -e "${COLLIDE_OUT}"

# Non-allowlisted secrets (and an absent file) must not block rendering.
printf 'HCLOUD_TOKEN=x\n' > "${SECRETS}"
rc=0
run_renderer --input "${DEFAULT_INPUT}" --output "${COLLIDE_OUT}" --secrets-file "${SECRETS}" || rc=$?
assert_eq "${rc}" "0" "non-allowlisted secrets do not block rendering"

rc=0
run_renderer --input "${DEFAULT_INPUT}" --output "${COLLIDE_OUT}" --secrets-file "${TEST_TMPDIR}/absent.env" || rc=$?
assert_eq "${rc}" "0" "absent secrets file does not block rendering"

test_end || SUITE_FAILED=1

# ═════════════════════════════════════════════════════════════════════════════
# Usage
# ═════════════════════════════════════════════════════════════════════════════

test_begin "Renderer: usage"

rc=0
run_renderer || rc=$?
assert_eq "${rc}" "2" "missing --input exits 2"
rc=0
run_renderer --input "${TEST_TMPDIR}/does-not-exist" || rc=$?
assert_eq "${rc}" "2" "nonexistent --input exits 2"
rc=0
run_renderer --input || rc=$?
assert_eq "${rc}" "2" "--input without a value exits 2 instead of crashing on shift"

# L2: a final line without a trailing newline must still be read.
NO_EOL_INPUT="${TEST_TMPDIR}/no-eol.input"
printf '%s' "$(cat "${DEFAULT_INPUT}")" > "${NO_EOL_INPUT}"
NO_EOL_OUT="${TEST_TMPDIR}/no-eol/autoscale-settings.env"
rc=0
run_renderer --input "${NO_EOL_INPUT}" --output "${NO_EOL_OUT}" || rc=$?
assert_eq "${rc}" "0" "input without trailing newline renders"
assert_eq "$(cat "${NO_EOL_OUT}")" "$(printf '%s' "${EXPECTED_DEFAULT_OUTPUT}")" "final unterminated line is kept"

# L3: an existing output with drifted mode is re-enforced to 0644 before the no-op compare.
MODE_OUT="${TEST_TMPDIR}/mode/autoscale-settings.env"
run_renderer --input "${DEFAULT_INPUT}" --output "${MODE_OUT}" || true
chmod 0600 "${MODE_OUT}"
rc=0
run_renderer --input "${DEFAULT_INPUT}" --output "${MODE_OUT}" || rc=$?
assert_eq "${rc}" "0" "re-run over drifted-mode output succeeds"
assert_contains "$(cat "${TEST_TMPDIR}/last-stdout")" "unchanged" "matching content is a no-op"
MODE_NOW="$(stat -c '%a' "${MODE_OUT}" 2>/dev/null || stat -f '%Lp' "${MODE_OUT}")"
assert_eq "${MODE_NOW}" "644" "existing output mode is re-enforced to 0644"

test_end || SUITE_FAILED=1

echo ""
echo "═══ Renderer test suites complete ═══"
exit "${SUITE_FAILED}"
