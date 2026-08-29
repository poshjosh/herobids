# Trading Capability Extraction

**Status:** draft  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Worker Tool Visibility Enforcement](./004-worker-tool-visibility-enforcement.md)
**Normative inputs:** [Cross-Service Capability Execution Design](./008-cross-service-capability-execution-design.md), [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md)

## Purpose

Extract `trading` as the first separate deployable capability service
without renaming runtime binding families or redesigning trading-instance
authority.

## Scope

This phase includes:

1. service boundary for `trading`
2. branch-by-abstraction for trading tool invocation
3. first real use of the cross-service capability-tool contract
4. preservation of trading-instance authority

This phase does not include:

1. messaging extraction
2. global terminology cleanup
3. runtime-family renames

## Non-Goals

1. Do not extract the messaging capability in this phase.
2. Do not use this phase for broad terminology cleanup.
3. Do not rename runtime binding families into product capability IDs.
4. Do not treat a partial first-tool migration as complete trading extraction.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this phase after
   [004-worker-tool-visibility-enforcement.md](./004-worker-tool-visibility-enforcement.md).
2. [004-worker-tool-visibility-enforcement.md](./004-worker-tool-visibility-enforcement.md)
   must first harden ownership and activation behavior before cross-service
   extraction starts.
3. [008-cross-service-capability-execution-design.md](./008-cross-service-capability-execution-design.md)
   and [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md)
   remain binding normative inputs for the invocation boundary and tool
   coverage.

## Fixed Decisions

1. `trading` remains the shared product capability ID for this phase.
2. Runtime binding family `trading` remains an internal compatibility layer.
3. Trading-owned tools must execute through the shared invocation contract once
   extraction is complete.
4. Trading-instance authority remains intact behind the capability service.
5. Completion requires full trading-tool coverage from document 009, not a
   partial slice.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact abstraction boundary inside Agent Core for trading invocation
2. service packaging, adapter boundaries, and internal request plumbing
3. authentication and idempotency helper layout that still satisfies the shared
   contract
4. test placement across trading, worker, API, and integration suites

## Acceptance Criteria

This phase is complete only when:

1. `trading` runs as a separate deployable service
2. Agent Core no longer directly imports capability-specific trading
   implementation modules for the extracted tool slice
3. extracted trading tools execute through the shared invocation contract
4. idempotency behavior is defined and verified for side-effecting calls
5. typed failures, deadlines, and authentication are enforced at the boundary
6. trading-instance authority remains unchanged from a business-ownership
   perspective
7. every tool owned by `trading` in document 009 executes through the
   service; a partial first-tool slice is not complete extraction

## Validation

1. add integration tests for authenticated cross-service invocation of every
   trading-owned tool category
2. add retry and idempotency tests for every side-effecting trading tool,
   including `submit_decision` and bot/watch lifecycle tools
3. add failure-mode tests required by document 008
4. run targeted trading, API, worker, and domain tests
5. run `pnpm lint`
6. validate local or staging compose wiring for the new service

## Deliverables

1. a deployable `trading` capability service
2. an Agent Core abstraction for capability-owned trading tool invocation
3. service-backed implementations for every tool owned by `trading` in
   document 009, including decision execution, bots, account and risk
   inspection, market data, and price-watch lifecycle
4. service authentication and authorization at the boundary
5. idempotency, deadlines, and typed failures enforced through the contract

## Implementation Notes

### Extraction pattern

Use branch-by-abstraction and the HTTP invocation contract in document 008:

1. define a capability-tool invocation abstraction in Agent Core
2. keep the current in-process implementation behind that abstraction first
3. add the service-backed `trading` implementation behind the same
   abstraction
4. switch callers to the abstraction
5. remove direct in-process trading imports only after service-backed behavior
   is verified

### Boundary constraints

1. `trading` remains the shared product capability ID
2. runtime binding family `trading` remains an internal compatibility layer
3. deeper trading market taxonomy remains capability-owned rather than part of
   shared platform vocabulary
4. trading-instance authority remains intact behind the capability service