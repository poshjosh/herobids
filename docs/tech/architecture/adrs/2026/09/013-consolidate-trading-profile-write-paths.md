# ADR 013: Consolidate Trading-Profile Write Paths

**Date:** 2026-09-19
**Status:** Accepted

## Context

Trading configuration is normalized and written by multiple herobids paths:
agent create/update routes, agent interactivity, chat creation, and
instantiation. C1 would otherwise need to attach its profile write-through to
each independently, risking different profile state for the same user intent.

## Decision

Before C1's herobids cut-over, consolidate trading-profile validation and
normalization behind shared pure helpers. They produce exact profile snapshots
per bound trading connection, select one execution binding by the existing
default-ready then first-ready rule, and plan upserts, clears, and inverse
operations from prior and proposed bindings. They accept an injected durable
profile-change writer; C1 supplies that writer once it exists. Existing public
routes may remain; they must delegate to the same helpers.

## Consequences

- C1a establishes the shared snapshot, selection, and reconciliation planners
  before C1 adds the boundary tool and write-through.
- C1 has one integration point for eager-at-bind profile creation, updates,
  unbinds, and deletion.
- A profile write or rollback cannot silently differ by creation or update
  workflow.
- The other B5 consistency proposals remain independently open; this ADR does
  not approve the proposed A9 batch.

## References

- Decision brief: `docs/features/2026/09/18/001-trading-extraction-completion/decisions/B5-consistency-sweep.md`
- C1 plan: `docs/features/2026/09/18/001-trading-extraction-completion/plans/C1-trading-profile-slice.md`