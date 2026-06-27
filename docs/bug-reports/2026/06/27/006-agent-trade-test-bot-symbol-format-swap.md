# Agent Trade Test: Bot Creation Fails for Swap Venues with Invalid Symbol Format

**Status:** FIXED
**Severity:** High
**Date:** 2026-06-27

## Summary

The `agent-trade-test.sh` script (Phase 2.5: Agent bot creation) fails for swap venues (1inch) because the bot symbol `"WETH"` does not use the required BASE/QUOTE format (e.g., `"WETH/USDC"`). The broker's safety gate for swap venues rejects single-ticker symbols, causing the manage_bot message to be rejected and the bot creation to time out after 30 seconds.

## Root Cause

In `scripts/ts/agent-trade-test.ts`, line 1088:

```typescript
const botSymbol = VENUE === '1inch' ? 'WETH' : 'BTC';
```

The symbol `'WETH'` is a single ticker, but the `AgentMessageBroker.handleManageBot()` method (in `apps/worker/src/agents/agent-message-broker.ts`) enforces a safety gate for swap venues that requires symbols in BASE/QUOTE format (e.g., `"ETH/USDC"`). The validation splits on `/` and rejects symbols that don't have exactly two parts.

This check was added to prevent agents from using raw token addresses or malformed symbols for swap venues. The trade test decision already correctly uses `'WETH/USDC'` for 1inch, but the bot creation config was not updated to match.

### Worker log evidence:
```
{"level":50,"name":"agent-message-broker","messageId":"2eab4a68-d211-4404-b56f-02bf754a6b99",
"err":{"type":"Error","message":"Invalid symbol format \"WETH\". Swap venues require BASE/QUOTE format (e.g. \"ETH/USDC\" for 1inch on Base)."}}
```

## Fix

Changed the bot symbol for 1inch from `'WETH'` to `'WETH/USDC'` in the test script:

```typescript
// Before:
const botSymbol = VENUE === '1inch' ? 'WETH' : 'BTC';

// After:
const botSymbol = VENUE === '1inch' ? 'WETH/USDC' : 'BTC';
```

## Files Changed

1. **`scripts/ts/agent-trade-test.ts`** — Line 1088: Changed bot symbol for 1inch venue from `'WETH'` to `'WETH/USDC'` to comply with swap venue BASE/QUOTE format requirement.

## Verification

- The fix aligns the bot creation symbol with the trade test decision symbol (both use `'WETH/USDC'` for 1inch).
- The broker will validate the symbol against its swap-venue safety gate and accept it.
- Non-swap venues (Hyperliquid, Bybit) are unaffected — they continue to use `'BTC'`.
