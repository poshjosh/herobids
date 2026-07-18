# Plan: Platform Preset Assessment and Agent Strategy Transition

**Status:** Draft
**Scope:** Shared market assessment for strategy-preset ranking, platform-controlled review wakes, and actor-local preset transition decisions.

## Companion Documents

Implementers should read this plan together with:

- [000-notes.md](./000-notes.md) — source notes and product intent captured during feature definition
- [002-decision-record.md](./002-decision-record.md) — phase-0 architectural and data-model decisions adopted for implementation

## Problem

Agents can already run with preset-derived technical configuration, but preset fitness is not static across market regimes. Today the effective scanner/evaluator path is still primarily actor-centric: each agent scans with its own `technical` configuration and reaches its own conclusions about what the market looks like.

That is the wrong place to put the expensive, higher-level question:

```text
Which allowed preset is currently the best fit for this market segment?
```

That question is shared across many agents. It should not be recomputed independently by every actor agent.

## Core Decision

This feature adopts a three-layer split:

1. **Scanner layer stays dumb and deterministic.**
   It gathers shared evidence, computes deterministic per-preset scorecards, and never makes strategy-switch decisions.
2. **A platform assessor becomes the intelligent shared analyst.**
   It reviews the shared evidence on a periodic schedule and produces a cached market-assessment artifact for a market segment.
3. **The actor agent remains the final decision-maker for its own account.**
   It consumes the shared assessment together with local state (open positions, recent performance, creator-locked risk, switch history) and decides whether to switch presets and how to treat existing positions.

## Goals

1. Implement shared platform preset-fit assessment instead of adding preset-fit evaluation independently inside each actor.
2. Preserve the scanner-gated cost model: no new wake taxonomy, no unbounded direct regime-change wakes.
3. Allow agents to switch only among allowed presets inside their current style tier.
4. Preserve creator-locked risk and prevent a preset switch from silently weakening hard limits.
5. Allow an agent with open positions to switch presets without implicitly reinterpreting existing positions.
6. Add hysteresis and wake gating so agents do not thrash between presets during noisy transitions.
7. Produce auditable evidence for every ranking, wake, recommendation, and applied transition.
8. Measure preset, regime, scan, decision, transition, and realized-trade performance with first-class, meaningful metrics.
9. Keep the architecture flexible and evolvable: versioned schemas, pluggable scorecard logic, and clean separation between shared assessment and actor-local action.

## Non-Goals

- Do not allow arbitrary free-form mutation of trading strategy config.
- Do not let the platform assessor directly mutate agent config or submit trades.
- Do not add a new wake source to `AgentWakeSource`; preset review reuses the existing `scanner` wake path.
- Do not widen creator-locked stop loss, position size, or other hard risk settings through preset switching.
- Do not require every agent to use platform preset assessment; rollout must be feature-gated.
- Do not preserve legacy persistence or config shapes for this feature; the database reset permits a clean-slate design.

## Product Invariants

1. **Preset switching stays inside the current style tier.**
   A careful/economy agent can only rotate among economy presets; balanced/standard among standard; bold/premium among premium.
2. **The platform assessor ranks market fit, not account-specific action.**
   It answers "what fits this market segment best" rather than "should agent X switch right now".
3. **Actor-local state decides application.**
   Open positions, recent switch history, local performance, and creator constraints are evaluated by the actor agent, not the platform assessor.
4. **Future-entry behavior and open-position transitions are separate decisions.**
   A preset switch changes future entry behavior. Any treatment of existing positions must be explicit and auditable.
5. **Creator-locked risk always wins over preset defaults.**
   The runtime transition path must reuse the same precedence rules the API already applies for preset-derived risk fields.
6. **Performance attribution must be event-accurate.**
   Every scan, decision, trade outcome, assessment, wake, and transition must be attributable to the active preset, segment, and regime context at that time.
7. **This feature ships on clean first-class data structures.**
   Assessment, metrics, and transition data must use purpose-built schema/table design rather than ad hoc metadata blobs intended for backward compatibility.
8. **Platform recommendations are advisory; actor actions are authoritative.**
   The platform assessor ranks market fit and the wake gate decides whether to ring the bell, but the actor agent remains authoritative for account-level preset action.

