# ADR 003: Agent Blueprint Contract

**Date:** 2026-08-01
**Status:** Accepted

## Context

The current blueprint row stores opaque `configData`. That is sufficient for narrow bot presets, but not for a marketplace asset that must support filtering, ranking, projection, and faithful reconstruction of agents and bots.

Agent strategy identity is also under-modeled today. It is often inferred from preset metadata or surrounding configuration rather than stored as a first-class typed field.

## Decision

**Blueprint payloads are typed, validated, and queryable in shared domain code.**

Specifically:

1. The existing `blueprints` entity remains the single template entity.
2. Blueprints carry an explicit kind that distinguishes at least agent and bot recipes.
3. Agent blueprint payloads include first-class strategy identity.
4. Strategy identity must not depend on metadata sidecars, display-only labels, or inferred UI state.
5. Marketplace metadata and lineage stay on the blueprint row, while actor-specific recipe details live in the typed blueprint payload.
6. Because backward compatibility is not a requirement, the implementation may replace obsolete payload forms directly rather than preserve them.

## Contract Requirements

The blueprint contract must support at least:

1. blueprint kind
2. actor kind
3. strategy identity
4. style
5. prompt or goal where relevant
6. technical configuration
7. intelligence configuration
8. execution defaults
9. risk posture
10. operational policy
11. marketplace metadata
12. lineage metadata

## Rationale

1. Opaque blobs are insufficient for marketplace filtering, ranking, validation, and projection.
2. Agent strategy identity is currently under-modeled and must become first-class for discovery and attribution.
3. Shared domain schemas give API, DB, and worker code one contract rather than per-surface interpretations.
4. Direct reshaping is cheaper and clearer than carrying compatibility scaffolding for state that will be reset.

## Consequences

### Positive

1. Blueprints become searchable and rankable by typed fields.
2. Projection and instantiation logic can rely on explicit schemas.
3. Agent strategy identity no longer depends on metadata conventions.

### Negative

1. Domain and database work become a prerequisite for most later implementation.
2. Existing routes that accept or return raw blueprint blobs will need redesign.

## Follow-Up Rules

1. New blueprint APIs must validate payloads against shared domain schemas.
2. Strategy identity must be accessible without inspecting free-form metadata.
3. Obsolete compatibility scaffolding should not be introduced unless a concrete Phase 1 need is proven.
