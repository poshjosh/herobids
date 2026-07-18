# Decision Record: Platform Preset Assessment and Agent Strategy Transition

**Status:** Adopted for implementation planning
**Applies to:** [001-plan.md](./001-plan.md)
**Assumption:** Backward compatibility is not required. The database will be reset, so this feature may use a clean-slate schema and persistence model.

> Update: See [004-decision-amendment-per-symbol-on-demand-assessment.md](./004-decision-amendment-per-symbol-on-demand-assessment.md). That amendment supersedes the original segment-key and scheduled-generation decisions where they conflict.

## Companion Documents

- [001-plan.md](./001-plan.md) — root implementation plan and delivery phases
- [000-notes.md](./000-notes.md) — source notes and product intent that informed these decisions

## Purpose

This document freezes the phase-0 decisions needed before implementation begins so the feature can be built against one concrete architecture and one concrete data model.

## D1. Shared Assessment Segment Key

**Decision:** Use this minimum segment key:

```text
{ venueFamily, styleTier, universeScopeHash }
```

### Definitions

- `venueFamily`: e.g. `hyperliquid-orderbook`, `bybit-orderbook`
- `styleTier`: `economy`, `standard`, `premium`
- `universeScopeHash`: hash of the normalized shared-assessment scope, derived from discovery-relevant filters only

### Included in `universeScopeHash`

- binding venue family / venue type
- minimum volume / liquidity filters
- network filters
- explicit symbol allowlists
- explicit symbol deny-lists
- other discovery-relevant filters that change the shared candidate set

### Excluded from `universeScopeHash`

- open positions
- risk limits
- capital
- current preset
- recent PnL
- actor-specific transition policy

### Rationale

The segment key must be coarse enough for reuse and fine enough to avoid misleading cross-agent sharing. Actor-local state remains downstream of shared market assessment.

If two agents would discover different candidate populations, they must not share a segment key.

## D2. Wake Taxonomy Compatibility

**Decision:** Reuse `source: scanner` and enrich the scanner payload. Do not add a new `AgentWakeSource` for preset review.

### Required payload enrichment

- scanner context discriminator that distinguishes preset-review wakes from signal-scoring wakes
- `assessmentRef`
- `recommendedPreset`
- `currentPreset`
- `relativeUplift`
- `confidence`

### Required downstream routing

- the scanner wake context schema must become a discriminated union
- preset-review wakes must route to the transition-review path
- preset-review wakes must not route into the single-shot hybrid entry evaluator

### Rationale

This preserves the existing wake taxonomy and scanner-gated mental model while still distinguishing preset-review wakes from entry-signal or exit-advisory scanner wakes.

## D3. Persistence Home

**Decision:** Use Postgres as the authoritative store. Redis may be used as a cache for the latest segment artifact, but not as the source of truth.

### Authoritative first-class tables

- `market_assessment_runs`
- `market_assessment_artifacts`
- `market_assessment_wake_decisions`
- `agent_scan_metrics`
- `agent_preset_transitions`

Equivalent naming is acceptable, but the model must remain explicit and queryable.

### Rationale

This feature depends on historical auditability, attribution, replay, and evaluation. Those requirements favor a relational authoritative store.

## D4. Execution Model

**Decision:** Implement the platform assessor as a worker-hosted scheduled coordinator in v1.

### First-version behavior

- one scheduler loop per configured segment family / venue surface
- one assessment job per segment on operator-configured cadence
- deterministic evidence generation happens in worker-managed shared infrastructure
- platform LLM assessment is invoked by the worker, not by actor containers
- shared scorecard generation runs through a headless engine that is decoupled from `AgentTradingActor`

### Deferred

- separate service deployment
- external orchestrator-specific assessment service
- actor-local LLM fallback for missing shared assessment

### Rationale

This is the smallest architecture that centralizes cost and logic while reusing existing worker access to market data, config, and persistence.

## D5. Phase-1 Local Performance Metrics

**Decision:** Phase 1 must persist and expose the following authoritative metrics:

### Scan-level

- `candidatesDiscovered`
- `candidatesScored`
- `signalsGenerated`
- scan health classification
- active preset at scan time

### Decision-level

- decision submitted / accepted / rejected
- entry vs exit intent
- active preset at decision time

### Trade-level

- realized PnL
- hold duration
- exit classification
- active preset at close time

### Transition-level

- old preset
- new preset
- transition mode
- open-position count at transition time
- accept / reject / defer outcome

### Deferred metrics

- MAE / MFE
- regime-bucketed expectancy
- per-preset drawdown decomposition
- advanced confidence calibration studies

### Rationale

These metrics are the minimum needed to measure preset quality meaningfully without blocking the first implementation on richer analytics.

