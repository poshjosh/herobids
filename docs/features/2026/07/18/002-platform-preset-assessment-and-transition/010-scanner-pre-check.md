# Implementation Plan: Persisted Scanner Candidates And Deterministic Review Advice

**Status:** Done - rewritten after implementation review
**Depends on:** active-preset state defined in [012-tool-context-wiring.md](./012-tool-context-wiring.md) and request/billing eligibility in [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md)
**Purpose:** Make `ReviewScheduler` produce real, bounded, advice-only assessment-review wakes from persisted normal-scanner observations.

## Authoritative Plan

This section supersedes the archived draft below. Implement only this section.

### Scope And Invariants

- Review advice is derived from recent persisted scanner candidates, not venue-wide discovery guesses, open-position enumeration, or aggregate `agent_scan_metrics`.
- `agent_scan_metrics` contains aggregate counts and normally only the active preset. It cannot compare peer presets for a symbol and must not be used to claim that a peer preset produces more signals.
- The pre-check performs no LLM call, assessment run, billing reservation, credit deduction, or configuration change.
- A due review with no qualifying advice persists a durable check result and sends no wake. The absence of a candidate must not cause immediate post-restart rechecks.
- Every agent type uses the existing one `source: scanner`, `scannerKind: assessment_review` path. Ordinary scanner signal wakes remain unrelated and must never carry assessment advice.

### Persist Scanner Candidate Observations

Instrument the normal technical scan path to persist a bounded candidate observation for each candidate that reaches deterministic scoring. Add a first-class table, for example `agent_scan_candidates`, linked to the scan/agent and retained only for the configured review lookback.

Persist at minimum:

- agent ID, scan timestamp, scan/signal calculation version, active preset key and mechanically derived behavior version;
- canonical identity or a lossless raw candidate identity plus resolution status;
- stable candidate rank and source scan scope;
- deterministic signal/indicator facts, confidence, regime/volatility facts if available, and a data freshness timestamp;
- candidate disposition: discovered, scored-no-signal, entry-candidate, exit-advisory, rejected, or unresolved;
- enough normalized facts to reproduce the review predicate without making another market-data/provider request.

Do not overload `agent_scan_metrics`; it remains aggregate telemetry. Apply a bounded retention policy and indexes for `(agentId, scannedAt)`, canonical identity, and rank. Invalid/unresolved candidates are recorded for observability but cannot be advised until canonical resolution succeeds.

### Deterministic Review Predicate

Create a pure `AssessmentReviewEligibility` function or domain port:

```ts
evaluate(input: {
  candidate: PersistedScannerCandidate;
  activePreset: ActivePresetState;
  policy: ResolvedReviewPreCheckPolicy;
}): { eligible: boolean; reasons: string[]; policyVersion: string };
```

The predicate compares a candidate's persisted deterministic market facts with the active preset's actual catalog behavior profile, for example interval, signal bias, enabled indicator requirements, and configured compatibility thresholds. It must produce stable, explainable reason codes such as `regime_bias_mismatch`, `volatility_outside_preset_band`, or `insufficient_candidate_quality`; it must not claim observed peer-preset outperformance without running peer scorecards.

Keep thresholds and selectable policy dimensions in resolved operator configuration. Calculation algorithms and reason-code vocabulary are versioned in code. The persisted advice record contains the predicate version, input fact references, and reasons used at the time.

### Pre-Check Flow

For one due agent review:

1. Acquire a durable per-agent review-check lease or enforce a unique due-window check record so multiple workers cannot create duplicate checks/wakes.
2. Resolve the agent's effective assessment config and active-preset state. A disabled/misconfigured agent creates an auditable non-advised check and does not wake.
3. Select recent, successfully resolved candidate observations in stable rank/timestamp order, capped by `scannerCandidateLimit`.
4. For each candidate, reject or record the first applicable outcome: stale candidate data, unresolved identity, fresh shared artifact, per-agent identity advice cooldown, non-reserving billing preflight failure, or failed deterministic review predicate.
5. Persist one review-check record and its candidate outcomes before attempting delivery. Every outcome, including `no_candidate`, has a durable home.
6. If one or more outcomes are `advised`, emit exactly one bounded `assessment_review` wake, mark only the delivered advice as consumed, and preserve at-least-once delivery/idempotent-consumer semantics.

