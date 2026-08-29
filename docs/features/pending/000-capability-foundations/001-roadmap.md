# Capability Implementation Roadmap

**Status:** ready  
**Created:** 2026-07-18  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)  
**Normative inputs:** [ADR 002](../../../tech/architecture/adrs/2026/07/002-capability-model-and-registry.md), [ADR 003](../../../tech/architecture/adrs/2026/07/003-agent-core-vs-capability-services.md), [ADR 004](../../../tech/architecture/adrs/2026/07/004-capability-registry-and-tool-exposure-model.md)

## Purpose

Decompose capability implementation into bounded, phase-specific docs so the
platform can establish shared capability metadata, route resolution, worker
gating, and service extraction without mixing those concerns into one
uncontrolled stream.

## Scope

This roadmap includes:

1. the ordered executable phases for capability foundations through naming
   cleanup
2. the active supporting references and the first ready low-level slice inside
   this feature
3. the phase gates, extraction strategy, and cross-phase invariants that keep
   implementation order stable

This roadmap does not include:

1. direct product-code changes
2. unrelated new top-level capabilities during this rollout
3. renaming persisted fields before service extraction is complete
4. treating historical notes as active implementation authority

## Non-Goals

1. Do not combine service extraction with naming cleanup.
2. Do not promote unrelated skill domains into product capabilities during this
   roadmap.
3. Do not redesign deep trading semantics while extracting the `trading`
   service boundary.
4. Do not split attachments or documents into a separate top-level capability
   during this roadmap.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   fixes this feature's place in the staged program.
2. [ADR 002](../../../tech/architecture/adrs/2026/07/002-capability-model-and-registry.md),
   [ADR 003](../../../tech/architecture/adrs/2026/07/003-agent-core-vs-capability-services.md),
   and [ADR 004](../../../tech/architecture/adrs/2026/07/004-capability-registry-and-tool-exposure-model.md)
   fix the architecture boundary this roadmap implements.
3. The first executable slice in this feature is controlled by
   [012-shared-capability-taxonomy-revision.md](./012-shared-capability-taxonomy-revision.md)
   and [tasks/001-shared-trading-taxonomy-implementation-tasks.md](./tasks/001-shared-trading-taxonomy-implementation-tasks.md).
4. Documents 008 through 011 remain background supporting references for later
   phase detail, but they are not part of the readiness gate for entering the
   first slice.

## Fixed Decisions

1. `trading` and `messaging` are separate deployable capability services.
2. Runtime binding families such as `trading` and `email` remain
   compatibility-layer internals during this rollout.
3. Capability-owned tool calls must converge on one versioned cross-service
   contract.
4. Tool ownership must be exhaustive and machine-readable over
   `AgentToolName`.
5. Capability-owned tool visibility must require both ownership and activation.
6. Provider lifecycle, service health, and tenant readiness are separate
   states.
7. Naming cleanup is not allowed to delay service extraction.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. helper and module boundaries inside each executable phase
2. the exact order of local subtasks inside one phase or task list
3. whether a supporting design reference is consulted directly or summarized in
   the active task list, as long as the controlling ready docs stay unchanged
4. compatibility-field mechanics that preserve the documented canonical routes
   and identifiers

Implementation may not use open latitude to reorder phases, reopen shared
identifiers, or promote a supporting reference into a controlling doc silently.

## Child Docs And Sequence

Executable phases:

1. [002-capability-foundations.md](./002-capability-foundations.md)
2. [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md)
3. [004-worker-tool-visibility-enforcement.md](./004-worker-tool-visibility-enforcement.md)
4. [005-trading-capability-extraction.md](./005-trading-capability-extraction.md)
5. [006-messaging-capability-extraction.md](./006-messaging-capability-extraction.md)
6. [007-capability-naming-cleanup.md](./007-capability-naming-cleanup.md)

Supporting references for later phase detail:

7. [008-cross-service-capability-execution-design.md](./008-cross-service-capability-execution-design.md)
8. [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md)
9. [010-capability-activation-model.md](./010-capability-activation-model.md)
10. [011-capability-route-and-response-migration-manifest.md](./011-capability-route-and-response-migration-manifest.md)

