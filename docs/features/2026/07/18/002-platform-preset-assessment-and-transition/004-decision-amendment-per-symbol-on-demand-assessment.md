# Decision Amendment: Per-Symbol Identity And On-Demand Billing Gate

**Status:** Adopted amendment
**Supersedes in part:** [002-decision-record.md](./002-decision-record.md)

## Purpose

This amendment replaces the original segment-key decision with a per-symbol identity and replaces scheduled background generation with agent-requested, billing-gated execution.

## A1. Assessment Identity

**Decision:** The assessment identity is per-symbol.

```text
orderbook / perps: { venueFamily, styleTier, symbol }
swaps / dex:       { venueFamily, styleTier, network, address }
```

### Included

- `venueFamily`
- `styleTier`
- `symbol` for orderbook / perps instruments
- `network + address` for swap / dex instruments

### Canonical identity decision

For swaps / dex, canonical identity is **`network + address`**, not ticker string alone.

### Rationale

Ticker strings are convenient for agent UX, but they are not always unique enough for canonical persistence identity in swap markets.

### Excluded

- `excludeSymbols`
- `minLiquidityUsd`
- `minVolume24hUsd`
- broader discovery filters that only influence which symbols the agent is willing to inspect or trade
- open positions
- capital
- current preset
- recent PnL
- actor-specific transition policy

### Rationale

The assessment should be keyed by the market actually being evaluated, not by agent-specific discovery filters. This preserves accuracy while preventing unbounded segment multiplication from arbitrary filter variation.

## A2. Trigger Model

**Decision:** Assessment generation is on-demand and agent-requested.

### Required behavior

- no phase-1 platform-scheduled background assessment generation
- an assessment run starts only when requested by an agent
- billing / credit gating must succeed before the run starts
- if billing / credit gating fails, no run occurs
- `get_market_preset_assessment` auto-starts the run when cache is missing
- `not available` is used only for failure / blocked outcomes, not for ordinary cache misses

### Rationale

This aligns cost with the requesting agent and removes platform liability for speculative background assessment work.

## A2A. Agent Request Shape

**Decision:** Agents should request assessment through a symbol-first interface.

### Required behavior

- request UX should be symbol-first for ease of use
- the platform resolves canonical assessment identity underneath that request
- swap / dex requests may resolve to `network + address` internally even when the agent began from symbol text
- related tools should stay consistent about what agents are expected to submit

### Rationale

Agents have already shown confusion when required to juggle symbol and address manually. The platform should absorb that complexity where practical.

## A2B. Assessment Interval Control

**Decision:** Assessment request interval is agent-level configurable, bounded by operator-level guardrails.

### Required behavior

- the agent owner may configure the review/request interval
- operator config must enforce a minimum allowed interval
- operator config may enforce a maximum requests-per-day cap
- default review/request interval: **24 hours**
- default operator minimum floor: **24 hours**

### Rationale

Assessment cost should remain user-controlled, but the platform must prevent obviously unsafe settings that would recreate cost spikes or noisy behavior.

## A2C. Scanner Trigger Rule

**Decision:** Scanner-assisted assessment prompting must be tightly filtered.

### Required behavior

A symbol qualifies to be offered for assessment only when all of the following are true:

- it is in the top `N` scanner candidates
- no fresh assessment exists for that symbol identity
- billing / credit gating would allow a run
- cheap deterministic checks indicate a possible preset mismatch
- the agent is outside assessment-review cooldown

### Rationale

This keeps scanner-assisted assessment access selective and cost-aware, rather than turning every scanner event into an assessment request opportunity.

## A2D. Scanner-Gated Assessment Access

**Decision:** `scanner_gated` agents must access assessment only through a dedicated low-frequency review path.

### Required behavior

- do not piggyback assessment access onto ordinary scanner signal wakes for `scanner_gated` agents
- use a separate, low-frequency review path for assessment access
- that path still respects billing / credit gating and assessment interval controls

### Rationale

This preserves the cost discipline of scanner-gated agents instead of letting ordinary signal wakes become a backdoor for more frequent assessment spending.

## A3. Cache Reuse

**Decision:** On-demand runs may still benefit from shared cache reuse.

### Required behavior

- if a fresh artifact already exists for the same assessment identity, it may be returned instead of starting a new run
- freshness rules still determine when reuse is allowed

### Default freshness

- freshness remains operator-configurable
- default cache freshness: **6 hours**

### Billing

- both a new run and a cache hit are billable events under the adopted model
- there is no price difference between a fresh run and a cache hit

### Rationale

This preserves the useful part of sharing without reintroducing unbounded background generation.

## A4. Relationship To Original Decisions

This amendment supersedes the original decision record only where it conflicts on:

- segment key / assessment identity
- scheduled background generation as the default phase-1 path
- inclusion of `excludeSymbols`, `minLiquidityUsd`, and `minVolume24hUsd` in assessment identity

All other decisions remain in force unless replaced by a later amendment.

## A5. Scheduled Wakes

**Decision:** Platform-driven preset-review wakes are deferred from phase 1.

### Required behavior

- phase 1 assessment generation remains on-demand and agent-requested
- scanner / wake plumbing may remain in code, but is not part of the canonical phase-1 assessment trigger model

### Rationale

This preserves the simplified, cost-bounded request model and avoids reintroducing proactive platform-funded behavior too early.

## A6. Analytics Feedback

**Decision:** Record now, use later.

### Required behavior

- phase 1 must record the data needed for later analytics-informed assessment
- phase 1 assessment ranking should remain primarily market-structure-based
- realized performance feedback may be incorporated later once attribution quality is trusted

### Rationale

This keeps phase 1 simpler while ensuring the system collects the evidence needed to improve assessment quality later.