The pre-check's billing preflight may quote/check account eligibility through a read-only billing port. It is advisory only; the request service re-evaluates price, balance, cap, cache state, and reservation authoritatively when the agent asks for an assessment.

### Scheduler Lifecycle And Persistence

Add a review-check table, such as `agent_assessment_review_checks`, with agent ID, effective interval, due/checked/next-eligible timestamps, status, policy version, outcome summary, lease/recovery fields, and error details. `review_advice` rows reference this check record.

`isReviewDue()` reads this durable state rather than inferring due time from only advice rows. The scheduler registry must reconcile agents when they start/stop, enable/disable assessment, or update their review interval/config. Worker startup is not the sole lifecycle hook. Recurring loops must reschedule after failure and leave a recoverable failed check record.

### Configuration

Define typed, resolved policy for:

- candidate observation retention/freshness and maximum advice payload size;
- scanner candidate limit and stable ordering;
- per-identity advice cooldown and review interval floor;
- deterministic compatibility thresholds and policy version;
- review-check lease duration/recovery policy;
- read-only billing-preflight timeout/behavior.

Do not add a second open-position polling timer in phase 1. Open positions may become an explicitly designed candidate source later only when the same freshness, deterministic-fact, and review-predicate contracts are defined.

### Required Changes And Tests

| Surface | Change |
|---|---|
| Normal technical scan path | Persist bounded candidate observations with deterministic facts. |
| `ReviewScheduler` | Replace placeholder `runPreCheck`, add durable check/lease flow, and consume candidate records. |
| DB schema | Add candidate and review-check tables; link advice to checks. |
| Domain/config | Add active-preset accessor contract, eligibility predicate types, and resolved policy. |
| Scheduler registry | Reconcile scheduler lifecycle on agent/config changes. |

Unit tests must prove stable candidate ordering, eligibility reason codes, every blocked outcome, stale/unresolved handling, and no LLM/billing/assessment side effect. Integration tests must prove a no-candidate check persists and does not wake; advised candidates create exactly one bounded wake; ordinary scanner wakes remain unmodified; two workers cannot duplicate one due check; and restart recovery respects the persisted interval.

This plan is complete only when [006-followup-plan.md](./006-followup-plan.md) C5 has executable proof.

## Archived Draft - Do Not Implement

---

## 0. Scope

This plan covers the **deterministic scanner pre-check** — the bridge between the per-agent review scheduler and the assessment pipeline. Without this, the scheduler runs on a timer but never finds anything to advise, so no `assessment_review` tick is ever emitted to any agent.

It does NOT cover:
- The scheduler loop, due-check, or tick-delivery infrastructure (already implemented in `review-scheduler.ts`)
- The assessor itself (Plans 008, 009)
- Billing (Plan 007)

---

## 1. Current State (what's broken)

### `ReviewScheduler.runPreCheck()` — `review-scheduler.ts`

Always returns a single `no_candidate` entry:

```ts
private async runPreCheck(): Promise<Result<Array<{...}>>> {
  // TODO: Wire the actual scanner/deterministic check logic.
  // For now, return a single no_candidate entry to indicate the check
  // ran without finding any actionable candidates.
  return ok([
    { outcome: 'no_candidate' },
  ]);
}
```

This means:
- The scheduler starts, waits for the review interval, runs the pre-check, persists "no_candidate", and schedules the next check.
- No advice rows with outcome `advised` are ever created.
- No `assessment_review` wake is ever emitted.
- The entire review pipeline (G3, G6 from Plan 006) exists structurally but is behaviorally idle.

---

## 2. What Needs to Change

### 2.1 Candidate Discovery

The pre-check must discover what symbols the agent is trading (or could trade) and check each one against deterministic criteria.

**Step 1 — Gather candidate symbols (resolved priority order):**

1. **Open positions first** — Query the agent's open positions (via `BotRepository.getOpenPositionsByCreator`). These are symbols the agent has real exposure to. If open positions alone exceed `scannerCandidateLimit`, prioritize by position size (largest first).
2. **Venue top-N as fallback** — If open positions < `scannerCandidateLimit`, fill the remainder with the venue's top instruments by volume/liquidity (from Discovery Redis cache or `VenueInstrumentCache`).

