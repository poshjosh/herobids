## Plan: Meaningful Strategy Review UX (Sync Assessment, Preset Rankings, Agent Action Tracking)

**Status:** Done
**Scope:** Forced/manual strategy review path only. The scheduled (timer-driven) review path is unchanged — see Non-Goals.

**TL;DR:** Redesign the user-triggered ("forced") strategy review to run the billed platform assessment synchronously after the deterministic pre-check, surface preset rankings (not instrument flags) as the primary UX, share the resulting assessment artifact IDs with the agent so it can call `change_strategy_preset` directly (no second billed call), and let the user see whether the agent acted on the recommendation.

---

## Current Code Truth (verified)

Do not re-diagnose these. They are confirmed facts about the code as it exists today.

1. **The forced review today only runs a deterministic, unbilled pre-check.** `AssessmentReviewRunner.run()` in [assessment-review-runner.ts](../../../../../apps/worker/src/market-intelligence/assessment-review-runner.ts) calls `runPreCheck()` (line 276) which never calls `AssessmentRequestPort` or `PlatformAssessor`. It only produces `CandidatePreCheckOutcome[]` — instrument-level flags with reason codes, not preset rankings.

2. **`AssessmentReviewRunnerDeps` has no assessment port today.** Defined at lines 42–52: `{ db, agentId, eventPublisher, resolveActivePreset, checkBillingEligibility }`. No `AssessmentRequestPort`.

3. **`PlatformAssessor` and `AssessmentRequestService` (which implements `AssessmentRequestPort`) already exist and are constructed in the worker.** In [index.ts](../../../../../apps/worker/src/index.ts): `createPlatformAssessor(...)` at line 2113, `new AssessmentRequestService(db, usageBillingRepo, appConfig.platformAssessor, platformAssessor)` at line 2130, then `setAssessmentRequestPort(assessmentRequestService)` (module-level singleton, consumed by the `assess_strategy_preset` tool). Neither is passed into the `ManualReviewRunnerFactory` lambda (lines ~1957–2038) that constructs `AssessmentReviewRunner` for the manual path.

4. **`AssessmentRequestService.requestBatchAssessment(params: AssessmentRequestPortParams[])` is the batched entry point.** Signature confirmed in [ports/assessment-request.ts](../../../../../packages/domain/src/ports/assessment-request.ts) lines 78–84. Returns `Result<AssessmentRequestPortOutcome[]>`, one outcome per input in the same order. Outcome kinds: `cache_hit`, `assessment_completed`, `request_in_flight`, `billing_blocked`, `cooldown_blocked`, `identity_unresolved`, `provider_failed`.

5. **The agent's own `assess_strategy_preset` tool already caps instrument count.** `AssessStrategyPresetParamsSchema` (in [tool-schemas.ts](../../../../../packages/domain/src/tool-schemas.ts)) accepts up to 50 symbols, but the tool truncates to `port.maxInstrumentsPerRequest` (config default 3, in [assess-strategy-preset.ts](../../../../../apps/worker/src/tools/assess-strategy-preset.ts) — `const maxInstrumentsPerRequest = port?.maxInstrumentsPerRequest ?? 3`). `PlatformAssessorConfigSchema.maxInstrumentsPerRequest` (in [config/schema.ts](../../../../../packages/domain/src/config/schema.ts) line ~1377) defaults to 3, max 50. **The forced review runner must respect this same cap** — it is an operator-configured cost control, not a tool-specific quirk.

6. **`change_strategy_preset` does not care who created the artifact.** [change-strategy-preset.ts](../../../../../apps/worker/src/tools/change-strategy-preset.ts) validates only: (a) artifact exists in `market_assessment_artifacts`, (b) `targetPreset` is in the artifact's `allowedPresets`, (c) artifact not expired (`isArtifactFresh`). Any artifact ID satisfying these gates is accepted — confirmed no coupling to `assess_strategy_preset` having been the caller.