## D6. First-Class Config and Schema Surfaces

**Decision:** Use dedicated typed config surfaces and first-class tables instead of generic metadata overlays.

### Agent-owned typed config surface

`UnifiedAgentConfig` should gain dedicated typed sections for:

- allowed strategy preset policy
- preset transition policy
- platform assessment opt-in / mode

### Platform-owned relational surfaces

Use first-class tables for:

- assessments
- wakes
- scan metrics
- transitions

### Rationale

The DB reset removes the need for compatibility shims, so the design should optimize for clarity, queryability, and evolution.

## D7. Preset Versioning Rule

**Decision:** The authoritative preset behavior version is derived mechanically from a normalized hash of behavior-affecting preset fields.

### Behavior-affecting fields include

- indicator parameters
- candle interval or candle limit
- signal bias
- scoring thresholds or confidence weighting
- entry/exit logic semantics
- risk-default mapping derived from the preset
- execution sizing semantics derived from the preset

### Non-material changes include

- display name edits
- description/help text edits
- documentation-only changes

### Rationale

Performance attribution must remain meaningful after preset evolution. A manual version bump is not an enforceable mechanism; the authoritative behavior version must change automatically when behavior changes.

## D8. Freshness and Fallback Behavior

**Decision:** If there is no fresh shared assessment artifact, the actor does not switch presets.

**Configurability:** Freshness windows and staleness behavior thresholds are operator-configurable.

### Freshness rules

- stale artifacts do not trigger review wakes
- stale artifacts are surfaced as stale by actor read tools
- stale artifacts cannot be used for `apply_preset_transition` in v1

### Fallback behavior

- actor keeps its current preset
- actor continues normal trading behavior
- missing or stale shared assessment is recorded for observability

### Rationale

The fallback path must be deterministic and conservative. Missing shared assessment must not create implicit local strategy churn.

## D9. Materially Better Threshold Model

**Decision:** Review-wake eligibility requires all of the following dimensions, with exact numeric thresholds owned by operator config:

- minimum score uplift over current preset
- minimum assessor confidence
- stricter threshold when open positions exist
- optional persistence across multiple consecutive assessments when the market is noisy

**Configurability:** The score-uplift threshold, confidence threshold, and stricter open-position threshold are operator-configurable.

### Rationale

"Materially better" must be a policy-controlled threshold model, not a free-form explanation from the platform assessor.

## D10. Recommendation Authority

**Decision:** The platform assessor is advisory. The actor agent is authoritative for account-level preset switching.

### Required behavior

- actor may accept, defer, or reject a platform recommendation
- defer/reject outcomes must persist a reason
- those reasons become evaluation inputs later

### Rationale

Shared market fit is not the same as account-specific actionability. Open positions, recent experience, and creator constraints remain actor-local.

## D11. Rollout Safety Gate

**Decision:** Live preset switching must not be enabled before shadow-mode evidence shows acceptable behavior.

**Configurability:** Assessment cadence, budget caps, and rollout/shadow-mode thresholds are operator-configurable.

### Required shadow-mode evidence

- wake volume is bounded
- recommendation stability is acceptable
- actor reject/defer behavior is understandable
- assessor-quality metrics are directionally sane

### Budget degradation policy

- when the global assessor budget is exhausted, the platform stops starting new assessment-driven review work for yet-unassessed segments
- already-started assessments are preferred over new work
- queued segments are revisited in stable round-robin order on the next eligible cycle
- existing fresh artifacts may still be used until they expire

### Rationale

The platform needs recommend-only evidence before it is allowed to change agent preset behavior live.

## D12. Open-Position Transition Scope for v1

**Decision:** v1 supports:

- `entries_only`
- `entries_and_tighten_existing`

`entries_and_full_transition` remains gated for later rollout.

### Rationale

This preserves useful transition behavior without creating a backdoor to widen stops, remove protection, or silently rewrite management assumptions for underwater positions.

## Summary of Adopted Choices

- shared assessment key: `venueFamily + styleTier + universeScopeHash`
- wake source: existing `scanner`, enriched with `scannerKind: preset_review`
- storage: Postgres authoritative, Redis cache optional
- execution model: worker-hosted scheduled coordinator
- phase-1 metrics: scan/decision/trade/transition attribution with preset context
- preset versioning: material behavior changes bump `presetVersion`
- fallback: no fresh artifact means no preset switch
- v1 transition modes: `entries_only`, `entries_and_tighten_existing`

## Configurability Summary

The following must be operator-configurable and must not be hard-coded in implementation:

- platform assessor cadence
- assessment freshness window / staleness policy
- materially-better score uplift threshold
- minimum assessor confidence threshold
- platform-assessor budget caps