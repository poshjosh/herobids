# Capability Foundations

**Status:** proposed  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)

## Purpose

Create the shared metadata and contract foundation required by the ADR set
without changing runtime behavior or extracting services yet.

## Scope

This phase includes:

1. shared capability registry metadata
2. exhaustive tool ownership metadata
3. shared capability-tool contract types
4. preset or role metadata separation
5. compatibility clarifications around `capabilityFamilies`

This phase does not include:

1. worker tool visibility behavior changes
2. public route migration
3. capability service extraction
4. naming cleanup of legacy persisted fields

## Deliverables

1. `packages/domain/src/capability-registry.ts`
2. `packages/domain/src/tool-ownership.ts`
3. `packages/domain/src/capability-tool-contract.ts`
4. `packages/domain/src/agent-presets.ts` or equivalent
5. domain exports for the above
6. comments or helper names clarifying that `capabilityFamilies` means runtime
   binding requirements, not product capability membership

## Implementation Notes

### Registry

The registry must include at least:

1. `ProductCapabilityId`
2. canonical `publicRouteId`
3. optional legacy route aliases
4. capability activation metadata
5. capability family and provider metadata
6. provider lifecycle metadata
7. runtime binding-family mapping metadata

### Ownership

Ownership must be exhaustive over `AgentToolName` with exactly one of:

1. `core`
2. `general`
3. `capability` with one `ProductCapabilityId`

### Contract types

The shared contract types must cover:

1. versioning
2. request, correlation, and idempotency identifiers
3. tenant, agent, session, and actor identity
4. deadlines and retry semantics
5. typed success payloads
6. typed failure payloads

## Acceptance Criteria

This phase is complete only when:

1. the registry compiles and exports the canonical capability metadata for
   `crypto-trading` and `messaging`
2. the ownership manifest is exhaustive over `KNOWN_AGENT_TOOL_NAMES`
3. unknown tool names are rejected by tests or validation helpers
4. the shared capability-tool contract types compile and are usable by both
   Agent Core and future capability services
5. no runtime behavior has changed yet

## Validation And Verification

1. add unit tests for registry structure, route IDs and aliases, provider
   lifecycle fields, and runtime-family mappings
2. add unit tests for ownership completeness and exactly-one ownership
3. add compile-level tests or type assertions for the capability-tool contract
4. run targeted domain tests
5. run `pnpm lint`

## Extraction Pattern

This phase prepares branch-by-abstraction but does not switch implementations
yet.

## Out Of Scope

1. API behavior changes
2. worker visibility gating
3. separate deployable capability services
4. route migration