7. **`review_advice` already has a precedent column for tracking agent follow-through.** `assessment_requested_at` (nullable timestamptz, added in migration `0052_clear_expediter.sql`, schema in [review-advice.ts](../../../../../packages/db/src/schema/review-advice.ts) line 88) is set by `AssessmentRequestService` when the agent's own `assess_strategy_preset` call resolves for a matching identity. **This plan's new `assessment_artifact_id` column follows the same pattern** (nullable, FK to `market_assessment_artifacts.id`, `onDelete: 'set null'`, own btree index) — see `agent_preset_bindings.sourceArtifactId` and `agent_preset_transitions.assessmentArtifactId` for the existing FK convention.

8. **The manual review lifecycle is: API → BullMQ job → `ManualReviewRuntime.start()` worker callback → `runnerFactory(agentId)` → `runner.run({ trigger: 'manual', force: true })` → `markManualReviewSucceeded`/`markManualReviewFailed`.** Full flow in [manual-review-runtime.ts](../../../../../apps/worker/src/manual-review-runtime.ts) lines 40–110. `ManualReviewResultSummary` (in [manual-review-repository.ts](../../../../../packages/db/src/manual-review-repository.ts) lines 23–30) is the exact JSON persisted to `agent_assessment_review_runs.result_summary` and is what the API's `GET /:requestId` status endpoint returns verbatim as `resultSummary`. **This interface must be extended, not replaced**, to avoid breaking the existing polling contract.

9. **The advice GET endpoint queries only `review_advice`, never `market_assessment_artifacts`.** [agent-platform-assessment-reviews.ts](../../../../../apps/api/src/routes/agent-platform-assessment-reviews.ts) lines 248–295. Selects `symbol, outcome, activePreset, candidateRank, supportingFacts (as reasons)`. No artifact join exists today.

10. **Preset display names are not resolved anywhere in the advice path.** `reviewAdvice.activePreset` stores the raw preset key (e.g. `"momentum"`). The only place a key → display-name lookup exists is `getPreset(strategy, style)` in [presets-loader.ts](../../../../../packages/domain/src/config/presets-loader.ts) line 63, which returns a `PresetEntry` with a `.name` field (e.g. `"Momentum — Day"`) sourced from the style YAML (`config/strategy-presets/{economy,standard,premium}.yaml`).

11. **`marketAssessmentArtifacts.presetRankings` already has the exact shape needed for the ranking table.** Schema in [market-assessment-artifacts.ts](../../../../../packages/db/src/schema/market-assessment-artifacts.ts): `Array<{ presetKey, presetBehaviorVersion, rank, score, scoreBand, pros: string[], cons: string[], fitNotes: string | null }>`, plus top-level `recommendedPreset`, `allowedPresets`, `confidence`, `urgency`, `expiresAt`. No new computation needed — only plumbing.

12. **`agent_preset_bindings` is the authoritative source for "did the agent switch presets."** Schema in [agent-preset-bindings.ts](../../../../../packages/db/src/schema/agent-preset-bindings.ts): one active row per `(agentId, scope)`, with `sourceArtifactId` FK. A binding whose `sourceArtifactId` matches one of this review's artifact IDs, created **after** the review's `checkedAt`, is direct proof the agent acted on this specific review's recommendation.

---

## Goals

1. The forced-review runner calls the platform assessor synchronously (respecting the existing per-request instrument cap) for instruments the pre-check advises, producing real `market_assessment_artifacts` with ranked presets.
2. The wake sent to the agent includes the resulting artifact IDs and tells the agent to call `change_strategy_preset` directly — eliminating the redundant, separately-billed `assess_strategy_preset` call for artifacts the user's review already paid for.
3. The frontend shows, in order: (a) the per-instrument pre-check table immediately, (b) an assessment-in-progress state, (c) a preset-ranking result (current vs. recommended, full ranking with pros/cons) as the primary, non-collapsed UX once assessment completes.
4. The user can see whether the agent has acted on the recommendation (requested/consumed timestamps, and — when detectable — the resulting preset binding).
5. Preset keys are never shown raw in the UI; reason codes are shown as descriptions, not enum strings.
6. The scheduled review path is untouched — same behavior, same billing model (agent decides whether to spend on `assess_strategy_preset`).

## Non-Goals