## High-Level Architecture

```text
scheduled segment assessment
  -> shared scanner evidence collection
  -> deterministic per-preset scorecards
  -> platform LLM assessment
  -> cached market-assessment artifact
  -> platform wake gate
  -> eligible actor agents receive review wake
  -> actor agent decides whether to switch
  -> actor applies entries-only or explicit transition actions
```

## Decision Rules

### Materially better

The implementation must define "materially better" explicitly rather than leaving it as a narrative phrase.

The first version should require:

- a minimum score uplift over the actor's current preset
- a minimum assessor confidence threshold
- optional persistence across more than one assessment when the market is noisy
- a stricter threshold when open positions exist

Exact numbers belong in operator config, but the dimensions of comparison must be fixed in the contract.

The following must all be operator-configurable rather than hard-coded:

- assessment cadence
- artifact freshness window / staleness policy
- minimum score uplift threshold
- minimum assessor confidence threshold
- platform-assessor budget caps

### Budget degradation policy

If the platform-assessor budget is exhausted, the system must degrade deterministically:

- stop creating new assessment-driven review wakes for segments that were not assessed
- prefer completing already-started assessments over starting new ones
- evaluate queued segments in a stable round-robin order on the next eligible cycle
- continue serving existing fresh artifacts until they expire
- record budget-exhaustion suppressions for observability

### Recommendation authority and disagreement

The platform assessor is advisory. The actor agent is authoritative for its own account-level decision.

If the actor declines a strong platform recommendation, the system must persist a reject or defer reason for later evaluation.

## Assessment Segments

The platform assessor must not publish one global ranking for all agents. Assessments are partitioned by a segment key.

### Minimum segment dimensions

1. Venue family / execution surface
   - e.g. `hyperliquid-orderbook`, `bybit-orderbook`
2. Style tier
   - `economy`, `standard`, `premium`
3. Effective scan universe scope
   - at minimum, whether the universe is global vs explicitly restricted symbols

### Candidate follow-up segment dimensions

- Region of liquidity band or market-cap band if preset tuning becomes universe-sensitive
- Asset-class cohort if a single venue surface mixes materially different products

The first version should use the smallest segment key that avoids obviously misleading cross-agent ranking reuse.

`universeScopeHash` must be derived from the concrete discovery inputs that determine the shared candidate population. At minimum this includes:

- binding venue family / venue type
- `minVolume24hUsd`
- `minLiquidityUsd`
- `networks`
- `symbols`
- `excludeSymbols`
- any future discovery input that changes the candidate set

If two agents would discover different candidate populations, they must not share the same segment key.

## Clean-Slate Data Model

Backward compatibility is not a requirement for this feature. The implementation should use a clean purpose-built model from the start.

### Persisted concepts that should be first-class

- allowed strategy preset policy for an agent
- preset transition policy for an agent
- market assessment runs
- current and historical market assessment artifacts
- agent scan metrics
- agent preset transition events
- platform wake-gate decisions

### Preferred direction

Use explicit schema/table design rather than burying these concepts inside generic JSON metadata where queryability, attribution, and evolution become fragile.

## Preset Identity and Versioning

Preset IDs must be durable and behavior versions must be mechanically derived.

### Rules

- `presetKey` identifies the logical preset family.
- the authoritative behavior version must be derived from a normalized hash of behavior-affecting preset fields
- assessments, metrics, decisions, and transitions must record both `presetKey` and the derived behavior version
- a human-readable revision label may exist, but attribution must not depend on a manual version bump
- a materially changed preset must not silently inherit old performance history as though it were unchanged

## Meaningful Performance Measurement

This feature only works if the platform can measure performance accurately enough to support trustworthy preset recommendations.

### Measurement principle

Every important event must be attributable to:

- agent
- active preset at the time
- market-assessment segment key
- regime snapshot or regime bucket
- timestamp
- transition context, where applicable

### Minimum measurement primitives

#### Scan-level metrics

- candidates discovered
- candidates scored
- signals generated
- scan health classification
- no-signal streaks and signal-yield trend

Derived scan summaries may additionally include top-signal confidence, but the authoritative primitive counters are the same ones listed in the decision record.

#### Decision-level metrics

