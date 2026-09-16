# Bug Report: `preset-review-gap-closure` R3 fails — test reads `reasons[]` but the eligibility API returns `reason` (singular)

- **Status:** FIXED (test-only change; see "Fix" + "Verification").
- **Severity:** Low (test-harness field-name bug only — no product/runtime impact; the API and web frontend are correct and unaffected).
- **Date:** 2026-09-16
- **Discovered By:** Full cross-stack `run-extra-tests.sh` Tier-5 run (`RUN_UNSTABLE_LLM_LATENCY_TESTS=1`) during the herobids→traderton shell-test migration verification. R3 of `preset-review-gap-closure-test` failed: `✗ FAIL R3: canTrigger=false reasons=[]`.
- **Not caused by:** the trading extraction / REST-boundary migration. The `GET /agents/:id/platform-assessment/reviews/eligibility` endpoint touches **no** trading boundary — it reads only local `agents` + `agent_runtime_sessions` tables (`apps/api/src/routes/agent-platform-assessment-reviews.ts`). The mismatch pre-dates the migration by months (endpoint authored 2026-07-21, commit `75ced71b`, and has always returned `reason` singular).

## Summary

`preset-review-gap-closure-test.ts` R3 asserts that for a non-hybrid (intelligence) agent the eligibility endpoint reports `canTrigger === false` **and** a reason containing "hybrid". It read the response field **`reasons`** (an array):

```ts
const res = await apiRequest<{ canTrigger?: boolean; reasons?: string[] }>(
  'GET', `/agents/${agentId}/platform-assessment/reviews/eligibility`, { token });
const reasonText = Array.isArray(body?.reasons) ? body.reasons.join('|') : '';
const hasCapabilityReason = reasonText.toLowerCase().includes('hybrid');
record('R3', canTriggerFalse && hasCapabilityReason, ...);
```

But the endpoint returns **`reason`** (a single joined string), not `reasons`:

```ts
// apps/api/src/routes/agent-platform-assessment-reviews.ts (eligibility handler)
const canTrigger = reasons.length === 0;
return reply.send({
  canTrigger,
  reason: canTrigger ? null : reasons.join('; '),   // singular `reason`
});
```

So `body.reasons` was always `undefined` -> `reasonText = ''` -> `hasCapabilityReason` always `false` -> R3 could never pass, regardless of correct server behaviour.

## Impact

- **Test-only.** R3 was unsatisfiable by construction; it had failed since the test was written. No product code is wrong.
- The endpoint is **correct**: for a non-hybrid agent it pushes `"Strategy review is only available for hybrid agents"` and returns `canTrigger=false`. R2 (which asserts only `canTrigger`) passes; R3 failed only because it additionally read the non-existent `reasons` array.

## Why the API is NOT the bug (the contract is `reason`, singular)

Two independent consumers rely on the singular `reason` shape — changing the API would break them, so the fix belongs in the test:

- **Web frontend** — `apps/web/src/lib/api-client.ts` types the response as `{ canTrigger: boolean; reason: string | null }`; `AgentEvaluations.tsx` consumes `reviewEligibilityQuery.data.canTrigger`.
- **API unit test** — `apps/api/src/routes/agent-platform-assessment-reviews.test.ts` asserts `body.reason` (singular) contains `'Strategy review is only available for hybrid agents'` — and passes.

## Root cause

Field-name mismatch between the operator test script (`reasons: string[]`) and the API's real response contract (`reason: string | null`). A latent test bug; not a regression and not migration-related.

## Fix

Aligned the test to the API's real contract — read the singular `reason` string in `scripts/ts/preset-review-gap-closure-test.ts` (both the R2 diagnostic log and the R3 assertion). No API or frontend change (their `reason` contract is correct and depended upon).

Changed (both eligibility reads):
- type `{ canTrigger?: boolean; reasons?: string[] }` -> `{ canTrigger?: boolean; reason?: string | null }`
- `reasonText = Array.isArray(body?.reasons) ? body.reasons.join('|') : ''` -> `typeof body?.reason === 'string' ? body.reason : ''`

## Verification

- The edited script loads, type-resolves, and executes under its real runner
  (`npx tsx scripts/ts/preset-review-gap-closure-test.ts`) — verified it reaches runtime
  (prints the scenario banner, then stops only on "postgres is not running" when no stack is
  up). A type/parse error in the edit would throw at load, before any output. (Note: there is
  no `scripts/tsconfig.json`, so these operator scripts are validated by tsx execution, not a
  tsc project — tracked separately as a LOW in the Slice-3 plan.)
- Re-run under `RUN_UNSTABLE_LLM_LATENCY_TESTS=1` on a warm stack to confirm R3 passes end-to-end (needs Ollama + venue creds; agent-activation latency per bug 2026-09-05/001 can still gate a cold run).
- API unit suite `apps/api/src/routes/agent-platform-assessment-reviews.test.ts` unchanged and still green (it already used `reason`).

## Related

- The other two Tier-5 failures in the same run (`agent-trade-test`, `scanner-provider-smoke`) are the documented unstable LLM-latency flakiness (bug `2026-09-05/001`), not this issue.