- Do **not** change the scheduled review scheduler (`ReviewScheduler` / `startReviewSchedulerForAgent`) — it keeps the existing pre-check → wake → agent-self-initiates-`assess_strategy_preset` flow. Rationale (per discussion): nobody is necessarily watching a scheduled review's result, so the billing decision must stay with the agent, not be forced by a timer.
- Do **not** change `assess_strategy_preset` or `change_strategy_preset` tool contracts.
- Do **not** remove the per-instrument pre-check table — it becomes a collapsed "Show instrument details" section, not deleted.
- Do **not** add new operator config knobs beyond reusing `platformAssessor.maxInstrumentsPerRequest` and `platformAssessor.maxReviewRequestsPerDay` (both already exist in [config/schema.ts](../../../../../packages/domain/src/config/schema.ts)) as the cost guardrails for the new synchronous call.
- Do **not** touch intelligence-agent gating — already handled (capability-mode gate is pre-existing and unaffected by this plan).

---

## Design Decisions (closed — do not reopen)

1. **Pre-check remains a hard gate before any billed call.** Only `CandidatePreCheckOutcome` rows with `outcome === 'advised'` are passed to the assessor. This preserves the existing cooldown, fresh-artifact-suppression, and staleness protections untouched.
2. **Cap enforcement:** the runner takes at most `appConfig.platformAssessor.maxInstrumentsPerRequest` advised instruments per forced review (same operator config the tool already uses). If more are advised, the excess are left as `advised` in `review_advice` (uncalled) with a `not_assessed_capacity` marker so the UI can say "6 more instruments flagged — assess them individually via chat."
3. **Single billed call per instrument per review.** The runner calls `requestBatchAssessment` once; the resulting artifact IDs are handed to both the frontend and the agent wake. The agent must not re-call `assess_strategy_preset` for the same identity unless the artifact has expired.
4. **Assessment failures are non-fatal to the review.** If `requestBatchAssessment` returns `provider_failed`/`billing_blocked`/etc. for some instruments, the review still reports `succeeded`; those instruments get an error state in the results, not a failed run.
5. **Artifact expiry is the agent's responsibility, not the runner's.** The wake message states the expiry per artifact; if the agent wakes after expiry, it must call `assess_strategy_preset` fresh (billed again) — this is a rare, expected fallback, not a bug.
6. **Preset display names resolved server-side** via `getPreset(key, styleTier)?.name ?? key` — never computed or duplicated in the frontend.
7. **Reason codes get a fixed, versioned human-readable map** co-located with `ReviewPreCheckReasonCodes` — the API resolves codes to descriptions; the frontend never renders raw codes.
8. **Agent-action visibility is best-effort, not real-time-guaranteed.** The API looks up `review_advice.assessment_requested_at`/`consumed_at` and any `agent_preset_bindings` row with a matching `source_artifact_id` created after the review's `checkedAt`. If the agent hasn't acted yet, the UI shows "Awaiting agent action," not an error.
9. **Two-phase frontend UX, not three separate pages.** Same "Evaluations" card. Phase A (pre-check table, collapsed by default after phase B data arrives) → Phase B (progress) → Phase C (ranking result, primary/expanded).

---

## Proposed Changes

### Change 1 — Extend `AssessmentReviewRunner` to run assessments after the pre-check (manual trigger only)

**Files:**
- [assessment-review-runner.ts](../../../../../apps/worker/src/market-intelligence/assessment-review-runner.ts)
- [index.ts](../../../../../apps/worker/src/index.ts) (manual review runner factory lambda)

**What:**

1. Add to `AssessmentReviewRunnerDeps`:
   ```ts
   export interface AssessmentReviewRunnerDeps {
     db: Database;
     agentId: string;
     eventPublisher: InstanceEventPublisher;
     resolveActivePreset: () => Promise<Result<ActivePresetState>>;
     checkBillingEligibility: () => Promise<Result<boolean>>;
     /** Only required when the manual/forced path needs to run synchronous assessments. */
     assessmentRequestPort?: AssessmentRequestPort;
   }
   ```
   Optional so the scheduled path (`startReviewSchedulerForAgent`, which must NOT get this behavior) does not need to change its construction call.

2. Add to `AssessmentReviewRunnerConfig`:
   ```ts
   /** Cap on instruments assessed per forced review (mirrors platformAssessor.maxInstrumentsPerRequest). */
   maxAssessmentsPerReview: number;
   ```