- decision submitted / accepted / rejected
- entry vs exit intent
- target size / sizing mode used
- preset active at decision time

#### Trade-level metrics

- realized PnL
- hold duration
- exit classification: stop-loss, take-profit, discretionary, timeout, other
- win / loss outcome
- drawdown contribution where available

#### Transition-level metrics

- old preset
- new preset
- assessment artifact reference
- mode: entries-only vs explicit existing-position transition
- open-position count when switch occurred
- whether transition recommendation was accepted, deferred, or rejected

### Metrics that should be phase-1 mandatory

- scan-level signal yield by preset
- realized PnL by preset
- transition history by agent
- current-preset-at-decision attribution

### Metrics that may phase in later

- regime-bucketed expectancy
- MAE / MFE
- per-preset drawdown decomposition
- confidence calibration analysis for assessor rankings

## Assessment Quality Metrics

The system must measure not only trading outcomes but also whether the platform assessor itself is useful.

### Required assessor-quality metrics

- recommendation acceptance rate
- wake-to-review conversion rate
- review-to-switch conversion rate
- switch regret rate
- confidence calibration
- ranking stability over time
- actor rejection rate for strong recommendations

## Evolvability Constraints

The implementation should optimize for evolution, not just first delivery.

### Required design constraints

1. Segment keys must be versionable.
2. Market-assessment artifact schemas must be versioned.
3. Deterministic scorecard generation must be pluggable so presets can be added or retired without rewriting actor logic.
4. Wake-gate policy must be configurable independently of assessor prompt or model choice.
5. Transition modes must be extensible without breaking existing actor-tool contracts.
6. Metrics/event schemas must not be hard-coded around today's preset catalog only.
7. Shared assessment storage must support historical replay and re-analysis.
8. Preset-catalog evolution must not require redesigning actor transition contracts.

## Shared Scanner Responsibilities

The shared scanner is deterministic infrastructure. It may do the following:

1. Gather venue-wide market evidence for a segment on a configurable schedule.
2. Compute shared regime facts.
3. Compute breadth, volatility, liquidity-quality, and scan-health facts.
4. Run deterministic dry-run scorecards for each allowed preset in the segment.
5. Persist raw evidence and scorecards for later audit.
6. Forward the evidence package to the platform assessor.

The shared scanner must **not**:

- decide that an agent should switch presets,
- compare account-level PnL or drawdown,
- modify agent config,
- or wake actor agents directly on heuristic intuition.

## Platform Assessor Responsibilities

The platform assessor is a platform-owned LLM workflow that consumes the scanner evidence package and returns a market-assessment artifact.

### It should answer questions like:

- Which allowed presets currently fit this market segment best?
- How confident is that ranking?
- Has the ranking changed materially since the last assessment?
- Is the current leader only marginally better, or clearly better?
- Is the market in a stable regime or a noisy transitional state?

### It should not answer:

- whether a specific agent should switch right now,
- whether a specific position should be widened, held longer, or exited,
- or whether a creator-locked risk rule should be overridden.

## Market-Assessment Artifact

The platform assessor writes a cached artifact per segment. First version should include at least:

- `segmentKey`
- `assessedAt`
- `expiresAt`
- `assessmentVersion`
- `styleTier`
- `allowedPresets`
- `currentMarketSummary`
- `regimeSummary`
- `scanHealthSummary`
- `presetRankings[]`
- `relativeUplift`
- `confidence`
- `urgency`
- `reasoningSummary`
- `evidenceRefs`
- `artifactVersion`
- `rankingPolicyVersion`

### `presetRankings[]` should include

- `presetKey`
- `rank`
- `score`
- `scoreBand` or normalized percentile
- `pros`
- `cons`
- `fitNotes`

### Important rule for scoring language

If one preset scores `75` and another scores `50`, the system may say the first has a **50% higher assessment score**. It must not call that a predicted 50% trading-performance improvement unless a validated statistical model exists for that claim.

### Artifact requirements for measurement and evolution

- The artifact schema must be versioned.
- The artifact must reference the deterministic evidence bundle used to create it.
- The artifact must preserve enough structured ranking detail for later offline evaluation of assessor quality.

## Freshness and Fallback Policy

Shared assessments must have explicit freshness rules.

### Required fields

