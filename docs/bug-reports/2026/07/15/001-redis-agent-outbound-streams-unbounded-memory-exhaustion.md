# Bug Report: Redis Agent Outbound Streams Grow Unbounded, Exhausting System Memory

- **Status:** OPEN (server patched; root cause in application code unfixed)
- **Severity:** High
- **Date:** 2026-07-15
- **Discovered By:** Monitoring — staging server at `staging.openaidom.com` reached 94% memory usage (3.5 Gi / 3.7 Gi).
- **Summary:** Redis `agent:outbound:*` streams accumulate entries indefinitely because `XADD` calls do not specify a `MAXLEN` cap. On a small instance (4 GB RAM) with 4 running agents, streams reached 734K–878K entries each (3.17M total), consuming 1.58 GB of Redis memory. Combined with other services, the system hit 94% memory utilization with only ~200 MiB available.

## Observed Behavior

Staging server memory steadily climbed over ~7 days of uptime until it reached 94%:

```
              total        used        free      shared  buff/cache   available
Mem:          3.7Gi       3.5Gi       105Mi        30Mi       415Mi       204Mi
```

Redis was the dominant consumer at 1.58 GB RSS (42% of system RAM) despite holding only 68 keys:

| Key | Entries |
|-----|---------|
| `agent:outbound:51403f2e-...` | 877,600 |
| `agent:outbound:93552994-...` | 806,665 |
| `agent:outbound:64afd699-...` | 771,484 |
| `agent:outbound:b4f67404-...` | 739,051 |
| **Total (16 streams)** | **3,169,510** |

Redis had **no `maxmemory` limit** (`maxmemory_human: 0B`) with `maxmemory_policy: noeviction`, so it grew without bound.

## Root Cause

1. **Missing `MAXLEN` on `XADD`**: The code that writes to `agent:outbound:*` streams (in the worker's stream/event plumbing) calls `XADD` without a `MAXLEN` (~ or =) argument. Every message ever sent to an agent accumulates in its outbound stream forever.

2. **No Redis memory cap**: The `docker-compose.yaml` Redis service definition has no `command:` or config file specifying `maxmemory`. The Redis 7 default is `maxmemory 0` (unlimited) with `noeviction` policy.

3. **Small instance**: The staging server has only 3.7 GiB RAM. With 4 agents running, the outbound streams grew at ~100K entries/day/agent, exhausting memory within a week.

## Fix (Applied on Server)

### Immediate relief (2026-07-15, on staging server only)

1. **Trimmed bloated streams** with `XTRIM MAXLEN 1000` on all `agent:outbound:*` keys — reduced from 3.17M to ~4K entries total.
2. **Set runtime Redis limits** via `CONFIG SET maxmemory 512mb` + `CONFIG SET maxmemory-policy allkeys-lru`.
3. **Ran `MEMORY PURGE`** to reclaim RSS overhead from the prior peak allocation.

### Persistence edit (on `/opt/herobids/docker-compose.yaml`)

Added to the `redis:` service definition so the cap survives container restarts:

```yaml
  redis:
    image: redis:7-alpine
    ports:
      - '6379:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 10
    command: ["redis-server", "--maxmemory", "512mb", "--maxmemory-policy", "allkeys-lru"]
    # ...
```

### Result

| Metric | Before | After |
|--------|--------|-------|
| System memory used | 3.5 Gi (94%) | 2.0 Gi (54%) |
| Available memory | 204 Mi | 1.7 Gi |
| Redis data size | 1.53 GB | ~8 MB |

## What Still Needs Fixing

The `maxmemory` cap is a **band-aid**, not the cure. The real fix must happen in application code:

1. **Add `MAXLEN` to agent outbound stream `XADD` calls** — the worker and/or agent runtime should cap these streams at a reasonable size (e.g. `MAXLEN ~ 1000` or `MAXLEN ~ 5000`). This prevents streams from consuming unbounded memory regardless of Redis limits.

2. **Consider `MAXLEN` on agent inbound streams** — same pattern, though inbound streams were not the primary culprit in this incident.

3. **Consider a periodic cleanup job or stream TTL** as an additional safety net.

Without the code-level fix, the `allkeys-lru` eviction will eventually kick in (once Redis hits 512 MB), which may cause silent data loss — old stream entries will be evicted, potentially dropping messages that consumers haven't read yet. LRU eviction of streams is safe provided consumers keep up, but it's a coarser mechanism than explicit `MAXLEN` trimming.

## Files That Likely Need Changes

- Stream plumbing in `packages/venues/` or `apps/worker/` where `XADD` is called for agent outbound messages.
- `docker-compose.yaml` — add `command:` with `--maxmemory` and `--maxmemory-policy` (already done on staging server, needs committing to the repo).

## Verification

- Memory on staging dropped from 94% → 54% and remained stable.
- All 11 Docker containers remain healthy.
- Streams are refilling (~18K entries/stream after 30 min) but the 512 MB cap will protect the system from exhaustion until the code-level fix lands.
