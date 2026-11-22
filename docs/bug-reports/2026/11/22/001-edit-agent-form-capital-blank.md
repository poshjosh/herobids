# Bug Report: Edit agent form shows blank capital

- **Status:** FIXED (not verified in a running app)
- **Severity:** Medium
- **Date:** 2026-11-22
- **Summary:** After saving capital (e.g. 3000), reopening the edit agent form showed an empty capital field.

## Root Cause

Capital, risk and execution defaults are Traderton trading-profile state (ADR 010, commit `91fcd7a7`), not columns on `agents`. `GET /agents/:id` returned only the agent row plus `unifiedConfig`-derived fields, so the response had no `capital` (and no `risk` / `executionDefaults` for bound agents). The form hydrates with `agent.capital ?? ''` (`agent-form-state.ts`), so it was always blank. Saving worked: `PATCH` writes to the profile.

Consequence: saving the form sends `capital: null` and a null-filled `risk` (`agent-payloads.ts`), which clears the stored values.

## Fix

- `GET /agents/:id` overlays the selected execution-binding profile (`capital`, `riskPosture` as `risk`, `executionDefaults`) and returns `tradingProfileAvailable: true`. Only the selected binding is read, so one boundary call is made and a failing non-selected venue cannot hide the selected profile.
- Unbound agents (no binding) use the `unifiedConfig` snapshot (`capital`, `execution`), type-guarded: a non-string capital or non-object execution is ignored.
- If a bound agent's profile cannot be read (boundary failure, or the selected venue missing from the result), the response is still 200 with `tradingProfileAvailable: false` and no capital/risk/executionDefaults. The stale snapshot is deliberately not used for bound agents. A warning is logged.
- The edit form passes `tradingProfileAvailable` to `buildUpdateAgentPayload`. When it is `false`, `capital`, `risk` and `executionDefaults` are omitted from the PATCH, so a blank form cannot clear stored values. An absent flag means available.
- No local `agents.capital` was reintroduced, so the 2026-09-22 reconciliation cleanup is not reverted.

## Files Changed

- `apps/api/src/routes/agents.ts`, `apps/api/src/routes/agents.test.ts`
- `apps/web/src/lib/api-client.ts`, `apps/web/src/features/agents/agent-payloads.ts`, `apps/web/src/features/agents/agent-payloads.test.ts`, `apps/web/src/features/agents/EditAgentModal.tsx`

## Verification

- `pnpm lint` passes.
- `agents.test.ts` and the web `features/agents` tests pass (754 tests). New cases: selected-venue-only read, unbound snapshot, non-string snapshot values, no snapshot, read failure, selected venue missing, payload omission when unavailable.
- Not checked in a running app (bound agent, unbound agent, Traderton down).

## Known gap

When the profile is unavailable the capital field still renders blank, with no notice. Saving is safe (the fields are not sent), but the user is not told why it is blank.