- `assessedAt`
- `expiresAt`
- `maxActorUseAge`
- `maxWakeAge`

### Required behavior

- stale artifacts must not trigger new review wakes
- actor tools must surface staleness explicitly
- actor transitions must not be applied from stale assessments unless explicitly allowed by policy

## Scanner Review Wake Routing

Reusing `source: scanner` requires an explicit downstream branch, not just payload enrichment.

### Required design

- `ScannerWakeContext` becomes a discriminated union with at least:
   - entry-signal / exit-advisory scanner context
   - preset-review scanner context
- `runTick()` / wake routing must branch on the scanner context discriminator, not just `source === 'scanner'`
- preset-review scanner wakes must dispatch to the transition-review flow
- preset-review scanner wakes must not route into the single-shot hybrid entry evaluator

### Required implementation consequence

The runtime path that currently treats scanner wakes as scored trade opportunities must be refactored so preset-review wakes are handled as assessment-review events instead.

### Fallback behavior

If the platform assessor is unavailable or no fresh artifact exists, the first version should:

- keep the actor on its current preset
- continue normal trading behavior without preset switching
- record the missing-assessment condition for observability

Optional deterministic local fallback can be considered later, but it should not be a phase-1 dependency.

## Platform Wake Gate

The platform wake gate decides whether a shared market assessment should trigger actor review wakes. The platform assessor may recommend urgency, but the wake gate enforces policy.

### Required wake-gate rules

1. Minimum interval between preset-review wakes per agent.
2. Maximum review wakes per agent per day.
3. Wake only when the ranking changed materially or the current preset fell materially.
4. Wake only when confidence exceeds a configurable threshold.
5. Wake only when the agent's current preset is now meaningfully worse than a better allowed preset in the same tier.
6. Enforce segment and style-tier compatibility.
7. Deduplicate repeated identical assessments.

### Wake behavior

The first version should preserve the scanner-gated runtime model by emitting a **scanner review wake** rather than introducing direct regime-change wakes for auto-switching.

The wake payload should indicate that the trigger is a preset-review assessment rather than an entry-signal scan. This must be represented in payload shape and downstream routing without breaking the existing wake taxonomy and runtime discipline.

## Actor-Agent Responsibilities

After receiving a platform-approved review wake, the actor agent combines the shared market-assessment artifact with local account state:

- current preset
- recent signal yield for this agent
- recent realized PnL / win rate / drawdown by preset or regime bucket
- time since last switch
- open position state
- creator-locked risk and mutable risk

Then it decides whether to:

- do nothing,
- switch for future entries only,
- switch and tighten/reduce existing positions,
- or apply a fuller explicit transition if creator policy allows it.

## Actor Transition Tools

Introduce actor-facing tools in two layers.

### 1. Read/recommendation tools

- `get_market_preset_assessment`
  - reads the latest shared artifact for the actor's segment
- `recommend_preset_transition`
  - combines shared artifact + local state and produces a transition recommendation

### 2. Write/apply tools

- `apply_preset_transition`
  - persists the new preset-derived config and records transition actions

### Supported application modes

- `entries_only`
- `entries_and_tighten_existing`
- `entries_and_full_transition`

The first implementation may support only the first two modes if the full-transition surface is not yet operationally safe.

## Transition State Machine

Transitions should be represented explicitly as owned cross-process events, not inferred after the fact.

### Minimum states

- assessment available
- wake suppressed
- wake emitted
- actor reviewed
- transition recommended
- transition applied
- transition deferred
- transition rejected
- transition expired

This state model should drive persistence, retries, and metrics.

### Ownership

- platform-owned states:
   - assessment available
   - wake suppressed
   - wake emitted
- actor-owned states:
   - actor reviewed
   - transition recommended
   - transition applied
   - transition deferred
   - transition rejected
- expiry may be owned by whichever side owns the pending item being expired, but ownership must be explicit in the implementation

This is not a single distributed mutable state row. It is a coordinated event model across platform and actor processes.

## Open Positions and Transition Safety

An agent with open positions may switch presets, but the new preset must not silently retroactively reinterpret those positions.

### Baseline rules

