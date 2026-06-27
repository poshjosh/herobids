# Bot Trade Test: Only Supports Hyperliquid Venue

**Status:** FIXED
**Severity:** High
**Date:** 2026-06-27

## Summary

The `bot-trade-test.sh` script (`scripts/ts/bot-trade-test.ts`) immediately fails with `Unsupported VENUE: 1inch. Supported: hyperliquid` when the environment is configured for 1inch (or bybit). The `venueSecrets()` function only had a branch for Hyperliquid, and the rest of the script was hardcoded for perpetual futures (BTC-PERP symbol, Hyperliquid-specific API payloads).

## Root Cause

Three interrelated issues in `scripts/ts/bot-trade-test.ts`:

1. **`venueSecrets()` only supported Hyperliquid** — Missing branches for `bybit` (requires `BYBIT_API_KEY`, `BYBIT_SECRET`) and `1inch` (requires `ONEINCH_API_KEY`, `ONEINCH_PRIVATE_KEY`).

2. **Provider-link payload format mismatched the API** — The script spread `...secrets` at the top level of the request body and used `credentialLabel` instead of `label`. The API expects `{ provider, label, secrets: {...}, capability }` per `SetupProviderLinkSchema`. Also, the response was parsed as `linkRes.body.tradingBindingId` but the API returns `response.tradingBinding.id`.

3. **Bot creation was hardcoded for perpetual futures** — The symbol `BTC-PERP` is invalid for swap venues (1inch), which require BASE/QUOTE format (e.g., `WETH/USDC`). Swap venues also require `swapAssets` (base/quote token metadata) for token resolution.

## Fix

### 1. Added venue secrets support for bybit and 1inch

Added branches mirroring `agent-trade-test.ts`:
- **bybit**: `BYBIT_API_KEY`, `BYBIT_SECRET`
- **1inch**: `ONEINCH_API_KEY`, `ONEINCH_PRIVATE_KEY`

### 2. Fixed provider-link payload and response parsing

- Request body: `{ provider, label, secrets, capability: 'trading' }` (was `{ provider, credentialLabel, ...secrets }`)
- Response parsing: `linkRes.body.tradingBinding?.id` (was `linkRes.body.tradingBindingId`)

### 3. Made bot creation venue-aware

- Symbol: `WETH/USDC` for 1inch, `BTC-PERP` for other venues
- Added `swapAssets` inside `config` for 1inch (NOT at top level — `CreateInstanceSchema` uses `.strict()` and rejects unrecognized top-level keys)

## Files Changed

1. **`scripts/ts/bot-trade-test.ts`**
   - `venueSecrets()`: Added `bybit` and `1inch` branches
   - Provider-link `post()` call: Fixed body format and response parsing
   - Bot creation: Venue-aware symbol; `swapAssets` placed inside `config` (where `BotConfigSchema` expects it)

## Verification

- The `venueSecrets()` function now handles all three supported venues identically to `agent-trade-test.ts`.
- Provider-link payload matches `SetupProviderLinkSchema` (`{ provider, label, secrets, capability }`).
- Bot symbol for 1inch uses BASE/QUOTE format (`WETH/USDC`), matching the swap-venue safety gate in `AgentMessageBroker.handleManageBot()`.
