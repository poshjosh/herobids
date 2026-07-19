# Implementation Plan: Legacy Assessment Removal And Rollout Evidence

**Status:** Draft - rewritten after implementation review
**Run only after:** [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md) through [012-tool-context-wiring.md](./012-tool-context-wiring.md) have executable proof
**Purpose:** Remove superseded segment/scheduler compatibility code only after its replacement is live, and expose durable rollout evidence from real request, assessment, and transition records.

## Authoritative Plan

This section supersedes the archived draft below. Implement only this section.

### Sequencing Rule

Cleanup is the final implementation slice. Do not delete legacy code simply because a replacement type exists. First pass C1-C7 in [006-followup-plan.md](./006-followup-plan.md), then remove only source references proven to be obsolete by the replacement tests.

The worker-wide market-intelligence coordinator and its leader election are not platform-assessor scheduler code. Preserve `leader-election.ts` and coordinator callers unless a separate coordinator design removes them.

### Code To Remove After Replacement

Remove the old segment-based assessment identity and scheduled-assessment remnants only when no production source consumer remains:

- `MarketAssessmentSegmentKey`, its schema, `computeUniverseScopeHash`, `createSegmentKey`, and `segmentKeyFromTechnicalConfig`;
- deprecated segment/universe fields from assessment artifacts/runs/wake decisions/transitions and their domain schemas;
- segment scheduler resolution, assessor cycle fields, and segment-specific leader-election wiring;
- unused scheduled `preset_review` wake-gate/config/persistence code that is not part of the retained advice-only `assessment_review` path;
- unused platform transition-state types that have been replaced by the durable request, binding, and transition state machines in `007` and `012`.

Do not remove aggregate scan scope. `agent_scan_metrics.scanScope`, venue family, and style tier are legitimate telemetry context even though they are not assessment identity dimensions.

### Database And Generated Artifacts

Apply clean-slate schema changes in dependency order:

1. Add evidence, request, lease, scanner-candidate/review-check, binding, and transition-action tables/columns required by `007` through `012`.
2. Migrate all runtime callers to the new canonical identity and state models.
3. Remove old segment/wake tables and columns only after no runtime caller remains.
4. Use `drizzle-kit generate` for every migration and confirm SQL files and `_journal.json` agree.
5. Rebuild generated package output rather than manually editing `dist`. Source-removal checks must exclude generated `dist` directories; build output is validated by `pnpm build`.

The clean database reset must be rehearsed in integration/staging: apply the journal from an empty database, start API and worker, then execute the completion scenario. No code may read a new schema before its migration is deployed.

### Durable Rollout Evidence

Do not add process-local shadow counters as a substitute for auditable evidence. In `recommend_only`, derive operator metrics from persisted request, evidence, scorecard, ranking, review-check, advice, binding, and transition records.

Expose queryable metrics for:

- assessment requests by blocked/cache/completed/provider-failed outcome;
- evidence availability/freshness failures and deterministic scorecard coverage;
- LLM validation/provider failures, confidence distribution, and ranking stability;
- review checks, advice volume, wake delivery, and no-advice rate;
- cache reuse, reservation/capture/release, daily-cap blocks, and lease recovery;
- recommendation, defer/reject, attempted/apply/failed transition outcomes;
- position-action outcomes and protection-rejection reasons.

Use these persisted facts for the shadow/recommend-only rollout review. Do not enable apply-capable transition mode before the configured rollout criteria and C6/C7 tests are satisfied.

### Verification Commands

Before declaring cleanup complete, run source-only searches that intentionally exclude docs and generated output:

```sh
rg -n \
   --glob '!**/dist/**' \
   --glob '!docs/**' \
   'universeScopeHash|MarketAssessmentSegmentKey|computeUniverseScopeHash|createSegmentKey|segmentKeyFromTechnicalConfig|resolveSegments|runAssessmentCycle' \
   packages apps
```

The command must return no deprecated assessment-identity or scheduler references. Investigate every match rather than suppressing it mechanically. Run a separate targeted search for retained coordinator leader-election imports before deleting any export.

Then run the focused implementation/integration tests, migration-journal validation, `pnpm lint`, `pnpm build`, and the complete [006-followup-plan.md](./006-followup-plan.md) scenario.

### Completion Bar

