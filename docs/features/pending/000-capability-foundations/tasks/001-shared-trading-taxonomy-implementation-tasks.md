# Shared Trading Taxonomy Implementation Tasks

**Status:** ready  
**Created:** 2026-08-29  
**Parent docs:** [Capability Implementation Roadmap](../001-roadmap.md), [Shared Capability Taxonomy Revision](../012-shared-capability-taxonomy-revision.md)

## Purpose

Turn the adopted shared `trading` taxonomy direction into concrete
implementation work for route IDs, activation rows, ownership manifests, and
their immediate contract consumers.

Read this task list after [Capability Implementation Roadmap](../001-roadmap.md)
and [Shared Capability Taxonomy Revision](../012-shared-capability-taxonomy-revision.md).

## Execution Rules

1. Do not reintroduce shared `crypto-trading` capability IDs in code, schemas,
   or public control-plane routes.
2. Treat `/capabilities/trading` as the shared canonical control-plane route.
3. Keep deeper trading taxonomy such as `crypto`, `forex`, and `commodities`
   out of the shared platform types unless a later capability-owned contract
   explicitly needs them.
4. Keep runtime binding family `trading` as an implementation-layer concept,
   separate from shared capability taxonomy.

## Task List

### T1. Introduce shared `trading` capability IDs in domain types

**Status:** `not-started`

Touchpoints:

1. `packages/domain/src/capability-registry.ts`
2. `packages/domain/src/capability-tool-contract.ts`
3. `packages/domain/src/tool-ownership.ts`
4. domain exports that re-export these modules

Work:

1. define `ProductCapabilityId` around `trading | messaging`
2. ensure registry route IDs use `trading` and `messaging`
3. ensure contract schemas validate `capabilityId: 'trading' | 'messaging'`
4. ensure derived ownership views expose `trading`, not `crypto-trading`

Validation:

1. targeted domain tests for registry, ownership, and contract types
2. grep for shared `crypto-trading` literals in `packages/domain`
3. `pnpm lint`

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

1. unit tests for manifest key-set equality with `KNOWN_AGENT_TOOL_NAMES`
2. unit tests for exactly-one ownership
3. `pnpm lint`

### T3. Convert activation schema and persistence to shared `trading`

**Status:** `not-started`

Touchpoints:

1. `packages/db` activation schema and repositories once added
2. migration for `agent_capability_activations`
3. API request validation for capability activation routes
4. worker capability-activation consumers

Work:

1. accept `trading` and `messaging` as the shared durable capability IDs
2. backfill `trading` for existing trading-skill agents instead of
   `crypto-trading`
3. keep messaging activation rules unchanged
4. do not add shared per-market rows for `crypto`, `forex`, or `commodities`

Validation:

1. db migration tests for new and existing agents
2. API tests for activation write and read paths
3. worker tests for activation-gated visibility
4. `pnpm lint`

### T4. Keep shared control-plane routes canonical at `/capabilities/trading`

**Status:** `not-started`

Touchpoints:

1. `apps/api/src/routes/capabilities/trading.ts`
2. capability route registration and resolver wiring in `apps/api/src/routes/capabilities/`
3. `apps/web/src/lib/api-client.ts`
4. route and functional tests under `apps/api/src/__tests__/` and `tests/e2e/`

Work:

1. keep `/capabilities/trading` as the canonical shared capability route
2. do not introduce `/capabilities/crypto-trading` as the shared public route
3. migrate response shape toward `capabilityId: 'trading'` plus
   `runtimeFamily: 'trading'`
4. retain temporary compatibility fields only where explicitly declared

Validation:

1. route tests for canonical trading paths
2. functional tests for trading capability and positions routes
3. web client tests for trading capability consumers
4. grep for `/capabilities/crypto-trading` outside historical docs
5. `pnpm lint`

### T5. Update cross-service trading contract naming

**Status:** `not-started`

Touchpoints:

1. worker capability-invocation client when added
2. trading capability service when added
3. event naming docs and capability audit event publishers
4. operator config schema for capability transport service keys

Work:

1. rename shared contract capability IDs from `crypto-trading` to `trading`
2. rename service event names from `capability.crypto-trading.*` to
   `capability.trading.*`
3. rename transport config service key from `cryptoTrading` to `trading`
4. keep any crypto-specific market classification inside trading-owned payloads
   or internal docs only

Validation:

1. contract schema tests
2. capability invocation integration tests
3. config schema tests
4. `pnpm lint`

### T6. Align worker visibility and API resolver against shared `trading`

**Status:** `not-started`

Touchpoints:

1. `apps/worker/src/runtime-tool-visibility.ts`
2. worker capability resolver or visibility predicate modules when added
3. API shared capability resolver when added

Work:

1. gate trading-owned tools on shared `trading` activation
2. keep `send_message` implicit messaging rule unchanged
3. ensure visibility logic never expects `crypto-trading` as a shared owner or
   activation value

Validation:

1. worker visibility tests
2. API capability resolver tests
3. grep for `crypto-trading` in worker and API implementation modules
4. `pnpm lint`

## Suggested Order

1. T1 shared domain types
2. T2 ownership manifest
3. T3 activation schema and persistence
4. T4 control-plane routes
5. T6 worker visibility and API resolver
6. T5 cross-service contract naming

## Completion Check

This task list is complete only when:

1. shared code and public control-plane routes use `trading`, not
   `crypto-trading`
2. any remaining shared `crypto-trading` mentions in active docs exist only as
   negative migration checks or guardrails, not as live identifiers
3. tests cover routes, activation rows, and ownership manifest semantics
4. `pnpm lint` passes