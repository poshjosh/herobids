# Agent Minimum Tick Interval Extension

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Define the bounded tick-extension feature so an agent may delay its next
scheduled timer tick when allowed, while preserving the existing minimum cadence
and all earlier wake-driven execution paths.

## Scope

This doc includes:

1. a per-agent permission that allows one-shot delay requests for the next
   scheduled timer tick
2. operator-owned caps and runtime-policy resolution for the feature
3. a tool and prompt/runtime contract that explains the extension boundary to
   the agent

This doc does not include:

1. letting agents shorten their cadence below the existing minimum interval
2. replacing wake-driven ticks with a delay-only model
3. introducing a new top-level agent column for this permission
4. product-code implementation in this documentation step

## Non-Goals

1. Do not turn the base tick interval into a best-effort suggestion.
2. Do not allow persistent indefinite extensions from one request.
3. Do not expose the operator-owned cap as a free-form user setting.
4. Do not show the tool when the permission is disabled and rely only on a
   runtime rejection.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after agent chat sessions and before skill-driven tick
   defaults.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to stay as one canonical overview.
3. [001-plan.md](./001-plan.md) remains the legacy source for the minimum-cadence
   semantics, runtime-policy fit, scheduling rules, and tool direction.

## Fixed Decisions

1. The configured tick interval remains the minimum timer cadence.
2. Delay requests are one-shot and may only lengthen the next scheduled timer
   tick.
3. Wake signals remain allowed to trigger earlier execution than a delayed
   timer.
4. The per-agent permission lives in runtime-policy overrides, while the max
   extension cap is operator-owned.
5. Tool visibility and execution-time enforcement must stay aligned under the
   same permission boundary.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact tool input shape and response payload for the one-shot delay request
2. exact logging and prompt wording for accepted, clamped, or pre-empted delay
   requests
3. exact helper boundaries between scheduler internals and tool context wiring

## Acceptance Criteria

1. The overview fixes the one-shot, minimum-cadence semantics clearly enough to
   avoid accidental cadence weakening.
2. The runtime-policy, scheduler, and tool boundaries are explicit.
3. The feature preserves wake precedence and operator-owned maximum delay.
4. Later task-list work can implement the permission and scheduler changes
   without guessing where the policy should live.

## Validation

1. Compared the scope, fixed decisions, and implementation boundaries against
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).