First ready implementation slice:

11. [012-shared-capability-taxonomy-revision.md](./012-shared-capability-taxonomy-revision.md)
12. [tasks/001-shared-trading-taxonomy-implementation-tasks.md](./tasks/001-shared-trading-taxonomy-implementation-tasks.md)

Historical context only:

13. [archive/002-shared-trading-taxonomy-delta.md](./archive/002-shared-trading-taxonomy-delta.md)
14. [archive/003-taxonomy-impact-map.md](./archive/003-taxonomy-impact-map.md)

## Acceptance Criteria

This roadmap is fit for implementation handoff only when:

1. the ordered executable phases are explicit and do not mix with historical
   context
2. the first executable slice is explicit and controlled by docs marked ready
3. the cross-phase invariants and gates prevent route migration, worker gating,
   or service extraction from starting out of order
4. the active path distinguishes controlling docs, supporting references, and
   historical docs clearly enough for a spec-based implementation agent to
   follow without guessing
5. the completion condition for the overall capability program remains explicit

## Validation

1. the folder guide in [000-README.md](./000-README.md) points to the same
   first executable slice and classifies historical material consistently
2. the playbook in
   [../000-program/003-spec-agent-playbook.md](../000-program/003-spec-agent-playbook.md)
   routes an implementation agent through the same current path
3. the first task list in `tasks/` names only ready controlling docs as
   parents and does not require 008 through 011 to enter the slice
4. no historical or superseded docs remain on the default implementation path

## Extraction Strategy

Two extraction patterns are mandatory in this roadmap:

1. **Branch-by-abstraction** for capability service extraction.
   Agent Core must call a stable abstraction first, then switch the backing
   implementation from in-process logic to a separate capability service.
2. **Strangler-fig migration** at public route boundaries.
   Canonical product routes such as `/capabilities/trading` and
   `/capabilities/messaging` are established first. Compatibility fields or
   temporary aliases are used only where explicitly declared, and are removed
   only after callers migrate.

## Phase Gates

### Gate 1: Foundations complete

Required before route migration or worker gating changes:

1. shared registry exists
2. exhaustive ownership manifest exists
3. cross-service capability-tool contract types exist
4. preset or role metadata is separated conceptually from capabilities
5. the registry and ownership data match the supporting reference in document
   009

### Gate 2: Capability resolution complete

Required before worker gating changes:

1. shared capability resolver exists
2. canonical capability route IDs exist
3. route alias policy is explicit
4. provider lifecycle enrichment model is explicit
5. activation state follows the supporting reference in document 010 and route
   coverage follows the supporting reference in document 011

### Gate 3: Worker gating complete

Required before service extraction:

1. visibility uses ownership plus activation
2. `send_message` remains available only through explicit messaging rules
3. CI validates ownership exhaustiveness
4. activation is resolved from the durable source described in document 010

### Gate 4: Trading extraction complete

Required before messaging extraction:

1. Agent Core can invoke capability-owned trading tools through the stable
   abstraction
2. service authentication, idempotency, deadlines, and typed failures are real
3. trading-instance authority is preserved
4. every tool owned by `trading` in supporting reference 009 executes through
   the capability service

### Gate 5: Messaging extraction complete

Required before naming cleanup:

1. `send_message` and `send_email` run through the messaging capability service
2. provider lifecycle and health appear correctly in capability APIs and UI
3. preset handling is aligned in UI surfaces
4. service boundary behavior follows supporting reference 008 without an
   in-process fallback

## Completion Condition

The roadmap's governed capability rollout is complete only when:

1. product capability metadata is sourced from one shared registry
2. every known agent tool has exactly one validated owner
3. capability-owned tool visibility is gated by ownership and activation
4. canonical public capability routes use product capability IDs, with legacy
   aliases only where explicitly declared
5. `trading` runs through a separate deployable capability service
6. `messaging` runs through a separate deployable capability service
7. runtime families such as `trading` and `email` remain compatibility-layer
   internals rather than durable product identifiers