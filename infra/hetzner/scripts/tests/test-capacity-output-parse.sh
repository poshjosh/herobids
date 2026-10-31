#!/usr/bin/env bash
# test-capacity-output-parse.sh — parse_capacity_output (scale-common.sh) must
# accept only plain key=value capacity lines and refuse anything else without
# evaluating it. Each malicious line writes a marker file if it were executed;
# the marker must never appear.
#
# Run: bash infra/hetzner/scripts/tests/test-capacity-output-parse.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${TESTS_DIR}/test-harness.sh"

TEST_TMPDIR="$(create_test_tmpdir)"
trap 'rm -rf "${TEST_TMPDIR}"' EXIT

source "${TESTS_DIR}/source-helper.sh"

MARKER="${TEST_TMPDIR}/executed"
GOOD='free_memory_mb=50
free_memory_pct=5
free_slots=0
ready_nodes=2'

# parse_result TEXT — sets PARSE_RC to the parser's exit status.
parse_result() {
  if parse_capacity_output "$1"; then
    PARSE_RC=0
  else
    PARSE_RC=1
  fi
}

test_begin "capacity output: well-formed output is parsed"

parse_result "${GOOD}"
assert_eq "${PARSE_RC}" "0" "plain key=value output is accepted"
assert_eq "${CAP_FREE_MEMORY_MB}" "50" "free_memory_mb is read"
assert_eq "${CAP_FREE_MEMORY_PCT}" "5" "free_memory_pct is read"
assert_eq "${CAP_FREE_SLOTS}" "0" "free_slots is read"
assert_eq "${CAP_READY_NODES}" "2" "ready_nodes is read"

parse_result "${GOOD}
total_memory_mb=4096
agent_memory_reservation_mb=2048"
assert_eq "${PARSE_RC}" "0" "allowlisted extra keys are accepted"

test_end || SUITE_FAILED=1

test_begin "capacity output: malicious lines are refused without execution"

parse_result "${GOOD}
free_slots=\$(touch ${MARKER})"
assert_eq "${PARSE_RC}" "1" "command substitution in a value is refused"

parse_result "${GOOD}
free_slots=1;touch ${MARKER}"
assert_eq "${PARSE_RC}" "1" "semicolon-chained command is refused"

parse_result "${GOOD}
free_slots=1 && touch ${MARKER}"
assert_eq "${PARSE_RC}" "1" "and-chained command is refused"

