# Implementation Checklist: Per-Symbol On-Demand Assessment (Consolidated)

**Status:** Done — authoritative implementation checklist
**Clarifies:** [003-plan-amendment-per-symbol-on-demand-assessment.md](./003-plan-amendment-per-symbol-on-demand-assessment.md) and [004-decision-amendment-per-symbol-on-demand-assessment.md](./004-decision-amendment-per-symbol-on-demand-assessment.md)
**Retains:** [001-plan.md](./001-plan.md) and [002-decision-record.md](./002-decision-record.md), except where the amendments or this checklist explicitly replace them
**Follow-up Enforcement Plan:** [006-followup-plan.md](./006-followup-plan.md) — gap register, coverage gate, and end-to-end acceptance scenario for closing the remaining implementation gaps

---

## 0. How To Use This Document

This is a step-by-step checklist for one implementing agent. Read sections in order. Section 2 lists the decisions that are already made — do **not** re-open them. Section 3 is the map of the current code you must change or delete. Sections 4–11 are the build. Sections 12–18 are retained requirements, tests, order, risks, and the completion bar.

Ground rules for the implementer:

- Do not add the new path alongside the old one. When a replacement path is live and tested, **delete** the superseded code (Section 11). Leaving dead segment/scheduler code in place is a failure condition.
- Every default value (interval, freshness, price, candidate limit) must come from resolved operator config. No magic numbers in code (`AGENTS.md` → "No hard-coded magic numbers").
- Public tool boundaries never throw; they return structured `ToolResult`/`Result` outcomes. Invalid runtime requests must not crash the worker.
- Run `pnpm lint` and `pnpm build` before considering any step complete.

---

## 1. Phase-1 Contract

Phase 1 is a **per-symbol, agent-authoritative, on-demand** assessment flow.

- A worker-owned, **per-agent** review scheduler runs cheap deterministic checks at an interval the agent owner configures, bounded by operator policy.
- When the deterministic scanner finds a candidate worth reviewing, it **records advice**. It does not generate an assessment, call the LLM, reserve credit, bill, or change a preset.
- Advice is delivered to the agent through **one dedicated, low-frequency `assessment_review` tick** — never an ordinary scanner signal wake.
- The agent decides whether to request an assessment via `assess_strategy_preset` using a symbol-first request.
- Only that request may reuse a fresh artifact or start a new **billed** assessment run, and only after synchronous billing authorization succeeds.
- The platform assessor is **advisory**. The agent decides whether to request, recommend, and apply an allowed transition.

### 1.1 Authoritative workflow

```mermaid
sequenceDiagram
  participant Scheduler as Per-agent review scheduler
  participant Scanner as Deterministic scanner pre-check
  participant Advice as Review-advice store
  participant Agent as Agent assessment_review tick
  participant Request as Assessment request service
  participant Billing as Synchronous billing reservation
  participant Assessor as On-demand assessor

  Scheduler->>Scanner: Run check when review is due
  Scanner->>Scanner: Rank candidates, apply cheap deterministic filters
  alt No candidate advised
    Scanner-->>Scheduler: Record no advice; DO NOT invoke agent
  else Review advised
    Scanner->>Advice: Persist advice for eligible symbol(s)
    Advice->>Agent: Deliver ONE dedicated assessment_review tick
    Agent->>Agent: Decide whether an assessment is worth requesting
    opt Agent requests assessment
      Agent->>Request: assess_strategy_preset(symbols=[symbol])
      Request->>Request: Resolve canonical identity, check opt-in/cooldown/cap
      Request->>Request: Re-check fresh artifact cache
      Request->>Billing: Atomically reserve/debit the assessment price
      alt Fresh artifact (cache hit)
        Request-->>Agent: Return billed cached artifact
      else Cache miss or stale
        Request->>Assessor: Run assessment for canonical identity (single in-flight lease)
        Assessor-->>Request: Persist run + artifact; settle reservation
        Request-->>Agent: Return billed new artifact
      end
    end
  end
```

### 1.2 Non-negotiable boundaries

- A review becoming due is **not** an assessment request.
- Scanner advice is **not** a billable event and **not** permission to bypass the final credit, freshness, cooldown, or identity checks.
- The scanner never calls the LLM assessor directly.
- An ordinary scanner signal wake never carries assessment advice and never asks the agent to assess a symbol.
- A fresh cached artifact is **still billable** when an agent requests it (1 run = 1 charge; 1 cache hit = 1 charge; no price difference).
- Assessment ranking never directly changes agent configuration or positions.

---

## 2. Locked Decisions (do not re-open)

