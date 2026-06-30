# create-agents.sh fails — "bind" action removed after connections/bindings merge

**Status:** FIXED
**Severity:** High
**Date:** 2026-06-30

## Summary

`scripts/shell/run/create-agents.sh` fails at Step 3 with HTTP 400: `Unsupported action "bind". Supported: start, stop, pause, resume`. The script called `POST /agents/:id/capabilities/trading/actions/bind` which no longer exists after the `trading_bindings` → `connections` merge (feature `docs/features/2026/06/28/002-merge-connections-bindings/`).

## Root Cause

The `connections`/`bindings` merge (2026-06-28) collapsed `trading_bindings` into `connections` and removed the separate `"bind"` action from the `/agents/:id/capabilities/trading/actions/:action` endpoint. The endpoint now only supports `start|stop|pause|resume`.

Trading capability grants are now created by passing `connectionIds` in the `POST /agents` (or `PATCH /agents/:id`) payload — the API handler automatically inserts into `agentConnections`.

Two issues in the script:
1. `POST /capabilities/trading/bindings` → renamed to `POST /capabilities/trading/connections` (fixed earlier)
2. `POST /agents/:id/capabilities/trading/actions/bind` → must use `PATCH /agents/:id` with `{ connectionIds: [...] }`

## Fix

Three changes in `scripts/shell/run/create-agents.sh`:

1. **`build_agent_payload`** — Added `$connection_id` parameter and `connectionIds: [$connectionId]` to the JSON payload so new agents automatically get the capability grant at creation time.

2. **`bind_trading_capability` → `grant_trading_capability`** — Replaced `POST /agents/:id/capabilities/trading/actions/bind` with `PATCH /agents/:id` carrying `{ connectionIds: [$connectionId] }`.

3. **`create_and_bind_agent`** — Updated variable names and log messages to reflect the "grant" terminology; passes `$connection_id` to `build_agent_payload` for new agents.

## Files Changed

- `scripts/shell/run/create-agents.sh`

## Verification

Run `create-agents.sh` against a running HeroBids instance with pre-seeded Hyperliquid + 1inch connections. The script should:
- Look up connections via `GET /capabilities/trading/connections` ✅
- Create agents with `connectionIds` in the payload ✅
- Grant trading capability for existing agents via `PATCH /agents/:id` ✅
