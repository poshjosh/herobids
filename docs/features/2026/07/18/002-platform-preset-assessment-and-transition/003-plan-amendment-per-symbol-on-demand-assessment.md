# Plan Amendment: Per-Symbol On-Demand Assessment

**Status:** Adopted amendment
**Supersedes in part:** [001-plan.md](./001-plan.md)
**Scope:** Replaces the shared unbounded segment-assessment direction with on-demand per-symbol assessment.

## Purpose

This amendment preserves the original feature record while replacing the cost-sensitive parts of the plan with a simpler, user-first direction.

The original segment model tied assessment identity to agent-specific discovery filters. That creates unbounded assessment growth and platform-funded background work. This amendment replaces that with a per-symbol, on-demand model.

## Adopted Direction

### 1. Assessment unit

Assessment is **per symbol**, not per agent-defined discovery scope.

- orderbook / perps identity:
  - `venueFamily + styleTier + symbol`
- swaps / dex identity:
  - `venueFamily + styleTier + network + address`

For swaps / dex, the canonical market identity is token identity, not ticker text alone.

### 2. Inputs removed from assessment identity

The following no longer define distinct assessments:

- `excludeSymbols`
- `minLiquidityUsd`
- `minVolume24hUsd`

These may still matter for agent discovery or trading policy, but they do not create separate assessment artifacts.

### 3. Assessment trigger model

Assessment generation is **on-demand only**.

- no platform-scheduled background assessment generation in phase 1
- an assessment runs only when an agent requests it
- the run must pass billing / credit gating before it starts
- if billing / credit fails, no run happens
- `get_market_preset_assessment` auto-triggers assessment generation when cache is missing
- `not available` is reserved for failure / blocked paths, not normal cache-miss behavior

### 3B. Assessment request interval control

Assessment review/request interval should be **agent-level configurable**, with operator guardrails.

- the agent owner controls how often the agent may request assessment
- operator config enforces a minimum floor to prevent excessively frequent requests
- operator config may also enforce a maximum requests-per-day budget

Default review/request interval: **24 hours**.

Operator minimum floor: **24 hours** by default unless a later product tier intentionally introduces a faster allowed cadence.

This keeps cost control close to the user while protecting the platform from pathological settings such as a 30-minute review interval.

### 3C. Scanner trigger rule

When scanner-assisted assessment prompting is used, a symbol is worth offering for assessment only when all of the following are true:

- the symbol is in the top `N` scanner candidates
- no fresh assessment exists for that symbol identity
- billing / credit gating would allow a run
- cheap deterministic checks suggest a possible preset mismatch
- the agent is outside its assessment-review cooldown

### 3D. Scanner-gated agent access

For `scanner_gated` agents, assessment access must **not** piggyback on existing scanner wakes.

- do not run or offer assessment inside ordinary scanner signal wakes
- use a dedicated, low-frequency review path instead
- that path remains subject to billing / credit gating and review interval controls

### 3A. Agent request shape

Assessment request flow should optimize for agent ease of use.

- agents should request assessment using symbol-first inputs, not low-level identity objects
- the platform should resolve canonical market identity underneath that request
- for swaps / dex, canonical persistence identity still remains `network + address`
- related tools should use one consistent request model so agents are not asked for symbol in one place and address in another without need

### 4. Cache and reuse

Assessment artifacts may still be cached and reused.

- if another agent asks for the same symbol identity while the artifact is fresh, the cached artifact may be reused
- stale artifacts must not be reused silently when freshness rules say otherwise

Freshness must remain configurable. Default freshness should be **6 hours** unless operator config overrides it.

### 4A. Billing model

Billing applies to both fresh generation and cache reuse.

- 1 new run = 1 charge
- 1 cache hit = 1 charge
- example: 1 run + 2 cache hits = 3 charges

There is no price difference between a fresh run and a cache hit.

## Why This Direction Won

### User outcome

Per-symbol assessment is more accurate than coarse shared cohorts because it evaluates the actual instrument the agent wants to trade.

### Cost control

On-demand generation plus billing-before-run removes platform exposure to unbounded background assessment cost.

### Architecture

This keeps some shared reuse through cache hits while avoiding the unbounded `universeScopeHash` multiplier.

## What Changes Relative To The Original Plan

### Replaced

- segment-based assessment identity using `universeScopeHash`
- scheduled background generation as the default phase-1 path
- treating discovery-scope filters as first-class assessment-identity dimensions

### Still true

- the platform assessor remains advisory
- the actor agent remains authoritative for account-level action
- creator-locked risk still wins over preset defaults
- transition actions remain explicit and auditable
- wake taxonomy compatibility still matters if wake-driven review is reintroduced later

## Additional adopted decisions

### 5. Scheduled wakes

Platform-driven preset-review wakes are **deferred from phase 1**.

- phase 1 uses on-demand, agent-requested assessment
- wake-driven review may be reconsidered later

### 6. Analytics feedback

Analytics feedback is **record now, use later**.

- phase 1 should record the data needed for later feedback loops
- phase 1 assessment logic should remain primarily market-structure-based
- realized performance can be incorporated into later assessor versions once attribution is trustworthy

## Guidance For Implementation

Implement future work as if the canonical assessment identity is per-symbol.

Use the original documents for everything that still applies, but treat this amendment as authoritative wherever they conflict on:

- assessment identity
- assessment trigger model
- the role of `excludeSymbols`, `minLiquidityUsd`, and `minVolume24hUsd`
