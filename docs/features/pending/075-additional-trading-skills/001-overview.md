# Additional Trading Skills

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Define the additional-trading-skills feature as a bounded methodology-skills
expansion so later work can publish supported trading playbooks without
pretending the current agent tool surface already supports every discretionary
methodology idea.

## Scope

This doc includes:

1. methodology-style trading skills delivered as instruction or playbook skills
2. a first-wave filter that distinguishes currently supported, partially
   supportable, and currently unsupported methodologies
3. a publication or seeding path for those skills that does not hard-code them
   into product code unnecessarily

This doc does not include:

1. inventing new market data the platform does not currently expose
2. pretending OHLCV-heavy, order-flow, or volume-profile methodologies are
   immediately executable without prerequisite tooling
3. broad redesign of the trading engine or scanner to fit each methodology
4. product-code implementation in this documentation step

## Non-Goals

1. Do not treat unsupported methodology names as active scope just because they
   are desirable.
2. Do not hide the candle and raw price-history gap when it blocks a method.
3. Do not couple methodology publication to one specific preset or strategy
   preset implementation.
4. Do not turn this feature into a substitute for the missing raw-data tools.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after capability foundations and unified skill
   discoverability, and before daily brief.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to stay as one canonical overview.
3. [000-notes.md](../075-additional-trading-skills.md/000-notes.md) remains the
   legacy source for methodology triage, tool-gap analysis, and publication
   direction.
4. The missing candle or OHLCV capability remains a prerequisite for any later
   expansion into methodologies that the source notes classify as currently
   unsupported.

## Fixed Decisions

1. The feature is about publishing methodology skills, not adding new core
   trading-engine strategies.
2. First-wave scope is limited to methodologies the current tool surface can
   support directly or with explicit bounded compromises.
3. Fully unsupported methodologies that require absent candle, order-flow,
   volume-profile, or session-range data remain out of scope until a separate
   prerequisite closes those gaps.
4. Skill publication may use a generic upload or seeding path rather than
   hard-coded product registration.
5. A selector or orchestration skill may exist later, but it must not hide the
   boundaries of the underlying methodology skills.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact first-wave subset among currently supported and partially
   supportable methodologies
2. whether some partially supportable methods remain deferred until additional
   bounded helper tooling exists
3. the exact publication and packaging workflow for the skills, as long as it
   does not require product-code hard-coding by default

## Acceptance Criteria

1. The overview names the methodology-filtering rule clearly enough that later
   task-list work cannot treat dead-on-arrival methods as executable scope.
2. The feature remains explicitly dependent on current tool reality rather than
   aspirational methodology lists.
3. The overview preserves room for publication work without deciding that every
   methodology becomes a skill in the first slice.
4. The dependency edge into daily brief remains credible because only supported
   methodology outputs may be treated as active inputs.

## Validation

1. Compared the scope, fixed decisions, and methodology boundaries against
   [../075-additional-trading-skills.md/000-notes.md](../075-additional-trading-skills.md/000-notes.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