3. Add a new type in [review-pre-check.ts](../../../../../packages/domain/src/review-pre-check.ts) (or reuse `AssessmentResultEntry` from `tool-schemas.ts` — prefer reuse, do not duplicate):
   ```ts
   export interface ReviewAssessmentResult {
     identity: MarketAssessmentIdentity;
     candidateRank: number;
     entry: AssessmentResultEntry; // from '@herobids/domain' tool-schemas.ts — reuse verbatim
   }
   ```

4. Add a private method to `AssessmentReviewRunner`:
   ```ts
   private async runAssessments(
     advised: CandidatePreCheckOutcome[],
   ): Promise<ReviewAssessmentResult[]>
   ```
   - No-op (returns `[]`) if `this.assessmentRequestPort` is undefined (scheduled path safety — this must never be reachable there, but fail safe, not fail loud, since the scheduled path deliberately omits this dep).
   - Filters `advised` to identities resolvable to `AssessmentRequestPortParams` (symbol + venueFamily + instrumentKind + styleTier from `activePreset`'s resolved `styleTier`).
   - Truncates to `this.config.maxAssessmentsPerReview`, preserving `candidateRank` order (best candidates assessed first).
   - Calls `this.assessmentRequestPort.requestBatchAssessment(params)` once (single batched call, not N calls).
   - Zips outcomes back to identities in request order (same pattern as `mapOutcomeToResultEntry` in [assess-strategy-preset.ts](../../../../../apps/worker/src/tools/assess-strategy-preset.ts) — reuse that exact mapping function, exported for shared use, instead of reimplementing).
   - On a `Result` failure from `requestBatchAssessment` itself (not per-instrument outcome failure), logs a warning and returns `[]` — the review still succeeds with pre-check-only results (Design Decision 4).

5. Modify `run()`:
   - After building `advisedPreFilter` (existing code, ~line 165), when `params.trigger === 'manual'` **and** `this.assessmentRequestPort` is defined, call `runAssessments(advisedPreFilter)` and store the result.
   - Persist assessment linkage (Change 2) before building the wake payload.
   - Extend `ReviewCheckOutcome` with:
     ```ts
     export interface ReviewCheckOutcome {
       // ...existing fields unchanged...
       /** Present only for the manual/forced path when assessments ran. */
       assessmentResults?: ReviewAssessmentResult[];
       /** True if more advised instruments existed than maxAssessmentsPerReview allowed. */
       assessmentCapacityExceeded?: boolean;
     }
     ```

6. **Wire the dep in `index.ts`.** In the `ManualReviewRunnerFactory` lambda (the async closure passed to `new ManualReviewRuntime(...)`), add `assessmentRequestPort: assessmentRequestService` and `maxAssessmentsPerReview: appConfig.platformAssessor.maxInstrumentsPerRequest` to the `AssessmentReviewRunner` construction. **Do not** add these to `startReviewSchedulerForAgent`'s construction (Non-Goal).

**Why:** keeps the scheduled path's construction call untouched (optional dep defaults to old behavior), while giving the manual path a single, capped, batched, non-blocking-on-failure path to real assessments.

### Change 2 — Persist assessment↔advice linkage: new `assessment_artifact_id` column

**Files:**
- [review-advice.ts](../../../../../packages/db/src/schema/review-advice.ts)
- new migration under `packages/db/drizzle/`

**What:**

1. Add column, following the exact precedent of `assessment_requested_at` (migration `0052_clear_expediter.sql`):
   ```ts
   /** Assessment artifact produced by a synchronous forced-review assessment (null until assessed). */
   assessmentArtifactId: text('assessment_artifact_id').references(() => marketAssessmentArtifacts.id, { onDelete: 'set null' }),
   ```
   Add import: `import { marketAssessmentArtifacts } from './market-assessment-artifacts.js';` (watch for circular import — `market-assessment-artifacts.ts` does not import `review-advice.ts`, so this is safe; verify with `pnpm --filter @herobids/db run build` after the change).
2. Add index: `index('idx_review_advice_assessment_artifact_id').on(t.assessmentArtifactId)`.
3. Generate the migration: `pnpm --filter @herobids/db run db:generate`. Verify the generated SQL matches the pattern:
   ```sql
   ALTER TABLE "review_advice" ADD COLUMN "assessment_artifact_id" text;
   ALTER TABLE "review_advice" ADD CONSTRAINT ... FOREIGN KEY ("assessment_artifact_id") REFERENCES "market_assessment_artifacts"("id") ON DELETE SET NULL;
   CREATE INDEX "idx_review_advice_assessment_artifact_id" ON "review_advice" USING btree ("assessment_artifact_id");
   ```
   Do not hand-edit the generated file or the `meta/*_snapshot.json`.
4. In `persistCheckOutcomes()` (assessment-review-runner.ts), when building `reviewAdvice` insert rows, set `assessmentArtifactId` from the matching `ReviewAssessmentResult.entry.assessment?.artifactId` (match by identity), else `null`.

**Why:** gives the API a direct join path from advice rows to their artifacts, and gives the agent-action-tracking query (Change 5) a stable key.

### Change 3 — Rewrite the wake message for artifact-first flow

**File:** [assessment-review-message.ts](../../../../../apps/worker/src/assessment-review-message.ts)

**What:** `buildAssessmentReviewMessage` currently always tells the agent to call `assess_strategy_preset` first. Split behavior:

- **When `ctx.advice` entries carry no artifact reference (scheduled path — unchanged today's message):** keep the exact current message unmodified. This is the default/fallback and must not regress — add a test asserting the scheduled-path message is byte-for-byte unchanged.
- **When advice entries carry an assessment artifact (manual/forced path, new):** render a new message:
  ```
  🔔 **Strategy Assessment Complete**

  The platform ran a deterministic pre-check and a market assessment at `${checkedAt}` for **${advice.length}** symbol(s).

  **Results:**
  - **#{candidateRank}** `{symbol}` ({venueFamily}, {styleTier})
    Current: `{activePreset}` → Recommended: **{recommendedPreset}** (confidence: {confidence})
    Artifact: `{artifactId}` — expires `{expiresAt}`

  **What to do:**
  1. Review the recommendation for each symbol above.
  2. To apply a switch, call `change_strategy_preset` with the exact `assessmentArtifactId` shown and your chosen `targetPreset` (must be one of the artifact's allowed presets).
  3. If an artifact has expired by the time you act, call `assess_strategy_preset` again for a fresh one (this will incur a new charge).

  **Important:** You are the final decision-maker. Consider your open positions, recent performance, and risk limits before acting. No further billing occurs for the artifacts listed above.
  ```
- This requires extending the wake payload's `context.advice[]` entries (currently `{identity, candidateRank, activePreset, presetBehaviorVersion, reasons}`, built in `run()`) with optional `assessmentArtifactId`, `recommendedPreset`, `confidence`, `expiresAt` fields **only for the manual path**. Extend `ScannerWakeContext`'s advice item type in [domain scanner-wake types] accordingly (additive, optional fields — do not break the scheduled path's existing shape).

**Why:** the agent must not be told to re-spend on an assessment the user already paid for; the message must make the already-billed artifact the obvious, cheaper path.

### Change 4 — Human-readable reason code descriptions

**File:** [review-pre-check.ts](../../../../../packages/domain/src/review-pre-check.ts)

**What:** add, adjacent to `ReviewPreCheckReasonCodes` (line 121):
```ts
export const ReviewPreCheckReasonDescriptions: Record<ReviewPreCheckReasonCode, string> = {
  regime_bias_mismatch: 'Market regime does not match this preset\u2019s bias',
  volatility_outside_preset_band: 'Volatility is outside this preset\u2019s acceptable range',
  insufficient_candidate_quality: 'Signal confidence is below the minimum threshold',
  no_peer_outperformance: 'No other preset is outperforming the current one here',
  peer_outperformance_detected: 'A different preset is generating more signals on this instrument',
  candidate_stale: 'Scanner data for this instrument is too old to act on',
  identity_unresolved: 'Could not resolve a canonical identity for this instrument',
  fresh_artifact_exists: 'A recent assessment already exists for this instrument',
  cooldown_active: 'This instrument was reviewed too recently to review again',
  billing_blocked: 'Assessment was skipped due to a billing restriction',
  agent_disabled: 'This agent is disabled',
  no_candidate: 'No scanner candidates were available to review',
};
```
Values are illustrative — copy review is expected during implementation, not a blocker.

**Why:** direct, testable, versioned mapping the API layer can consume without string-matching logic scattered elsewhere.

### Change 5 — API: advice endpoint enrichment + new results endpoint + agent-action lookup

**File:** [agent-platform-assessment-reviews.ts](../../../../../apps/api/src/routes/agent-platform-assessment-reviews.ts)

**5a. Enrich `GET /agents/:id/platform-assessment/reviews/:requestId/advice` (existing endpoint, lines 248–295):**

Add to the select: `reviewAdvice.assessmentArtifactId`, `reviewAdvice.assessmentRequestedAt`, `reviewAdvice.consumedAt`, `reviewAdvice.styleTier`. For each row, resolve:
- `activePresetName = getPreset(row.activePreset, row.styleTier as StyleKey)?.name ?? row.activePreset`
- `reasonsDisplay = (reasons as string[]).map(code => ReviewPreCheckReasonDescriptions[code as ReviewPreCheckReasonCode] ?? code)`

New response shape (additive fields only — do not remove existing ones, frontend rolls out in step with this):
```ts
{
  requestId, checkId,
  advice: Array<{
    symbol, outcome, activePreset, activePresetName,
    candidateRank, reasons /* raw, kept for debug */, reasonsDisplay,
    assessmentArtifactId: string | null,
    assessmentRequestedAt: string | null,
    consumedAt: string | null,
  }>,
}
```

**5b. New endpoint: `GET /agents/:id/platform-assessment/reviews/:requestId/results`**

- Ownership check (same pattern as existing endpoints).
- 404 if run not found or not owned.
- If `run.status !== 'succeeded'` or `!run.checkId`: return `{ requestId, status: run.status, results: [] }` (200, not error — polling clients treat empty results as "not ready").
- Otherwise: join `reviewAdvice` (by `checkId`) → `marketAssessmentArtifacts` (by `assessmentArtifactId`), only rows where `assessmentArtifactId IS NOT NULL`.
- For each: also check `agentPresetBindings` for a row with `sourceArtifactId = artifact.id` (agent acted).
- Response:
  ```ts
  {
    requestId: string,
    status: 'succeeded',
    capacityExceeded: boolean, // from agent_assessment_review_checks.outcome_summary or a stored flag — see Change 1 step 5
    results: Array<{
      symbol: string,
      artifactId: string,
      currentPreset: string,
      currentPresetName: string,
      recommendedPreset: string | null,
      recommendedPresetName: string | null,
      confidence: number,
      urgency: 'low' | 'medium' | 'high',
      expiresAt: string,
      rankings: Array<{ presetKey: string; presetName: string; rank: number; score: number; scoreBand: string; pros: string[]; cons: string[]; fitNotes: string | null }>,
      agentAction: 'awaiting' | 'acted',
      agentActionDetail: { appliedPreset: string; appliedAt: string } | null,
    }>,
  }
  ```
  `presetName` per ranking entry resolved the same way as `activePresetName` above.

**5c. Extend `PlatformAssessmentReviewStatus.resultSummary`** (returned by the existing `GET /:requestId` status endpoint) with:
```ts
assessmentStatus: 'not_applicable' | 'assessing' | 'completed';
assessedCount: number;
totalAdvised: number;
```
`not_applicable` covers old runs from before this change (no assessment ran) and any run where `advisedCount === 0`. Populate from `ManualReviewResultSummary` — extend that interface in [manual-review-repository.ts](../../../../../packages/db/src/manual-review-repository.ts) with these three optional fields (optional so existing rows without them still deserialize).

**Why split into two endpoints:** the status endpoint stays cheap (single-table read, used for 5s polling); the results endpoint does the artifact join and is only called once, when status flips to `succeeded`.

### Change 6 — Frontend: two-phase UX with preset ranking as primary result

**Files:**
- [api-client.ts](../../../../../apps/web/src/lib/api-client.ts)
- [AgentEvaluations.tsx](../../../../../apps/web/src/features/agents/AgentEvaluations.tsx)
- [en.ts](../../../../../apps/web/src/app/i18n/locales/en.ts) (+ other locale files, low priority — English first, note as follow-up if not translated same-PR)

**What:**

1. Update `PlatformAssessmentReviewStatus['resultSummary']` and `PlatformAssessmentReviewAdvice` interfaces to match Change 5's additive fields.
2. Add `PlatformAssessmentReviewResults` interface and `platformAssessmentReviews.getResults(agentId, requestId)` method, matching the 5b response shape exactly.
3. In `AgentEvaluations.tsx`, sequence the UI as:
   - **Phase A (immediate):** as soon as `reviewStatus.status === 'succeeded'` and `adviceData` loads, render the advice table **inside a `<details>`/expander, collapsed by default**, labeled via `agents.strategyReview.details` ("Show instrument details"). Use `activePresetName` and `reasonsDisplay`, not raw keys/codes.
   - **Phase B (progress):** while `resultSummary.assessmentStatus === 'assessing'`, show a progress row: `agents.strategyReview.assessing` ("Assessing {assessedCount} of {totalAdvised} instruments…") with a simple indeterminate or count-based progress bar. Poll `GET /:requestId` (existing polling already does this — just read the new fields).
   - **Phase C (primary result):** once `resultSummary.assessmentStatus === 'completed'`, fetch `getResults()` and render it **above** the (still-collapsed) instrument details expander. For each symbol: current vs. recommended preset (names, not keys), confidence, a ranking table (preset name / score / pros / cons), and an agent-action line ("Agent notified" / "Agent switched to {presetName}" using `agentAction`/`agentActionDetail`).
   - If `resultSummary.assessmentStatus === 'not_applicable'` (old runs, or zero advised instruments), Phase C is skipped entirely — only the instrument table (not collapsed in this case, since it's the only content) and the existing "no advice"/"advice" summary line render, preserving today's behavior exactly.
4. Add `agents.strategyReview.results.*` and `agents.strategyReview.assessing`/`.details` i18n keys per the earlier list (recommended, current, score, pros, cons, agentNotified, agentActed).
5. `agentActed` message interpolates the preset display name: `'Agent switched to {preset}'`.

**Why above, not replacing:** preserves an audit trail (raw instrument reasons) while making the actionable recommendation the first thing seen, without a second page or route change.

### Change 7 — Tests

1. **Worker:** `assessment-review-runner.test.ts` — `runAssessments()` calls `requestBatchAssessment` once with correctly capped/ordered params; skips entirely when `assessmentRequestPort` is undefined; non-fatal on port failure; `persistCheckOutcomes` writes `assessmentArtifactId` when present.
2. **Worker:** `agent-assessment-review.test.ts` (or new file) — scheduled-path message byte-for-byte unchanged (regression guard); manual-path message includes artifact IDs, recommended presets, and the "no further billing" line when assessment data is present.
3. **API:** advice endpoint returns `activePresetName` and `reasonsDisplay`; new results endpoint returns 200 with empty results for non-succeeded runs, and full ranking data (with `agentAction` correctly `'acted'`) for a succeeded run with a matching `agent_preset_bindings` row.
4. **Frontend:** component test — Phase A/B/C render order and collapse state; `not_applicable` fallback matches pre-change snapshot; agent-action row states.
5. **Regression:** existing `assessment-review-runner.test.ts`, `review-scheduler.test.ts`, `agent-assessment-review.test.ts` continue to pass unmodified except where explicitly noted above.

---

## Implementation Order

| Step | Change | Depends on | Risk |
|---|---|---|---|
| 1 | Change 4 — reason descriptions | none | Low |
| 2 | Change 2 — schema + migration | none | Low |
| 3 | Change 1 — runner assessment integration | 2 | Medium |
| 4 | Change 3 — wake message | 3 | Low |
| 5 | Change 5 — API enrichment + results endpoint | 2, 3 | Medium |
| 6 | Change 6 — frontend | 5 | Medium |
| 7 | Change 7 — tests | 1–6 | Low |

Steps 1 and 2 are independent and parallelizable.

---

## Verification

### Code-level
- [ ] `AssessmentReviewRunnerDeps.assessmentRequestPort` is optional; `startReviewSchedulerForAgent`'s construction call is unmodified.
- [ ] `runAssessments()` respects `maxAssessmentsPerReview` and calls `requestBatchAssessment` exactly once per forced review.
- [ ] Migration file exists under `packages/db/drizzle/` adding `assessment_artifact_id` + FK + index; no hand-edited snapshot.
- [ ] Scheduled-path wake message is byte-for-byte identical to today's (regression test passes).
- [ ] No `any`, `@ts-ignore`, or `as unknown as X` introduced.
- [ ] `pnpm lint` passes.
- [ ] `mapOutcomeToResultEntry` reused from `assess-strategy-preset.ts` rather than duplicated.

### Behavior-level
- [ ] Clicking "Run Strategy Review" on an eligible hybrid agent shows the pre-check table immediately (collapsed once Phase C data exists), then a progress indicator, then a preset ranking result.
- [ ] Preset keys never render raw in the UI; reason codes never render raw.
- [ ] The agent's wake for a manual-triggered review references the same artifact IDs shown in the frontend — no duplicate billed call for the same identity within the artifact's freshness window.
- [ ] A review with more advised instruments than `maxAssessmentsPerReview` still succeeds; excess instruments are visibly flagged as not assessed.
- [ ] A review where `requestBatchAssessment` fails outright still shows the pre-check table and a clear "assessment unavailable" state, not a failed run.
- [ ] The UI shows "Agent switched to {preset}" only when a real `agent_preset_bindings` row created after the review exists with a matching `sourceArtifactId`.
- [ ] Scheduled reviews are unaffected: no assessment calls, no new wake format, no new UI elements triggered.

### Commands
- `pnpm --filter @herobids/db run db:generate` then inspect the generated migration.
- `pnpm --filter @herobids/worker run test`
- `pnpm --filter @herobids/api run test` (if present) or relevant API test target.
- `pnpm --filter @herobids/web run test`
- `pnpm lint`

---

## Relevant Files

- `apps/worker/src/market-intelligence/assessment-review-runner.ts` — add optional `assessmentRequestPort` dep, `runAssessments()`, extend `run()` and `ReviewCheckOutcome`
- `apps/worker/src/tools/assess-strategy-preset.ts` — export `mapOutcomeToResultEntry` for reuse (currently module-private-ish, already exported per earlier research — verify and keep exported)
- `apps/worker/src/assessment-review-message.ts` — dual message paths (scheduled unchanged, manual new)
- `apps/worker/src/index.ts` — wire `assessmentRequestPort` + `maxAssessmentsPerReview` into the manual review runner factory only
- `apps/worker/src/manual-review-runtime.ts` — extend `ManualReviewResultSummary` construction with `assessmentStatus`/`assessedCount`/`totalAdvised`
- `packages/db/src/schema/review-advice.ts` — add `assessmentArtifactId` column + index
- `packages/db/src/manual-review-repository.ts` — extend `ManualReviewResultSummary` interface (optional fields)
- `packages/db/drizzle/` — new migration
- `packages/domain/src/review-pre-check.ts` — `ReviewPreCheckReasonDescriptions` map
- `apps/api/src/routes/agent-platform-assessment-reviews.ts` — enrich advice endpoint, add `/results` endpoint
- `apps/web/src/lib/api-client.ts` — new/extended interfaces, `getResults()` method
- `apps/web/src/features/agents/AgentEvaluations.tsx` — Phase A/B/C restructure of the Strategy Review section
- `apps/web/src/app/i18n/locales/en.ts` — new i18n keys

---

## Open Questions (resolved)

1. **Should the runner assess ALL advised instruments regardless of count?** No — capped at `platformAssessor.maxInstrumentsPerRequest`, same operator control as the agent tool (Design Decision 2).
2. **What happens if PlatformAssessor itself is down?** Review still succeeds with pre-check-only data; frontend Phase C shows an "assessment unavailable" state instead of rankings (Design Decision 4).
3. **Do we need a new operator config knob for this feature specifically?** No — reuse `maxInstrumentsPerRequest` and existing billing eligibility check already in `AssessmentReviewRunnerDeps.checkBillingEligibility`.
4. **Does the scheduled scheduler need any change at all?** No code change — confirmed as a hard non-goal; only regression test coverage to prove the wake message is unaffected.