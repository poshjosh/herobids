# ADR 002: Redis Streams Agent Transport

Status: Accepted
Date: 2026-06-02

## Context

Step 6 needs a durable protocol path between the isolated agent runtime and the platform.

The canonical agent docs already assume:

- at-least-once delivery
- duplicate-safe handlers keyed by `messageId`
- bounded replay after reconnect
- reconnect and recovery without losing trust-critical events

Bare Redis pub/sub does not satisfy those requirements because it does not provide durable replay or consumer recovery semantics.

HeroBids already uses Redis as part of the operational stack, and the project docs already treat Redis Streams as the simple next step before heavier transport choices.

## Decision

Use Redis Streams as the canonical v1 transport for the agent protocol path.

Specifically:

- runtime-to-platform and platform-to-runtime protocol messages use Redis Streams, not bare Redis pub/sub
- delivery remains at-least-once
- handlers deduplicate by `messageId`
- reconnect uses bounded replay from durable stream state
- the message envelope stays transport-neutral so a later transport change does not require a protocol rewrite

## Consequences

- v1 gets durable replay and reconnect behavior without introducing a heavier messaging system
- the transport matches the recovery model already documented in the canonical agent docs
- operators must configure retention, trimming, and consumer-group behavior explicitly
- exactly-once delivery is still not assumed; idempotency remains required at the application layer
- Redis pub/sub may still be used for low-value notifications, but not for the canonical agent protocol path