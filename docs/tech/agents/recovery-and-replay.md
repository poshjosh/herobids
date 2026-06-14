# Recovery And Replay

This document is the canonical reference for failure handling, restart behavior, and reconnect semantics around the agent runtime boundary.

It complements [Agent Runtime Boundary And Message Contract](./runtime-boundary-and-message-contract.md) and [Message Catalog](./message-catalog.md).

## Goals

Recovery must preserve three properties:

1. no venue-side effect occurs without a durable record of the intent that led to it
2. crashes do not create ambiguous ownership over state or execution authority
3. reconnecting agents regain enough context to be trustworthy without replaying unbounded noise

## Failure Classes

| Failure class | Expected behavior |
|---|---|
| Invalid startup or operator config | Fail fast before trading starts |
| Invalid runtime message payload | Reject that payload, journal it, keep the worker healthy unless continuing would be unsafe |
| Stale or unauthorized decision | Reject with a stable code and no execution side effect |
| Risk or guardrail block after acceptance | Emit the appropriate guardrail or risk outcome and stop progress for that decision |
| Agent runtime heartbeat loss | Mark runtime unhealthy, stop trusting new agent input, continue instance-owned safety work as needed |
| Worker crash during trading | Rehydrate from durable state, reconcile incomplete work, then resume |

## Persistence Before Side Effects

The platform must preserve write-ahead intent before touching the venue.

Required ordering:

1. receive and validate the decision proposal
2. persist the decision and decision context reference
3. create and persist the execution plan
4. mark plan execution state in a durable path
5. perform venue-side effects
6. persist order, fill, and resulting position updates
7. mark the plan terminal state

If the process dies after step 4 but before later terminal records are written, reconciliation must treat the plan as incomplete work rather than assuming nothing happened.

## Agent Runtime Failure

If the isolated agent runtime crashes, times out, or stops heartbeating:

- the trading instance remains authoritative for any already-accepted decision
- no new agent decisions should be trusted until the runtime is healthy again
- the platform may pause agent-driven intake without changing position state by default
- already-persisted plans continue under normal engine execution and reconciliation rules

Agent runtime failure is not by itself proof that venue execution failed.

## Worker Or Trading Instance Failure

If the worker dies, the replacement path follows the existing HeroBids rehydration model:

1. lease ownership transfers to another worker
2. positions, orders, fills, and known plans reload from Postgres
3. incomplete plans are identified and reconciled against the venue
4. private stream subscriptions are re-established
5. the new worker performs reconciliation before resuming normal decision intake

No trading loop should resume until the instance has a reconciled baseline it can trust.

## Transport Choice

V1 should use Redis Streams as the durable at-least-once transport for the canonical agent protocol path rather than bare pub/sub.

Recommended shape:

- persist delivery state so reconnect and replay are possible
- use Redis Streams consumer-group semantics for runtime and platform consumers
- deduplicate by `messageId`
- keep transport-order independence and idempotent handlers
- support bounded replay checkpoints after reconnect

This is the simplest transport that matches the existing recovery model without forcing a second bespoke reliability layer.

## Reconnect Surface For Agents

V1 uses a hybrid replay model.

After reconnect, the platform should send:

1. the latest `instance.status`
2. a fresh `instance.context.snapshot`
3. a bounded replay of high-value missed events such as terminal `instance.plan.status`, `instance.execution.result`, `instance.guardrail.triggered`, and material `instance.reconciliation.notice`

The platform should not replay every low-value intermediate event by default.

This keeps the agent's picture of trust-critical events intact without requiring unbounded event reconstruction.

## Duplicate Handling

- Replayed messages still obey at-least-once delivery assumptions.
- Consumers deduplicate by `messageId`.
- Decision submission remains idempotent by `decisionId` and transport-level `messageId`.
- Lifecycle requests must be safe to repeat.

## What Recovery Must Not Do

- It must not assume that a missing terminal record means a venue request never happened.
- It must not silently invent a new strategy decision during restart.
- It must not treat reconnect as a grant of new execution authority for the agent runtime.
- It must not hide startup safety failures behind runtime rejection messages.

## Deferred Details

The following details can evolve without changing the main invariants in this document:

- exact replay checkpoint encoding
- event retention window for replay
- transport-specific reconnect handshakes
- whether replay acknowledgment is explicit or implicit