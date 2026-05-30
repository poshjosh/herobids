# Bug Report: Missing walletAddress in HyperliquidCredentials Crashes Instance on Startup

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-05-30
- **Summary:** Trading instances using Hyperliquid crash immediately after startup because the CCXT exchange object is never told which account to query. Reconciliation's first-pass call to `fetchPositions()` throws and blocks trading permanently.

## Root Cause

`HyperliquidCredentials` only stored `apiKey` (agent wallet address) and `secret` (agent private key). CCXT's Hyperliquid integration requires a separate `walletAddress` property — the main Hyperliquid account address whose positions and balances are to be queried. Without it, any call to `fetchPositions()` or `fetchBalances()` throws:

```
hyperliquid fetchPositions() requires a user parameter inside 'params' or the wallet address set
code: "venue.exchange_error"
```

The actor performs a mandatory reconciliation pass on startup before allowing any trading. When that call fails, it logs "Reconciliation first pass inconclusive (venue fetch failed) — blocking trading", stops the actor, and marks the instance as `crashed`.

This affects both `paper` and `live` execution modes. The bug was always present but only surfaced when running the full pipeline end-to-end via the rollout script.

Hyperliquid distinguishes between two address types:

| Field          | Value                                | Purpose                          |
|---------------|--------------------------------------|----------------------------------|
| `apiKey`       | Agent/API wallet address (`0x…`)    | Used to sign orders              |
| `secret`       | Agent wallet private key             | Used to sign messages            |
| `walletAddress`| Main account address (`0x…`)        | Used to query positions/balances |

When using your main wallet key directly (not an agent key), `walletAddress` must be set to the same value as `apiKey`.

## Fix

1. **`packages/venues/src/hyperliquid.ts`** — Added required `walletAddress: string` to `HyperliquidCredentials` interface. Passes it to the CCXT constructor:
   ```typescript
   this.exchange = new ccxt.hyperliquid({
     apiKey: config.credentials.apiKey,
     secret: config.credentials.secret,
     walletAddress: config.credentials.walletAddress,
     enableRateLimit: false,
   });
   ```

2. **`apps/worker/src/index.ts`** — Extended decrypted credential type to include `walletAddress`. Added `HYPERLIQUID_WALLET_ADDRESS` env var fallback. Passes `walletAddress` to `HyperliquidAdapter`.

3. **`scripts/shell/rollout-stage-b.sh`** — Added `HYPERLIQUID_WALLET_ADDRESS` to required env checks. Included `walletAddress` field in the credential secrets JSON when creating the credential.

4. **`packages/venues/src/hyperliquid.integration.test.ts`** — Added `HYPERLIQUID_TESTNET_WALLET_ADDRESS` to the integration test env requirements.

## Files Changed

- `packages/venues/src/hyperliquid.ts`
- `apps/worker/src/index.ts`
- `scripts/shell/rollout-stage-b.sh`
- `packages/venues/src/hyperliquid.integration.test.ts`

## Verification

- `pnpm lint` passes (tsc --noEmit, no errors)
- `bash -n scripts/shell/rollout-stage-b.sh` passes (SYNTAX OK)
- Instance no longer crashes on startup once `HYPERLIQUID_WALLET_ADDRESS` is set correctly

## Notes

- Existing credentials in the DB do not have `walletAddress` stored in their encrypted blob. Re-running the rollout script will create a new credential that includes it. Old credentials will resolve `walletAddress` as `undefined` — the worker falls back to `process.env['HYPERLIQUID_WALLET_ADDRESS']`.
- If deploying to an environment where the env var fallback is not set and the credential predates this fix, the instance will still crash with the same CCXT error until the credential is rotated.
