# Unified Skill Discoverability

**Status:** ready  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Make skill discovery part of the default agent surface so agents can discover
both platform skills and external skills without first being told about a
separate skill-management flow.

## Scope

This doc includes:

1. a base-skill `search_skills` discovery tool that combines local catalog and
   skills.sh search
2. discovery hints and derived dependency surfacing across skill responses and
   API views
3. fixed rules for external discovery, dependency inference, and graceful
   degradation

This doc does not include:

1. a Herobids-managed external skill registry or mirrored catalog
2. automatic installation of external skills
3. silent dependency auto-resolution
4. product-code implementation in this documentation step

## Non-Goals

1. Do not turn discovery into arbitrary command execution.
2. Do not persist `dependsOn` data when it can be derived from tool ownership.
3. Do not fail the whole tool call when the external discovery arm is
   unavailable.
4. Do not blur the line between discovering a skill and installing or using
   it.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after capability foundations and before blank-slate
   agents.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to stay as one canonical overview rather than a
   feature-internal roadmap.
3. [001-plan.md](../../2026/08/29/001-unified-skill-discoverability/001-plan.md)
   is the legacy implementation-ready source for the discovery contract and
   dependency-surfacing rules.
4. This feature depends on capability foundations because tool ownership and
   capability visibility must already be authoritative before discovery results
   can be trusted.

## Fixed Decisions

1. Base-skill agents must be able to discover external skills without already
   having the programming skill.
2. External discovery uses the standard skills.sh search flow directly rather
   than a Herobids-maintained external registry.
3. Discovery and installation remain separate actions.
4. The external search arm runs as a fixed-purpose subprocess with sanitized
   argv, non-interactive execution, and bounded output.
5. Derived skill dependencies are computed at read time from tool ownership and
   must surface consistently across worker and API responses.
6. Missing dependencies are reported; they are not auto-assigned.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact response shape used to label local versus external results
2. the exact timeout, output limit, and note text for best-effort external
   discovery failures
3. the exact helper boundaries used for ownership precedence and derived
   dependency inference

## Acceptance Criteria

1. Agents on BASE_SKILL can discover both platform and external skills through
   one documented path.
2. Skill responses and API skill views surface derived dependency information
   from tool ownership without persisting redundant dependency fields.
3. External discovery failures degrade to local results plus an explicit note
   instead of failing the whole call.
4. The feature remains bounded to discovery and dependency surfacing rather
   than installation automation.

## Validation

1. Compared the scope, fixed decisions, and acceptance boundaries against
   [../../2026/08/29/001-unified-skill-discoverability/001-plan.md](../../2026/08/29/001-unified-skill-discoverability/001-plan.md).
2. Confirmed the feature shape and dependency position against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
