# Event And Wakeup Contract

Define the message contract between the always-on market intelligence loop and the agent runtime.

This document covers:
- what event types exist
- what payloads they carry
- how dedupe and coalescing work
- how a market event differs from a wake signal
- what rate limits protect the runtime from thrash

The coordinator and monitor do not make trading decisions. They observe, classify, publish, and wake. Agents remain the decision makers.

---

## Background

Today, watches are stored and evaluated through agent tools in `apps/worker/src/tools/watch.ts`.
The agent learns a watch fired only when it later calls `check_watches` during a normal tick.

The always-on loop changes this model:

1. the worker evaluates watches and monitor rules outside the agent tick
2. the worker publishes structured market events to the agent stream
3. the worker may request an early bounded wake so the agent reasons sooner than its normal interval

This must preserve agent-mode purity, avoid duplicate notifications, and prevent market noise from forcing unbounded LLM calls.

---

## Scope

### In scope

- event types emitted by `MarketDataCoordinator` and `MarketMonitor`
- payload schemas and required fields
- dedupe identity rules
- wake signal semantics
- coalescing and per-agent rate limits
- delivery path through existing agent stream infrastructure

### Out of scope

- Redis key layout for shared discovery state
- exact monitor rule logic for discovery and regime
- strategy policy or trade execution logic

---

## Design Principles

1. Market events are facts, not instructions.
2. Wakeups are hints to reason early, not a command to trade.
3. The same condition crossing should produce one event per crossing.
4. Multiple similar events should collapse into one bounded wake request.
5. Delivery should reuse the existing agent message path first.

---

## Transport Choice

Use the existing instance-to-agent outbound stream pattern as the first transport.

Current path:
- stream: `agent:outbound:{agentId}`
- publisher: `apps/worker/src/agents/instance-event-publisher.ts`
- consumer: `apps/worker/src/agents/outbound-message-reader.ts`

v1 recommendation:
- extend the protocol with market-monitor event types
- publish them onto `agent:outbound:{agentId}`
- let the agent consume them at tick start
- add a bounded wake signal in parallel so the next tick can happen early

Do not introduce a separate market-event stream in v1 unless event volume proves the shared stream too noisy.

---

## Event Families

Two message families are needed.

### 1. Market Event

Purpose:
- persist and deliver a fact about market state or a monitor trigger
- give the agent structured context it can reason over later

Examples:
- watch crossed above threshold
- token entered top discovery set
- regime flipped from favorable to unfavorable

### 2. Wake Signal

Purpose:
- request that the agent run an early bounded tick
- does not itself contain the full market fact set
- may reference one or more coalesced event ids

Wake signals exist because event delivery and scheduling are different concerns.
An event should be durable. A wake signal should be cheap, bounded, and coalesced.

---

## Proposed Message Types

Extend the protocol with the following worker-originated types.

### `market.watch.triggered`

Emitted when a stored watch changes from not-met to met.

Payload:

```json
{
  "eventId": "uuid",
  "monitorType": "watch_threshold",
  "watchId": "uuid",
  "symbol": "SOL",
  "chain": "solana",
  "condition": "above",
  "thresholdPrice": 200,
  "currentPrice": 204.12,
  "priceSource": "oracle",
  "stale": false,
  "note": "breakout watch",
  "triggeredAt": "2026-06-10T12:34:56.000Z"
}
```

### `market.discovery.detected`

Emitted when the monitor detects a notable discovery delta.

Payload:

```json
{
  "eventId": "uuid",
  "monitorType": "discovery_delta",
  "symbol": "WIF",
  "network": "solana",
  "address": "...",
  "reason": "entered_top_set",
  "rank": 3,
  "liquidityUsd": 1450000,
  "volume24hUsd": 8300000,
  "discoveryVectors": ["trending", "boosts_latest"],
  "detectedAt": "2026-06-10T12:35:10.000Z"
}
```

### `market.regime.changed`

Emitted when a configured regime state flips in a way relevant to the agent.

Payload:

```json
{
  "eventId": "uuid",
  "monitorType": "regime_change",
  "benchmarkSymbol": "BTC",
  "previousState": "favorable",
  "currentState": "unfavorable",
  "details": {
    "emaAlignment": "bearish",
    "adxValue": 18.4,
    "choppy": true
  },
  "changedAt": "2026-06-10T12:36:00.000Z"
}
```

### `agent.market.wake`

Emitted when the worker requests an early bounded tick for an agent.

Payload:

```json
{
  "wakeId": "uuid",
  "reason": "market_monitor_triggered",
  "eventIds": ["uuid-1", "uuid-2"],
  "priority": "normal",
  "requestedAt": "2026-06-10T12:36:02.000Z",
  "notBefore": "2026-06-10T12:36:02.000Z"
}
```