- Always allow tightening risk on existing positions.
- Allow reducing size or taking partial exits.
- Allow shortening max hold duration.
- Do not allow widening stop loss, removing protection, or adding size to an existing losing position unless the creator explicitly enabled that class of transition.
- Do not let a preset switch bypass user-configured hard limits.

### Implementation rule

Any treatment of open positions must be persisted as explicit transition actions or explicit decision actions, not inferred later from the new preset name.

## Hysteresis and Anti-Thrashing Controls

This feature must not ship without hysteresis.

### Required controls

- minimum dwell time since the last preset switch
- maximum preset switches per rolling 24h window
- minimum assessment-score improvement threshold
- higher threshold when positions are open
- optional cool-off window after a failed transition recommendation

Thresholds and intervals belong in operator config. Agent-level opt-in/opt-out and allowed preset sets belong in persisted config.

## Persistence and Audit

Every stage must produce durable evidence.

### Persisted records required

1. Shared scanner evidence packages per segment.
2. Platform assessment artifacts per segment and timestamp.
3. Wake-gate decisions: emitted, suppressed, throttled, deduped.
4. Actor recommendations: old preset, recommended preset, reason, confidence, local blockers.
5. Applied transitions: old preset, new preset, mode, open-position treatment, creator-policy checks, timestamp.
6. Scan metrics attributed to active preset and segment.
7. Decision/trade outcomes attributed to active preset and transition context.

This audit trail is required to distinguish smart adaptation from random churn and to evaluate whether the platform assessor is actually helping.

### Recommended first-class storage surfaces

- `market_assessment_runs`
- `market_assessment_artifacts`
- `market_assessment_wake_decisions`
- `agent_scan_metrics`
- `agent_preset_transitions`

Equivalent naming is fine, but the underlying model should remain explicit and queryable.

## Configuration Ownership

Follow the repo's config-layer rules.

### Operator config owns

- assessment cadence
- wake-gate thresholds
- confidence thresholds
- score-improvement thresholds
- review cooldowns
- feature flags
- platform assessor model/provider selection
- maximum shared assessment concurrency / budget
- assessment freshness/staleness policy
- max assessments per segment per day
- minimum reassessment interval
- max daily platform-assessor spend budget
- degrade mode when assessor budget is exhausted

### Persisted agent config owns

- whether shared preset assessment is enabled for the agent
- allowed preset set
- style tier (already implied via existing preset flow)
- whether entries-only is required
- whether full transition of open positions is allowed
- any stricter per-agent transition guardrails

### Data-model recommendation

Because the database will be reset, prefer first-class fields and tables over compatibility-minded metadata overlays. This is especially important for:

- allowed preset policy
- transition policy
- assessment references
- performance attribution

Do not store platform budget or cadence in per-agent JSONB. Do not store creator trading policy in operator YAML.

## Operational Controls

The feature needs explicit operator control surfaces.

### Minimum controls

- global kill switch
- per-segment disable
- per-agent disable
- advisory-only mode
- preset pin / no-switch mode
- suppress review wakes
- force reassessment

These controls are required for safe rollout and incident response.

## Delivery Phases

## Phase 0: Decision Record and Data Model Boundary

### Decisions to record before implementation

1. Exact segment key dimensions for shared assessment reuse.
2. Whether scanner review wakes reuse `source: scanner` with enriched payload or require another existing-compatible mechanism.
3. The persistence home for shared market-assessment artifacts.
4. Whether assessment generation is a worker sub-loop, a standalone coordinator, or a platform agent job queue.
5. Which local performance metrics are available today vs must be added.
6. Which first-class tables / schemas are introduced now instead of being embedded in existing generic config or metadata blobs.
7. What exact preset versioning rule constitutes a materially changed preset.
8. What exact fallback behavior applies when no fresh artifact exists.

### Acceptance criteria

- Segment key is explicitly documented.
- Wake taxonomy compatibility is documented against the runtime wake rules.
- Ownership of cadence, thresholds, and allowed-preset policy is documented.
- Measurement primitives are explicitly listed and attributed.
- Clean-slate persistence choices are documented without backward-compatibility shims.

## Phase 1: Shared Assessment Foundations

### Changes