| # | Decision | Source |
|---|----------|--------|
| D1 | **One trigger mechanism for every agent type: the per-agent review scheduler emits a single dedicated advice-only `assessment_review` tick.** This is the *only* phase-1 prompting mechanism — there is no per-agent-type notification path. It is agent-owned (interval set by the creator), advice-only, and distinct from signal wakes. It reconciles A2C/A2D ("dedicated low-frequency review path") with A5 ("no platform-driven preset-review wakes"): the scheduler produces *advice*, never a generated assessment. **When no advice is due, no tick fires** — silence is the default; the elapsed interval alone never wakes an agent. | User decision; 003 §3C/§3D; 004 §A2C/§A2D |
| D2 | **The same dedicated `assessment_review` tick applies to all agent types, including `scanner_gated`.** No agent type gets a second or alternative route; `scanner_gated` agents must not piggyback on ordinary scanner signal wakes, and `mixed`/intelligence/hybrid agents must not get an extra path just because they already wake for signals. Delivery reuses `AgentWakeSource = 'scanner'` (no new wake source — 002) with a **new** discriminant `scannerKind: 'assessment_review'`, distinct from the deferred `scannerKind: 'preset_review'`. It routes to the transition-review path and must never route through entry-signal or exit-advisory handling. | User decision; 002 D-wake; 004 §A2D |
| D3 | **Clean-slate database.** No in-place migration of old segment data is required. Reset/initialize the assessment tables as part of deployment. Do not carry a migration-vs-reset choice as open. | 002 line 5; 004 |
| D4 | **Delete obsolete segment/scheduler code now.** Removal is part of "done," not a later cleanup. | User decision; 003 "Replaced" |
| D5 | **Assessment identity is per-symbol** — `{venueFamily, styleTier, symbol}` for orderbook/perp; `{venueFamily, styleTier, network, address}` for swap/dex. `excludeSymbols`, `minLiquidityUsd`, `minVolume24hUsd`, positions, capital, current preset, PnL, transition policy are **not** identity dimensions. | 003 §1–§2; 004 §A1 |
| D6 | **On-demand only, billing-gated.** No scheduled background assessment generation in phase 1. Billing authorization is the first hard gate before any run. Cache hits are billed. | 003 §3/§4A; 004 §A2/§A3 |
| D7 | **Defaults from config:** agent review interval 24h, operator minimum floor 24h, cache freshness 6h. All read from resolved config, not literals. | 003 §3B/§4; 004 §A2B/§A3 |
| D8 | **Shadow mode (`recommend_only` / `auto_apply`) has been removed.** Per follow-up plan [006b](./006b-followup-plan-2.md), the platform no longer supports a split assessment/apply mode. The agent's `platformAssessment.enabled` flag gates the feature; when enabled, both assess and apply are available. | 006b; supersedes 001/002 |

Where the amendments were ambiguous, the decisions above are now **settled**. Treat them as authoritative; do not invent alternatives.

---

## 3. Current Code Inventory (change / remove map)

Grep target to track removal progress:

```sh
rg -n "universeScopeHash|MarketAssessmentSegmentKey|computeUniverseScopeHash|createSegmentKey|segmentKeyFromTechnicalConfig|resolveSegments|runAssessmentCycle" \
  packages apps
```

### 3.1 Domain — `packages/domain`

- `src/market-assessment.ts`
  - `MarketAssessmentSegmentKey` (interface) + `MarketAssessmentSegmentKeySchema` — **replace** with discriminated canonical identity (Section 4).
  - `computeUniverseScopeHash()`, `createSegmentKey()`, `segmentKeyFromTechnicalConfig()` — **delete** once callers migrate.
  - `PlatformTransitionState` / `ActorTransitionState` / transition state machine / `TransitionMode` / `PresetScorecardEntry` / `MarketAssessmentPresetRanking` — **keep** (still valid).
- `src/market-assessment.test.ts` — remove hashing tests for `minVolume24hUsd`, `minLiquidityUsd`, `symbols`, `excludeSymbols`; add identity tests (Section 8).
- `src/tool-schemas.ts` — `GetMarketPresetAssessmentParamsSchema` is currently `z.object({})`. **Replace** with a symbol-first shape (Section 10). Update `RecommendPresetTransitionParamsSchema` and `ApplyPresetTransitionParamsSchema` for artifact-reference handoff.
- `src/config/schema.ts`
  - `PlatformAssessorConfigSchema` (~L1287, operator) — **replace** scheduler-only fields (`assessmentIntervalMs`, `segmentFamilies`, `venueFamilies` for scheduling, `styleTiers` sweep) with on-demand fields (Section 6.2). Keep `enabled` semantics if still meaningful; otherwise remove.
  - `PlatformAssessmentOptInSchema` (~L2039, agent-owned: `enabled`, `mode`, `minConfidenceThreshold`, `minScoreUpliftThreshold`) — **add** `reviewIntervalMs` (Section 6.1).
  - `WakeGateConfigSchema` (~L1307) — **deferred infra**; keep only if the deferred wake path is retained (Section 11), otherwise delete with its config block.

### 3.2 DB schema — `packages/db/src/schema`

- `market-assessment-runs.ts` — has `segmentKey` jsonb + denormalized `venueFamily`/`styleTier`/`universeScopeHash` + segment indexes. **Replace** with canonical identity columns (Section 5).
- `market-assessment-artifacts.ts` — same segment columns + `uq_market_assessment_artifacts_segment_active` unique index on `segmentKey where status='active'`. **Replace** identity columns and the active-uniqueness index (Section 5).
- `agent-preset-transitions.ts` — writes `segmentKey`/`venueFamily`/`styleTier`/`universeScopeHash`. **Replace** with immutable identity snapshot + `assessmentArtifactId` (Section 5, Section 10.3).
- `market-assessment-wake-decisions.ts` — **deferred**; keep only if the wake path is retained (Section 11).
- `agent-scan-metrics.ts` — **preserve aggregate scan meaning** (Section 5.3). Do not relabel aggregate counters as per-symbol.
- **New:** review-advice table (Section 7.4).

### 3.3 Worker — `apps/worker/src`

