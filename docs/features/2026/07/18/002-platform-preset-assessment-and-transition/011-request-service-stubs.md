# Superseded: AssessmentRequestService Non-Billing Stub Completion

**Status:** Superseded - do not implement this document
**Replaced by:** [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md)

## Supersession Notice

The earlier split between non-billing gates in this document and billing gates in `007` was unsafe. Opt-in, owner resolution, cooldown, daily cap, idempotency, cache reuse, reservation, cross-worker provider leases, artifact supersession, capture, and release form one request transaction and one durable audit trail.

In particular, do not add a requester `agentId` to `market_assessment_runs`. Runs are shared provider executions and may serve multiple independently billed requester attempts. Requester-scoped data belongs in `market_assessment_requests`, as specified by authoritative `007`.

The remaining text is retained only as historical context and must not be used as an implementation source.

## Archived Draft - Do Not Implement

---

## 0. Scope

This plan covers the **non-billing gates** in the assessment request pipeline — the checks that happen before billing authorization. Billing itself is out of scope (covered by [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md)).

It does NOT cover:
- The assessor's core logic (Plans 008, 009)
- The review scheduler (Plan 010)
- Tool context wiring (Plan 012)

---

## 1. Current State (what's broken)

### `AssessmentRequestService.requestAssessment()` — steps 3–5

```ts
// ── 3. Validate opt-in and mode (stub) ────────────────────────────
// TODO(Step 7): Query agent's PlatformAssessmentOptIn from DB,
// resolve via resolveAssessmentConfig, and validate enabled + mode.

// ── 4. Enforce cooldown (stub) ────────────────────────────────────
// TODO(Step 7): Check last assessment time per (agentId, key).
// If within cooldown window, return { kind: 'cooldown_blocked', ... }.

// ── 5. Re-check cache (stub) ──────────────────────────────────────
// TODO(Step 7): Query marketAssessmentArtifacts for a fresh active
// artifact matching this identity. If found and not expired,
// return { kind: 'cache_hit', assessmentArtifactId, billed: true }.
```

All three gates always pass — every request proceeds directly to a new assessor run, even if the agent isn't opted in, is in cooldown, or has a perfectly fresh cached artifact.

---

## 2. What Needs to Change

### 2.1 Gate 3: Opt-in Validation

**Logic:**
1. Query the agent's unified config from DB (agents table → `unifiedConfig` JSONB column).
2. Extract `platformAssessment` from the unified config.
3. Check `platformAssessment.enabled === true`. If false or missing → return `{ kind: 'identity_unresolved', reason: 'Agent not opted into platform assessment' }`. (Note: `identity_unresolved` is the wrong outcome kind — add a new `opt_in_blocked` kind.)
4. Check `platformAssessment.mode`.**Resolved:** Block unrecognized modes (fail-closed). Currently only `recommend_only` is valid. If mode is unrecognized or malformed, return `{ kind: 'opt_in_blocked', reason: 'Unrecognized platform assessment mode: "${mode}". Supported: recommend_only.' }`.

**New outcome kind:**
```ts
{ kind: 'opt_in_blocked'; reason: string }
```

**Dependency:** The service needs access to agent config. Add `agentRepo: AgentRepository` or a `getAgentConfig(agentId: string)` function to the constructor deps.

### 2.2 Gate 4: Cooldown Enforcement

**Logic:**
1. Query `market_assessment_runs` for the most recent run matching `(agentId, identity)`.
2. If a run exists and its `startedAt` is within the cooldown window → return cooldown blocked.
3. The cooldown window = `PlatformAssessorConfig.minReviewIntervalMs` (operator floor) or the agent's configured `reviewIntervalMs`, whichever is larger.
4. Return `nextEligibleAt` = `lastRun.startedAt + cooldownMs`.

**New outcome kind (already defined):**
```ts
{ kind: 'cooldown_blocked'; nextEligibleAt: string }
```

**Note:** The cooldown check needs `agentId` added to the `market_assessment_runs` table. **Resolved:** Add `agentId` column to `market_assessment_runs` rather than creating a separate cooldown table. A separate table would duplicate identity columns and create synchronization risks (run succeeds but cooldown insert fails → orphan state).

### 2.3 Gate 5: Cache Re-Check