1. Define shared assessment schemas and storage contract.
2. Add operator config for cadence, thresholds, and feature gating.
3. Build a segment scheduler that runs market assessments periodically.
4. Extract a headless, pure per-preset scorecard engine that can evaluate a shared snapshot without `AgentTradingActor` context.
5. Add deterministic per-preset scorecard generation for a segment using that same snapshot.
6. Persist the evidence bundle and scorecards.
7. Introduce first-class persistence for agent scan metrics and transition history.
8. Introduce explicit preset identity/version attribution across generated records.

### Candidate files

- `packages/domain/src/config/schema.ts`
- `config/default.yaml`
- new shared assessment schema and persistence modules in `packages/domain` / `packages/db`
- worker scheduler/orchestration code under `apps/worker/src/`
- focused schema, config, and persistence tests

### Acceptance criteria

- Segment assessments run on operator-configured cadence.
- The per-preset scorecard engine is runnable without actor-local runtime state.
- All allowed presets in the segment receive deterministic scorecards from the same snapshot.
- Evidence and scorecards persist successfully and are queryable.
- Required phase-1 performance metrics persist with preset and segment attribution.

## Phase 2: Platform Assessor and Cached Assessment Artifacts

### Changes

1. Implement the platform assessor workflow.
2. Feed it the persisted evidence package rather than raw ad hoc live calls.
3. Store returned ranking, confidence, urgency, and explanation as a cached assessment artifact.
4. Add expiry and replacement semantics for artifacts.
5. Enforce freshness metadata and staleness handling.

### Acceptance criteria

- Each completed assessment writes exactly one current artifact per segment version.
- Repeated identical evidence does not create noisy duplicate artifacts without a versioned reason.
- Assessment output shape is validated at the boundary.

## Phase 3: Platform Wake Gate

### Changes

1. Implement wake-gate policy evaluation against new assessment artifacts.
2. Add per-agent eligibility checks: current preset, style tier, allowed presets, cooldowns, max wakes/day.
3. Emit review wakes only for eligible agents when the assessment is materially better than the current preset.
4. Persist suppressed and emitted wake decisions.
5. Support advisory-only and shadow modes for rollout.

### Acceptance criteria

- Agents do not receive duplicate review wakes from unchanged assessments.
- Confidence and improvement thresholds are enforced.
- Wake rate stays bounded by policy.

## Phase 4: Actor Read/Recommend/Apply Flow

### Changes

1. Add actor read access to the shared market-assessment artifact.
2. Add `recommend_preset_transition`.
3. Add `apply_preset_transition`.
4. Reuse existing preset-application logic from the API path in a shared service.
5. Preserve creator-locked risk precedence.
6. Support at least `entries_only` and `entries_and_tighten_existing`.
7. Persist explicit reject/defer reasons when the actor does not follow the platform recommendation.

### Required extraction

Before actor tools use preset transitions, extract the preset-resolution logic out of the HTTP route into a shared pure service with focused precedence tests. API routes and actor transition tools must both call the same resolution path.

### Acceptance criteria

- Actor can read the latest artifact for its segment.
- Recommended transitions stay inside the allowed preset set and style tier.
- Applied transitions update future-entry config without implicitly mutating existing positions.
- Creator-locked limits remain unchanged after transition.

## Phase 5: Performance Metrics and Local Decision Inputs

### Changes

1. Persist per-agent signal-yield history keyed by preset.
2. Persist decision/trade attribution with active preset and transition context.
3. Add local performance summaries by preset and, where feasible, regime bucket.
4. Expose those summaries to `recommend_preset_transition`.
5. Define which metrics are phase-1 authoritative and which are advisory-only until richer analytics ship.
6. Add assessor-quality metrics and review/switch conversion metrics.

### Acceptance criteria

- The actor can compare shared market fit with its own recent experience.
- Recommendation output references both shared assessment and local performance.
- Metric definitions are explicit enough that future analysis can distinguish signal quality, execution quality, and transition quality.

## Phase 6: Evolvability Hardening

### Changes

1. Version market-assessment artifacts and segment keys.
2. Ensure deterministic scorecard generation is modular and preset-extensible.
3. Confirm wake-gate policy is configurable independently from assessor implementation.
4. Confirm new presets can be added without rewriting actor transition contracts.
5. Confirm preset versioning does not pollute attribution across materially changed preset revisions.