- `market-intelligence/platform-assessor.ts` — `PlatformAssessor` with `start()`/`stop()`, `runAssessmentCycle()`, `resolveSegments()`, leader election, `assessmentIntervalMs`, `EvidencePackage.segmentKey`, `getRegimeSnapshot(segmentKey)`. **Refactor** to an on-demand execution service (Section 9); delete the scheduler loop, `runAssessmentCycle`, `resolveSegments`, and leader election from phase 1.
- `market-intelligence/index.ts` — update exports.
- `market-intelligence/leader-election.ts` — **delete** if no retained caller remains.
- `tools/get-market-preset-assessment.ts` — currently reads latest global active artifact. **Rewrite** to symbol-first via request service (Section 10.1).
- `tools/recommend-preset-transition.ts` — currently reads latest global active artifact. **Rewrite** to artifact-reference handoff (Section 10.2).
- `tools/apply-preset-transition.ts` — currently substitutes the latest global artifact and writes `segmentKey`. **Rewrite** to require the exact `assessmentArtifactId` and validate identity/freshness (Section 10.3).
- `index.ts` — wires `PlatformAssessor` start/stop; update to the on-demand service and the per-agent review scheduler.
- **New:** per-agent review scheduler (Section 7.2) and assessment request service (Section 8).

### 3.4 Config & docs

- `config/default.yaml` — `platformAssessor` block (~L606) and `wakeGate` block. Update `platformAssessor` to on-demand fields; gate/remove `wakeGate` per Section 11.
- `CHANGELOG.md` — the `MarketAssessmentSegmentKey` / `platformAssessment` entries describe superseded behavior; update when the domain types change.

---

## 4. Canonical Assessment Identity (domain)

File: `packages/domain/src/market-assessment.ts`

### 4.1 Replace the identity type

```ts
export type MarketAssessmentIdentity =
  | {
      instrumentKind: 'orderbook' | 'perp';
      venueFamily: string;
      styleTier: 'economy' | 'standard' | 'premium';
      symbol: string; // normalized, venue-canonical
    }
  | {
      instrumentKind: 'swap' | 'dex';
      venueFamily: string;
      styleTier: 'economy' | 'standard' | 'premium';
      network: string;  // canonical chain id
      address: string;  // canonical token address
    };
```

- Model identity as a **discriminated union** (not one object with optional fields). `orderbook`/`perp` requires `symbol` and forbids `network`/`address`; `swap`/`dex` requires `network + address` and forbids `symbol` as canonical identity.
- Add a matching Zod schema (`MarketAssessmentIdentitySchema`) as a discriminated union so invalid mixed shapes are rejected at the boundary.

### 4.2 One normalization/resolution boundary

Implement a single resolver used consistently for requests, lookup, persistence, billing, and logs:

- Orderbook/perp: trim and canonicalize venue-supported symbols.
- Swap/dex: symbol-first UX, but resolve to canonical `network + address` before any lookup/billing/persistence. Reuse an existing venue resolver/service if one already fits; otherwise add a dedicated canonicalization step.
- Reject unknown or ambiguous symbols with a resolvable error. **Never** select an arbitrary swap token address.

### 4.3 Remove segment helpers

Delete `computeUniverseScopeHash()`, `createSegmentKey()`, and `segmentKeyFromTechnicalConfig()` when their callers move to the new model. `excludeSymbols`, `minLiquidityUsd`, `minVolume24hUsd` may still exist for discovery/eligibility/selection — but not as assessment identity.

---

## 5. Persistence Model (clean-slate — D3)

### 5.1 Identity columns

For `market_assessment_runs` and `market_assessment_artifacts`, replace the segment columns with:

- `instrument_kind` (`orderbook` | `perp` | `swap` | `dex`)
- `venue_family`
- `style_tier`
- `symbol` (nullable; required for orderbook/perp)
- `network`, `address` (nullable; both required for swap/dex)
- an immutable JSON identity snapshot column where it aids audit replay

### 5.2 Constraints and uniqueness

- Add DB **check constraints** enforcing exactly one valid identity shape:
  - orderbook/perp → `symbol` NOT NULL AND `network` IS NULL AND `address` IS NULL
  - swap/dex → `network` NOT NULL AND `address` NOT NULL AND `symbol` IS NULL
- Replace `uq_market_assessment_artifacts_segment_active` with **partial unique indexes** that permit history but guarantee at most one `active` artifact per canonical identity (one for the orderbook/perp shape, one for the swap/dex shape).
- Index the identity columns used for lookup.

### 5.3 Preserve `agent_scan_metrics` meaning

`agent_scan_metrics` describes aggregate scans over an agent's candidate universe. Do **not** attach a per-symbol identity to those counters. Retain a separate scan/discovery-scope context where needed for analytics. Remove `universeScopeHash` only where it was an **assessment identity**; do not destroy legitimate scan-scope context without a replacement.

### 5.4 Transitions table

`agent_preset_transitions` must persist `assessmentArtifactId` plus an **immutable identity snapshot** (not a live segment key), so later artifact replacement cannot make a recorded transition ambiguous. Remove `segmentKey`/`universeScopeHash` columns.

### 5.5 Cutover

- Generate the schema change with `drizzle-kit generate`; verify the Drizzle journal includes the new migration.
- Reset/initialize the assessment tables as part of deployment (clean-slate — D3).
- Remove all runtime reads/writes of `universeScopeHash` as assessment identity.
- Do not deploy code that reads the new identity before the schema is live.

---

## 6. Configuration

### 6.1 Agent-owned (typed, persisted, API-validated)