**Logic:**
1. Query `market_assessment_artifacts` for an active artifact matching this identity (using the existing `identityWhereClause` pattern from `get-market-preset-assessment.ts`).
2. Check freshness with `isArtifactFresh(artifact, now)`.
3. If found AND fresh → return cache hit with the artifact ID:

```ts
{
  kind: 'cache_hit',
  assessmentArtifactId: artifact.id,
  billed: true,
}
```

**IMPORTANT:** The `billed: true` field is set but actual billing is wired by Plan 007. **Resolved billing ordering:** Per D6 in Plan 005 ("cache hits are billable"), the billing authorization gate (Plan 007) must be placed BEFORE the cache re-check in the `requestAssessment` method. The flow: identity resolution → opt-in → cooldown → **billing** → cache re-check → assessor run (if miss). The cache re-check gates whether a new assessor run is needed, not whether billing occurs.

**Implementation note:** The cache re-check query is identical to what `get-market-preset-assessment.ts` already does. Consider extracting a shared helper or reusing the same query pattern.

---

## 3. Schema Gap: `agentId` on `market_assessment_runs`

### 3.1 Problem

The current `market_assessment_runs` table has no `agentId` column. The cooldown check needs to know which agent last requested an assessment for a given identity.

### 3.2 Solution

Add `agentId` column to `market_assessment_runs`:
```sql
ALTER TABLE market_assessment_runs ADD COLUMN agent_id TEXT NOT NULL REFERENCES agents(id);
```

Update:
- `packages/db/src/schema/market-assessment-runs.ts` — add column definition
- `AssessmentRequestService.runAssessor()` — pass `agentId` when inserting the run record
- Run `drizzle-kit generate` to produce the migration

---

## 4. Files Changed

| File | Change |
|------|--------|
| `apps/worker/src/market-intelligence/assessment-request-service.ts` | Rewrite steps 3-5 from stubs to real logic. Add `agentRepo` to constructor deps. Add `opt_in_blocked` outcome kind. |
| `apps/worker/src/market-intelligence/assessment-request-service.test.ts` | Add tests for: opt-in disabled agent, opt-in enabled agent, cooldown active, cooldown expired, cache hit, cache miss. (Create file if not existing.) |
| `packages/db/src/schema/market-assessment-runs.ts` | Add `agentId` column. |
| `apps/worker/src/index.ts` | Update `AssessmentRequestService` instantiation to pass `agentRepo`. |

---

## 5. Dependencies

- `AgentRepository` must be available in the worker context (already is — used by review scheduler).
- Plan 007 (billing) is NOT a dependency — the `billed: true` field is set as a placeholder. Plan 007 will wire the actual billing call between gates 5 and 6.
- The schema migration for `agentId` must be applied before deploying the code change.

---

## 6. Test Strategy

- **Unit tests:** Mock `agentRepo` and DB queries. Verify each gate independently:
  - Opt-in: disabled → blocked; enabled → passes
  - Cooldown: recent run → blocked; no recent run → passes; `nextEligibleAt` computed correctly
  - Cache: fresh artifact → cache_hit; no artifact → miss; expired artifact → miss
- **Integration tests:** Run against real DB with seeded agent config and artifacts. Verify full request flow with all gates active.
- **No visual/browser testing needed.**

---

## 7. Completion Bar

- Opt-in validation queries the agent's real config from DB and blocks non-opted-in agents.
- Cooldown enforcement queries `market_assessment_runs` and blocks requests within the cooldown window.
- Cache re-check queries `market_assessment_artifacts` and returns cache hits for fresh artifacts.
- All three gates produce correct outcome kinds (`opt_in_blocked`, `cooldown_blocked`, `cache_hit`) with proper `nextEligibleAt` / `assessmentArtifactId` fields.
- `agentId` column added to `market_assessment_runs` with migration.
- `pnpm lint` and `pnpm build` pass.

---

## 8. Resolved Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Cooldown tracking: add `agentId` to `market_assessment_runs`** | Avoids schema proliferation. A separate table would duplicate identity columns and risk orphan states. |
| 2 | **Opt-in mode gating: block unrecognized modes (fail-closed)** | Currently only `recommend_only` is valid. Unrecognized modes are a safety boundary — blocking forces config fix. |
| 3 | **Billing vs. cache ordering: bill BEFORE cache re-check** | Per D6: "cache hits are billable." The cache check gates assessor run necessity, not billing eligibility. |
