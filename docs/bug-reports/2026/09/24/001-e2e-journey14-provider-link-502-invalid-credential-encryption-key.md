# Bug Report 001 — E2E Journey 14 fails: provider-link 502 due to invalid `CREDENTIAL_ENCRYPTION_KEY`

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-09-24
- **Environment:** development; local docker compose cross-stack (`run-all-tests.sh --e2e`)
- **Discovered by:** `scripts/shell/tests/run-all-tests.sh --e2e`

## Summary

E2E Journey 14 (`tests/e2e/journeys/14-create-agent-setup-escape-hatch.spec.ts`)
failed at the assertion after `Connect AI agent` — the `ProviderSetupForm`
("Connect agent to external platform") never closed:

```
Error: expect(locator).not.toBeVisible() failed
Locator: locator('div').filter({ hasText: /^Connect agent to external platform$/ }).first()
Expected: not visible
Received: visible
```

21 of 25 Playwright tests passed; Journey 14 was the sole failure. Every other
tier (unit, integration, functional, and all four API smokes) passed. These
smokes do **not** exercise the trading `POST /setup/provider-link` path, so the
defect was invisible until the E2E tier.

## Root Cause

Cross-stack trading provisioning in herobids now flows through the Traderton
REST boundary: `POST /setup/provider-link` → `createTradingProviderLink`
(`apps/api/src/routes/setup.ts`) → boundary tool `provision_venue_account`
(`traderton/packages/worker/src/tools/provisioning.ts`).

That tool encrypts the supplied credential secrets using
`getEncryptionKey()` (`traderton/packages/worker/src/crypto.ts`), which
**fail-fasts unless `CREDENTIAL_ENCRYPTION_KEY` is exactly 64 hex chars
(32 bytes)**:

```ts
export function getEncryptionKey(): string {
  const key = process.env['CREDENTIAL_ENCRYPTION_KEY'];
  if (!key || key.length !== 64) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY env var must be set (64 hex chars = 32 bytes)');
  }
  return key;
}
```

The traderton repo's `.env` (and its committed `.env.example`) carried the
placeholder:

```
CREDENTIAL_ENCRYPTION_KEY=changeme-32-byte-encryption-key
```

That string is **31 characters long**, so the length guard throws at provision
time. The provision tool catches this and returns `success:false, fault:true,
errorCode:'provision.encryption_unavailable'`. The boundary's `mapToolResult`
maps a non-retryable internal fault to a closed-union `internal.non_retryable`
failure; the herobids client maps that to a `failure` result, and
`createTradingProviderLink` translates it to `{ kind: 'fault', code:
'setup.provider_link_failed' }` → HTTP **502**. The frontend mutation rejects,
so the setup modal never closes.

Critically, the boundary **still reaches `/health/ready`** — the encryption key
is only read at provision time, not at startup — so `ensure_boundary_up` went
green and the failure did not surface until the very end of the flow. This is
why the migration-era docs (which gates on `/health/ready`) did not catch it.

The heroidbids-side `CREDENTIAL_ENCRYPTION_KEY` values (`herobids/.env`,
`.env.ops.dev`, `infra/hetzner/.env.*`) are all correct 64-hex values — **only
traderton** carried the placeholder. The keys need not *match* across the two
repos (each side encrypts/decrypts only its own at-rest data); each must simply
be a valid 64-hex value.

## Fix

1. **`traderton/.env`** — replaced the invalid placeholder with a valid
   64-hex (32-byte) key.
2. **`traderton/.env.example`** — the committed, self-documenting twin: left
   the value **blank** (the `.example` convention for a real secret) and
   replaced the misleading `changeme-32-byte-encryption-key` placeholder with a
   comment explaining the 64-hex requirement + a generation command
   (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`),
   so a future operator cannot copy the invalid value again.

This is a pure configuration fix — the `.example` twin was updated in the same
change per the env-twin rule (real secrets → blank/placeholder only; one inline
comment explaining the variable).

### Files Changed

- `traderton/.env`
- `traderton/.env.example`

## Verification

- Confirm the boundary's own readiness does **not** gate on the key (it is read
  lazily at provision time) — this explains why the failure surfaced only at
  E2E, and why `with-boundary.sh`'s documented troubleshooting line already
  anticipated this exact symptom ("provider-link 502 'Credential encryption
  unavailable … 64 hex chars'").
- Re-run the full suite (`scripts/shell/tests/run-all-tests.sh --e2e`) and
  confirm Journey 14 passes (provider-link returns 201, the setup modal closes,
  and the new binding is auto-selected in the Create Agent form).

## Notes / Considerations

- **Encryption key ≠ HMAC secret.** The `CREDENTIAL_ENCRYPTION_KEY` encrypts
  venue credentials at rest on the traderton side; the `BOUNDARY_*` HMAC triple
  authenticates herobids↔boundary calls. Only the HMAC triple must *match*
  across repos. A misleading note in `scripts/shell/run/boundary.sh` (line 62)
  groups `CREDENTIAL_ENCRYPTION_KEY` under "MUST match" — that is imprecise
  (each side only needs its own valid key), though harmless once both are valid.
- This was a local-operating-env defect, not a code defect: no production
  `herobids` value was invalid. The `.env.example` fix prevents recurrence for
  any future fresh checkout.