File: `packages/domain/src/config/schema.ts` → `PlatformAssessmentOptInSchema`

- Add `reviewIntervalMs: z.number().int().positive()` (agent review/request interval).
- Keep existing `enabled`, `mode`, `minConfidenceThreshold`, `minScoreUpliftThreshold`.
- **API write-time validation:** reject `reviewIntervalMs` below the resolved operator minimum floor. Do **not** silently clamp. Default when unset: **24h** (resolved from operator config, not a literal in code).

### 6.2 Operator-resolved (fail fast at startup)

File: `packages/domain/src/config/schema.ts` → `PlatformAssessorConfigSchema`; `config/default.yaml` → `platformAssessor`

Replace scheduler-only fields with on-demand fields:

- `minReviewIntervalMs` — operator minimum floor. Default **24h**.
- `maxReviewRequestsPerDay` — optional daily cap (billed cache hits and fresh runs both count).
- `scannerCandidateLimit` — top `N` candidates the deterministic pre-check considers.
- `cacheFreshnessMs` — single resolved freshness for lookup **and** artifact expiry. Default **6h**. Do not leave assessor/actor-use/wake-age defaults contradictory — collapse them to this one value.
- `assessmentPrice` (or the assessment rate-card meter configuration).

Remove `assessmentIntervalMs`, `segmentFamilies`, and the scheduling use of `venueFamilies`/`styleTiers`. Operator config must fail fast at worker and API startup when invalid.

---

## 7. Per-Agent Review Scheduler, Advice, and Review Tick (D1/D2)

### 7.0 Trigger mechanism — one mechanism for every agent type (explicit)

There is exactly **one** way any agent is notified to consider a review: the per-agent review scheduler fires a **single dedicated `assessment_review` tick**. Do not build per-type notification paths. The table below is normative — every opted-in agent type uses the identical mechanism.

| Agent type | How it is triggered | Explicitly forbidden |
|---|---|---|
| `hybrid` / `mixed` | Per-agent scheduler → one `assessment_review` tick when advice is due | Piggybacking on signal wakes |
| `hybrid` / `scanner_gated` | Per-agent scheduler → one `assessment_review` tick when advice is due | Any assessment offer inside ordinary scanner signal wakes |

> **`intelligence` is out-of-scope for preset review.** Intelligence agents have no strategy preset (`capabilityMode` ≠ `'hybrid'`), so preset review does not apply to them. The scheduler, forced-review API trigger, eligibility endpoint, and worker defense-in-depth all gate on `capabilityMode === 'hybrid'`. (Change 3, 2026-07-30.)

Rules that hold for **all** types:

- **No advice due → no tick.** The interval elapsing is not itself a trigger; a tick fires only when ≥1 unexpired `advised` record exists (§7.4–§7.5).
- **Exactly one tick per due interval**, carrying a bounded advice list — never one tick per symbol.
- Delivery reuses `AgentWakeSource = 'scanner'` (no new wake source — 002) with `scannerKind: 'assessment_review'`, a **new** discriminant distinct from the deferred `scannerKind: 'preset_review'` (Section 11). It routes to the transition-review path only.
- The tick is **advice-only**: it never bills, never runs an assessment, and never carries a generated assessment or a recommendation to switch.
- The agent may ignore the tick with zero side effects.

Wake taxonomy grounding: `AgentWakeSourceSchema` (`packages/domain/src/agent-protocol.ts`) stays `reminder | watch_threshold | discovery_delta | regime_change | scanner` — do **not** add a value (`docs/best-practices/agent-runtime.md`). `ScannerWakeContext` is a discriminated union; add `assessment_review` alongside the existing `signal_scoring` and deferred `preset_review` kinds.

### 7.1 Purpose

This is the phase-1 prompting mechanism. It replaces the platform-wide segment-assessment scheduler. It is scoped to each opted-in agent and its configured interval, and it produces **advice only**.

### 7.2 Due-review scheduler

Implement a worker-owned scheduler for each opted-in agent. It must:

1. Determine whether the agent's `reviewIntervalMs` has elapsed since its last completed review check.
2. Run the deterministic scanner pre-check **only** when the review is due.
3. Persist the review-check outcome before delivering any review tick.
4. Deliver **at most one** dedicated `assessment_review` tick per due interval.
5. Reschedule after success or failure; log and retry a failed scheduler operation per the worker's recurring-loop rules (`AGENTS.md` → "Every async loop must reschedule itself on failure").

It must **not** scan every configured venue/style segment independently of agent demand.

### 7.3 Deterministic scanner pre-check

For each due agent review, advise review only for symbols satisfying **all** of:

- the symbol is in the agent's top `N` scanner candidates (`scannerCandidateLimit`)
- the candidate resolves to a canonical per-symbol identity
- no fresh artifact exists for that identity (per `cacheFreshnessMs`)
- the agent is outside its review cooldown for that identity
- a **non-reserving** billing/credit eligibility check indicates a charge could be authorized
- cheap deterministic facts indicate a possible mismatch between the candidate's market structure and the agent's active preset

The pre-check must not use an LLM, create a run, reserve funds, or deduct credit. Billing eligibility here is advisory; account state can change before the agent requests. The request service (Section 8) remains the authoritative enforcement point.

### 7.4 Review-advice record (new first-class table)

Create a persisted review-advice/check record — the handoff from deterministic scanner work to the agent review tick, providing auditability without pretending an assessment ran. Persist at minimum:

- agent ID
- canonical identity
- scanner/check timestamp
- review-due timestamp and next eligible review timestamp
- candidate rank and deterministic facts supporting the advice
- active preset and mechanically derived behavior version at check time
- advice outcome: `advised` | `not_advised` | `blocked_by_cooldown` | `blocked_by_no_credit_indication` | `fresh_artifact_exists` | `no_candidate`
- advice expiry
- consumed timestamp when the review tick receives it

A single due check may advise more than one symbol; the review tick receives a **bounded, stable ordering** of advice records, not one LLM invocation per symbol.

### 7.5 Delivery to the agent

Delivery is identical for **every** agent type (§7.0) — one mechanism, no per-type variation.

- When at least one unexpired `advised` record exists, the runtime creates **one** dedicated `assessment_review` tick for that agent. Its context contains only the bounded advice list and deterministic reasons — no generated assessment and no recommendation to switch.
- The agent then chooses whether to call `assess_strategy_preset` for any advised symbol, or to do nothing.
- Expired/consumed advice does not auto-create another tick; the next opportunity is the next due review.
- The tick reuses `AgentWakeSource = 'scanner'` with `scannerKind: 'assessment_review'`, routes to the transition-review path only, and must never route through entry-signal or exit-advisory handling.
- For `scanner_gated` agents this is additionally the **only** scanner-originated route to assessment — ordinary scanner signal wakes must never carry assessment advice.

---

## 8. On-Demand Assessment Request Service (worker)

### 8.1 Single service boundary

Create one worker application service that owns assessment requests. `get_market_preset_assessment` and any future caller must use it; tools must not reimplement cache lookup, cooldown, billing, or assessor invocation.

**Input:** requesting agent ID + account/user context; symbol-first request plus any required venue/network disambiguator; caller-provided idempotency key.

**Output:** canonical identity; `assessmentArtifactId` when available; cache-reuse vs new-run flag; billing outcome + request ID; a clear blocked/failure reason when unavailable.

### 8.2 Required request transaction

For an idempotency key scoped to the requesting agent **and** canonical identity:

1. Resolve and validate canonical identity.
2. Validate assessment opt-in and the agent's transition/assessment mode.
3. Enforce the agent-plus-identity cooldown and operator daily request limit (billed cache hits and fresh runs both count toward the cap).
4. Re-check the fresh artifact cache.
5. **Atomically** persist the billable request and **reserve or debit** the assessment price — including for a cache hit.
6. For a cache hit, return the exact billed artifact after the transaction commits.
7. For a cache miss, acquire a **per-identity in-flight lease**; concurrent requests join/observe the same run rather than start duplicate provider work.
8. Persist run intent **before** the LLM/provider side effect.
9. Run the on-demand assessor, persist the run and artifact, then settle the reservation per the settlement policy (§8.3).
10. Return the **original outcome** for an idempotent retry without another charge.

The existing asynchronous, fail-open LLM usage recorder is **not** sufficient for this gate. Add a **synchronous** assessment billing reservation/debit operation with a dedicated assessment meter or rate-card item.

### 8.3 Settlement policy (record before implementing)

Record one explicit policy for provider failure after execution begins:

- whether a charge settles because provider work was attempted,
- whether unused reserved credit is released,
- whether a retry reuses the request or starts a newly billed request.

Persist and expose distinct outcomes: `billing_blocked`, `cooldown_blocked`, `identity_unresolved`, `provider_failed`, `cache_hit`, `assessment_completed`. Ordinary cache misses are **not** failures — they produce a billed on-demand run.

---

## 9. On-Demand Assessor (refactor)

File: `apps/worker/src/market-intelligence/platform-assessor.ts`

- **Remove** the global scheduler loop, `runAssessmentCycle()`, `resolveSegments()`, leader election, and cycle-budget behavior from phase 1. `start()`/`stop()` become unnecessary or limited to cache/housekeeping.
- **Retain** one callable operation that assesses **one canonical identity** after the request service authorizes it.
- Persist run intent, evidence, scorecards, artifact, and failure outcome for that identity.
- Supersede only the previous `active` artifact for the **same** canonical identity.
- Use the single resolved `cacheFreshnessMs` to set and evaluate expiry.
- Keep ranking **market-structure-based** in phase 1. Record later analytics inputs but do not use realized performance to rank until attribution quality is validated (Section 13).
- Change `EvidencePackage.segmentKey` and `getRegimeSnapshot(segmentKey)` to take the canonical identity.

---

## 10. Agent Tools and Transition Safety

### 10.1 `assess_strategy_preset`

File: `apps/worker/src/tools/assess-strategy-preset.ts`; schema `AssessStrategyPresetParamsSchema`.

- Accept a **symbol-first** request shape (single or multi-instrument, up to `platformAssessor.maxInstrumentsPerRequest`); venue/binding context is required.
- Resolve canonical identity **before** cache lookup, billing, persistence, or logging.
- Call the request service (Section 8). On cache miss, it auto-starts the on-demand run — a cache miss is **not** a `not available` outcome.
- Return `not available` only for failure/blocked conditions.
- Return canonical identity, `assessmentArtifactId`, assessed/expiry timestamps, request ID, billing outcome, and idempotency/retry metadata for each assessed instrument.
- This is a billable tool — each assessed instrument incurs a charge (including cache reuse).

### 10.2 — Removed (`recommend_preset_transition`)

