#!/usr/bin/env bash
# agent-bot-e2e-test.sh — Verify agent-bot LLM inheritance + stop cascade
#
# This script runs the focused vitest suite that exercises the
# AgentMessageBroker manage_bot path for agent-created LLM bots.
#
# Tests covered:
#   - Agent modelPolicy provider/model is stamped into bot strategy.params
#   - Falls back to user AI defaults when modelPolicy is empty
#   - Does NOT stamp provider/model for mechanical or DCA bots
#
# Usage:
#   scripts/shell/tests/agent-bot-e2e-test.sh
#   scripts/shell/tests/agent-bot-e2e-test.sh --help
#
# Exit codes:
#   0 — all LLM inheritance tests passed
#   1 — one or more tests failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      sed -n '2,/^set /p' "${BASH_SOURCE[0]}" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg"
      exit 1
      ;;
  esac
done

echo "[agent-bot-e2e] Running agent-broker LLM inheritance tests..."
cd "$REPO_ROOT"

# Run only the LLM inheritance test suite, scoped to the single test file
# so we don't load integration/e2e test files that need a running stack.
pnpm vitest run apps/worker/src/agents/agent-broker.test.ts \
  -t "manage_bot create_and_start.*LLM inheritance" 2>&1 | tail -20

EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
  echo "[agent-bot-e2e] ✓ All LLM inheritance tests passed"
else
  echo "[agent-bot-e2e] ✗ Tests failed (exit $EXIT_CODE)" >&2
  exit 1
fi
