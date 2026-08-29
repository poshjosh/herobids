# OpenAIdom Brand Rollout Follow-Up

**Status:** ready  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Define the independent follow-up feature that closes the remaining Tier 2 brand
rollout gaps without reopening the main staged program or mixing design-system
cleanup into platform-critical feature sequencing.

## Scope

This doc includes:

1. the remaining Tier 2 brand-hardening items from the legacy follow-up plan
2. component test coverage and brand-token cleanup
3. email renderer hardening and related delivery-test gaps
4. Safari/favicon and related asset-fidelity follow-up

This doc does not include:

1. re-running the main brand rollout from scratch
2. unrelated capability, trading, or agent-runtime work
3. promoting this independent follow-up track ahead of the main staged program
4. product-code implementation in this documentation step

## Non-Goals

1. Do not widen this follow-up into a new brand redesign.
2. Do not mix Tier 2 cleanup into the active staged feature critical path.
3. Do not reopen the already chosen favicon or email plain-text contract
   decisions without a new controlling doc.
4. Do not treat independent task ordering as permission to ignore focused
   validation per item.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   keeps this feature on an independent follow-up track outside the main staged
   path.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   assigns this feature to the canonical follow-up folder and keeps it as one
   overview doc.
3. [001-plan.md](../027-openaidom-brand-rollout-followup/001-plan.md) remains the
   legacy source for the Tier 2 item list and the resolved implementation
   choices that this overview carries forward.

## Fixed Decisions

1. This feature remains independent follow-up work and must not pre-empt the
   main staged roadmap.
2. The remaining rollout scope is limited to the seven Tier 2 items captured in
   the legacy follow-up plan.
3. The Safari favicon path uses a true SVG with embedded color-scheme styling
   rather than dual PNG links.
4. Email plain-text fidelity uses an explicit `textBody` contract rather than
   tag-stripping alone as the preferred path.
5. Email HTML content hardening and related tests stay inside this follow-up
   feature rather than being deferred into unrelated messaging work.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact execution order of the independent Tier 2 items
2. whether closely related email-renderer items land in one change or several
   focused changes
3. exact test placement for component, renderer, and SES coverage additions

## Acceptance Criteria

1. The feature boundaries keep the follow-up isolated from the main staged
   program.
2. The overview carries forward the legacy plan's resolved design decisions and
   keeps the remaining item set explicit.
3. Later task-list work can implement the follow-up items without guessing
   whether they are still in scope.
4. The canonical follow-up folder becomes the authoritative high-level entry
   point for this feature.

## Validation

1. Compared the scope, fixed decisions, and follow-up positioning against
   [../027-openaidom-brand-rollout-followup/001-plan.md](../027-openaidom-brand-rollout-followup/001-plan.md).
2. Confirmed the independent-track placement and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
