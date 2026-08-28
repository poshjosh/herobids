#!/usr/bin/env bash
# run-all.sh — Run all shell script unit tests for the Hetzner infra scripts.
#
# Usage: bash infra/hetzner/scripts/tests/run-all.sh

set -euo pipefail

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OVERALL_EXIT=0

echo "═══════════════════════════════════════════════"
echo "  Hetzner Infra Shell Script Tests"
echo "═══════════════════════════════════════════════"

for test_file in "${TESTS_DIR}"/test-*.sh; do
  echo ""
  echo "▶ Running: $(basename "${test_file}")"
  echo "─────────────────────────────────────────────"
  if bash "${test_file}"; then
    echo "  ✓ $(basename "${test_file}") passed"
  else
    echo "  ✗ $(basename "${test_file}") had failures"
    OVERALL_EXIT=1
  fi
done

echo ""
echo "═══════════════════════════════════════════════"
if [[ ${OVERALL_EXIT} -eq 0 ]]; then
  echo "  All test suites passed"
else
  echo "  Some test suites had failures"
fi
echo "═══════════════════════════════════════════════"

exit ${OVERALL_EXIT}
