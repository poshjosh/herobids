# Operational Readiness For External Backends

**Status:** draft
**Created:** 2026-08-30
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)
**Applies to:** every external backend; the first expected `backendId` is `trading`

## Purpose

Define the generic operational readiness requirements that must be satisfied
before an external backend can replace its in-process predecessor for
production agent traffic. This document complements
[008-cross-service-capability-execution-design.md](./008-cross-service-capability-execution-design.md),
which defines what the boundary looks like.  This document defines how to prove
the boundary works well enough under real conditions.

## Scope

This doc includes:

1. the latency budget model for external-backend tool invocation
2. the shadow-mode validation protocol for proving equivalence before cutover
3. the restart-resilience requirements for independent backend lifecycle
4. the load-test expectations for concurrent agent traffic
5. the cutover decision criteria and rollback conditions

This doc does not include:

1. the invocation contract, auth, or idempotency rules (those belong to 008)
2. domain-specific business validation inside any one backend
3. native-capability operational concerns (native capabilities remain
   in-process)
4. deployment topology or infrastructure sizing beyond what the readiness
   checks require

## Non-Goals

1. Do not define domain-specific acceptance thresholds inside this generic doc.
   Domain-specific phase docs such as 005 own their concrete targets.
2. Do not require a production load-test environment as a prerequisite for
   entering the first backend extraction. Local compose or staging is
   sufficient for the initial validation.
3. Do not block the first backend on achieving sub-millisecond latency. The
   goal is measured, budgeted, and operator-configurable latency, not an
   absolute performance target.
4. Do not define monitoring, alerting, or observability infrastructure. Those
   are operational concerns outside the scope of this feature set.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) keeps this doc as an
   active supporting reference for external-backend extraction phases.
2. [008-cross-service-capability-execution-design.md](./008-cross-service-capability-execution-design.md)
   defines the invocation contract, auth, deadline, and health model that this
   doc's operational checks validate.
3. [005-trading-capability-extraction.md](./005-trading-capability-extraction.md)
   references this doc as a normative input for its trading-specific
   operational readiness criteria.

## Fixed Decisions

1. Every external backend must pass the operational readiness checklist in this
   doc before full cutover from the in-process path.
2. Latency budgets are operator-configurable, not hard-coded. This doc defines
   the measurement protocol and default targets, not immutable numbers.
3. Shadow-mode validation is mandatory before the in-process path is removed
   for any external backend.
4. Restart resilience must be proven by automated test, not assumed from the
   health-endpoint design.
5. Cutover is a deliberate decision with explicit criteria, not a side effect
   of deploying the backend.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. the exact load-test tooling and harness used
2. the shadow-mode implementation approach (feature flag, dual dispatch, log
   comparison, or equivalent)
3. the staging or local compose topology used for pre-production validation
4. the exact format and location of latency and equivalence reports
5. whether the restart-resilience test uses compose restart, process signal,
   or container orchestration mechanics

## Latency Budget

### Model

End-to-end latency for an external-backend tool invocation is measured from the
moment platform-core dispatches the request to the moment the agent runtime
receives the mapped `ToolResult`. This includes:

1. platform-side request construction, signing, and serialization
2. network transit to the backend (private network)
3. backend-side envelope validation, tool dispatch, and downstream execution
4. network transit back
5. platform-side response deserialization and result mapping

### Default Targets

The following are default operator-configurable targets. Domain-specific phase
docs may tighten them for their backend.

| Metric | Default target | Config path |
| --- | --- | --- |
| p50 latency | 200ms | `externalBackends.latencyTargets.p50Ms` |
| p95 latency | 500ms | `externalBackends.latencyTargets.p95Ms` |
| p99 latency | 2000ms | `externalBackends.latencyTargets.p99Ms` |
| Hard timeout | 10000ms | `externalBackends.requestTimeoutMs` (from 008) |

These targets apply to tool invocations under normal operating conditions. They
exclude downstream venue or provider latency that is inherently variable (for
example, a venue API call that takes 3 seconds is backend-owned latency, not
boundary overhead). The measurement must separate boundary overhead from
downstream execution time so that boundary-introduced latency is identifiable.

### Measurement Protocol

1. The load test must record timestamps at platform dispatch and at tool-result
   receipt.
2. Boundary overhead is the difference between end-to-end latency and the
   backend-reported downstream execution time (if available) or the
   backend-side request-to-response duration.
3. Results must be reported as a histogram with p50, p95, p99, and max.
4. The test fails if p95 boundary overhead exceeds the configured target.

## Shadow-Mode Validation

### Protocol

Before full cutover for any external backend:

1. The platform dispatches each affected tool call through both the existing
   in-process path and the external-backend boundary.
2. Both results are captured. The in-process result is returned to the agent.
   The external-backend result is logged for comparison.
3. A comparison report records: total calls, matching results, mismatches by
   tool name, latency delta distribution, and any external-backend failures
   that the in-process path did not produce.
4. The shadow period must cover at least one representative workload cycle
   under realistic agent load. For trading, this means at least one full
   trading session with active position management.

