# Worker Tool Visibility Enforcement

**Status:** proposed  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Depends on:** [Capability Resolution And Route Migration](./003-capability-resolution-and-route-migration.md)

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

## Acceptance Criteria

This phase is complete only when:

1. capability-owned tools do not become visible solely because a skill listed
   them
2. capability-owned tools become visible only when ownership and activation are
   satisfied
3. `send_message` still works through the intended implicit messaging rule
4. `send_email` stays correctly gated by readiness
5. ownership CI checks fail on missing, duplicate, or unknown ownership entries

## Validation And Verification

1. add worker tests for ownership plus activation visibility rules
2. add tests covering implicit messaging activation for `send_message`
3. add tests covering `send_email` gating
4. add CI or unit validation for exhaustive ownership over
   `KNOWN_AGENT_TOOL_NAMES`
5. run targeted worker and domain tests
6. run `pnpm lint`

## Extraction Pattern

No service extraction happens here. This phase hardens the in-process runtime
behavior before branch-by-abstraction is used for service boundaries.

## Out Of Scope

1. deployable capability services
2. public route removal
3. legacy field renames