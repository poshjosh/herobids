# Bug Report: Stale Credential Blob Missing walletAddress Causes Crash on Re-run

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-05-30
- **Summary:** After bug 001 added `walletAddress` to the Hyperliquid adapter, existing credentials stored in PostgreSQL still contained the old encrypted blob (only `apiKey` + `secret`). The rollout script reused the existing credential without rotating it, so the worker decrypted a blob without `walletAddress`, passed an empty string to CCXT, and the instance crashed with the same `fetchPositions()` error.

## Root Cause

Two layered problems:

1. **Rollout script idempotency was too passive** — when it found an existing credential by label, it printed `Credential (existing): <id>` and moved on. It never re-encrypted the secrets with the updated field set.

2. **Worker trusted the decrypted blob unconditionally** — the type assertion `as { apiKey: string; secret: string; walletAddress: string }` made `walletAddress` appear required, but old blobs yielded `undefined` at runtime. No fallback to the env var `HYPERLIQUID_ACCOUNT_ADDRESS`.

## Error

```json
{
  "level": 50,
  "name": "actor-7d7937fb...",
  "err": {
    "message": "hyperliquid fetchPositions() requires a user parameter inside 'params' or the wallet address set",
    "code": "venue.exchange_error"
  },
  "msg": "Failed to fetch venue positions"
}
```

Followed by: `"Reconciliation first pass inconclusive (venue fetch failed) — blocking trading"` → instance marked `crashed`.

## Fix

1. **`scripts/shell/rollout-stage-b.sh`** — When an existing credential is found, rotate it via `POST /credentials/:id/rotate` with the full secrets (including `walletAddress`). This ensures the encrypted blob is always up to date regardless of when it was originally created.

   ```bash
   if [[ -n "$EXISTING_CRED_ID" ]]; then
     CRED_ID="$EXISTING_CRED_ID"
     # Rotate existing credential to ensure walletAddress is included
     curl -X POST "$API_URL/credentials/$CRED_ID/rotate" \
       -H "Content-Type: application/json" \
       -d '{ "secrets": { "apiKey": "...", "secret": "...", "walletAddress": "..." } }'
     ok "Credential (rotated): $CRED_ID"
   ```

2. **`apps/worker/src/index.ts`** — Made `walletAddress` optional in the decrypted type (`walletAddress?: string`). Falls back to the already-resolved env var value if the blob field is missing or empty:

   ```typescript
   const decrypted = JSON.parse(...) as { apiKey: string; secret: string; walletAddress?: string; testnet?: boolean };
   apiKey = decrypted.apiKey;
   secret = decrypted.secret;
   walletAddress = decrypted.walletAddress || walletAddress; // fallback to env
   ```

## Files Changed

- `scripts/shell/rollout-stage-b.sh` — rotate credential on reuse
- `apps/worker/src/index.ts` — optional walletAddress with env fallback

## Verification

After the fix, re-running `./scripts/shell/rollout-stage-b.sh --paper` shows:

```
[stage-b] Credential (rotated): 99361dcf-f1f2-4856-9d76-15bbcbbf952e
...
[18:05:48] paper | status=running | orders=0 | fills=0 | recon=none
[18:05:54] paper | status=running | orders=0 | fills=0 | recon=match (0 diffs)
[18:06:00] paper | status=running | orders=0 | fills=0 | recon=match (0 diffs)
```

Instance stays running with successful reconciliation passes.

## Lessons

- Idempotent "create-or-reuse" patterns must account for schema evolution of the stored data. When a new required field is added, existing records must be migrated or re-written.
- Defense-in-depth: the worker should always fall back to env vars for critical identity fields, even when credentials come from DB. A missing optional field shouldn't crash the system when the value is available elsewhere.