Deduplicate by canonical symbol + venueFamily. Cap at `scannerCandidateLimit` (from config, default 20).

**Step 2 — For each candidate symbol, construct a `MarketAssessmentIdentity`:**

- Orderbook/perp: `{ instrumentKind, venueFamily, styleTier, symbol }`
- Swap/dex: `{ instrumentKind, venueFamily, styleTier, network, address }`

Use `resolveAssessmentIdentity()` for normalization. Skip candidates that fail resolution (unknown symbols, ambiguous tokens).

**Step 3 — For each resolved identity, run the deterministic checks:**

| Check | Logic | Outcome if fails |
|-------|-------|-----------------|
| **Fresh artifact exists** | Query `market_assessment_artifacts` for an active, non-expired artifact matching this identity. Use `isArtifactFresh()`. | `fresh_artifact_exists` |
| **Cooldown active** | Query `review_advice` for the most recent `advised` or `blocked_by_cooldown` row for this (agentId, identity). If within cooldown window, block. | `blocked_by_cooldown` |
| **Credit indication** | Non-reserving check: can the agent's billing account afford an assessment? This is a cheap pre-check, NOT the actual billing reservation (that happens later in `AssessmentRequestService`). Query `UsageBillingRepository` for current balance vs. assessment price. | `blocked_by_no_credit_indication` |
| **Preset-candidate mismatch** | Deterministic check: does the agent's current preset look sub-optimal for this symbol? Compare scan metrics for the current preset vs. peer presets in the same tier. If another preset consistently generates more signals or higher-confidence signals for this symbol family, flag as advised. | `not_advised` (if no mismatch detected) |

If ALL checks pass → outcome = `advised`.

### 2.2 Data Sources for Mismatch Detection

The "preset-candidate mismatch" check is the heart of the pre-check.

**Resolved algorithm: Signal-count ratio for Phase 1.**
- Query `agent_scan_metrics` for the agent's current preset vs. peer presets in the same style tier.
- If a peer preset has ≥`signalRatioThreshold`× the `signalsGenerated` count of the current preset over the lookback window → flag as potential mismatch.
- This is cheap (single DB query), uses existing data, and requires zero new scanner work.
- **Fast-follow (Phase 1.1):** Add confidence-based comparison (`topConfidence` across presets) as a secondary signal once scanner populates it consistently.

### 2.3 Pre-Check Frequency

**Resolved:** Single interval for all checks in Phase 1. The pre-check runs on the agent's review interval (default 24h, configurable via `reviewIntervalMs`, subject to operator minimum floor). No separate interval for open positions — adding a second timer adds scheduling complexity (race conditions, double-wake risk) for marginal benefit.

If open-position urgency becomes a real need later, the right mechanism is an **event-driven trigger** ("position opened → check preset fit") rather than a second polling interval. Design as a separate feature post Phase 1.

### 2.4 Dependencies to Inject

`ReviewScheduler` currently only has `db`, `redis`, `agentId`, and `eventPublisher`. The pre-check needs:

| Dependency | Purpose | Source |
|-----------|---------|--------|
| Bot repository (or position lookup) | Get agent's open positions | Already available via `agentRepo` / `botRepo` in `index.ts` |
| `agent_scan_metrics` table | Query scan metrics for preset comparison | Already available via `db` |
| `market_assessment_artifacts` table | Check for fresh artifacts | Already available via `db` |
| `review_advice` table | Check cooldown | Already available via `db` |
| `UsageBillingRepository` | Non-reserving credit check | Already available in worker context |
| Preset catalog (preset behavior versions) | Get peer preset keys for comparison | Available via strategy presets or config |
| Agent config (current preset, style tier) | Know what the agent is currently using | Available via `agentConfigOps` or `unifiedConfig` |

Add these as optional constructor dependencies or pass them via the existing `ReviewSchedulerDeps` interface.

### 2.5 Config-Driven Thresholds

All thresholds must come from config, not hardcoded:

| Threshold | Config path | Default |
|-----------|------------|---------|
| Signal count ratio for mismatch flag | `platformAssessor.preCheck.signalRatioThreshold` | 2.0 |
| Lookback window for scan metrics | `platformAssessor.preCheck.scanMetricsLookbackMs` | 86_400_000 (24h) |
| Minimum signals to consider a preset "active" | `platformAssessor.preCheck.minSignalsForActive` | 3 |
| Cooldown window per (agent, identity) | `platformAssessor.preCheck.identityCooldownMs` | 86_400_000 (24h) |

### 2.6 The `no_candidate` Case

When the pre-check genuinely finds nothing (no open positions, no scanner candidates, empty venue cache), returning `[{ outcome: 'no_candidate' }]` is correct. The scheduler should log this at debug (not warn) level — it's a normal state.

The `persistCheckOutcomes` method already skips `no_candidate` entries (no identity to hand off). This behavior is correct and should be preserved.

---

## 3. Files Changed

| File | Change |
|------|--------|
| `apps/worker/src/market-intelligence/review-scheduler.ts` | Rewrite `runPreCheck()`: collect candidates, build identities, run checks, classify outcomes. Add config-driven thresholds. Extend `ReviewSchedulerDeps` with needed repositories. |
| `apps/worker/src/market-intelligence/review-scheduler.test.ts` | Add tests for candidate discovery, identity resolution, mismatch detection, cooldown, credit check. Test all outcome types. (Note: file may not exist yet — create if needed.) |
| `apps/worker/src/index.ts` | Update `createReviewScheduler()` call to pass new dependencies (botRepo, usageBillingRepo, preset catalog, agent config). |
| `packages/domain/src/config/schema.ts` | Add `PreCheckConfigSchema` with signalRatioThreshold, scanMetricsLookbackMs, minSignalsForActive, identityCooldownMs. Embed in `PlatformAssessorConfigSchema`. |
| `config/default.yaml` | Add `preCheck` block under `platformAssessor`. |

---

## 4. Dependencies

- The scanner must be running and populating `agent_scan_metrics` (otherwise mismatch detection will never fire).
- `UsageBillingRepository` must be initialized in the worker context.
- Plan 008 (real evidence) is NOT a hard dependency — the pre-check is about flagging candidates, not assessing them.

---

## 5. Test Strategy

- **Unit tests:** Mock all DB queries. Verify `runPreCheck()` returns correct outcomes for each check type:
  - Candidate with fresh artifact → `fresh_artifact_exists`
  - Candidate within cooldown → `blocked_by_cooldown`
  - Candidate with no credit → `blocked_by_no_credit_indication`
  - Candidate with signal mismatch → `advised`
  - Candidate with no mismatch → `not_advised`
  - No candidates at all → `no_candidate`
- **Unit tests:** Verify candidate deduplication.
- **Unit tests:** Verify config thresholds are respected (signal ratio, lookback window).
- **Integration tests:** Run against a real DB with seeded positions, scan metrics, and artifacts. Verify pre-check produces `advised` outcomes when conditions are met.
- **Integration tests:** Verify the full flow: scheduler → pre-check → persist → wake emission (G3, G6 from Plan 006).

---

## 6. Completion Bar

- `runPreCheck()` queries real data sources (positions, scan metrics, artifacts, advice) — not hardcoded results.
- At least one integration test proves an `advised` outcome is produced when conditions are met.
- At least one integration test proves the full wake-emission path (scheduler → pre-check → persist → wake).
- `no_candidate` is still possible and handled correctly when scanners/venues have no data.
- All thresholds come from operator config.
- `pnpm lint` and `pnpm build` pass.

---

## 7. Resolved Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Candidate scope: open positions first, venue top-N as fallback** | Open positions have real exposure — highest urgency. Fill remainder with venue top-N up to `scannerCandidateLimit`. |
| 2 | **Mismatch detection: signal-count ratio (Phase 1), confidence-based later** | Signal-count ratio is available TODAY from `agent_scan_metrics` with zero scanner changes. Confidence comparison is a fast-follow (Phase 1.1). |
| 3 | **Pre-check frequency: single interval, no separate open-position timer** | Avoids scheduling complexity. Event-driven trigger for open-position urgency can be designed as a separate feature later. |
| 4 | **Non-reserving balance check: add `getBalance()` if missing** | Read-only query on `UsageBillingRepository`. Distinct from the billing reservation in Plan 007. |
