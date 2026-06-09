# Bug 004 — Credential rotation accepts empty walletAddress, crashes worker at runtime

**Date:** 2026-05-31  
**Severity:** Medium  
**Status:** CLOSED  
**Component:** `apps/api/src/routes/credentials.ts` (create + rotate endpoints)

## Summary

The `POST /credentials/:id/rotate` endpoint accepts a `secrets` payload with an empty `walletAddress` field without validation. The rotation succeeds and stores the encrypted credential. Later, when the worker decrypts the credential and constructs the `HyperliquidAdapter`, it passes an empty `walletAddress` to CCXT, which then fails with:

```
hyperliquid fetchPositions() requires a user parameter inside 'params' or the wallet address set
```

The instance crashes and never recovers (the same empty credential is decrypted on every restart attempt).

## Impact

- Live instance enters an unrecoverable crash loop until the credential is re-rotated with a valid walletAddress
- Violates fail-fast principle: the system accepts invalid data at write time and fails loudly at a much later read time
- In a multi-instance scenario, rotation could crash all dependent instances simultaneously

## Root Cause

The rotation endpoint (`apps/api/src/routes/credentials.ts`, line ~98) encrypts whatever `secrets` object is provided without venue-specific validation. The `RotateCredentialSchema` (in `apps/api/src/schemas.ts`) only requires `secrets: z.record(z.string())` — any key-value pairs pass.

For Hyperliquid, the required fields are:
- `apiKey` (non-empty)
- `secret` (non-empty)
- `walletAddress` (non-empty, must be a valid 0x-prefixed EVM address)

## Reproduction

```bash
# Rotate with empty walletAddress
curl -X POST http://localhost:3000/credentials/<id>/rotate \
  -H "Content-Type: application/json" \
  -d '{"secrets":{"apiKey":"0x...","secret":"...","walletAddress":""}}'
# Returns 200 {status: "rotated"} — should reject

# Worker then crashes on next start:
# "hyperliquid fetchPositions() requires a user parameter inside 'params' or the wallet address set"
```

## Proposed Fix

Add venue-aware secret validation at rotation time. Options:

**Option A (minimal):** Validate that all non-empty string values remain non-empty after rotation. The rotation endpoint already knows the venue (via credential → venue_account → venue). Add a check:

```typescript
// After parsing secrets, before encrypting:
if (venue === 'hyperliquid') {
  if (!secrets.walletAddress || !secrets.walletAddress.startsWith('0x') || secrets.walletAddress.length !== 42) {
    return reply.status(400).send({ error: 'validation_error', message: 'walletAddress must be a valid EVM address (0x + 40 hex chars)' });
  }
}
```

**Option B (general):** Add a `VenueSecretSchema` registry that defines required fields per venue. Validate against it during both creation and rotation.

## Workaround

Ensure `HYPERLIQUID_ACCOUNT_ADDRESS` is set in the environment before running any rotation commands. Re-rotate with the correct value to fix an existing bad credential.

## Regression Tests

Added to `apps/api/src/routes/credentials.test.ts`:

> **`POST /credentials (create) > rejects Hyperliquid credential with empty walletAddress`** — sends `{ walletAddress: '' }`; asserts HTTP 400, `error: 'validation_error'`, and `details` path includes `secrets.walletAddress`.

> **`POST /credentials (create) > rejects Hyperliquid credential with malformed walletAddress`** — sends `{ walletAddress: 'not-an-address' }`; asserts HTTP 400, `details` path includes `secrets.walletAddress`.

> **`POST /credentials/:id/rotate > rejects rotation with empty walletAddress for Hyperliquid`** — sends rotate payload with `{ walletAddress: '' }`; asserts HTTP 400, `error: 'validation_error'`, `details` path includes `secrets.walletAddress`, and no journal event is appended (rotation did not proceed).

These three tests together ensure that both the create and rotate paths reject invalid Hyperliquid credentials before they are encrypted and stored.
