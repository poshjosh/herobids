# Bug Report: Jupiter Manual Connection Missing venueAccountRef

**Date:** 2026-08-07
**Status:** Resolved
**Severity:** 🔴 Critical — agent crashes on startup

## Summary

When a Jupiter connection is created via the manual credential mode (user enters
their own private key through the setup form or guided setup), the resulting
`venue_accounts` row has a `credential_id` but **no `venueAccountRef`** (wallet
address). The worker's `VenueAdapterFactory.buildSwapAdapter` requires a wallet
address for Jupiter swap venues and throws `CredentialResolutionError`, crashing
the agent container.

## Reproduction

1. Create a Jupiter connection via `POST /setup/provider-link` with
   `credentialMode: 'manual'`, `capability: 'trading'`, and a valid Solana
   private key in `secrets.privateKey`.
2. Create a trading agent through the guided setup chat (or form) that uses
   this connection.
3. Start the agent.
4. **Observed:** Agent container crashes with:
   ```
   CredentialResolutionError: Venue account <id> has no venueAccountRef
   — cannot resolve wallet address for swap venue agent <id>
   ```

## Root Cause

In `apps/api/src/routes/setup.ts`, the `venueAccountRef` resolution for
`provisionTradingTarget` only handles two cases:

```typescript
venueAccountRef: generated?.wallet.address
  ?? (provider === 'hyperliquid' ? normalizedSecrets['walletAddress'] ?? null : null)
```

- **Generated wallet:** Uses `generated.wallet.address` ✓
- **Manual Hyperliquid:** Uses `normalizedSecrets['walletAddress']` ✓
- **Manual Jupiter:** Falls through to `null` ✗

For Jupiter manual mode, the private key is stored in the credential, but the
wallet address is never derived and persisted. The worker then crashes because
`buildSwapAdapter` requires `venueAccountRef` for Jupiter.

## Fix

Two-layer fix:

### Layer 1 (Root cause — `apps/api/src/routes/setup.ts`)
Derive the Solana wallet address from the base58-encoded private key when
creating a manual Jupiter connection, and persist it as `venueAccountRef`.

### Layer 2 (Defensive — `apps/worker/src/venue-adapter-factory.ts`)
If `venueAccountRef` is null for a Jupiter venue account but a credential with
a valid private key exists, derive the wallet address from the credential at
runtime rather than crashing. This handles existing broken data.

## Files Changed

| File | Change |
|------|--------|
| `packages/venues/src/solana-signer.ts` | Added `deriveSolanaAddress()` export |
| `packages/venues/src/index.ts` | Export `deriveSolanaAddress` |
| `apps/api/src/routes/setup.ts` | Derive `venueAccountRef` from private key for manual Jupiter |
| `apps/worker/src/venue-adapter-factory.ts` | Fall back to credential derivation when `venueAccountRef` missing |

## Verification

- [x] Unit test: `POST /setup/provider-link` for manual Jupiter persists a
  non-null `venueAccountRef` derived from the private key.
- [x] Unit test: `buildSwapAdapter` succeeds when `venueAccountRef` is null but
  a valid credential with a derivable private key exists.
- [x] Unit test: `buildSwapAdapter` still throws when `venueAccountRef` is null
  and no credential is linked (fail-closed for genuinely broken data).
- [x] Lint passes (`tsc --noEmit`).
- [ ] Integration test: Agent created via guided setup with Jupiter connection
  starts successfully (requires full stack).

## Test Coverage

| Test file | Test name | What it covers |
|-----------|-----------|----------------|
| `apps/api/src/routes/setup.test.ts` | `persists a derived venueAccountRef for manual Jupiter trading setup` | Root-cause: setup route derives Solana address from private key and calls `provisionTradingTarget` with non-null `venueAccountRef` |
| `apps/worker/src/venue-adapter-factory.test.ts` | `derives Jupiter wallet address from credential when venueAccountRef is null` | Defensive: worker falls back to credential derivation when persisted data is missing |
| `apps/worker/src/venue-adapter-factory.test.ts` | `throws when Jupiter venueAccountRef is null and no credential exists` | Fail-closed: worker still rejects genuinely broken data |