This tool has been consolidated into `assess_strategy_preset` per [006b-followup-plan-2.md](./006b-followup-plan-2.md). The assessment tool now returns the recommendation payload directly alongside the artifact data. There is no separate recommendation step.

### 10.3 `change_strategy_preset`

File: `apps/worker/src/tools/change-strategy-preset.ts`; schema `ChangeStrategyPresetParamsSchema`.

- **Require** the exact `assessmentArtifactId` returned by `assess_strategy_preset`. Do not substitute the latest global artifact.
- Before applying, validate: artifact identity and freshness; target preset allowed for the agent's style tier; agent transition policy, dwell time, daily transition cap; creator-locked risk precedence; permitted open-position transition mode.
- Persist an immutable transition record: `assessmentArtifactId`, identity snapshot, old/new preset keys, old/new mechanically derived behavior versions, open-position treatment, outcome, reason. (Replace the `segmentKey`/`universeScopeHash` write.)
- Never substitute a newer artifact for the reviewed one. Never use a transition to widen protection, remove protection, or silently reinterpret an existing position.

---

## 11. Deferred Infrastructure and Removal Discipline (D4)

Phase-1 assessment generation must not depend on scheduled wake production. Concepts affected: `packages/engine/src/wake-gate.ts`, `apps/worker/src/agent.ts`, `packages/domain/src/agent-protocol.ts`, `apps/worker/src/market-intelligence/platform-assessor.ts`, `market_assessment_wake_decisions`, `WakeGateConfigSchema`/`wakeGate` config.

Rule (D4 — delete now):

- If a wake-driven path is **not** part of the retained future direction, **delete** it rather than leaving dead code: dead config suggesting scheduled generation is active, dead routing branches unreachable under the adopted design, and tests that only protect superseded behavior.
- If a specific wake artifact is deliberately retained as deferred infra, it must be **named explicitly** in the requirements matrix (Section 12) with a justification and a note that it is inert in phase 1. Anything not so named must be deleted.
- Any future wake must use the existing wake taxonomy and a discriminated scanner context; it must never route through ordinary scanner-signal handling.

Acceptance check: `rg universeScopeHash packages apps` returns **zero** assessment-identity usages, and no unreachable segment/scheduler branch remains.

---

## 12. Retained Requirements Matrix

Create a requirements matrix naming the **implementing module, persistence home, and test** for each original requirement that remains in force. At minimum retain:

- Postgres as authoritative assessment storage; Redis only as an optional cache.
- Mechanically-derived preset behavior versions on artifacts, scan metrics, decisions, trades, and transitions.
- Feature gate is controlled by `platformAssessment.enabled` per agent. Shadow mode (`recommend_only` / `auto_apply`) has been removed per follow-up plan 006b.
- Explicit transition modes, creator-locked risk precedence, and the prohibition on silently weakening protection for existing positions.
- Durable evidence for assessment, review advice, billing, recommendation, and transition outcomes.
- Phase-1 scan, decision, trade, and transition attribution; analytics feedback deferred only as a **ranking input**, not as data collection.
- Public boundary failures return structured outcomes; invalid runtime requests do not crash the worker.

---

## 13. Analytics Feedback (record now, use later)

- Keep/expand metrics/attribution capture needed for later assessor-quality improvements.
- Do not block phase 1 on wiring realized-performance feedback into ranking.
- Phase-1 ranking remains primarily market-structure-based; analytics become a later enhancement once attribution is trusted.

---

## 14. Tests

### 14.1 Identity and persistence

- equivalent supported symbols normalize to one orderbook/perp identity
- different symbols produce different identities
- swap/dex identity requires canonical `network + address`
- ambiguous swap symbol fails before cache lookup, billing, or provider work (never selects an arbitrary address)
- DB check constraints reject invalid mixed identity shapes
- DB uniqueness allows history and rejects duplicate `active` artifacts per identity
- migration/reset validation proves no runtime path requires the removed segment identity

### 14.2 Scheduler, advice, and review tick

- a due review with no advised candidate does not invoke the agent or assessor
- a due review with advice creates exactly one dedicated `assessment_review` tick containing bounded advice records
- every agent type (`intelligence`, `mixed`, `scanner_gated`) is triggered by the same single mechanism — the per-agent scheduler tick — with no per-type notification path
- the elapsed interval alone does not wake an agent when no advice is due
- ordinary scanner signal wakes never receive assessment-review context
- `scanner_gated` agents receive assessment access only via the dedicated review tick
- the tick reuses `AgentWakeSource = 'scanner'` with `scannerKind: 'assessment_review'`, and `AgentWakeSourceSchema` gains no new enum value
- the agent may decline advice with no billing or assessment side effect

### 14.3 Request service, billing, concurrency

- direct agent requests and scanner-advised requests use the same request service
- a fresh cache hit returns without a new run and is charged exactly once
- a stale artifact creates exactly one new billed run
- insufficient credit blocks before provider work (zero side effects when blocked)
- concurrent same-identity cache misses create at most one provider run and one billable request per requesting agent
- idempotent retry returns the original outcome without an additional charge
- provider failure follows the documented settlement policy
- cache hit is billed the same as a fresh run

### 14.4 Config

- agent `reviewIntervalMs` below the operator minimum is rejected at write time (not clamped)
- `maxReviewRequestsPerDay` guard works
- the 24h interval defaults and 6h freshness default come from resolved config
- lookup and expiry use the same resolved `cacheFreshnessMs`