`priority` should be limited to a small enum in v1, for example `low | normal | high`, but the scheduler should still remain bounded by local cooldown rules.

---

## Envelope Ownership

For all market-monitor events:
- `initiatorType`: `system`
- `initiatorId`: agent id or worker leader id
- `agentId`: required
- `botId`: omitted unless the event is bot-specific

The events are platform-authored facts. They are not agent-authored outputs.

---

## Dedupe Rules

Every emitted market event must have two identifiers:

1. `eventId`
   Purpose: unique row/message identity.

2. `dedupeKey`
   Purpose: semantic identity for suppression.

The dedupe key is not necessarily sent to the agent, but it must exist in the publisher path.

### Watch threshold dedupe

Recommended dedupe key:

```text
watch:{watchId}:cross:{condition}:at:{edgeVersion}
```

Where `edgeVersion` increments only when the watch resets from met back to not-met and then crosses again.

Meaning:
- one notification per crossing
- staying above the threshold must not keep firing
- dropping back below resets eligibility for the next `above` crossing

### Discovery delta dedupe

Recommended dedupe key:

```text
discovery:{network}:{address}:reason:{reason}:window:{bucket}
```

Where `bucket` is a bounded time window such as 10 minutes.

Meaning:
- a token entering the top set should not produce repeated events every poll cycle
- after the bucket expires, the event may fire again if still relevant

### Regime change dedupe

Recommended dedupe key:

```text
regime:{benchmarkSymbol}:from:{previousState}:to:{currentState}
```

Meaning:
- only real flips matter
- repeated evaluation of the same state does not emit a new event

---

## Coalescing Rules

Wake signals should coalesce multiple market events for the same agent.

### Coalescing window

Recommended v1 window:
- 2 to 5 seconds

Within that window:
- collect all newly emitted event ids for the agent
- publish at most one `agent.market.wake`

### Coalescing policy

For a given agent:
- if no wake is pending, create one
- if a wake is already pending and the coalescing window is still open, append event ids
- if a wake is pending and already due, do not create another immediately unless the cooldown has expired

### Coalescing goal

If three watched tokens fire within three seconds, the agent should receive:
- three durable market events
- one wake request referencing all three event ids

---

## Wake Semantics

Wakeups should not interrupt the agent mid-LLM-call.

v1 behavior:
- if agent is idle, schedule an early bounded tick
- if agent is already in a tick, mark `wakePending = true`
- when the current tick completes, the scheduler may run the next tick early subject to cooldown

This avoids re-entrant reasoning and keeps the runtime scheduler simple.

### Recommended scheduler behavior

Inputs:
- normal tick interval
- last wake time
- pending wake flag
- in-flight tick state

Rules:
- never run more than one tick concurrently
- never bypass hard minimum wake interval
- allow wake to pull the next tick earlier than the normal interval
- after servicing a wake, clear or partially drain the pending wake set

---

## Rate Limits And Protections

### Event emission rate

Protect the system from noisy conditions.

Recommended v1 caps:
- max 20 market events per agent per minute per monitor family
- max 1 wake signal per agent every 15 seconds
- max 5 coalesced event ids per wake payload before truncation with summary metadata

### Agent wake rate

Wakes should be bounded even if events keep arriving.

Recommended v1 minimums:
- hard cooldown: 15 seconds between wake-driven ticks
- soft coalescing window: 2 to 5 seconds

### Overflow behavior

If event rate exceeds limits:
- continue updating monitor state internally
- emit a summary market event such as `monitor.rate_limited`
- do not keep queuing wake requests

---

## Failure Handling

If the worker cannot publish a market event:
- log the failure with agent id, monitor family, and dedupe key
- do not place trades or mutate policy as fallback
- keep the monitor eligible to retry on the next evaluation if dedupe rules allow it

If the worker can publish the event but not the wake signal:
- the event remains durable in the outbound stream
- the agent still learns about it on the next scheduled tick

This preserves correctness even when latency improvements temporarily degrade.

---

## Observability

Emit logs and counters for:
- market events emitted by family
- market events suppressed by dedupe
- wake requests emitted
- wake requests coalesced
- wake requests suppressed by cooldown
- publish failures by type

Suggested metrics:
- `market_monitor_events_emitted_total`
- `market_monitor_events_suppressed_total`
- `agent_wake_requests_total`
- `agent_wake_coalesced_total`
- `agent_wake_suppressed_total`

---

## v1 Contract Summary

v1 must guarantee:

1. durable market events are published for real threshold or monitor crossings
2. the same crossing does not emit repeatedly without a reset
3. multiple nearby triggers can map to one bounded wake signal
4. wakeups schedule earlier reasoning but do not interrupt the runtime mid-tick
5. if wakeup fails, normal scheduled ticks still consume the durable event stream

That gives event-driven behavior without sacrificing runtime safety.