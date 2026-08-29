# LLM Cost Attribution Metrics

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Define one canonical attribution contract for LLM usage so evaluation artifacts
and billing queries can explain which runtime path, trigger source, and
reasoning level produced cost.

## Scope

This doc includes:

1. canonical dimensions for LLM path, trigger source, and effective reasoning
   level
2. matching attribution vocabulary across runtime activity events and billing
   usage rows
3. evaluation artifacts and query surfaces that make the new dimensions usable

This doc does not include:

1. a new end-user cost dashboard in this slice
2. retroactive backfill for historical usage events
3. a billing price-model redesign
4. product-code implementation in this documentation step

## Non-Goals

1. Do not add new top-level billing columns when JSONB metadata is sufficient
   for the first pass.
2. Do not record configured reasoning defaults when the runtime resolved level
   differs.
3. Do not let scout, judge, and hybrid paths keep incompatible attribution
   vocabularies.
4. Do not require manual log forensics to answer feature-level cost questions.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after capability foundations and chat sessions.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to stay as one canonical overview.
3. [001-plan.md](./001-plan.md) remains the legacy source for canonical
   dimensions, trigger precedence, metadata shape, and evaluation artifacts.
4. [../../2026/07/11/004-hybrid-mode-split/001-plan.md](../../2026/07/11/004-hybrid-mode-split/001-plan.md)
   is legacy background for the runtime paths this feature needs to measure,
   but the active execution order is fixed by the master roadmap.

## Fixed Decisions

1. LLM attribution data lives in `billing_usage_events.metadata` for the first
   implementation.
2. The canonical dimensions are `llmPath`, `triggerSource`, and effective
   `reasoningLevel`, with runtime context fields such as `capabilityMode` and
   `hybridMode` included when available.
3. Trigger-source resolution uses one shared precedence order and must always
   resolve to a canonical value.
4. Runtime activity events and billing usage rows must use the same
   attribution vocabulary.
5. Evaluation output must expose the new dimensions without breaking existing
   coarse cost artifacts.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact helper boundaries for trigger-source derivation and reasoning-level
   capture
2. exact grouped JSON artifact shape, as long as the canonical dimensions are
   queryable
3. optional debug metadata such as turn indices, as long as the required
   attribution contract stays stable

## Acceptance Criteria

1. The feature defines one stable attribution contract for scout, judge, and
   hybrid single-shot LLM paths.
2. Billing events and runtime activities can be grouped by path, trigger
   source, and effective reasoning level without ad hoc parsing.
3. The overview keeps accounting scope separate from dashboards and billing
   pricing policy.
4. Later task-list work can implement runtime, billing, and evaluation changes
   without guessing the canonical dimensions.

## Validation

1. Compared the scope, fixed decisions, and acceptance boundaries against
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).