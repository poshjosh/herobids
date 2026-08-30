# Native Messaging Capability Hardening

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Trading Capability Extraction](./005-trading-capability-extraction.md)
**Normative inputs:** [Native Capabilities And External Backends](./013-native-capabilities-and-external-backends.md), [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md), [Capability Activation Model](./010-capability-activation-model.md)

## Purpose

Harden `messaging` as a native platform capability that coexists cleanly with
external backends, without forcing messaging into the external-backend model.

## Scope

This phase includes:

1. a clear native boundary for messaging-owned tools
2. preservation of implicit platform-inbox messaging and explicit
   provider-backed messaging activation
3. provider lifecycle, platform health, and tenant readiness surfacing for
   messaging
4. UI and API alignment for native messaging terminology

This phase does not include:

1. turning messaging into an external backend
2. separate documents capability creation
3. runtime-family renames
4. broad terminology cleanup outside messaging-related surfaces

## Non-Goals

1. Do not force a deployable external backend for messaging in this phase.
2. Do not create a separate top-level documents capability in this phase.
3. Do not widen cleanup beyond messaging-related surfaces.
4. Do not bypass the shared native activation and visibility rules for
   messaging-owned tools.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this phase after
   [005-trading-capability-extraction.md](./005-trading-capability-extraction.md).
2. [005-trading-capability-extraction.md](./005-trading-capability-extraction.md)
   must first prove coexistence with the first external backend so messaging
   can be hardened without reabsorbing trading semantics.
3. [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md),
   [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md),
   and [010-capability-activation-model.md](./010-capability-activation-model.md)
   remain binding normative inputs for native ownership, activation, and
   readiness semantics.

## Fixed Decisions

1. `messaging` remains a native platform capability. This phase hardens that
   boundary. It does not plan or prepare for messaging extraction.
2. `send_message`, `send_email`, and `publish_artifact` remain
   messaging-owned.
3. `send_message` stays available through the documented implicit
   platform-inbox or brokered path.
4. `send_email` requires explicit messaging activation plus a ready email
   binding.
5. Documents and attachments remain inside messaging rather than becoming a new
   top-level capability.
6. Provider lifecycle support, platform health, and tenant readiness stay
   distinct in API and UI surfaces.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. internal module or package boundaries for native messaging
2. exact UI and API wiring for lifecycle, health, and readiness surfaces
3. internal naming of provider-specific helpers that does not change native
   ownership or route semantics
4. test placement across web, API, worker, and domain packages

## Acceptance Criteria

This phase is complete only when:

1. messaging-owned tools execute through a native messaging boundary rather
   than ad hoc core-owned logic
2. `send_message` still works through the intended implicit native rule
3. `send_email` remains provider-linked and readiness-gated
4. provider lifecycle support is distinguishable from platform health and
   tenant readiness in API and UI surfaces
5. preset or role UI no longer mislabels `personal-assistant` as a capability
6. coexistence with external backends is explicit and no external-backend
   routing assumptions leak into messaging semantics

## Validation

1. add tests covering implicit messaging activation for `send_message` and
   explicit activation plus readiness for `send_email`
2. add UI tests for planned providers being non-actionable
3. add UI and API tests for lifecycle, health, and readiness separation
4. run targeted web, API, worker, and domain tests
5. run `pnpm lint`

## Deliverables

1. a native messaging boundary for:
   - `send_message`
   - `send_email`
   - `publish_artifact`
2. messaging setup and detail surfaces that distinguish:
   - provider lifecycle support
   - platform health
   - tenant or agent readiness
3. preservation of documents and attachments inside messaging
4. preset or role UI alignment so `personal-assistant` is not treated as a
   capability

## Implementation Notes

### Native boundary pattern

1. Messaging may move into its own platform package or module, but the
   platform still owns its business semantics.
2. Messaging extraction is not planned. If a future need arises, it must be
   justified in a new active doc with its own phase gate, not assumed from
   this phase.

### Coexistence rule

1. Messaging and external backends share generic visibility, audit, health,
   and entitlement composition where those concerns are platform-owned.
2. Only external backends use the external invocation contract from document
   008.