#!/usr/bin/env bash
# run-all.sh — Run all shell script unit tests for the Hetzner infra scripts.
#
# Usage: bash infra/hetzner/scripts/tests/run-all.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERALL_EXIT=0
SKIP_COUNT=0

echo "═══════════════════════════════════════════════"
echo "  Hetzner Infra Shell Script Tests"
echo "═══════════════════════════════════════════════"

for test_file in "${TESTS_DIR}"/test-*.sh; do
  echo ""
  echo "▶ Running: $(basename "${test_file}")"
  echo "─────────────────────────────────────────────"
  LOG_FILE="$(mktemp)"
  if bash "${test_file}" 2>&1 | tee "${LOG_FILE}"; then
    echo "  ✓ $(basename "${test_file}") passed"
  else
    echo "  ✗ $(basename "${test_file}") had failures"
    OVERALL_EXIT=1
  fi
  SKIP_COUNT=$((SKIP_COUNT + $(grep -c '^  SKIP:' "${LOG_FILE}" || true)))
  rm -f "${LOG_FILE}"
done

echo ""
echo "═══════════════════════════════════════════════"
if [[ ${OVERALL_EXIT} -eq 0 ]]; then
  echo "  All test suites passed"
else
  echo "  Some test suites had failures"
fi
if [[ ${SKIP_COUNT} -gt 0 ]]; then
  echo "  ${SKIP_COUNT} check(s) SKIPPED (bash ${BASH_VERSION} cannot run them; run under bash >= 4.1 for full coverage)"
fi
echo "═══════════════════════════════════════════════"

exit ${OVERALL_EXIT}
