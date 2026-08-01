# 002 - Agent Blueprint Marketplace Delivery Map

**Status:** Draft  
**Created:** 2026-08-01

## Purpose

Provide the high-level workstreams and sequencing for the full feature set without over-hardening later phases.

## Delivery Principles

1. Lock the asset model before expanding implementation scope.
2. Prefer clean replacement over compatibility bridges.
3. Keep later phases rough until Phase 1 is accepted and underway.
4. Validate each workstream with explicit evidence, not just document completion.

## Workstreams

### 0. Architecture lock

**Goal**
Freeze the target state and the ADR set.

**Outputs**
1. target-state brief
2. accepted ADR set
3. hardened Phase 1 boundary

**Verification**
1. no open ambiguity about the installable marketplace asset
2. no unresolved disagreement about template versus instance fields

### 1. Domain and schema foundation

**Goal**
Define the typed blueprint contract and move the database toward the clean asset model.

**Outputs**
1. domain schemas for blueprint kinds and typed blueprint payloads
2. first-class agent strategy identity
3. expanded blueprint table and support tables for v1 marketplace mechanics

**Verification**
1. blueprint payloads validate cleanly
2. typed fields are queryable without metadata guessing
3. schema no longer depends on legacy compatibility layers

### 2. Marketplace backend

**Goal**
Turn blueprints into a real marketplace API surface.

**Outputs**
1. lifecycle endpoints
2. browse, filter, and sort endpoints
3. likes, forks, usage events, and scores
4. projection and instantiation endpoints

**Verification**
1. API tests cover lifecycle, access control, ranking, and attribution
2. save and instantiate flows are server-owned and deterministic

### 3. Marketplace web flows

**Goal**
Expose usable blueprint flows in the product.

**Outputs**
1. blueprints page
2. publish and fork actions
3. save-as-blueprint entry points
4. use-blueprint entry points for agent and bot creation

**Verification**
1. users can browse, publish, fork, and instantiate without raw API calls
2. minimal smoke tests pass for publish to fork to instantiate

### 4. Monetization and quality signals

**Goal**
Layer on non-blocking marketplace depth after the core is stable.

**Outputs**
1. blueprint entitlements and paid access
2. richer public quality signals
3. possible evaluation-derived enrichment

**Verification**
1. monetization does not change the core blueprint contract
2. public quality signals do not depend on sparse one-off evaluations alone

### 5. Adjacent cleanup

**Goal**
Tidy follow-up duplication or extracted helpers after the asset model is proven.

**Outputs**
1. shared marketplace helpers if duplication becomes painful
2. config-loading cleanup if it materially helps feature maintenance

**Verification**
1. cleanup follows working behavior rather than blocking it
2. refactors do not reopen the blueprint contract

## Phase Framing

### Phase 1

Build the reusable marketplace core:

1. contract
2. schema
3. API
4. projection and application rules
5. attribution
6. thin UI flows

### Phase 2

Broaden marketplace depth:

1. monetization
2. quality and reputation signals
3. richer merchandising and discovery
4. optional abstractions or cleanup proven necessary by Phase 1

## Exit Rule

Only Phase 1 should be fully hardened now. Everything after Phase 1 should remain high-level until Phase 1 implementation exposes real constraints.