- No source code executes legacy segment/scheduled assessment behavior.
- Coordinator leader election remains intact unless separately redesigned.
- Legacy code removal does not erase legitimate aggregate scan telemetry.
- Migrations are journaled and clean-database startup works.
- Rollout metrics are derived from durable records, not process-local counters.
- C8 has executable proof and all prior C-items remain green.

## Archived Draft - Do Not Implement

---

## 0. Scope

This plan covers **cleanup and deferred wiring** — removing dead code that the per-symbol on-demand model made obsolete, and wiring the remaining deferred infrastructure (shadow mode tracking, wake gate schema).

It does NOT cover any new behavioral logic. It is purely deletion + deferred schema finalization.

---

## 1. Current State

### 1.1 Deprecated Segment Key Code (still present)

Per Plan 005 §3.1 and §4.3, the following should have been deleted:

| Symbol | File | Status |
|--------|------|--------|
| `computeUniverseScopeHash()` | `packages/domain/src/market-assessment.ts` | Present, marked `@deprecated` |
| `createSegmentKey()` | `packages/domain/src/market-assessment.ts` | Present, marked `@deprecated` |
| `segmentKeyFromTechnicalConfig()` | `packages/domain/src/market-assessment.ts` | Present, marked `@deprecated` |
| `MarketAssessmentSegmentKey` (interface) | `packages/domain/src/market-assessment.ts` | Present |
| `MarketAssessmentSegmentKeySchema` | `packages/domain/src/market-assessment.ts` | Present |
| `segmentKey` / `universeScopeHash` fields on domain interfaces | `packages/domain/src/market-assessment.ts` | Present, marked `@deprecated` |
| `leader-election.ts` | `apps/worker/src/market-intelligence/leader-election.ts` | Present |
| `leader-election.test.ts` | `apps/worker/src/market-intelligence/leader-election.test.ts` | Present |

### 1.2 Shadow-Mode Evidence Tracking (commented TODO)

In `platform-assessor.ts`:

```ts
// TODO(002): Implement shadow-mode evidence tracking.
// Shadow-mode metrics (assessment runs, scan health, preset rankings) should be
// collected and validated for a full cycle before enabling live transitions.
```

### 1.3 WakeGateConfig (deferred)

In `packages/domain/src/config/schema.ts`:

```ts
/**
 * NOTE: The full Zod schema (`WakeGateConfigSchema`) is deferred until the
 * scheduled wake path is implemented. Only the type is defined here...
 */
export interface WakeGateConfig { ... }
```

There is no Zod schema — only a TypeScript interface. The `config/default.yaml` has no `wakeGate` block.

### 1.4 Transition State Machine (types only, no enforcement)

`isValidTransition()` exists in `packages/domain/src/market-assessment.ts` but is never called at runtime. The transition state machine types (`PlatformTransitionState`, `ActorTransitionState`) are defined but there is no code that manages these state transitions.

---

## 2. What Needs to Change

### 2.1 Delete Deprecated Segment Key Code

**Precondition:** Verify no remaining callers of the deprecated functions. Run the grep from Plan 005 §3:

```sh
rg -n "universeScopeHash|MarketAssessmentSegmentKey|computeUniverseScopeHash|createSegmentKey|segmentKeyFromTechnicalConfig|resolveSegments|runAssessmentCycle" packages apps
```

**Actions:**
1. Delete `computeUniverseScopeHash()`, `createSegmentKey()`, `segmentKeyFromTechnicalConfig()` from `packages/domain/src/market-assessment.ts`.
2. Delete `MarketAssessmentSegmentKey` interface and `MarketAssessmentSegmentKeySchema`.
3. Remove deprecated `segmentKey` and `universeScopeHash` fields from:
   - `MarketAssessmentRun` interface
   - `MarketAssessmentArtifact` interface
   - `MarketAssessmentWakeDecision` interface
   - `AgentScanMetrics` interface
   - `AgentPresetTransition` interface
   - And their corresponding Zod schemas
4. **DO NOT delete `leader-election.ts`.** The `coordinator.ts` imports it (`import { createLeaderElection, type LeaderElection } from './leader-election.js'`). Only remove any unused leader-election exports and any remaining PlatformAssessor-specific leader election wiring in `index.ts`. Keep the file and its exports that the coordinator uses.
5. Run `pnpm lint` and `pnpm build` to verify no broken imports.

### 2.2 Wire Shadow-Mode Evidence Tracking

The shadow-mode TODO is a Phase 2 concern — it requires collecting metrics over multiple assessment cycles before enabling `auto_apply` mode. For Phase 1 (`recommend_only`), shadow mode is the only mode.

