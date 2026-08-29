# Shared Trading Taxonomy Implementation Tasks

**Status:** superseded
**Created:** 2026-08-29  
**Parent docs:** [Capability Implementation Roadmap](../001-roadmap.md), [Shared Capability Taxonomy Revision](../012-shared-capability-taxonomy-revision.md)

This task list is superseded by
[002-external-backend-boundary-implementation-tasks.md](./002-external-backend-boundary-implementation-tasks.md),
which defines the current repo-local external-backend boundary work.

## Purpose

Turn the adopted shared `trading` taxonomy direction into concrete
implementation work for shared domain metadata, ownership manifests, and the
foundational contract surfaces that belong to the first Capability
Foundations slice.

Read this task list after [Capability Implementation Roadmap](../001-roadmap.md)
and [Shared Capability Taxonomy Revision](../012-shared-capability-taxonomy-revision.md).

## Execution Rules

1. Do not reintroduce shared `crypto-trading` capability IDs in shared domain
   code, schemas, or ownership metadata.
2. Treat `/capabilities/trading` only as canonical registry metadata in this
   slice. Actual API route migration belongs to
   [../003-capability-resolution-and-route-migration.md](../003-capability-resolution-and-route-migration.md).
3. Keep deeper trading taxonomy such as `crypto`, `forex`, and `commodities`
   out of the shared platform types unless a later capability-owned contract
   explicitly needs them.
4. Keep runtime binding family `trading` as an implementation-layer concept,
   separate from shared capability taxonomy.
5. Defer activation persistence, worker visibility gating, public route
   migration, and service-backed invocation naming to their later phase docs.

## Task List

### T1. Introduce shared `trading` capability IDs in domain metadata

**Status:** `not-started`

Touchpoints:

1. `packages/domain/src/capability-registry.ts`
2. `packages/domain/src/capability-tool-contract.ts`
3. domain exports that re-export these modules

Work:

1. define `ProductCapabilityId` around `trading | messaging`
2. ensure registry metadata uses `trading` and `messaging` as the shared
   capability IDs, including canonical route metadata declarations
3. ensure contract schemas validate `capabilityId: 'trading' | 'messaging'`
4. ensure shared domain surfaces do not expose `crypto-trading` as a shared
   capability ID

Validation:

1. add or update `packages/domain/src/capability-registry.test.ts` and
   `packages/domain/src/capability-tool-contract.test.ts`
2. run `pnpm test -- packages/domain/src/capability-registry.test.ts packages/domain/src/capability-tool-contract.test.ts`
3. run `rg -n "crypto-trading" packages/domain/src/capability-registry.ts packages/domain/src/capability-tool-contract.ts`
4. run `pnpm lint`

### T2. Convert ownership manifest to shared `trading`

**Status:** `not-started`

Touchpoints:

1. `packages/domain/src/tool-ownership.ts`
2. `packages/domain/src/tools.ts`
3. ownership or catalog tests in `packages/domain/src/*.test.ts`

Work:

1. encode all currently trading-owned tools under shared owner `trading`
2. keep messaging-owned, core-owned, and general-owned tools unchanged
3. make ownership tests assert that no manifest entry uses `crypto-trading`
4. fail loudly on missing or unknown tool keys

Validation:

1. add or update `packages/domain/src/tool-ownership.test.ts`
2. run `pnpm test -- packages/domain/src/tool-ownership.test.ts`
3. run `rg -n "crypto-trading" packages/domain/src/tool-ownership.ts`
4. run `pnpm lint`

### T3. Clarify foundational capability metadata boundaries

**Status:** `not-started`

Touchpoints:

1. `packages/domain/src/capability-registry.ts`
2. `packages/domain/src/agent-presets.ts` or equivalent
3. domain tests covering capability metadata and preset separation

Work:

1. keep shared capability membership separate from preset or role metadata
2. document and test that runtime binding families remain implementation-layer
   requirements rather than shared product capability membership
3. keep deeper trading classification out of shared capability metadata
4. fail loudly if new shared metadata attempts to add `segment`, `market`, or
   similar universal layers without a later active doc

Validation:

1. add or update `packages/domain/src/config/presets.test.ts` and any domain
   metadata test that covers capability registry separation
2. run `pnpm test -- packages/domain/src/config/presets.test.ts`
3. run `rg -n "\\b(segment|market)\\b" packages/domain/src/capability-registry.ts packages/domain/src/agent-presets.ts`
4. run `rg -n "crypto-trading" packages/domain/src/capability-registry.ts packages/domain/src/agent-presets.ts packages/domain/src/tool-ownership.ts`
5. run `pnpm lint`

## Stop And Escalate

Stop and escalate instead of widening this task list when any of the following
becomes necessary:

1. activation persistence or durable capability-activation rows
2. public API route registration, response migration, or web client route work
3. worker visibility gating or capability-resolution behavior outside shared
   domain metadata
4. service-backed invocation clients, event naming, or transport config wiring
5. any change that would add a shared universal market layer or reintroduce
   `crypto-trading` as a shared capability ID

## Suggested Order

1. T1 shared domain types
2. T2 ownership manifest
3. T3 foundational capability metadata boundaries

## Completion Check

This task list is complete only when:

1. shared domain metadata, foundational contract types, and ownership manifests
   use `trading`, not `crypto-trading`
2. any remaining shared `crypto-trading` mentions in active docs or code exist
   only as negative guardrail checks or historical references, not as live
   shared identifiers
3. tests cover registry, ownership, and foundational contract semantics
4. `pnpm lint` passes