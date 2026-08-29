# Skill-Driven Tick Interval Defaults

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
**Normative inputs:** [Agent Minimum Tick Interval Extension](../070-agent-min-tick-interval-extension/001-overview.md)

## Purpose

Define the default-cadence feature so agent tick intervals can be derived from
selected skills instead of only from trading-centric style defaults, while
keeping the stored tick interval explicit and auditable.

## Scope

This doc includes:

1. computing the default tick interval from selected skills' suggested
   intervals
2. style-based modulation of the computed baseline
3. server and client behavior for create-time defaulting and display

This doc does not include:

1. runtime re-derivation of existing agents' stored tick intervals
2. retroactive migration of previously created agents to new defaults
3. new agent-style enum values
4. product-code implementation in this documentation step

## Non-Goals

1. Do not remove the existing style defaults; they remain fallback data.
2. Do not recompute stored cadence automatically on later skill edits in v1.
3. Do not let auto-derived defaults hide the user's ability to override the
   final stored interval.
4. Do not treat `base` or `bot-management` as cadence-defining skills.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after chat sessions and the minimum tick-interval
   extension feature.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to stay as one canonical overview.
3. [001-plan.md](./001-plan.md) remains the legacy source for the averaging
   model, fallback chain, and create-time storage decision.
4. This feature depends on
   [../070-agent-min-tick-interval-extension/001-overview.md](../070-agent-min-tick-interval-extension/001-overview.md)
   for the bounded extension model that layers on top of the default cadence.

## Fixed Decisions

1. The default baseline is derived from the selected skills'
   `suggestedTickIntervalMs`, excluding `base` and `bot-management`.
2. The reducer for mixed-skill agents is the arithmetic average of the
   included `suggestedTickIntervalMs` values before style multipliers are
   applied.
3. Style multipliers modulate the derived baseline rather than replacing it.
4. The fallback chain is skill-derived baseline, then preset-aware fallback,
   then style fallback, then platform last resort.
5. The computed default is applied at create time and stored explicitly on the
   agent record.
6. Existing agents are not retroactively migrated in v1.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact helper placement for shared tick-interval computation across API and
   web code
2. exact display text for showing the computed default in the create flow
3. exact preset fallback mapping details, as long as the documented fallback
   order stays unchanged

## Acceptance Criteria

1. The overview fixes the create-time computation model and keeps the stored
   tick interval explicit.
2. The overview fixes arithmetic averaging as the reducer for mixed-skill
   suggested intervals before style modulation.
3. The feature preserves current trading-agent defaults through the fallback
   and multiplier design.
4. The boundaries around excluded skills, no retroactive migration, and user
   override remain explicit.
5. Later task-list work can implement the domain, API, and UI changes without
   guessing when recomputation should happen.

## Validation

1. Compared the scope, fixed decisions, and fallback model against
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
