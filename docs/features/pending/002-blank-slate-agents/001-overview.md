# Blank-Slate Agents

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Define the canonical blank-slate agent feature so agent creation can collapse
to a one-click server-default flow, with guidance and self-management tools
that let the agent and creator shape the agent after creation instead of at
form time.

## Scope

This doc includes:

1. one-click agent creation entry points that call the existing create route
   with empty or minimal input
2. post-creation guidance for unconfigured blank-slate agents
3. agent self-management of prompt and skill assignments within plan
   entitlements
4. prompt provenance and journal visibility for user versus agent updates

This doc does not include:

1. removal of the full create/edit form or guided setup flows
2. self-provisioning of user connections or credentials by the agent
3. live-trading startup without a user-owned connection
4. product-code implementation in this documentation step

## Non-Goals

1. Do not introduce a backend agent type split based on creation-time role.
2. Do not make one-click creation a substitute for later configuration.
3. Do not allow self-management tools to bypass plan or capability limits.
4. Do not rely on string comparison to detect whether an agent is still using
   the default blank prompt.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after capability foundations and unified skill
   discoverability.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to stay as one canonical overview.
3. [001-plan.md](./001-plan.md) remains the legacy source for one-click
   creation semantics, self-management tooling, and prompt provenance.
4. [../../2026/08/23/001-relaxed-agent-creation-form/001-plan.md](../../2026/08/23/001-relaxed-agent-creation-form/001-plan.md)
   is background context for the server-side defaults this feature builds on,
   but the program dependency that controls execution order remains the master
   roadmap above.

## Fixed Decisions

1. Role and type remain frontend concepts; the backend does not branch on a new
   creation-time agent category.
2. One-click creation uses server-side defaults and starts blank-slate agents in
   test mode with no skills or connections by default.
3. Prompt and skill changes are mutable runtime state and may be initiated by
   the creator or the agent itself.
4. Agent self-management must reuse the same entitlement and validation rules
   as user-driven configuration changes.
5. Blank-slate detection uses explicit prompt-state metadata rather than
   string-comparing against the configured default prompt.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact UI placement and wording for the one-click affordances and guidance
   banner
2. prompt-journal retention shape, as long as provenance remains explicit
3. exact module boundaries for self-management tools and broker handlers

## Acceptance Criteria

1. The feature cleanly separates creation-time simplification from later prompt,
   skill, and connection configuration.
2. The self-management path is explicit and bounded by the same permission model
   as user-side configuration.
3. The overview fixes the source plan's key product semantics without reopening
   backend role/type design.
4. Later task-list work can implement one-click creation, guidance, and prompt
   provenance without guessing the intended contract.

## Validation

1. Compared the scope, non-goals, and fixed decisions against
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
