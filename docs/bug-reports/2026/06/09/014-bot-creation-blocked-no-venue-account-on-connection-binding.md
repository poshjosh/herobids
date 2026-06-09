# 014 — Bot creation blocked: connection-based trading bindings have no sourceVenueAccountId

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-09
- **UAT reference:** I-03

---

## Summary

A user who follows the standard UI flow (create connection → bind to agent → create bot) cannot create any bot.
The "Create Bot" form dropdown shows no available trading bindings, making the form permanently un-submittable.

## Root Cause

There are two separate entity stores:

| Entity | Created by | Has `sourceVenueAccountId`? |
|---|---|---|
| `venue_accounts` | `POST /venue-accounts` | (is the source) |
| `trading_bindings` | `POST /connections` (auto-created) | `null` |

When `POST /connections` creates a trading binding it always sets `sourceVenueAccountId: null`.
The bot-creation API (`POST /bots`) requires `binding.sourceVenueAccountId !== null` in order to
populate `bots.venue_account_id NOT NULL FK`. Bindings with a null `sourceVenueAccountId` are also
filtered out by `BotsPage.tsx` before reaching the dropdown (filter: `b.sourceVenueAccountId !== null`).

The migration (0007_trading_bindings.sql) seeded existing venue accounts with corresponding
connections and bindings (with `sourceVenueAccountId` set). But all **new** connections created
after that migration produce bindings with `sourceVenueAccountId: null`.

## Fix

In `apps/api/src/routes/connections.ts`, when inserting a trading binding for a trading-capable
provider (`TRADING_CONNECTION_PROVIDERS`), also insert a companion `venue_accounts` row and
set `sourceVenueAccountId` to its ID. This mirrors what the 0007 migration did for pre-existing
venue accounts.

## Files Changed

- `apps/api/src/routes/connections.ts`

## Verification

- Navigate to `/connections` → create a new hyperliquid connection
- Navigate to `/bots` → click "Create Bot" → trading-binding dropdown now shows the new binding
- Create the bot → bot appears in list

