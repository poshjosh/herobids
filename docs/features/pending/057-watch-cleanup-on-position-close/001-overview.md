# Watch Cleanup on Position Close

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Define the bounded cleanup feature that removes orphaned protective watches when
positions close so prompt context, watch summaries, and monitor cycles do not
continue reflecting closed exposure.

## Scope

This doc includes:

1. system-level cleanup of protective watches linked to a closing position
2. summary refresh so runtime context reflects the cleanup immediately
3. soft prompt guidance for agent-owned memory cleanup after close

This doc does not include:

1. automatic creation of watches for new positions
2. system-owned deletion of arbitrary agent memory
3. broad redesign of watch semantics beyond orphan cleanup
4. product-code implementation in this documentation step

## Non-Goals

1. Do not treat stale watches as proof that per-trade level enforcement is
   itself broken.
2. Do not remove non-protective informational watches just because they share a
   symbol.
3. Do not make watch cleanup failures block position close.
4. Do not let system cleanup violate agent-mode purity for memory ownership.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after exit-policy and advanced order-management work.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to stay as one canonical overview.
3. [001-plan.md](./001-plan.md) remains the legacy source for the cleanup
   trigger, position-key matching rules, and best-effort failure handling.

## Fixed Decisions

1. Cleanup is triggered when a position transitions to `flat` in the persistence
   paths that already finalize close state.
2. Removal targets only watches whose `coverage.positionKey` matches the closed
   position and whose purpose is protective.
3. Summary-cache refresh is part of the cleanup contract.
4. Redis cleanup failures are non-fatal and must be logged rather than block
   close persistence.
5. Memory cleanup remains advisory guidance to the agent rather than system
   enforcement.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact helper placement for watch removal and summary refresh
2. exact logging fields and warning text for cleanup failures
3. whether prompt guidance lands in skill text or another existing prompt
   composition layer

## Acceptance Criteria

1. The feature explicitly distinguishes stale-watch cleanup from per-trade
   level-enforcement logic.
2. The overview fixes the removal rules tightly enough that later task-list
   work cannot over-delete unrelated watches.
3. The non-fatal cleanup behavior and memory-ownership boundary stay explicit.
4. Later implementation can cover both normal close persistence paths without
   guessing where cleanup belongs.

## Validation

1. Compared the scope, fixed decisions, and implementation boundaries against
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
