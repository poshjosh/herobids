# Worker Tool Visibility Enforcement

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Capability Resolution And Route Migration](./003-capability-resolution-and-route-migration.md)
**Normative inputs:** [Native Capabilities And External Backends](./013-native-capabilities-and-external-backends.md), [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md), [Capability Activation Model](./010-capability-activation-model.md)

## Purpose

Make worker tool visibility obey ownership, native-capability activation, and
external-backend registration and health rules instead of deriving effective
visibility from skill membership alone.

## Scope

This phase includes:

1. ownership-aware visibility across `core`, `general`, native-capability, and
   external-backend owners
2. native-capability-activation-aware visibility
3. external-backend registration, auth or entitlement, health, and readiness
   gating
4. preservation of the intended base `send_message` behavior
5. CI validation for exhaustive ownership

This phase does not include:

1. creation of new external backends beyond consuming registry state
2. terminology cleanup
3. public route redesign
4. domain-specific readiness logic in platform core

## Non-Goals

1. Do not let resolved skill membership alone control final tool visibility.
2. Do not create an agent capability activation row for an external backend.
3. Do not reimplement trading-specific provider or policy rules inside worker
   visibility.
4. Do not widen public route work here.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this phase after
   [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md).
2. [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md)
   must first establish canonical control-plane resolution and activation
   inputs.
3. [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
   fixes the owner kinds and platform-core boundary this phase must respect.
4. [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md)
   and [010-capability-activation-model.md](./010-capability-activation-model.md)
   remain binding normative inputs for ownership exhaustiveness and activation
   behavior.

## Fixed Decisions

1. Every tool has exactly one owner: `core`, `general`, a native capability, or
   an external backend.
2. Native-capability-owned tool visibility requires ownership, requested-tool
   membership, and native activation or native readiness as defined in document
   010.
3. External-backend-owned tool visibility requires ownership, requested-tool
   membership, backend registration, auth or entitlement presence, backend
   health, and generic readiness signals. It does not use a native activation
   row.
4. `send_message` and `publish_artifact` remain native messaging-owned and
   available through the documented implicit platform-inbox path.
5. `send_email` remains native messaging-owned and readiness-gated through
   explicit messaging activation plus provider readiness.
6. Resolved skills remain an input to visibility, not the final authority.
7. Worker visibility composes from already-resolved native activation and
   external-backend dispatchability state; it does not redefine those states.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact worker predicate structure for ownership and state checks
2. where ownership validation runs in CI or unit-test surfaces
3. internal helper names and module layout for activation and backend-state
   snapshots
4. test placement across worker and domain packages

## Acceptance Criteria

This phase is complete only when:

1. tools do not become visible solely because a skill listed them
2. native-capability-owned tools become visible only when ownership,
   activation, and readiness are satisfied
3. external-backend-owned tools become visible only when ownership, backend
   registration, auth or entitlement presence, health, and readiness are
   satisfied
4. `send_message` still works through the intended implicit native messaging
   rule
5. `send_email` stays correctly gated by readiness
6. ownership CI checks fail on missing, duplicate, or unknown ownership entries
7. all current tools use the exact ownership classifications in document 009

## Validation

1. add worker tests for ownership plus native-activation visibility rules
2. add worker tests for external-backend registration, auth or entitlement,
   health, and readiness gating
3. add tests covering implicit messaging activation for `send_message`
4. add tests covering `send_email` gating
5. add CI or unit validation for exhaustive ownership over
   `KNOWN_AGENT_TOOL_NAMES`
6. run targeted worker and domain tests
7. run `pnpm lint`

## Deliverables

1. worker visibility logic that requires:
   - a known tool
   - exactly one owner
   - requested by the baseline or a resolved skill
   - owner state satisfied
   - readiness and degradation eligibility
2. preservation of `send_message` through implicitly active native messaging
3. `send_email` gated by provider-linked native messaging readiness
4. generic external-backend health and readiness gating
5. CI checks for ownership completeness and exactly-one ownership

## Implementation Notes

### External backend nuance

1. Worker may consume only generic backend state such as registration,
   configured auth, entitlement presence, health, and backend-declared
   readiness summary.
2. If trading needs richer provider or persistence reasoning, that reasoning
   stays in the external backend and returns to the worker only as generic
   availability data.

### Worker behavior rule

Resolved skills remain inputs, not the final authority. A skill requesting a
tool is necessary but not sufficient for final visibility.

Implement the complete visibility predicate in document 010. In particular,
the worker must consume native activation snapshots and external-backend state;
it must not infer either from `capabilityMode`, `capabilityFamilies`, a
connection alone, or an old per-tool sandbox grant.

For external backends, the worker consumes generic registration, entitlement,
health, and readiness state. A resolved skill must not be treated as if it were
backend registration.

## Extraction Pattern

No external-backend creation happens here. This phase hardens in-process
visibility behavior before external-backend dispatch is widened.