### Acceptance criteria

- Artifact versioning is enforced at the boundary.
- Adding a preset or adjusting scorecard logic does not require redesigning the wake or actor transition flow.
- Historical artifacts remain analyzable after scoring logic evolves.

## Phase 7: Verification

### Deterministic verification

1. Segment scheduler creates evidence package on cadence.
2. Platform assessor receives evidence and returns validated artifact.
3. Wake gate suppresses weak/duplicate/low-confidence assessments.
4. Eligible agent receives exactly one review wake when thresholds are crossed.
5. Actor reads artifact and local metrics, recommends a transition, and applies an allowed transition mode.
6. Creator-locked risk remains intact.
7. Assessor outage or stale artifacts do not trigger unsafe preset switching.

### Runtime verification

1. Multiple agents in the same segment reuse one shared assessment artifact.
2. Agents in different style tiers or segments do not cross-consume artifacts.
3. Open-position transitions remain explicit and auditable.
4. Wake volume and platform-assessor cost remain within configured bounds.
5. Advisory-only and shadow modes produce actionable evaluation evidence before live switching is enabled.

### Counterfactual / shadow evaluation

Before enabling live preset switching, the platform should run in recommend-only mode long enough to evaluate:

- what the platform would have recommended
- what the actor actually did
- how often recommendations were accepted or rejected
- whether alternative presets would have ranked better on stored evidence snapshots

The first version may use snapshot-level counterfactual comparison rather than full historical replay, but the plan should preserve enough evidence to support richer replay later.

### Evolution verification

Verification must include:

- adding a new preset without breaking assessment generation
- changing segment-key version without corrupting historical artifacts
- changing scorecard logic without breaking actor transition contracts
- continuing to read and analyze historical artifacts after schema evolution

## Candidate File Surfaces

- `packages/domain/src/config/schema.ts`
- `packages/domain/src/config/presets.ts`
- `packages/domain/src/agent-protocol.ts`
- `packages/db/src/agent-repository.ts`
- new assessment repositories/tables or artifact storage modules in `packages/db`
- `apps/api/src/routes/agents.ts`
- `apps/worker/src/index.ts`
- `apps/worker/src/technical-phase.ts`
- `apps/worker/src/complete-technical-scan.ts`
- `apps/worker/src/agent.ts`
- `apps/worker/src/agent-trading-actor.ts`
- new worker modules for shared assessment scheduling, assessor orchestration, wake gate, and transition tools

## Risks

1. **False precision risk**
   Platform rankings may look more quantitative than they really are. Score semantics must stay honest.
2. **Wake-spam risk**
   Without strict gating, shared assessments can become a new source of wake churn.
3. **Segment leakage risk**
   Reusing one assessment across incompatible universes can mis-rank presets.
4. **Silent risk expansion risk**
   Full transition mode can become a backdoor to widen stops or hold losers longer unless strongly gated.
5. **Assessment drift risk**
   If deterministic scorecards and platform explanations diverge, debugging ranking quality becomes difficult.
6. **Bad metrics risk**
   If attribution is incomplete or definitions are fuzzy, the system will optimize on misleading performance summaries.
7. **Schema ossification risk**
   If measurement and assessment structures are not versioned early, future preset or segment evolution will become expensive.
8. **Fallback ambiguity risk**
   If stale or missing assessments do not have a single clear fallback path, actors can behave inconsistently.

## Rollout Recommendation

1. Ship shared assessment generation and persistence behind a feature flag.
2. Ship platform assessor artifact generation next, still without actor wakes.
3. Enable wake gate in shadow mode, recording who would have been woken.
4. Enable actor read/recommendation flow for internal or selected agents.
5. Enable apply flow with `entries_only` first.
6. Enable tighter open-position transition modes only after audit evidence is healthy.
7. Do not enable live switching until shadow-mode and assessor-quality metrics show acceptable behavior.

## Done When

- Shared market assessment is computed once per eligible segment instead of independently by each actor.
- Actor agents receive bounded, policy-gated review wakes driven by shared assessment artifacts.
- Actor agents can recommend and apply allowed preset transitions using shared market evidence plus local state.
- Creator-locked risk remains intact.
- Every assessment, wake, recommendation, and transition is auditable.