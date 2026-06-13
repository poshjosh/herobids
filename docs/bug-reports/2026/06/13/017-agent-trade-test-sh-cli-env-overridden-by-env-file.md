# 017 — agent-trade-test.sh: CLI env vars overridden by env file

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-06-13
- **Summary:** Passing `DOCKER_COMPOSE_UP=1` (or any other env var) on the command line had no effect because `source "$ENV_FILE"` with `set -a` unconditionally overwrote every variable exported from `.env.trade-test`.

## Root Cause

The shell script loads the env file with:

```bash
set -a
source "$ENV_FILE"
set +a
```

`set -a` causes every assignment in the sourced file to be exported. Because `.env.trade-test` contains `DOCKER_COMPOSE_UP=0`, sourcing it overwrote the `DOCKER_COMPOSE_UP=1` value the caller had set in the environment before invoking the script.

The subsequent `:=` default-value assignments were a no-op because the variable was already set (to `0`) by the source, so the CLI override was silently discarded.

## Fix

Capture the values of key env vars **before** sourcing the file, then re-export them **after** sourcing to restore CLI precedence. Individual named variables are used instead of `declare -A` associative arrays for bash 3.x compatibility (macOS ships bash 3.2).

```bash
# Snapshot before sourcing
_PRE_DOCKER_COMPOSE_UP_SET="${DOCKER_COMPOSE_UP+1}"
_PRE_DOCKER_COMPOSE_UP_VAL="${DOCKER_COMPOSE_UP:-}"
# ... (DOCKER_COMPOSE_DOWN, SKIP_TEARDOWN, EXECUTION_MODE, VENUE)

set -a; source "$ENV_FILE"; set +a

# Restore CLI values
[[ "$_PRE_DOCKER_COMPOSE_UP_SET" == "1" ]] && export DOCKER_COMPOSE_UP="$_PRE_DOCKER_COMPOSE_UP_VAL"
# ...
```

## Files Changed

- `scripts/shell/tests/agent-trade-test.sh`

## Verification

Running `DOCKER_COMPOSE_UP=1 scripts/shell/tests/agent-trade-test.sh` now correctly auto-starts the Docker stack instead of failing with "API is not reachable". The trade test proceeds to Phase 3 and the agent starts successfully.
