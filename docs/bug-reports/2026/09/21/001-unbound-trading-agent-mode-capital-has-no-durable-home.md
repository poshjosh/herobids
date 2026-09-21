# Bug Report: Unbound trading agents have no durable home for execution mode + capital

- **Status:** FIXED (2026-09-21)
- **Severity:** High (silent loss of trading configuration; the execution mode and capital a user configured are dropped before any connection is bound)
- **Date:** 2026-09-21
- **Discovered by:** C1 follow-up — reconciling the 12 deferred C1 functional tests against the profile-backed read path.
- **Environment:** development; local docker compose cross-stack + functional test harness (`apps/api/src/__tests__/functional/`).

## Summary

C1 (ADR 010) moved `capital`, `riskPosture`, `riskOverrides`, and `executionDefaults` out of the `agents` row and into the traderton-owned trading profile, keyed by `(ownerId, actorId, venueAccountId)`. The retired `agents.capital` / `agents.risk` / `agents.execution_defaults` columns are physically present but inert (removed from the drizzle schema, deliberately not dropped yet).

The profile is keyed by `venueAccountId`, so a trading agent that is created **before any connection is bound** has **no venue account** and therefore **no profile row**. Consequences:

1. On `POST /agents`, the create path computes `executionDefaults.mode` (e.g. `paper`) and `capital`, but only writes a profile for connections whose `resolvedVenueAccountId` is non-null (`agents.ts` `prepareCreateProfilePlan` filters `venueAccountId !== null`). An unbound trading agent therefore drops its mode and capital immediately.
2. Because the inert `agents.execution_defaults` / `agents.capital` columns are no longer written (C1 retired them), the mode/capital are **ephemeral** — not recoverable from any store until a connection is bound.
3. The `paper → shadow` auto-upgrade on connection grant reads `currentExecutionMode` from the selected profile (`resolveExecutionModeForSkills` → `currentProfile?.executionDefaults?.mode`). For an unbound agent there is no profile, so the upgrade resolves back to the `'paper'` default instead of upgrading to `'shadow'`.

Functional evidence (after removing the now-dead `executionMode`/`capital`/`risk` from the agent response and repointing tests to the profile):

```
go-live.functional.test.ts "auto-transitions paper→shadow on connection grant":
  expected 'paper' to be 'shadow'        ← upgrade never persisted
go-live.functional.test.ts "preserves strategy and risk config":
  expected null to be '1000.00'          ← capital lost for unbound agent
```

## Root Cause

ADR 010 profile key is `(ownerId, actorId, venueAccountId)`. There is no store for trading-mode/capital **before** a venue account exists. C1's "eager-at-bind" lifecycle writes the profile only once a binding (and its venue account) is present, and the retired `agents` columns are not a fallback. The "create trading agent first, bind connection later" flow therefore has a configuration window with no persistence.

## Impact

- A user who configures `capital` / `executionDefaults.mode` when creating a trading agent (before connecting a venue) silently loses those values; they do not survive into the profile created later at bind time.
- The paper↔shadow auto-transition resolves incorrectly for agents whose mode was set before binding.
- This blocks full-functional green for C1 (7 of the deferred functional tests fail on the profile-backed assertions, not on stale assertions).

## Fix (Resolution B — chosen for cleanliness; implemented 2026-09-21)

Persist `executionDefaults.mode` (and `capital`) for **unbound** trading agents into `agents.unifiedConfig` at create time, so the values survive until a venue exists, then migrate into the profile when the first connection is bound. Traderton remains the authority for the bound profile; `unifiedConfig` is the herobids-owned placeholder for the unbound window.

Implemented in this order (herobids `consume-traderton`, alongside the response-field removal + test re-pointing):

1. **Create path** (`apps/api/src/routes/agents.ts`): stamp the resolved `executionDefaults.mode` into `unifiedConfig.execution.mode`, and `capital` into `unifiedConfig.capital`, for trading-capable agents — only when no ready connection otherwise persists them.
2. **PATCH path** (`apps/api/src/routes/agents.ts`): when resolving `currentExecutionMode`, fall back to the `unifiedConfig.execution.mode` snapshot so the paper→shadow upgrade fires on first bind; seed the first-bind profile's `executionDefaults`/`capital` from the snapshot when the caller omitted them.
3. **PUT path** (`apps/api/src/routes/agent-interactivity.ts`): same `unifiedConfig` fallback for the test↔live immutability guard, so the "cannot be changed after creation" rejection is correctly reported (was previously masked by the connection-requirement check).
4. **Telegram `/info` + `/mode`** (`apps/api/src/routes/telegram-command-handlers.ts`): read the selected profile, falling back to the `unifiedConfig` snapshot for unbound agents, so mode/capital are reported correctly before binding.

The response-field removal and telegram harness saga wiring were fixed in the same change-set but are separate concerns (see below).

## Related fixes in the same change-set

- Removed the dead `executionMode`/`capital`/`risk`/`executionDefaults` from the agent response (`agent-config-helpers.ts` `decorateAgentResponse`); write-side request schemas unchanged. Repointed the agent/go-live/telegram functional tests to assert through the trading-profile layer (`ctx.getProfile`).
- Wired the functional profile saga into the telegram harness (fixing `/connect` + `/disconnect`), and fixed the harness saga to key profiles by `(actorId, venueAccountId)` (previously venue-only, which collapsed a go-live clone onto its source).

## Verification

- `pnpm test:functional` — **187 passed, 0 failed** (16 files).
- `pnpm exec tsc --noEmit -p apps/api/tsconfig.json` and `-p apps/web/tsconfig.json` — clean.
- The previously-red C1 functional assertions (paper→shadow auto-transition, go-live mode/capital preservation, `/info`/`/mode`, `/connect`/`/disconnect`) now pass against the profile-backed read path.

## Related

- `docs/tech/architecture/adrs/2026/09/010-traderton-owned-trading-profile.md` (profile key + ownership line)
- `docs/features/2026/09/18/001-trading-extraction-completion/plans/C1-trading-profile-slice.md` (step 6: inert columns)
- `docs/features/2026/09/18/001-trading-extraction-completion/plans/C3-capability-agnostic-frontend.md` §C3b (removal of trading fields from the agent response)