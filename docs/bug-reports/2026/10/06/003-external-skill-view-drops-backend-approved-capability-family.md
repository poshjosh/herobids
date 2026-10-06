# 003 — External skill view drops backend-approved `capabilityFamilies`, mis-classifying trading agents as non-trading

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-10-06
- **Summary:** On branch `feat/repeating-reminders-mvp`, creating a trading agent with the external skill `traderton/skills/crypto-bot-management` fails at the create step (E2E journeys 16 & 19) with `Request validation failed: runtimePolicyOverrides.maxHoldDurationMs: maxHoldDurationMs (5400000ms) must be >= tickIntervalMs (86400000ms)`. The agent is assigned a 24h tick interval it should never have.

## Root Cause

A new feature defaults NON-TRADING agents to a 24h tick interval. The web create/edit form decides trading-vs-non-trading by reading `skill.capabilityFamilies` on the skills returned by `GET /skills?scope=selectable`.

There was a server-side asymmetry in `apps/api/src/routes/skills.ts` in how `capabilityFamilies` is populated for backend-approved external (`traderton/skills/*`) skills:

- **DB-row path** (`toSkillViews`, ~lines 362–369) correctly folds the backend-approved connection family into `capabilityFamilies`:
  ```ts
  const approval = skillBackendApproval({ sourceRef, slug });
  const effectiveFamilies = approval.approved && approval.family && !baseFamilies.includes(approval.family)
    ? [...baseFamilies, approval.family]
    : baseFamilies;
  ```
- **External-provider path** (`mapExternalToSkillView`, ~line 533) **hard-coded** `capabilityFamilies: []` even though it set `isBackendApproved: BACKEND_APPROVED_REFS.has(ext.ref)`. `BACKEND_APPROVED_REFS` is a `Map<string, string | undefined>` (ref → family, populated at startup from `appConfig.externalBackends[].approvedSourceSkillRefs` + `requiresConnectionFamily`), so the family (`'trading'`) was available via `BACKEND_APPROVED_REFS.get(ext.ref)` but ignored.

So an external `traderton/skills/crypto-bot-management` served via the external provider reached the web with `capabilityFamilies: []`. The web classified the agent as NON-TRADING, pre-filled and submitted a 24h tick interval, and then the server's own classifier (`hasSkillCapabilityFamily` → `BACKEND_REF_FAMILIES` in `agent-config-helpers.ts`) correctly classified it as TRADING and `validateMaxHoldDurationInvariant` rejected it (maxHold 5400000ms < tick 86400000ms).

The web (`capabilityFamilies: []`) and the server (TRADING) disagreed because they were fed by different sources for the external-provider view.

### Parallel path — `EditAgentModal.tsx`

`EditAgentModal.tsx` uses the same `selectedSkillsHaveCapabilityFamily` helper against the skills list from `/skills?scope=selectable`. It was affected by the same asymmetry; the single fix below covers it with no separate change needed, because both the create form and the edit modal consume the same endpoint.

## Fix

In `apps/api/src/routes/skills.ts`, made `mapExternalToSkillView` surface the backend-approved family into `capabilityFamilies`, mirroring the DB-row path. An external-provider view has no base families, so the approved family (if any) is the whole list:

```ts
export function mapExternalToSkillView(ext: ExternalSkillSummary): SkillView {
  const family = BACKEND_APPROVED_REFS.get(ext.ref);
  return {
    // ...
    isBackendApproved: BACKEND_APPROVED_REFS.has(ext.ref),
    capabilityFamilies: family ? [family] : [],
    // ...
  };
}
```

`BACKEND_APPROVED_REFS` is now the single source of truth driving BOTH the `capabilityFamilies` surfaced to the web AND `isBackendApproved`, so the web's trading classification agrees with the server's. The DB-row path was left unchanged. TS strict preserved (no `any`). `mapExternalToSkillView` was exported so it can be unit-tested directly.

## Files Changed

- `apps/api/src/routes/skills.ts` — `mapExternalToSkillView`: look up `BACKEND_APPROVED_REFS.get(ext.ref)` and set `capabilityFamilies: family ? [family] : []`; exported the function; added a boundary comment.
- `apps/api/src/routes/skills.test.ts` — added `mapExternalToSkillView` unit tests: approved trading ref → `['trading']` + `isBackendApproved: true`; non-approved ref → `[]` + `isBackendApproved: false`; approved ref with no registered family → `[]` + `isBackendApproved: true`.

## Verification

- `pnpm --filter @herobids/api exec vitest run src/routes/skills.test.ts src/routes/skills-slug.test.ts` → 60 passed (3 new tests green).
- `pnpm lint` (`tsc --noEmit`) → clean.
- Full E2E suite not run (requires the live stack). The fix makes the web keep the strategy/style (short) tick interval for a `crypto-bot-management` agent, so the maxHold>=tick invariant passes.