**Minimal Phase 1 implementation:**
1. Add a `metrics` counter in `PlatformAssessor` that tracks:
   - Total assessment runs (by identity)
   - Successful vs. failed runs
   - Average confidence scores
   - Average number of presets ranked
2. Expose these counters via a `getShadowMetrics()` method.
3. Log metrics at info level after each assessment run.
4. Emit metrics to Redis for observability (optional — can be done via existing monitoring infrastructure).

**File:** `apps/worker/src/market-intelligence/platform-assessor.ts`

**This is low priority** — shadow mode is inherently passive. The metrics are for operator confidence, not runtime behavior. Consider deferring to a fast-follow plan.

### 2.3 Finalize WakeGateConfig Schema

The `WakeGateConfig` is needed for the deferred wake path. Since the scheduled wake path is deferred (per Plan 005 D2 — only `assessment_review` ticks in Phase 1), the wake gate is not needed yet.

**Action:** Keep the TypeScript interface as-is. Add a comment referencing that the full Zod schema is deferred to the scheduled-assessment-wake phase (post Phase 1). No code changes needed.

### 2.4 Transition State Machine Enforcement

`isValidTransition()` exists but is unused. The transition state machine was designed for the old segment-based scheduled assessment model. In the new per-symbol on-demand model:
- The platform side transitions are simplified (`assessment_available` → agent decides)
- The actor side transitions are agent-driven (review → recommend → apply)

**Action:**
1. Keep `isValidTransition()` and the transition types — they may be useful when `auto_apply` mode is implemented.
2. Add a comment noting they are deferred until `auto_apply` rollout.
3. No runtime enforcement needed in Phase 1.

---

## 3. Files Changed

| File | Change |
|------|--------|
| `packages/domain/src/market-assessment.ts` | Delete deprecated functions, interfaces, schemas, and deprecated fields on domain types. |
| `packages/domain/src/market-assessment.test.ts` | Remove tests for deleted functions. Update tests that reference deprecated fields. |
| `apps/worker/src/market-intelligence/leader-election.ts` | **Keep file** (used by coordinator). Remove only unused exports if any. |
| `apps/worker/src/market-intelligence/leader-election.test.ts` | **Keep file** (tests coordinator-used exports). |
| `apps/worker/src/market-intelligence/index.ts` | Remove only leader election exports that are NOT used by coordinator. |
| `apps/worker/src/market-intelligence/coordinator.ts` | Remove leader election import (if coordinator uses its own leader election, keep it — the coordinator is NOT deprecated). |
| `apps/worker/src/index.ts` | Remove any remaining leader election wiring. |
| `apps/worker/src/market-intelligence/platform-assessor.ts` | Add shadow-metrics tracking (minimal). |

---

## 4. Dependencies

- All other plans (008–012) should be completed first — they may reference the deprecated types/functions during their implementation.
- Do NOT delete segment types if any of the plans 008–012 still reference them. Verify with grep before deletion.

---

## 5. Test Strategy

- **Compilation gate:** `pnpm lint` and `pnpm build` must pass after deletions.
- **Grep gate:** `rg "universeScopeHash|MarketAssessmentSegmentKey|computeUniverseScopeHash|createSegmentKey|segmentKeyFromTechnicalConfig" packages apps` must return zero results (except in CHANGELOG or docs).
- **Unit tests:** Verify no test imports deleted symbols.
- **No visual/browser testing needed.**

---

## 6. Completion Bar

- All deprecated segment key code is deleted.
- `leader-election.ts` is preserved (coordinator depends on it); only unused exports are removed.
- `pnpm lint` and `pnpm build` pass.
- Grep for deprecated symbols returns zero results.
- Shadow metrics are logged (optional, low priority).

---

## 7. Resolved Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Keep `leader-election.ts` — coordinator imports it** | `coordinator.ts` uses `createLeaderElection`. Only delete unused exports and old PA-specific wiring. The file and its coordinator-used exports stay. |
| 2 | **DB columns: verify no leftover `segmentKey`/`universeScopeHash` before closing** | Schema files already updated to canonical identity columns. Confirm with grep. Exception: `agent_scan_metrics` columns preserved per Plan 005 §5.3. |
| 3 | **Shadow metrics: defer to fast-follow** | Low priority — shadow mode is inherently passive. Metrics are for operator confidence, not runtime behavior. Implement after Plans 008–012 are complete. |