### 14.5 Tools and transition safety

- scanner trigger rule only offers assessment when all required filters pass
- recommendation returns an exact artifact reference
- apply rejects expired, mismatched, substituted, or disallowed artifacts/transitions
- behavior-version, attribution, advisory-rollout, and open-position-safety requirements remain covered

### 14.6 Files to update

- `packages/domain/src/market-assessment.test.ts`
- `apps/worker/src/market-intelligence/platform-assessor.test.ts`
- `apps/worker/src/tools/change-strategy-preset.test.ts`
- add tests for `assess-strategy-preset`, the request service, the review scheduler, and the advice record
- any schema/index tests asserting `universeScopeHash`

---

## 15. Verification Commands

Run, at minimum:

```sh
pnpm --filter @herobids/domain test
pnpm --filter @herobids/db test
pnpm --filter @herobids/worker test
pnpm lint
pnpm build
```

When the schema change is added, verify a clean database applies the generated migration and that the Drizzle journal includes it. Add an integration test exercising the request transaction against Postgres, including **concurrent same-identity requests**.

---

## 16. Implementation Order

1. Freeze the canonical identity, normalization, clean-slate cutover, and billing-settlement contracts (Sections 4, 5.5, 8.3).
2. Add the per-agent review scheduler, review-advice record, and dedicated `assessment_review` tick contract (Section 7).
3. Add agent + operator configuration schemas, API validation, and resolved runtime config (Section 6).
4. Replace the domain identity model and tool parameter schemas (Section 4, Section 10 schemas).
5. Replace DB constraints, uniqueness/index model, and generate the clean-slate migration; remove assessment uses of `universeScopeHash` (Section 5).
6. Implement the synchronous billing reservation, idempotency, cooldown, and per-identity lease in the request service (Section 8).
7. Refactor `PlatformAssessor` from scheduled coordinator to on-demand execution service (Section 9).
8. Wire tools through the request service and enforce exact-artifact transition handoff (Section 10).
9. Delete deferred/superseded segment + wake code; keep only explicitly named deferred infra (Section 11).
10. Preserve retained attribution/rollout/transition-safety requirements (Section 12); add analytics capture (Section 13).
11. Add/repair tests; run migration verification, package tests, lint, build (Sections 14–15).

---

## 17. Risks and Mitigations

| # | Risk | Mitigation |
|---|------|-----------|
| 1 | **Swap identity mismatch** — requested by symbol text but persisted by `network + address`; inconsistent resolution creates duplicate cache keys or wrong reuse. | Symbol-first UX only at the boundary; resolve to canonical `network + address` before lookup/persistence/billing; test symbol→canonical resolution. |
| 2 | **Billing-gate leak** — a run starts before billing completes; platform pays for a request that should be blocked. | Synchronous billing reservation is the first hard gate; test blocked runs with zero side effects. |
| 3 | **Residual segment assumptions** — `universeScopeHash` survives in lookups, indexes, or artifact-replacement code. | Remove helpers early; update DB uniqueness/index before wiring runtime; `rg universeScopeHash` must be clean. |
| 4 | **Tool UX inconsistency** — one tool asks for symbol, another for network/address. | Keep the request shape symbol-first across related tools; centralize canonical resolution behind the tools. |
| 5 | **Cache misuse** — stale artifacts reused silently; cache-hit bypasses billing. | Enforce freshness before every reuse; bill cache hits under the same policy; test fresh-hit vs stale-rerun. |
| 6 | **Scheduler mistaken for a wake backdoor** — the per-agent review tick drifts into ordinary signal-wake handling, reintroducing platform-driven wakes A5 deferred. | Keep the tick advice-only and discriminated (`scannerKind: 'assessment_review'`); test that signal wakes never carry assessment context. |
| 7 | **Analytics overreach** — feeding realized performance into ranking before attribution is trusted adds noise. | Record now, use later; keep phase-1 ranking market-structure-based. |

---

## 18. Definition of Done

- No assessment identity depends on `excludeSymbols`, `minLiquidityUsd`, or `minVolume24hUsd`.
- Assessment artifacts are keyed by per-symbol canonical identity, enforced in the domain model and database.
- No scheduled background generation is required for phase 1.
- A due review runs deterministic scanner checks at the configured agent interval, bounded by operator guardrails; the scanner records advice only and never bills, runs an assessment, or changes a preset.
- No advised candidate → no dedicated review tick; advised candidates reach the agent through one bounded `assessment_review` tick, never an ordinary signal wake. Every agent type (`intelligence`, `mixed`, `scanner_gated`) is triggered by the same single per-agent scheduler mechanism, with no per-type notification path, and the elapsed interval alone never wakes an agent.
- The agent decides whether to request assessment; every request uses a symbol-first interface, canonical identity, synchronous billing authorization, idempotency, and concurrency control.
- Fresh cache reuse and new runs are both billed exactly once per successful request; a request cannot execute until its synchronous billing reservation succeeds.
- Retries and concurrent requests cannot duplicate provider execution for one canonical identity.
- Default cache freshness is 6h and default review interval is 24h, both from resolved config; lookup and expiry use the same freshness value.
- One exact fresh artifact flows from assessment → transition application; apply validates and rejects expired/mismatched/substituted/disallowed artifacts.
- Invalid or ambiguous identity requests fail before billing or provider side effects.
- Database schema enforces valid identity shapes and one active artifact per canonical identity.
- Metric storage distinguishes aggregate scan context from per-symbol assessment evidence.
- Retained requirements (behavior versions, advisory rollout, transition safety, auditability, attribution) remain implemented and tested.
- Obsolete segment/scheduler/wake code is deleted, not left dormant, except deferred infra explicitly named in the requirements matrix; `rg universeScopeHash` is clean of assessment-identity usages.
- Focused tests, migration verification, `pnpm lint`, and `pnpm build` pass.

