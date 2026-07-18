# Crypto-Trading Capability Extraction

**Status:** proposed  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Depends on:** [Worker Tool Visibility Enforcement](./004-worker-tool-visibility-enforcement.md)

## Purpose

Extract `crypto-trading` as the first separate deployable capability service
without renaming runtime binding families or redesigning trading-instance
authority.

## Scope

This phase includes:

1. service boundary for `crypto-trading`
2. branch-by-abstraction for trading tool invocation
3. first real use of the cross-service capability-tool contract
4. preservation of trading-instance authority

This phase does not include:

1. messaging extraction
2. global terminology cleanup
3. runtime-family renames

## Deliverables

1. a deployable `crypto-trading` capability service
2. an Agent Core abstraction for capability-owned trading tool invocation
3. service-backed implementations for the first tool slice, starting with:
   - `submit_decision`
   - `find_instrument`
   - trading inspection tools only if required for the slice
4. service authentication and authorization at the boundary
5. idempotency, deadlines, and typed failures enforced through the contract

## Implementation Notes

### Extraction pattern

Use branch-by-abstraction:

1. define a capability-tool invocation abstraction in Agent Core
2. keep the current in-process implementation behind that abstraction first
3. add the service-backed `crypto-trading` implementation behind the same
   abstraction
4. switch callers to the abstraction
5. remove direct in-process trading imports only after service-backed behavior
   is verified

### Boundary constraints

1. `crypto-trading` remains the product capability ID
2. runtime binding family `trading` remains an internal compatibility layer
3. trading-instance authority remains intact behind the capability service

## Acceptance Criteria

This phase is complete only when:

1. `crypto-trading` runs as a separate deployable service
2. Agent Core no longer directly imports capability-specific trading
   implementation modules for the extracted tool slice
3. extracted trading tools execute through the shared invocation contract
4. idempotency behavior is defined and verified for side-effecting calls
5. typed failures, deadlines, and authentication are enforced at the boundary
6. trading-instance authority remains unchanged from a business-ownership
   perspective

## Validation And Verification

1. add integration tests for authenticated cross-service trading tool
   invocation
2. add retry and idempotency tests for `submit_decision`
3. add failure-mode tests for timeout, authorization, validation, and
   precondition cases
4. run targeted trading, API, worker, and domain tests
5. run `pnpm lint`
6. validate local or staging compose wiring for the new service

## Out Of Scope

1. messaging capability service extraction
2. deep trading-engine redesign
3. renaming `trading` runtime families to `crypto-trading`