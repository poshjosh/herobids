# Worker Tool Visibility Enforcement

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Capability Resolution And Route Migration](./003-capability-resolution-and-route-migration.md)
**Normative inputs:** [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md), [Capability Activation Model](./010-capability-activation-model.md)

## Purpose

Make worker tool visibility obey ownership and activation rules instead of
deriving effective visibility from skill membership alone.

## Scope

This phase includes:

1. ownership-aware visibility
2. capability-activation-aware visibility
3. preservation of the intended base `send_message` behavior
4. CI validation for exhaustive ownership

This phase does not include:

1. capability service extraction
2. naming cleanup
3. public route redesign

## Non-Goals

1. Do not extract deployable capability services in this phase.
2. Do not use this phase for naming cleanup.
3. Do not redesign public capability routes here.
4. Do not let resolved skill membership alone control final tool visibility.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this phase after
   [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md).
2. [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md)
   must first establish canonical capability resolution and activation inputs.
3. [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md)
   and [010-capability-activation-model.md](./010-capability-activation-model.md)
   remain binding normative inputs for ownership exhaustiveness and activation
   behavior.

## Fixed Decisions

1. Capability-owned tool visibility requires both ownership and activation.
2. `send_message` remains messaging-owned, not core-owned, and is available
   through the documented implicit brokered-messaging path.
3. `send_email` remains readiness-gated through the messaging capability.
4. Resolved skills remain an input to visibility, not the final authority.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact worker predicate structure for ownership and activation checks
2. where ownership validation runs in CI or unit-test surfaces
3. internal helper names and module layout for activation snapshots
4. test placement across worker and domain packages

## Acceptance Criteria

This phase is complete only when:

1. capability-owned tools do not become visible solely because a skill listed
   them
2. capability-owned tools become visible only when ownership and activation are
   satisfied
3. `send_message` still works through the intended implicit messaging rule
4. `send_email` stays correctly gated by readiness
5. ownership CI checks fail on missing, duplicate, or unknown ownership entries
6. all current tools use the exact ownership classifications in document 009

## Validation

1. add worker tests for ownership plus activation visibility rules
2. add tests covering implicit messaging activation for `send_message`
3. add tests covering `send_email` gating
4. add CI or unit validation for exhaustive ownership over
   `KNOWN_AGENT_TOOL_NAMES`
5. run targeted worker and domain tests
6. run `pnpm lint`

## Deliverables

1. worker visibility logic that requires:
   - a known tool
   - exactly one owner
   - active owning capability when capability-owned
   - readiness and degradation eligibility
2. preservation of `send_message` through implicitly active brokered messaging
3. `send_email` gated by provider-linked messaging readiness
4. CI checks for ownership completeness and exactly-one ownership

## Implementation Notes

### Messaging nuance

`send_message` must not be treated as a core-owned tool. It remains
messaging-owned, but is available through the base skill because the brokered
platform path makes messaging implicitly active.

### Worker behavior rule

Resolved skills remain inputs, not the final authority. A skill requesting a
tool is necessary but not sufficient for final visibility.

Implement the complete visibility predicate in document 010. In particular,
the worker must consume an activation snapshot; it must not infer product
capability activation from `capabilityMode`, `capabilityFamilies`, a connection,
or an old per-tool sandbox grant.

## Extraction Pattern

No service extraction happens here. This phase hardens the in-process runtime
behavior before branch-by-abstraction is used for service boundaries.