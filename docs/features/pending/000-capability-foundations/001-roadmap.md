# Capability Implementation Roadmap

**Status:** proposed  
**Created:** 2026-07-18

## Summary

This roadmap decomposes capability implementation into bounded, phase-specific
plans so implementation can proceed without mixing foundational metadata,
runtime behavior changes, service extraction, and terminology cleanup in a
single uncontrolled stream.

The roadmap implements the ADR set established in:

- [ADR 002](../../../tech/architecture/adrs/2026/07/002-capability-model-and-registry.md)
- [ADR 003](../../../tech/architecture/adrs/2026/07/003-agent-core-vs-capability-services.md)
- [ADR 004](../../../tech/architecture/adrs/2026/07/004-capability-registry-and-tool-exposure-model.md)

The guiding rule is: do not combine service extraction with naming cleanup.

## Child Plans

1. [Capability Foundations](./002-capability-foundations.md)
2. [Capability Resolution And Route Migration](./003-capability-resolution-and-route-migration.md)
3. [Worker Tool Visibility Enforcement](./004-worker-tool-visibility-enforcement.md)
4. [Trading Capability Extraction](./005-trading-capability-extraction.md)
5. [Messaging Capability Extraction](./006-messaging-capability-extraction.md)
6. [Capability Naming Cleanup](./007-capability-naming-cleanup.md)
7. [Cross-Service Capability Execution Design](./008-cross-service-capability-execution-design.md)
8. [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md)
9. [Capability Activation Model](./010-capability-activation-model.md)
10. [Capability Route And Response Migration Manifest](./011-capability-route-and-response-migration-manifest.md)
11. [Shared Capability Taxonomy Revision](./012-shared-capability-taxonomy-revision.md)

## Execution Task List

- [Shared Trading Taxonomy Implementation Tasks](./tasks/001-shared-trading-taxonomy-implementation-tasks.md)

## Historical Context

- [Historical Shared Trading Taxonomy Delta](./archive/002-shared-trading-taxonomy-delta.md) (superseded)
- [Historical Taxonomy Impact Map](./archive/003-taxonomy-impact-map.md)

## Sequence

The intended order is strict:

1. capability foundations
2. capability resolution and canonical route migration
3. worker visibility enforcement
4. `trading` service extraction
5. `messaging` service extraction
6. naming and documentation cleanup

Later phases must not start until the acceptance criteria of earlier phases are
met.

Documents 008 through 012 are active design inputs, not separately implemented
phases. They close the execution, ownership, activation, and route migration
decisions required by phases 002 through 007. The task list under `tasks/`
is the low-level execution surface for the first implementation slice.
Historical transition notes live under `archive/` and are retained only to
explain the taxonomy correction.

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

## Roadmap Invariants

These rules apply across all child plans:

1. `trading` and `messaging` are separate deployable capability services.
2. Runtime binding families such as `trading` and `email` remain compatibility
   layer internals during this rollout.
3. Capability-owned tool calls must converge on one versioned cross-service
   contract.
4. Tool ownership must be exhaustive and machine-readable over
   `AgentToolName`.
5. Capability-owned tool visibility must require both ownership and activation.
6. Provider lifecycle, service health, and tenant readiness are separate
   states.
7. Naming cleanup is not allowed to delay service extraction.

## Phase Gates

### Gate 1: Foundations complete

Required before route migration or worker gating changes:

1. shared registry exists
2. exhaustive ownership manifest exists
3. cross-service capability-tool contract types exist
4. preset or role metadata is separated conceptually from capabilities
5. the registry and ownership data match the normative manifest in document 009

### Gate 2: Capability resolution complete

Required before worker gating changes:

1. shared capability resolver exists
2. canonical capability route IDs exist
3. route alias policy is explicit
4. provider lifecycle enrichment model is explicit
5. activation state follows document 010 and route coverage follows document 011

### Gate 3: Worker gating complete

Required before service extraction:

1. visibility uses ownership plus activation
2. `send_message` remains available only through explicit messaging rules
3. CI validates ownership exhaustiveness
4. activation is resolved from the durable source in document 010

### Gate 4: Trading extraction complete

Required before messaging extraction:

1. Agent Core can invoke capability-owned trading tools through the stable
   abstraction
2. service authentication, idempotency, deadlines, and typed failures are real
3. trading-instance authority is preserved
4. every tool owned by `trading` in document 009 executes through the
   capability service; no partial tool slice qualifies for this gate

### Gate 5: Messaging extraction complete

Required before naming cleanup:

1. `send_message` and `send_email` run through the messaging capability service
2. provider lifecycle and health appear correctly in capability APIs and UI
3. preset handling is aligned in UI surfaces
4. service boundary behavior follows document 008 without an in-process fallback

## Anti-Scope-Creep Rules

1. Do not promote unrelated skill domains into product capabilities during this
   roadmap.
2. Do not rename persisted fields such as `capabilityFamilies` or
   `capabilityMode` before the service extractions are complete.
3. Do not redesign deep trading semantics while extracting the
   `trading` service boundary.
4. Do not split attachments or documents into a separate top-level capability
   during this roadmap.

## Completion Condition

The roadmap is complete only when:

1. product capability metadata is sourced from one shared registry
2. every known agent tool has exactly one validated owner
3. capability-owned tool visibility is gated by ownership and activation
4. canonical public capability routes use product capability IDs, with legacy
   aliases only where explicitly declared
5. `trading` runs through a separate deployable capability service
6. `messaging` runs through a separate deployable capability service
7. runtime families such as `trading` and `email` remain compatibility-layer
   internals rather than durable product identifiers