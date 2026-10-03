#!/usr/bin/env bash
# seed-ledger-fixture.sh — DEV-ONLY UAT fixture for the trading capability ledger
# redesign (plan docs/features/2026/10/03/003-trading-capability-ledger-redesign.md).
#
# WHAT IT DOES
#   Seeds a deterministic set of trading rows into the TRADERTON database so the
#   herobids trading capability page
#     http://localhost:8090/agents/<agentId>/capabilities/trading
#   shows a populated P&L summary, Trades ledger, Decisions list, and Fills table
#   for the given agent. It writes:
#     - a CLOSED WINNING position (realized_pnl 12.34, side flat, size 0) + open/close fills
#     - a CLOSED LOSING  position (realized_pnl -20.00, side flat, size 0) + open/close fills
#     - one OPEN hyperliquid BTC long (size 0.01) — its unrealized mark is fetched
#       live by traderton (needs Hyperliquid network access; otherwise "—")
#     - two decisions whose execution_plans statuses are `completed` and `failed`,
#       plus one decision with NO execution plan ("Not executed")
#   All rows are actor_type='agent', actor_id=<agentId>, venue_account_id = the
#   agent's ready connection's resolved_venue_account_id (read from herobids pg).
#
# WHERE IT WRITES
#   The TRADERTON Postgres on host port :5433 (project `traderton_xstack`, brought
#   up by scripts/shell/run/reset-and-run-xstack.sh). The agent/connection lookup
#   reads the herobids Postgres container `herobids-postgres-1` (:5432). This is a
#   dev/UAT convenience only — it writes synthetic trading state directly to the
#   traderton DB and must never run against a shared or production database.
#
# USAGE
#   scripts/shell/run/seed-ledger-fixture.sh <agentId>
#
#   <agentId> is a herobids agent id with a READY trading connection (use a
#   paper-mode agent from the default reset-and-run-xstack.sh setup). Idempotent:
#   all rows use fixed `ledger-fix-*` ids with ON CONFLICT DO NOTHING, so re-runs
#   do not duplicate.

