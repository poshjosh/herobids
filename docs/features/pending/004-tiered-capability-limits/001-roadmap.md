# Tiered Capability, Sandbox, and Tool Argument Limits

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Decompose tiered capability limits into ordered slices so operator defaults,
plan entitlements, sandbox ceilings, and argument-level enforcement can be
 normalized without mixing contract design with implementation details.

## Scope

This roadmap includes:

1. operator-configured capability defaults that replace hardcoded grants
2. plan-tier capability and sandbox entitlement resolution
3. ceiling enforcement over per-agent overrides
4. tool argument limits enforced before capability execution

This roadmap does not include:

1. per-user entitlement overrides outside plan tiers
2. new billing models for tool invocations
3. capability-foundations service extraction work
4. product-code implementation in this documentation step

## Non-Goals

1. Do not keep hardcoded defaults as the long-term source of truth.
2. Do not let per-agent overrides exceed operator or plan ceilings.
3. Do not widen this feature into unrelated filesystem or marketplace policy.
4. Do not treat rolling-deploy compatibility as permission to keep duplicate
   entitlement logic permanently.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after capability foundations and before later
   self-service agent features.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires a canonical `001-roadmap.md` with ordered child docs.
3. [001-plan.md](../001-plan-tiered-capability-limits/001-plan.md) remains the
   legacy source material for the layered resolution model, concrete limits,
   and phased rollout sequence.
4. This feature depends on capability foundations at program level because
   capability ownership and activation must already be authoritative before
   tiered enforcement becomes durable.

## Fixed Decisions

1. Operator config owns the default capability grants and absolute ceilings.
2. Plan entitlements define the next narrower layer for capabilities and
   sandbox limits.
3. Per-agent `toolPolicy` overrides may only tighten or further narrow the
   resolved plan limits.
4. Tool argument limits are part of the capability contract and must be
   enforced before execution.
5. Resolution order is operator ceiling, then plan entitlement, then per-agent
   override, with the most restrictive effective value winning.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact schema/helper boundaries for capability, sandbox, and argument-limit
   resolution
2. the exact backward-compatibility shim used during rolling deploy
3. the exact observability payload shape for resolved grants and disabled
   capabilities

## Child Docs And Sequence

Executable child docs to create in C09:

1. `002-operator-capability-defaults.md`
2. `003-plan-tier-capability-resolution.md`
3. `004-plan-tier-sandbox-limits.md`
4. `005-tool-argument-limits.md`
5. `006-documentation-and-defaults-tuning.md`

Supporting task lists should start only after the first child doc fixes the
config and resolution contract precisely enough for implementation.

## Acceptance Criteria

1. The roadmap fixes the layered resolution contract for capability grants,
   sandbox limits, and argument limits.
2. The child-doc order matches the source plan's phased implementation path.
3. The feature-wide boundaries prevent later work from bypassing operator
   ceilings or scattering enforcement logic.
4. Later C09 and C10 work can create executable slices without guessing which
   layer owns each limit.

## Validation

1. Compared the child-doc sequence and fixed decisions against
   [../001-plan-tiered-capability-limits/001-plan.md](../001-plan-tiered-capability-limits/001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the required section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
