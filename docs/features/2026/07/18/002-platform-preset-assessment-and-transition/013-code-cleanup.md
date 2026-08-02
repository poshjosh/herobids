# Implementation Plan: Legacy Assessment Removal And Rollout Evidence

**Status:** Done - rewritten after implementation review
**Run only after:** [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md) through [012-tool-context-wiring.md](./012-tool-context-wiring.md) have executable proof
**Purpose:** Remove superseded segment/scheduler compatibility code only after its replacement is live, and expose durable rollout evidence from real request, assessment, and transition records.

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