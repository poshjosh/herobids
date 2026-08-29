# First Repo-Local External Trading Backend

**Status:** draft  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Worker Tool Visibility Enforcement](./004-worker-tool-visibility-enforcement.md)
**Normative inputs:** [Native Capabilities And External Backends](./013-native-capabilities-and-external-backends.md), [Cross-Service Capability Execution Design](./008-cross-service-capability-execution-design.md), [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md)

## Purpose

Establish `trading` as the first repo-local external backend, expected to live
under `externals/trading`, while treating it everywhere else in the platform as
an external service from day one.

## Scope

This phase includes:

1. the first repo-local external backend boundary for `trading`
2. transport-only platform adapters for trading-owned tool invocation
3. strict no-direct-import enforcement for the repo-local boundary
4. preservation of trading domain authority inside the external backend
5. consolidation and hardening of the bootstrap boundary work introduced by
   the current ready slice

This phase does not include:

1. native messaging hardening
2. global terminology cleanup
3. runtime-family renames
4. mandatory skill or MCP packaging before direct API integration works

## Non-Goals

1. Do not model trading as a native platform capability.
2. Do not allow repo-local placement to justify direct imports into
   `apps/api`, `apps/worker`, `apps/web`, or shared platform packages.
3. Do not block on skills or MCP before direct API integration works.
4. Do not treat a partial first-tool migration as complete trading extraction.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this phase after
   [004-worker-tool-visibility-enforcement.md](./004-worker-tool-visibility-enforcement.md).
2. [004-worker-tool-visibility-enforcement.md](./004-worker-tool-visibility-enforcement.md)
   must first harden ownership and state behavior before full platform cutover
   and full tool-coverage completion are declared for external-backend
   extraction.
3. [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
   fixes the external boundary model this phase must implement.
4. [008-cross-service-capability-execution-design.md](./008-cross-service-capability-execution-design.md)
   and [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md)
   remain binding normative inputs for the invocation boundary and tool
   coverage.
5. [tasks/002-external-backend-boundary-implementation-tasks.md](./tasks/002-external-backend-boundary-implementation-tasks.md)
   is the current bootstrap path for this boundary. This phase consolidates and
   completes that work after the generic platform prerequisites are in place.

## Fixed Decisions

1. `trading` is the first external backend `backendId`, not a native
   capability ID.
2. The preferred intermediate runtime lives under `externals/trading/`.
3. Platform code may share only transport DTOs, auth helpers, generic retry or
   deadline utilities, health or readiness envelopes, and audit envelopes.
4. All platform interaction crosses the external-backend contract by direct API
   first.
5. Domain-specific policy, persistence semantics, provider rules, and tool
   meaning remain inside the external backend.
6. Completion requires full tool coverage for every tool owned by
   `external:trading` in document 009.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact adapter boundary inside platform-core dispatch for trading
   invocation
2. external service packaging, internal request plumbing, and compose wiring
3. authentication and idempotency helper layout that still satisfies the
   shared contract
4. test placement across trading, worker, API, and integration suites

## Acceptance Criteria

This phase is complete only when:

1. `trading` runs as a separate repo-local external backend with its own
   health endpoints
2. platform-core code no longer directly imports implementation modules from
   `externals/trading/`
3. trading-owned tools execute through the shared external-backend invocation
   contract
4. idempotency behavior is defined and verified for side-effecting calls
5. typed failures, deadlines, and authentication are enforced at the boundary
6. the configured trading backend base URL can move off-repo without semantic
   rewrites in platform-core code
7. every tool owned by `external:trading` in document 009 executes through the
   boundary; a partial first-tool slice is not complete extraction

## Validation

1. add integration tests for authenticated external-backend invocation of every
   trading-owned tool category
2. add retry and idempotency tests for every side-effecting trading tool,
   including `submit_decision` and bot or watch lifecycle tools
3. add failure-mode tests required by document 008
4. run repository checks that fail on direct imports from `externals/trading/`
5. run targeted trading, API, worker, and domain tests
6. run `pnpm lint`
7. validate local or staging compose wiring for the repo-local backend

## Deliverables

1. a deployable `externals/trading` runtime
2. a transport-only platform adapter for external-backend trading tool
   invocation
3. backend-backed implementations for every tool owned by `external:trading`
   in document 009, including decision execution, bots, account and risk
   inspection, market data, and price-watch lifecycle
4. boundary authentication and authorization
5. idempotency, deadlines, and typed failures enforced through the contract
6. automated enforcement of the no-direct-import rule

## Implementation Notes

### Boundary pattern

1. Introduce or reuse a generic external-backend invocation client in
   platform-core code.
2. Treat the ready task list under `tasks/002` as the bootstrap path for this
   client and boundary.
3. Move callers onto that client before deleting any direct imports.
4. Remove platform-side direct trading implementation imports before calling
   extraction complete.

### No-direct-import rule

1. `apps/api`, `apps/worker`, `apps/web`, and shared packages must not import
   implementation modules from `externals/trading/`.
2. Repo-local placement is an operational convenience only. It does not soften
   the boundary.

### Backend authority

1. Trading connection semantics, risk policy, provider selection, market-data
   policy, and durable side-effect rules stay in `externals/trading/`.
2. Platform-core code owns only generic dispatch, auth, entitlement,
   health or readiness gating, visibility composition, and audit plumbing.