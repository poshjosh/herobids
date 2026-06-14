# Shared Market State

Define the deployment-wide Redis-backed state owned by the always-on market intelligence loop.

This document covers:
- Redis key layout
- snapshot shapes
- freshness and staleness rules
- anti-staleness policy for discovery
- leader ownership and failover behavior

The purpose of shared market state is to prevent each agent from acting as its own primary discovery service.
Agents may still fetch or refine data during ticks, but the platform should maintain a shared baseline picture of the market.

---

## Background

HeroBids already has:
- discovery fanout and normalization in `packages/market-data/src/discovery.ts`
- coordinated provider access and cache behavior in `packages/market-data/src/provider-registry.ts`

What is missing is a deployment-wide state layer that:

1. refreshes continuously outside agent ticks
2. persists the latest shared discovery and monitor context in Redis
3. provides freshness and failover semantics
4. lets monitors evaluate changes without rebuilding world state from scratch every time

---

## Scope

### In scope

- Redis keys and ownership for shared discovery and monitor state
- snapshot document shapes
- freshness model and stale transitions
- anti-staleness policy for repeated discovery candidates
- leader lease semantics
- failover and resume behavior

### Out of scope

- agent-facing event payloads
- exact monitor rules
- persistent historical storage beyond short-lived Redis state

---

## Design Principles

1. One leader owns shared market state writes at a time.
2. Readers must be able to tell whether state is fresh, stale, or unavailable.
3. Discovery state must be cheap to consume and cheap to overwrite.
4. Anti-staleness belongs in shared state, not in each agent runtime.
5. Failover should prefer continuity over perfect preservation of in-memory counters.

---

## Ownership Model

The `MarketDataCoordinator` and `MarketMonitor` live inside the worker, but only one worker instance is the active leader for shared-state writes.

### Leader responsibilities

The leader:
- polls discovery and intelligence sources
- writes shared snapshots
- updates freshness metadata
- updates anti-staleness state
- evaluates monitor rules that depend on shared market state

Non-leader workers:
- may read shared state
- must not write shared-state snapshots except for explicit local caches unrelated to leader ownership

### Leader lease

Recommended Redis key:

```text
market-intel:leader
```

Suggested value:

```json
{
  "workerId": "worker-123",
  "startedAt": "2026-06-10T12:00:00.000Z",
  "leaseVersion": 4
}
```

Suggested behavior:
- acquire with `SET key value NX PX ttl`
- renew on interval shorter than TTL
- if renewal fails, stop acting as leader

Suggested TTL:
- 15 to 30 seconds

---

## Redis Key Layout

Use explicit prefixes so ownership and lifecycle are obvious.

### Leader and health

```text
market-intel:leader
market-intel:health
```

Purpose:
- current leader lease
- leader health and last successful refresh timestamps

### Discovery snapshots

```text
market-intel:discovery:latest
market-intel:discovery:meta
market-intel:discovery:by-network:{network}
```

Purpose:
- latest merged deployment-wide discovery set
- freshness metadata and source stats
- network-specific slices for faster reads

### Anti-staleness tracking

```text
market-intel:discovery:seen
market-intel:discovery:last-event:{network}:{address}
```

Purpose:
- track when a token was recently surfaced
- suppress repeated “new candidate” events

### Regime state

```text
market-intel:regime:{benchmarkSymbol}
```

Purpose:
- shared regime result for relevant benchmark symbols

### Monitor state

```text
market-monitor:watch:last-state:{agentId}
market-monitor:dedupe:{dedupeKey}
market-monitor:wake:{agentId}
```

Purpose:
- last known watch condition state by agent
- dedupe suppression keys
- wake coalescing bucket for agent

### Optional diagnostics

```text
market-intel:metrics:rolling
market-intel:last-error
```

Purpose:
- rolling counters and last known failures for debugging

---

## Snapshot Shapes

### Discovery snapshot

Key:

```text
market-intel:discovery:latest
```

Recommended JSON shape:

```json
{
  "snapshotId": "uuid",
  "capturedAt": "2026-06-10T12:40:00.000Z",
  "freshness": {
    "state": "fresh",
    "ageMs": 1200,
    "maxAllowedAgeMs": 600000
  },
  "sources": {
    "dexscreener": { "ok": true, "freshness": "fresh" },
    "geckoterminal": { "ok": true, "freshness": "fresh" },
    "coinmarketcap": { "ok": false, "freshness": "unavailable" }
  },
  "tokens": [
    {
      "network": "solana",
      "address": "...",
      "symbol": "WIF",
      "name": "dogwifhat",
      "priceUsd": 2.14,
      "liquidityUsd": 1450000,
      "volume24hUsd": 8300000,
      "poolAddress": "...",
      "poolCreatedAt": "2026-06-01T10:00:00.000Z",
      "discoveryVectors": ["trending", "boosts_latest"],
      "rank": 3
    }
  ]
}
```

### Discovery metadata snapshot

Key:

```text
market-intel:discovery:meta
```

Recommended JSON shape:

```json
{
  "snapshotId": "uuid",
  "leaderWorkerId": "worker-123",
  "capturedAt": "2026-06-10T12:40:00.000Z",
  "networks": ["solana", "base"],
  "tokenCount": 25,
  "pollIntervalMs": 30000,
  "nextPollDueAt": "2026-06-10T12:40:30.000Z",
  "sourceStats": {
    "dexscreener": { "count": 12 },
    "geckoterminal": { "count": 13 }
  }
}
```

### Regime snapshot

Key:

```text
market-intel:regime:BTC
```

Recommended JSON shape:

```json
{
  "benchmarkSymbol": "BTC",
  "evaluatedAt": "2026-06-10T12:41:00.000Z",
  "freshness": {
    "state": "fresh",
    "ageMs": 5000,
    "maxAllowedAgeMs": 60000
  },
  "pass": false,
  "reasons": ["EMA alignment is bearish", "ADX below threshold"],
  "details": {
    "emaAlignment": "bearish",
    "adxValue": 18.4,
    "choppy": true,
    "marketStructure": "lowerHighs"
  }
}
```

---

## Freshness Model

All shared state reads must expose freshness explicitly.

### Freshness states

- `fresh`
- `stale`
- `unavailable`

### Rules

`fresh`
- data age is within max allowed age
- last refresh completed successfully

`stale`
- previous snapshot exists but max allowed age was exceeded
- caller may still use it with caution

`unavailable`
- no usable snapshot exists
- or refresh failed before any valid snapshot was written

### Suggested freshness budgets

Discovery snapshot:
- target poll: 30 seconds
- max allowed age: 10 minutes

Regime snapshot:
- target poll: 30 to 60 seconds
- max allowed age: 1 minute for hot regime consumers

Monitor state:
- computed from latest available underlying snapshot
- no separate freshness field needed if source snapshot is referenced

---

## Anti-Staleness Policy

Discovery is not useful if the same token is surfaced as “new” forever.

### Purpose

Anti-staleness ensures the coordinator prefers newly surfaced opportunities over recently repeated ones.

### Recommended mechanism

Use a sorted set:

```text
market-intel:discovery:seen
```

Member:

```text
{network}:{address}
```

Score:
- last time the token was surfaced in a shared discovery snapshot or emitted as a discovery event

### Behavior

When ranking candidates:
- fresh unseen tokens get priority
- recently seen tokens are deprioritized, not removed
- if all candidates were seen recently, still return the best set but mark them as repeated

### Suggested cooldown

4 hours for discovery novelty ranking.

This aligns with the old anti-staleness pattern while remaining platform-wide instead of per agent.

---

## Polling And Write Behavior

### Discovery refresh

Recommended cadence:
- every 30 seconds in v1

Each cycle:
1. call discovery providers through the existing registry
2. merge and rank results
3. update anti-staleness state
4. write `market-intel:discovery:latest`
5. write `market-intel:discovery:meta`

Writes should be atomic enough that readers do not see contradictory metadata and body snapshots.

Recommended approach:
- write full JSON blobs in a single Redis pipeline or transaction
- snapshot id appears in both payload and metadata

### Regime refresh

Recommended cadence:
- every 30 to 60 seconds per tracked benchmark symbol

Only a bounded set of benchmark symbols should be monitored in v1.

---

## Failover Behavior

### Leader loss

If the leader stops renewing the lease:
- another worker may acquire leadership
- new leader should begin polling immediately
- previous snapshots remain readable until freshness expires

### No valid leader

If no worker is leader:
- readers continue using the last snapshot
- freshness transitions from `fresh` to `stale`, then `unavailable`
- no new monitor-triggered events should be emitted until leadership resumes

### Leader handoff guarantees

v1 should guarantee:
- no permanent outage if one worker dies
- no dependence on local process memory for correctness of shared state

v1 does not need to guarantee:
- exact once-only continuity of every transient coalescing counter across failover

Coalescing buckets may be briefly conservative after failover. That is acceptable.

---

## Reader Behavior

Readers such as the monitor, API, or agent-context builder should:

1. read the latest snapshot
2. inspect freshness state
3. degrade gracefully if stale or unavailable
4. never silently treat stale data as fresh

If a consumer needs stricter guarantees than the shared snapshot can provide, it may do an on-demand fetch, but that should be the exception, not the default discovery path.

---

## Observability

Track:
- leader acquire and renew success/failure
- discovery refresh duration
- source-level refresh failures
- snapshot freshness transitions
- anti-staleness suppressions

Suggested metrics:
- `market_intel_leader_active`
- `market_intel_refresh_duration_ms`
- `market_intel_snapshot_age_ms`
- `market_intel_snapshot_state_total`
- `market_intel_antistaleness_deprioritized_total`

---

## v1 Summary

v1 shared market state should provide:

1. one leader-owned source of deployment-wide discovery truth
2. explicit freshness metadata on every shared snapshot
3. anti-staleness handling for repeated candidates
4. enough Redis structure for monitors and wakeup logic to operate without each agent rediscovering the market independently
5. graceful degradation when the leader or providers fail

That is the minimum state layer needed to elevate discovery from a per-tick helper into platform infrastructure.