set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
if [[ $# -ne 1 || -z "${1:-}" ]]; then
  echo "Usage: $0 <agentId>" >&2
  echo "  <agentId>: a herobids agent id with a ready trading connection" >&2
  exit 1
fi
AGENT_ID="$1"

HEROBIDS_PG_CONTAINER="herobids-postgres-1"
TRADERTON_PROJECT="traderton_xstack"
WEB_PORT="${WEB_PORT:-8090}"

log()        { echo "[seed-ledger-fixture] $1"; }
error_exit() { echo "[seed-ledger-fixture] ERROR: $1" >&2; exit "${2:-1}"; }

command -v docker >/dev/null 2>&1 || error_exit "docker not found"

# ---------------------------------------------------------------------------
# 1. Resolve the agent's ready connection resolved_venue_account_id from the
#    herobids Postgres. Pick the first active connection with a non-null
#    resolved_venue_account_id for the agent's owner via agent_connections.
# ---------------------------------------------------------------------------
log "Resolving venue account for agent $AGENT_ID from herobids pg ($HEROBIDS_PG_CONTAINER)..."
docker ps --format '{{.Names}}' | grep -qx "$HEROBIDS_PG_CONTAINER" \
  || error_exit "herobids pg container '$HEROBIDS_PG_CONTAINER' not running (bring up with reset-and-run-xstack.sh)"

# agent_connections links an agent to grantable connections; connections holds
# resolved_venue_account_id once a trading connection is ready. Fall back to any
# ready connection owned by the agent's user if the join yields nothing.
VENUE_ACCOUNT_ID="$(docker exec "$HEROBIDS_PG_CONTAINER" psql -U herobids -d herobids -tAc "
  select c.resolved_venue_account_id
  from agent_connections ac
  join connections c on c.id = ac.connection_id
  where ac.agent_id = '${AGENT_ID}'
    and c.status = 'active'
    and c.resolved_venue_account_id is not null
  order by c.updated_at desc
  limit 1;
" 2>/dev/null | tr -d '[:space:]' || echo "")"

if [[ -z "$VENUE_ACCOUNT_ID" ]]; then
  error_exit "No ready connection with a resolved_venue_account_id found for agent '$AGENT_ID'. Ensure the agent has a ready trading connection."
fi
log "Resolved venue_account_id=$VENUE_ACCOUNT_ID"

# ---------------------------------------------------------------------------
# 2. Detect the traderton pg container (project traderton_xstack) and seed it.
# ---------------------------------------------------------------------------
TRADERTON_PG_CONTAINER="$(docker ps --filter "label=com.docker.compose.project=${TRADERTON_PROJECT}" \
  --format '{{.Names}}' | grep -i postgres | head -n1 || echo "")"
if [[ -z "$TRADERTON_PG_CONTAINER" ]]; then
  error_exit "Could not find a running traderton postgres container under project '${TRADERTON_PROJECT}' (bring up with reset-and-run-xstack.sh)."
fi
log "Using traderton pg container: $TRADERTON_PG_CONTAINER"

# Fixed timestamps keep the fixture deterministic and the "newest first" ordering
# stable: open position opened most recently, then the loser, then the winner.
# All inserts are idempotent via fixed ids + ON CONFLICT DO NOTHING.
#
# Column names below are taken verbatim from the traderton drizzle schema:
#   positions:       id, venue_account_id, actor_type, actor_id, venue, symbol,
#                    instrument_id, side, size, entry_price, realized_pnl,
#                    opened_at, closed_at, updated_at
#   fills:           id, order_id, venue_account_id, actor_type, actor_id, venue,
#                    symbol, side, quantity, price, realized_pnl_delta, filled_at
#   decisions:       id, venue_account_id, instrument_id, intent, target_size,
#                    actor_type, actor_id, created_at
#   execution_plans: id, decision_id, venue_account_id, actor_type, actor_id,
#                    venue, symbol, action, planned_orders, status, created_at,
#                    completed_at
log "Seeding ledger fixture rows into traderton pg..."
docker exec -i "$TRADERTON_PG_CONTAINER" psql -U traderton -d traderton -v ON_ERROR_STOP=1 <<SQL
begin;

-- ---- Positions -----------------------------------------------------------
-- Closed WINNING position: realized_pnl 12.34, side flat, size 0 (traderton
-- zeroes side/size on full close; entry price retained).
insert into positions
  (id, venue_account_id, actor_type, actor_id, venue, symbol, instrument_id,
   side, size, entry_price, realized_pnl, opened_at, closed_at, updated_at)
values
  ('ledger-fix-pos-win', '${VENUE_ACCOUNT_ID}', 'agent', '${AGENT_ID}',
   'hyperliquid', 'ETH-PERP', 'ETH-USD',
   'flat', '0', '2000', '12.34',
   timestamptz '2026-10-01 10:00:00+00', timestamptz '2026-10-01 12:00:00+00',
   timestamptz '2026-10-01 12:00:00+00')
on conflict (id) do nothing;

-- Closed LOSING position: realized_pnl -20.00, side flat, size 0.
insert into positions
  (id, venue_account_id, actor_type, actor_id, venue, symbol, instrument_id,
   side, size, entry_price, realized_pnl, opened_at, closed_at, updated_at)
values
  ('ledger-fix-pos-loss', '${VENUE_ACCOUNT_ID}', 'agent', '${AGENT_ID}',
   'hyperliquid', 'SOL-PERP', 'SOL-USD',
   'flat', '0', '150', '-20', 
   timestamptz '2026-10-02 09:00:00+00', timestamptz '2026-10-02 11:00:00+00',
   timestamptz '2026-10-02 11:00:00+00')
on conflict (id) do nothing;

-- OPEN hyperliquid BTC long, size 0.01 (unrealized mark fetched live by traderton).
insert into positions
  (id, venue_account_id, actor_type, actor_id, venue, symbol, instrument_id,
   side, size, entry_price, realized_pnl, opened_at, closed_at, updated_at)
values
  ('ledger-fix-pos-open', '${VENUE_ACCOUNT_ID}', 'agent', '${AGENT_ID}',
   'hyperliquid', 'BTC-PERP', 'BTC-USD',
   'long', '0.01', '60000', '0',
   timestamptz '2026-10-03 08:00:00+00', null,
   timestamptz '2026-10-03 08:00:00+00')
on conflict (id) do nothing;

-- ---- Fills ---------------------------------------------------------------
-- Winner: open (buy) then close (sell). The closing (sell) fill → Long direction
-- for the closed row; realized_pnl_delta carries the per-fill P&L.
insert into fills
  (id, order_id, venue_account_id, actor_type, actor_id, venue, symbol, side,
   quantity, price, realized_pnl_delta, filled_at)
values
  ('ledger-fix-fill-win-open', 'ledger-fix-ord-win-open', '${VENUE_ACCOUNT_ID}',
   'agent', '${AGENT_ID}', 'hyperliquid', 'ETH-PERP', 'buy',
   '0.5', '2000', null, timestamptz '2026-10-01 10:00:00+00'),
  ('ledger-fix-fill-win-close', 'ledger-fix-ord-win-close', '${VENUE_ACCOUNT_ID}',
   'agent', '${AGENT_ID}', 'hyperliquid', 'ETH-PERP', 'sell',
   '0.5', '2024.68', '12.34', timestamptz '2026-10-01 12:00:00+00')
on conflict (id) do nothing;

-- Loser: open (buy) then close (sell).
insert into fills
  (id, order_id, venue_account_id, actor_type, actor_id, venue, symbol, side,
   quantity, price, realized_pnl_delta, filled_at)
values
  ('ledger-fix-fill-loss-open', 'ledger-fix-ord-loss-open', '${VENUE_ACCOUNT_ID}',
   'agent', '${AGENT_ID}', 'hyperliquid', 'SOL-PERP', 'buy',
   '2', '150', null, timestamptz '2026-10-02 09:00:00+00'),
  ('ledger-fix-fill-loss-close', 'ledger-fix-ord-loss-close', '${VENUE_ACCOUNT_ID}',
   'agent', '${AGENT_ID}', 'hyperliquid', 'SOL-PERP', 'sell',
   '2', '140', '-20', timestamptz '2026-10-02 11:00:00+00')
on conflict (id) do nothing;

-- Open position: single open (buy) fill, no realized P&L yet.
insert into fills
  (id, order_id, venue_account_id, actor_type, actor_id, venue, symbol, side,
   quantity, price, realized_pnl_delta, filled_at)
values
  ('ledger-fix-fill-open-buy', 'ledger-fix-ord-open-buy', '${VENUE_ACCOUNT_ID}',
   'agent', '${AGENT_ID}', 'hyperliquid', 'BTC-PERP', 'buy',
   '0.01', '60000', null, timestamptz '2026-10-03 08:00:00+00')
on conflict (id) do nothing;

-- ---- Decisions + execution plans ----------------------------------------
-- Decision 1: has a COMPLETED plan → status "Done".
insert into decisions
  (id, venue_account_id, instrument_id, intent, target_size, actor_type, actor_id, created_at)
values
  ('ledger-fix-dec-done', '${VENUE_ACCOUNT_ID}', 'ETH-USD', 'go_long', '0.5',
   'agent', '${AGENT_ID}', timestamptz '2026-10-01 09:59:00+00')
on conflict (id) do nothing;

insert into execution_plans
  (id, decision_id, venue_account_id, actor_type, actor_id, venue, symbol, action,
   planned_orders, status, created_at, completed_at)
values
  ('ledger-fix-plan-done', 'ledger-fix-dec-done', '${VENUE_ACCOUNT_ID}', 'agent',
   '${AGENT_ID}', 'hyperliquid', 'ETH-PERP', 'open_long',
   '[]'::jsonb, 'completed', timestamptz '2026-10-01 09:59:30+00',
   timestamptz '2026-10-01 10:00:00+00')
on conflict (id) do nothing;

-- Decision 2: has a FAILED plan → status "Failed" (warning emphasis).
insert into decisions
  (id, venue_account_id, instrument_id, intent, target_size, actor_type, actor_id, created_at)
values
  ('ledger-fix-dec-failed', '${VENUE_ACCOUNT_ID}', 'SOL-USD', 'go_short', '2',
   'agent', '${AGENT_ID}', timestamptz '2026-10-02 08:59:00+00')
on conflict (id) do nothing;

insert into execution_plans
  (id, decision_id, venue_account_id, actor_type, actor_id, venue, symbol, action,
   planned_orders, status, created_at, completed_at)
values
  ('ledger-fix-plan-failed', 'ledger-fix-dec-failed', '${VENUE_ACCOUNT_ID}', 'agent',
   '${AGENT_ID}', 'hyperliquid', 'SOL-PERP', 'open_short',
   '[]'::jsonb, 'failed', timestamptz '2026-10-02 08:59:30+00', null)
on conflict (id) do nothing;

-- Decision 3: NO execution plan → status null → "Not executed".
insert into decisions
  (id, venue_account_id, instrument_id, intent, target_size, actor_type, actor_id, created_at)
values
  ('ledger-fix-dec-noplan', '${VENUE_ACCOUNT_ID}', 'BTC-USD', 'go_long', '0.01',
   'agent', '${AGENT_ID}', timestamptz '2026-10-03 07:59:00+00')
on conflict (id) do nothing;

commit;
SQL

log "Seed complete."
echo ""
echo "Capability page: http://localhost:${WEB_PORT}/agents/${AGENT_ID}/capabilities/trading"
