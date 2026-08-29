# Program Regression and Coverage Hardening

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Define the final hardening feature that adds targeted regression and coverage
tests around accepted program boundaries once the earlier feature surfaces stop
moving.

## Scope

This doc includes:

1. targeted automated regression coverage for known bugs and accepted feature
   boundaries
2. task-list-driven expansion of tests at the narrowest viable layer
3. final hardening checks after the staged feature path stabilizes

This doc does not include:

1. reopening feature scope decisions that earlier docs have already fixed
2. blanket refactors presented as testing work
3. unbounded exploratory bug fixing without a concrete regression target
4. product-code implementation in this documentation step

## Non-Goals

1. Do not invent middle-level phase docs for every individual regression case.
2. Do not treat this feature as a license to redesign earlier implementations.
3. Do not rely on real external calls when a deterministic lower-layer test can
   prove the behavior.
4. Do not collapse all coverage into one broad end-to-end suite when narrower
   tests can falsify the slice more cheaply.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after the earlier staged features have stabilized.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to stay as one canonical overview rather than a
   feature-internal roadmap.
3. [001-plan.md](./001-plan.md) remains the legacy source for the initial seed
   regressions around canonical token fallback and agent-native fill history.
4. This feature inherits the master-roadmap rule that hardening happens after
   accepted feature boundaries stop moving.

## Fixed Decisions

1. This feature is task-list-driven and does not require feature-internal phase
   docs.
2. The first normalized regression targets are the known canonical-token
   fallback and agent-native trade-history bugs named in the source plan.
3. Tests should be added at the narrowest layer that can prove the behavior
   deterministically.
4. Hardening work must respect the accepted boundaries of the features it
   covers rather than reopening them.
5. Final repo gates remain part of completion for each later hardening slice.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact grouping of future regression tasks into one or more task-list docs
2. exact harness choice per regression, as long as the narrowest practical
   layer is used
3. which adjacent regressions are bundled with the initial seed cases if they
   share the same test surface cleanly

## Acceptance Criteria

1. The overview makes clear that this feature is a stabilization and
   verification layer, not a new product surface.
2. The source plan's initial seed regressions are preserved as the first
   concrete targets for later task lists.
3. The overview keeps the hardening strategy compatible with the master-roadmap
   ordering and feature boundaries.
4. Later C10 work can write executable task lists without guessing how broad or
   narrow this feature should be.

## Validation

1. Compared the scope, fixed decisions, and seed regression targets against
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