---

## 19. Outstanding Issues (from implementation session 2026-07-18)

These issues are operationalized in [006-followup-plan.md](./006-followup-plan.md). Treat that follow-up plan as the mandatory closure checklist before declaring the end-to-end `assessment_review` flow complete.

### [Step 1] Identity & Billing Contracts
- MEDIUM: Missing tests for `knownSymbols`-omitted, `perp`/`dex` resolution paths via `resolveAssessmentIdentity`
- MEDIUM: `validateSettlementPolicy()` is a weak validator (throw-only, no semantic checks against documented rules)
- LOW: No tests for `validateSettlementPolicy()` itself
- LOW: JSDoc on `resolveAssessmentIdentity` missing two error codes (`invalid_symbol`, `no_token_resolutions`)
- LOW: No whitespace-trimming test for symbol normalization

### [Step 2] Review Scheduler, Advice, Tick
- MEDIUM: `runPreCheck` return type uses flat union with optional identity — could be discriminated union for compile-time safety
- LOW: `identitySnapshot: c.identity ?? {}` falls back to empty object if identity absent (unreachable but silent)
- LOW: No tests for review-scheduler, review-advice schema, or ScannerWakeContext discriminated union
- LOW: `review-advice.ts` CHECK constraints use raw SQL column names instead of Drizzle template literals for consistency and type safety

### [Step 3] Config Schemas & Validation
- MEDIUM: No tests for `resolveAssessmentConfig` and `validateReviewInterval`
- MEDIUM: `assessmentPrice` missing from operator config (deferred to billing step)
- MEDIUM: `minConfidenceThreshold` default 0.6 is a literal, not operator-config-derived
- LOW: Worker references stale `PlatformAssessorConfig` fields (pre-existing, resolved in Step 7)

### [Step 4] Tool Parameter Schemas
- MEDIUM: `RecommendPresetTransitionParamsSchema` `.refine()` constraint (at least one of `assessmentArtifactId`/`symbol`) is invisible in JSON Schema output
- MEDIUM: Registry description still says "shared assessment" — should say "per-symbol assessment"
- LOW: Lost `.describe()` on `ApplyPresetTransitionParamsSchema.targetPreset`
- LOW: `get_market_preset_assessment` description omits billing side-effect for cache hits
- LOW: `recommend_preset_transition` example shows only one path (artifact-reference), missing symbol-first path

### [Step 5] DB Schema
- MEDIUM: `review-advice.ts` CHECK constraints use raw SQL column names (e.g. `instrument_kind`) instead of Drizzle template literals (`${t.instrumentKind}`) — functionally identical but loses TypeScript compile-time column-name verification
- LOW: `identitySnapshot` default inconsistency: `marketAssessmentRuns`/`marketAssessmentArtifacts` use `default(sql'{}'::jsonb)`, while `reviewAdvice`/`agentPresetTransitions` have no default

### [Step 6] Assessment Request Service
- MEDIUM: Idempotency scope is key-only (not `agentId + identity + key`) — must be widened when real billing is wired
- MEDIUM: Race condition between billing reservation and per-identity lease when wired — two concurrent requests from same agent with different idempotency keys could both pass billing before acquiring lease
- MEDIUM: `venueFamily`/`styleTier`/`instrumentKind` have hard-coded defaults (`'hyperliquid'`, `'standard'`, `'orderbook'`) — should come from resolved config or be required params
- LOW: Unbounded in-memory cache growth for `idempotencyCache` (no TTL/size cap/eviction)
- LOW: `identityKey` delimiter collision risk with `|` character
- LOW: No concurrency limit enforcement (`maxConcurrentAssessments`)

### [Step 7] PlatformAssessor Refactor
- MEDIUM: `identityToSegmentKey` discriminated union narrowing may need explicit `switch` statement for robust TS narrowing
- MEDIUM: `PlatformAssessorDeps.db` and `redis` are now unused (persistence responsibility moved to `AssessmentRequestService`)
- LOW: `maxLlmCallsPerCycle` is dead config on the class after cycle loop removal

### [Step 8–10] Tools, Deletions, Retained Requirements
- MEDIUM: Duplicate `identityWhereClause` in two tool files — should be extracted to shared utility
- MEDIUM: `recommend_preset_transition` Path B (symbol-first) returns early without calling `identityWhereClause` — dead code
- LOW: `WakeGateConfig` interface retained in `schema.ts` for engine's `wake-gate.ts` compat — may need eventual deletion
- LOW: `MarketAssessmentWakeDecision` interface and Zod schema are dead code after DB table deletion

### [Step 11] Tests & Verification
- MEDIUM: No integration tests for assessment request service against Postgres (concurrent same-identity requests)
- MEDIUM: No tests for tool execution paths (`get_market_preset_assessment`, `recommend_preset_transition`, `apply_preset_transition`)
- LOW: Pre-existing `presets.test.ts` failures (9 tests) due to missing `config/strategy-presets/*.yaml` files — unrelated to this feature
- LOW: No migration application verification against a live database