parse_result "${GOOD}
free_slots=\`touch ${MARKER}\`"
assert_eq "${PARSE_RC}" "1" "backtick substitution is refused"

parse_result "${GOOD}
free_slots=\$HOME"
assert_eq "${PARSE_RC}" "1" "parameter expansion in a value is refused"

parse_result "${GOOD}
evil_key=1"
assert_eq "${PARSE_RC}" "1" "a key outside the allowlist is refused"

parse_result "${GOOD}
FREE_SLOTS=5"
assert_eq "${PARSE_RC}" "1" "an upper-case key is refused"

parse_result "${GOOD}
[DRY-RUN] dry_run=true"
assert_eq "${PARSE_RC}" "1" "the dry-run marker line is refused"

parse_result "${GOOD}
free_slots = 1"
assert_eq "${PARSE_RC}" "1" "spaces around the equals sign are refused"

assert_eq "$(test -e "${MARKER}" && echo present || echo absent)" "absent" \
  "no malicious line ever executed its payload"

test_end || SUITE_FAILED=1

test_begin "capacity output: incomplete or empty output is refused"

parse_result "free_memory_mb=50
free_memory_pct=5
ready_nodes=2"
assert_eq "${PARSE_RC}" "1" "output missing free_slots is refused"

parse_result ""
assert_eq "${PARSE_RC}" "1" "empty output is refused"

test_end || SUITE_FAILED=1

test_begin "capacity output: numeric keys accept only unsigned integers"

parse_result "free_memory_mb=50
free_memory_pct=5
free_slots=abc
ready_nodes=2"
assert_eq "${PARSE_RC}" "1" "free_slots=abc is refused"

parse_result "free_memory_mb=50
free_memory_pct=5
free_slots=ready_nodes
ready_nodes=2"
assert_eq "${PARSE_RC}" "1" "free_slots=ready_nodes is refused"

parse_result "free_memory_mb=50
free_memory_pct=5
free_slots=0x1F
ready_nodes=2"
assert_eq "${PARSE_RC}" "1" "free_slots=0x1F is refused"

parse_result "free_memory_mb=50
free_memory_pct=5
free_slots=08
ready_nodes=2"
assert_eq "${PARSE_RC}" "1" "free_slots=08 (leading zero) is refused"

parse_result "${GOOD}
total_memory_mb=4096x
agent_memory_reservation_mb=2048"
assert_eq "${PARSE_RC}" "1" "non-integer allowlisted extra key is refused"

parse_result "free_memory_mb=0
free_memory_pct=0
free_slots=0
ready_nodes=0"
assert_eq "${PARSE_RC}" "0" "zero is an accepted unsigned integer"

test_end || SUITE_FAILED=1

test_begin "capacity output: numbers are bounded to nine digits and free_memory_pct to 0-100"

parse_result "free_memory_mb=50
free_memory_pct=5
free_slots=12345678901234567890123
ready_nodes=2"
assert_eq "${PARSE_RC}" "1" "a 23-digit free_slots is refused"
assert_eq "${CAP_FREE_SLOTS}" "" "a refused 23-digit free_slots leaves CAP_FREE_SLOTS empty"

parse_result "free_memory_mb=1234567890
free_memory_pct=5
free_slots=0
ready_nodes=2"
assert_eq "${PARSE_RC}" "1" "a 10-digit free_memory_mb is refused"

parse_result "free_memory_mb=999999999
free_memory_pct=100
free_slots=999999999
ready_nodes=999999999"
assert_eq "${PARSE_RC}" "0" "nine-digit values and free_memory_pct=100 are accepted"
assert_eq "${CAP_FREE_MEMORY_MB}" "999999999" "a nine-digit free_memory_mb is read"
assert_eq "${CAP_FREE_MEMORY_PCT}" "100" "free_memory_pct=100 is read"

parse_result "free_memory_mb=50
free_memory_pct=101
free_slots=0
ready_nodes=2"
assert_eq "${PARSE_RC}" "1" "free_memory_pct=101 is refused"
assert_eq "${CAP_FREE_MEMORY_PCT}" "" "a refused free_memory_pct leaves CAP_FREE_MEMORY_PCT empty"

parse_result "free_memory_mb=50
free_memory_pct=999999999
free_slots=0
ready_nodes=2"
assert_eq "${PARSE_RC}" "1" "a nine-digit free_memory_pct is refused"

test_end || SUITE_FAILED=1

test_begin "capacity output: a repeated key is refused"

parse_result "${GOOD}
free_slots=5"
assert_eq "${PARSE_RC}" "1" "a repeated key is refused rather than last-wins"

parse_result "${GOOD}
total_memory_mb=1
total_memory_mb=2"
assert_eq "${PARSE_RC}" "1" "a repeated extra allowlisted key is refused"

test_end || SUITE_FAILED=1

test_begin "capacity output: a refused parse leaves no CAP_* values behind"

parse_result "free_memory_mb=50
free_memory_pct=5
free_slots=3
evil_key=1
ready_nodes=2"
assert_eq "${PARSE_RC}" "1" "a bad line after valid lines is refused"
assert_eq "${CAP_FREE_MEMORY_MB}" "" "CAP_FREE_MEMORY_MB is cleared after refusal"
assert_eq "${CAP_FREE_MEMORY_PCT}" "" "CAP_FREE_MEMORY_PCT is cleared after refusal"
assert_eq "${CAP_FREE_SLOTS}" "" "CAP_FREE_SLOTS is cleared after refusal"
assert_eq "${CAP_READY_NODES}" "" "CAP_READY_NODES is cleared after refusal"

parse_result "free_memory_mb=50
free_slots=3
free_slots=4"
assert_eq "${CAP_FREE_SLOTS}" "" "CAP_FREE_SLOTS is cleared after a repeated-key refusal"
assert_eq "${CAP_FREE_MEMORY_MB}" "" "CAP_FREE_MEMORY_MB is cleared after a repeated-key refusal"

test_end || SUITE_FAILED=1

echo ""
echo "═══ Capacity output parse suite complete ═══"
exit "${SUITE_FAILED:-0}"