### Equivalence Criteria

Shadow mode passes when all of the following hold:

1. result-payload equivalence rate is at or above 99% for all tool categories
   (allowing for expected timing differences in market-data tools)
2. no external-backend failure category occurs that the in-process path does
   not also produce under the same conditions
3. external-backend p95 latency is within the configured budget
4. no idempotency violation is detected (same idempotency key produces
   different durable outcomes)

### Mismatch Resolution

Mismatches must be triaged before cutover:

1. timing-related differences in market-data or price tools are expected and
   documented as acceptable
2. logic differences in side-effecting tools (`submit_decision`, bot lifecycle)
   are blocking and must be resolved before cutover
3. transient infrastructure failures during shadow mode are acceptable if they
   do not recur under steady-state conditions

## Restart Resilience

### Requirements

Each external backend must survive an independent restart without causing
agent-visible errors beyond the health-gating window:

1. When the backend process stops, its `/health/ready` endpoint becomes
   unreachable.
2. The platform detects the health failure within one health-check cycle and
   removes the backend's tools from new visibility snapshots.
3. In-flight invocations that were dispatched before the health check receive
   `upstream.transient` or `deadline.expired` and are handled by the standard
   retry and result-mapping logic in 008.
4. No agent session crashes, hangs, or loses durable state because of the
   backend restart.
5. When the backend restarts and `/health/ready` returns healthy, tools
   reappear in visibility snapshots within one health-check cycle.
6. Any invocations retried with the original idempotency key after restart
   produce the correct idempotent result.

### Test Shape

The restart-resilience test must:

1. start the external backend and confirm tools are visible
2. dispatch at least one tool invocation that is in-flight when the restart
   begins
3. stop or restart the backend process
4. confirm in-flight invocations receive the expected transient failure
5. confirm tools are removed from visibility
6. wait for the backend to become healthy again
7. confirm tools reappear in visibility
8. dispatch a new invocation and confirm it succeeds
9. retry the original invocation with the same idempotency key and confirm
   idempotent behavior

## Load-Test Expectations

### Scope

Each external backend must be load-tested before cutover. The test must
exercise:

1. at least one write-path tool that produces durable side effects (for
   trading: `submit_decision`)
2. at least one read-path tool that is called frequently (for trading:
   `get_price` or `list_positions`)
3. concurrent simulated agent sessions at a level representative of expected
   peak load or a defined multiplier of current average load

### Metrics To Record

| Metric | Required |
| --- | --- |
| p50, p95, p99, max end-to-end latency per tool | yes |
| p50, p95 boundary overhead (excluding downstream) | yes |
| Throughput (requests per second) | yes |
| Error rate by failure code | yes |
| Idempotency-violation count | yes (must be zero) |
| Backend resource utilization (CPU, memory, connections) | recommended |

### Pass Criteria

The load test passes when:

1. p95 latency is within the configured budget for every tested tool
2. error rate for non-transient failures is zero
3. idempotency-violation count is zero
4. no resource exhaustion (connection pool, memory, file descriptors) occurs
   during the test
5. the backend recovers to healthy within one health-check cycle after the
   load ramp-down

## Cutover Decision Criteria

Full cutover from in-process to external-backend execution may proceed only
when all of the following are satisfied:

1. shadow-mode equivalence criteria are met
2. load-test pass criteria are met
3. restart-resilience test passes
4. the in-process path can be disabled by operator config without code changes
5. a rollback path exists: re-enabling the in-process path by config change
   restores previous behavior without data loss or state corruption
6. the phase doc's own acceptance criteria and validation are satisfied

## Rollback Conditions

If any of the following occur after cutover, the operator may roll back to the
in-process path:

1. p95 latency exceeds the budget for more than one health-check cycle under
   normal load
2. a previously unseen failure code appears at a rate exceeding 1% of
   invocations
3. an idempotency violation is detected in production
4. the backend fails to recover from a restart within the configured health
   timeout

Rollback is an operator config change. It must not require a code deployment
or a database migration.

## Acceptance Criteria

This supporting reference is fit for implementation use only when:

1. the latency budget model, measurement protocol, and default targets are
   explicit
2. the shadow-mode protocol, equivalence criteria, and mismatch-resolution
   rules are explicit
3. the restart-resilience requirements and test shape are explicit
4. the load-test scope, metrics, and pass criteria are explicit
5. the cutover decision criteria and rollback conditions are explicit
6. every requirement in this doc is generic over backend identity and does not
   embed domain-specific policy

## Validation

1. confirm that [005-trading-capability-extraction.md](./005-trading-capability-extraction.md)
   references this doc as a normative input and its acceptance criteria and
   validation items are consistent with the requirements here
2. confirm that the latency budget config paths do not conflict with existing
   operator config in
   [008-cross-service-capability-execution-design.md](./008-cross-service-capability-execution-design.md)
3. confirm that the shadow-mode, restart-resilience, and load-test
   requirements are achievable in a local compose environment for the first
   backend
4. keep `pnpm lint` as the final repo-wide validation gate for any touched code
