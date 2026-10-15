#!/usr/bin/env bash
# connection-cycle-test.sh — connection cycle on the local stack, without the browser form.
# Needs the API on API_BASE_URL (default http://localhost:3000) with the traderton
# boundary up. Each run creates one test user and one agent. Exit 0 = pass.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "${ROOT}"
exec npx tsx scripts/ts/run-connection-cycle.ts
