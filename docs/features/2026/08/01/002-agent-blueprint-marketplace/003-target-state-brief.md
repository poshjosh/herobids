# 002 - Agent Blueprint Marketplace Target-State Brief

**Status:** Draft  
**Created:** 2026-08-01  
**Depends on:** [004-adr-list.md](./004-adr-list.md), [005-delivery-map.md](./005-delivery-map.md)

## Purpose

Define the clean end state for the agent blueprint marketplace before phase plans or implementation details are hardened.

## Assumptions

1. Backward compatibility is not a delivery constraint for this feature.
2. Resetting Postgres, Redis, and derived local state is acceptable.
3. The platform should evolve the existing `blueprints` concept rather than introduce a second template entity.
4. The marketplace asset must be understandable and installable without exposing private instance data.

## Product Objective

Blueprints become the canonical marketplace asset for reusable agents and bots.

A user should be able to discover a blueprint, understand what it does, fork or acquire it, bind only their own private runtime inputs, and get an agent or bot that behaves materially like the original.

## Target State

### 1. Blueprint is the canonical installable asset

A blueprint is the stable, shareable recipe that the marketplace ranks, displays, forks, and attributes.

Live agents and bots are runtime instances. They may later contribute evidence, attribution, or reputation, but they are not the installable marketplace unit.

### 2. The template and the instance are separated cleanly

Template data is shareable and publishable.

Instance data is private, user-owned, or runtime-derived.

The server, not the browser, decides which fields belong to each side.

### 3. Blueprint payloads are typed and queryable

Blueprint content is no longer opaque `configData`.

The blueprint contract must be typed, validated, and searchable across at least:

1. blueprint kind
2. actor kind
3. strategy identity
4. style
5. execution defaults
6. risk posture
7. marketplace lifecycle and lineage

### 4. Operational completeness is a hard requirement

A copied blueprint must not silently lose behavior because policy lived in an unrelated column, hidden form field, or API-only setting.

If a policy materially changes how an agent or bot behaves, it belongs in the template contract unless it is private or runtime-only.

### 5. Marketplace mechanics reuse the proven skills pattern

Blueprints should gain the same broad marketplace mechanics already present for skills:

1. publication lifecycle
2. likes
3. forks and lineage
4. popularity and trending scores
5. usage events
6. filtering and sorting

### 6. Phase 1 ships the reusable marketplace core

Phase 1 should deliver the typed blueprint contract, database support, API surface, server-side projection and application rules, attribution, and a thin but real UI flow.

Monetization, rich merchandising, and evaluation-derived reputation can follow after the core is stable.

## V1 Scope

### In scope

1. One canonical blueprint asset for both agent and bot recipes.
2. Typed blueprint contract and first-class agent strategy identity.
3. Blueprint lifecycle and ranking basics.
4. Server-side save-as-blueprint and instantiate-from-blueprint flows.
5. Agent and bot attribution back to the originating blueprint.
6. A minimal marketplace UI for browse, publish, fork, and use.

### Out of scope

1. Paid entitlements and purchase enforcement.
2. Review systems and public user ratings.
3. Evaluation-driven ranking as a primary score.
4. Generic shared marketplace abstractions unless duplication proves painful.
5. Unrelated cleanup such as shared API and worker config loading, unless required by an implementation slice.

## Template Surface

The blueprint template surface should include, where relevant:

1. prompt or goal
2. skill assignments
3. style
4. typed strategy identity
5. technical config
6. intelligence config
7. execution defaults
8. risk posture
9. capital defaults where applicable
10. operational policies
11. marketplace metadata
12. lineage metadata

## Instance-Only Surface

The instance surface should exclude at least:

1. connection IDs and venue account bindings
2. credentials and secret references
3. private destinations such as `telegramChatId`
4. pause state and session state
5. runtime self-adjustments such as `riskOverrides`
6. open positions, fills, P and L, and runtime analytics
7. per-user delivery destinations or account ownership details

## Success Criteria

This feature reaches the target state when:

1. a blueprint can fully describe a shareable agent or bot recipe without leaking private state
2. a user can instantiate a materially faithful copy by supplying only missing private bindings
3. the marketplace can list, filter, sort, fork, and attribute blueprints using typed fields
4. server-side projection rules are explicit and tested
5. Phase 1 can proceed without reopening the core asset model
