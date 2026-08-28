#!/usr/bin/env bash
# test-harness.sh — Minimal test harness for shell script unit tests.
#
# Provides assert helpers and test lifecycle management. Source this file
# in individual test scripts.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/test-harness.sh"
#   test_begin "my test suite"
#   assert_eq "actual" "expected" "description"
#   test_end

set -euo pipefail

# ─── State ────────────────────────────────────────────────────────────────────

_TEST_PASS=0
_TEST_FAIL=0
_TEST_SUITE=""

# ─── Colors (if stdout is a terminal) ─────────────────────────────────────────

if [[ -t 1 ]]; then
  _GREEN='\033[0;32m'
  _RED='\033[0;31m'
  _YELLOW='\033[0;33m'
  _BOLD='\033[1m'
  _RESET='\033[0m'
else
  _GREEN='' _RED='' _YELLOW='' _BOLD='' _RESET=''
fi

# ─── Lifecycle ────────────────────────────────────────────────────────────────

test_begin() {
  _TEST_SUITE="$1"
  _TEST_PASS=0
  _TEST_FAIL=0
  echo ""
  echo -e "${_BOLD}━━━ ${_TEST_SUITE} ━━━${_RESET}"
  echo ""
}

test_end() {
  local total=$(( _TEST_PASS + _TEST_FAIL ))
  echo ""
  echo -e "${_BOLD}── Results: ${_TEST_SUITE} ──${_RESET}"
  echo -e "  Total:  ${total}"
  echo -e "  ${_GREEN}Passed: ${_TEST_PASS}${_RESET}"
  if [[ ${_TEST_FAIL} -gt 0 ]]; then
    echo -e "  ${_RED}Failed: ${_TEST_FAIL}${_RESET}"
  fi
  echo ""

  if [[ ${_TEST_FAIL} -gt 0 ]]; then
    return 1
  fi
  return 0
}

# ─── Assertions ───────────────────────────────────────────────────────────────

_pass() {
  local desc="$1"
  # (( 0++ )) returns exit code 1 under set -e; || true prevents abort.
  (( _TEST_PASS++ )) || true
  echo -e "  ${_GREEN}✓${_RESET} ${desc}"
}

_fail() {
  local desc="$1"
  shift
  # (( 0++ )) returns exit code 1 under set -e; || true prevents abort.
  (( _TEST_FAIL++ )) || true
  echo -e "  ${_RED}✗${_RESET} ${desc}"
  for line in "$@"; do
    echo -e "    ${_RED}${line}${_RESET}"
  done
}

# assert_eq <actual> <expected> <description>
assert_eq() {
  local actual="$1"
  local expected="$2"
  local desc="$3"
  if [[ "${actual}" == "${expected}" ]]; then
    _pass "${desc}"
  else
    _fail "${desc}" "expected: '${expected}'" "  actual: '${actual}'"
  fi
}

# assert_neq <actual> <not_expected> <description>
assert_neq() {
  local actual="$1"
  local not_expected="$2"
  local desc="$3"
  if [[ "${actual}" != "${not_expected}" ]]; then
    _pass "${desc}"
  else
    _fail "${desc}" "expected NOT: '${not_expected}'" "  actual: '${actual}'"
  fi
}

# assert_exit_code <expected_code> <description> <command...>
# Runs the command in a subshell and checks the exit code.
assert_exit_code() {
  local expected="$1"
  local desc="$2"
  shift 2
  local actual=0
  "$@" >/dev/null 2>&1 || actual=$?
  if [[ "${actual}" -eq "${expected}" ]]; then
    _pass "${desc}"
  else
    _fail "${desc}" "expected exit code: ${expected}" "  actual exit code: ${actual}"
  fi
}

# assert_contains <haystack> <needle> <description>
assert_contains() {
  local haystack="$1"
  local needle="$2"
  local desc="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    _pass "${desc}"
  else
    _fail "${desc}" "expected to contain: '${needle}'" "  in: '${haystack}'"
  fi
}

# assert_not_contains <haystack> <needle> <description>
assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local desc="$3"
  if [[ "${haystack}" != *"${needle}"* ]]; then
    _pass "${desc}"
  else
    _fail "${desc}" "expected NOT to contain: '${needle}'" "  in: '${haystack}'"
  fi
}

# assert_matches <string> <regex> <description>
assert_matches() {
  local string="$1"
  local regex="$2"
  local desc="$3"
  if [[ "${string}" =~ ${regex} ]]; then
    _pass "${desc}"
  else
    _fail "${desc}" "expected to match regex: '${regex}'" "  actual: '${string}'"
  fi
}

# assert_success <description> <command...>
# Runs the command and asserts it exits 0.
assert_success() {
  local desc="$1"
  shift
  local rc=0
  "$@" >/dev/null 2>&1 || rc=$?
  if [[ ${rc} -eq 0 ]]; then
    _pass "${desc}"
  else
    _fail "${desc}" "expected success (exit 0)" "  actual exit code: ${rc}"
  fi
}

# assert_failure <description> <command...>
# Runs the command and asserts it exits non-zero.
assert_failure() {
  local desc="$1"
  shift
  local rc=0
  "$@" >/dev/null 2>&1 || rc=$?
  if [[ ${rc} -ne 0 ]]; then
    _pass "${desc}"
  else
    _fail "${desc}" "expected failure (exit non-zero)" "  actual exit code: 0"
  fi
}

# ─── Temp directory helper ────────────────────────────────────────────────────

# create_test_tmpdir — creates and echoes a temp directory. Caller should
# set a trap to clean it up.
create_test_tmpdir() {
  mktemp -d "${TMPDIR:-/tmp}/herobids-test-XXXXXX"
}
