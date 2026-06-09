# Bug Report: Paper mode instances blocked from starting — credential guard does not exempt paper mode

- **Status:** CLOSED
- **Severity:** High
- **Date:** 2026-06-04
- **Summary:** Starting a paper-mode trading instance was rejected at the API layer with `409 no_credential`, and again in the worker with a `CredentialResolutionError`. Paper mode does not interact with any venue and therefore does not need credentials. The guards introduced in bug 006's fix were too broad.

## Root Cause

Bug 006's fix added a credential guard in two places:

1. `apps/api/src/routes/instances.ts` — rejects `POST /instances/:id/start` with `409 no_credential` when the linked venue account has no credential.
2. `apps/worker/src/index.ts` — throws `CredentialResolutionError` during actor startup when credential resolution yields nothing.

Neither guard checked the instance's execution mode. A paper-mode instance with a real venue account (but no credential) was rejected in the same way as a live-mode instance, making it impossible to start any paper-mode instance when the venue account lacked credentials.

## Fix

Both guards now check the resolved execution mode before enforcing the credential requirement:

**`apps/api/src/routes/instances.ts`:**
```typescript
const executionMode = (instanceConfig?.['execution'] as Record<string, unknown> | undefined)?.['mode'];

if (instance.venueAccountId !== 'default' && venueType !== 'swap' && executionMode !== 'paper') {
  // credential guard
}
```

**`apps/worker/src/index.ts`:**
```typescript
} else if (config.execution.mode !== 'paper') {
  throw new CredentialResolutionError(`Venue account ${venueAccountId} has no linked credential`);
} else {
  logger.warn({ venueAccountId, tradingInstanceId }, 'Paper mode: venue account has no linked credential — proceeding without credentials');
}
```

## Files Changed

- [apps/api/src/routes/instances.ts](../../apps/api/src/routes/instances.ts)
- [apps/worker/src/index.ts](../../apps/worker/src/index.ts)

## Verification

- Paper-mode instance with a credentialless venue account now starts successfully.
- Live-mode instance without a credential is still rejected as expected.
- `pnpm lint` passes.

## Regression Tests

The worker-side credential guard is embedded in the `index.ts` factory function (not independently exportable), so a direct unit test at that layer is not practical. Regression coverage is added at the immediately adjacent enforcement layer:

Added to `apps/worker/src/live-gate.test.ts` under `non-live modes pass through`:

- **does not reject paper mode even when no credentials are present (bug-010 regression)** — calls `assertLiveReadiness()` with `executionMode: 'paper'`, `credentialsFromDb: false`, and `credentialsPresent: false`. Verifies it does not throw for either `liveRollout.enabled = true` or `enabled = false`. This documents that paper mode is exempt from credential enforcement at every layer of the startup gate, consistent with the `config.execution.mode !== 'paper'` guard added to `index.ts`.
