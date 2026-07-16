# Bug Report: Redis Agent Outbound Streams Grow Unbounded, Exhausting System Memory

- **Status:** FIXED (2026-07-16) — code-level fix implemented and tested; pending redeploy to staging/production to take effect
- **Severity:** High
- **Date:** 2026-07-15
- **Discovered By:** Monitoring — staging server at `staging.openaidom.com` reached 94% memory usage (3.5 Gi / 3.7 Gi).
- **Summary:** Redis `agent:outbound:*` streams accumulate entries indefinitely because `XADD` calls do not specify a `MAXLEN` cap. On a small instance (4 GB RAM) with 4 running agents, streams reached 734K–878K entries each (3.17M total), consuming 1.58 GB of Redis memory. Combined with other services, the system hit 94% memory utilization with only ~200 MiB available.

## Recurrence (2026-07-16)

The 2026-07-15 `maxmemory`/`maxmemory-policy` fix was applied only via `redis-cli CONFIG SET` (runtime-only) — it was **never committed to `docker-compose.yaml`**, so it did not survive the redis container being recreated (it was recreated after an OOM kill during a deploy earlier the same day, see [docs/bug-reports/2026/07/16/001-deploy-parallel-bake-oom-cpu-starvation.md](../../16/001-deploy-parallel-bake-oom-cpu-starvation.md)). Memory climbed back to 90%+ within hours:

- `used_memory_human: 1.33G`, `maxmemory_human: 0B`, `maxmemory_policy: noeviction` — cap was gone.
- Outbound streams had regrown to 322K–640K entries each (`agent:outbound:64afd699-...` → 640,280; `agent:outbound:a816965e-...` → 322,901; `agent:outbound:93552994-...` → 525,553; `agent:outbound:3fa538e3-...` → 351,049; `agent:outbound:b4f67404-...` → 401,329; `agent:outbound:51403f2e-...` → 492,007).
- Applied the same immediate relief again: `XTRIM ... MAXLEN 1000` on all `agent:outbound:*` streams, `CONFIG SET maxmemory 512mb`, `CONFIG SET maxmemory-policy allkeys-lru`, `MEMORY PURGE`. Result: `used_memory_human` 1.33G → 7.51M, system memory used 3.4Gi → 2.1Gi (out of 3.7Gi).
- **This will recur again on the next redis restart/recreate** until the fix lands in code (compose file + `MAXLEN` on the `XADD` call sites below). Runtime `CONFIG SET` is not persisted by Redis across container recreation since there is no `redis.conf` or persisted config file mounted — only the `command:` override proposed below survives restarts.

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

## Fix (Code-Level, 2026-07-16)

1. **Added `AGENT_STREAM_MAXLEN = 1000`** constant in `packages/domain/src/agent-protocol.ts`, shared by both `apps/api` and `apps/worker`.
2. **Added `MAXLEN ~ AGENT_STREAM_MAXLEN` to all 8 `XADD` call sites** publishing to `agent:inbound:*`/`agent:outbound:*` streams:
   - `apps/api/src/routes/agent-interactivity.ts` (both the user-message and Telegram-delivery call sites)
   - `apps/api/src/routes/bots.ts`
   - `apps/api/src/routes/connections.ts`
   - `apps/worker/src/agent.ts`
   - `apps/worker/src/agents/agent-runtime-launcher.ts`
   - `apps/worker/src/agents/agent-reconnect-handler.ts`
   - `apps/worker/src/agents/instance-event-publisher.ts`

   Streams now self-trim to ~1000 entries on every write instead of growing unbounded, regardless of Redis-level `maxmemory` settings.
3. **Persisted the `maxmemory`/`maxmemory-policy` cap in `docker-compose.yaml`** (`command: ['redis-server', '--maxmemory', '512mb', '--maxmemory-policy', 'allkeys-lru']`) as defense-in-depth — this now survives container recreation since it ships in the compose file committed to the repo, not just applied via `redis-cli` on the live server.
4. Updated existing unit tests (`agent-interactivity.test.ts`, `connections.test.ts`, `agent-reconnect-handler.test.ts`, `agent-runtime-launcher.test.ts`, `instance-event-publisher-market.test.ts`) to assert on the new `xadd` argument shape.

## What Still Needs Fixing

Nothing code-level remains open. Remaining follow-up (optional, not blocking):

1. Consider a periodic cleanup job or stream TTL as an additional safety net (defense-in-depth only — `MAXLEN` already bounds growth going forward).

Existing streams on the live staging server still contain the pre-fix trimmed backlog (~1000 entries each from the manual `XTRIM` on 2026-07-16); no further action needed there since they'll stay capped once the new image is deployed.

## Files Changed

- `packages/domain/src/agent-protocol.ts` — added `AGENT_STREAM_MAXLEN` constant.
- `docker-compose.yaml` — persisted `command:` with `--maxmemory 512mb --maxmemory-policy allkeys-lru` on the `redis` service.
- `apps/api/src/routes/agent-interactivity.ts` — `MAXLEN` added to both `xadd` call sites.
- `apps/api/src/routes/bots.ts` — `MAXLEN` added.
- `apps/api/src/routes/connections.ts` — `MAXLEN` added.
- `apps/worker/src/agent.ts` — `MAXLEN` added (inbound stream).
- `apps/worker/src/agents/agent-runtime-launcher.ts` — `MAXLEN` added.
- `apps/worker/src/agents/agent-reconnect-handler.ts` — `MAXLEN` added.
- `apps/worker/src/agents/instance-event-publisher.ts` — `MAXLEN` added.
- Test files updated to match new `xadd` call signature: `apps/api/src/routes/agent-interactivity.test.ts`, `apps/api/src/routes/connections.test.ts`, `apps/worker/src/agents/agent-reconnect-handler.test.ts`, `apps/worker/src/agents/agent-runtime-launcher.test.ts`, `apps/worker/src/agents/instance-event-publisher-market.test.ts`.

## Verification

- 2026-07-15: Memory on staging dropped from 94% → 54% and remained stable (temporarily — see Recurrence above).
- 2026-07-16 (recurrence): Re-applied the same `XTRIM`/`CONFIG SET` relief, memory dropped from ~92% to ~57% (2.1Gi / 3.7Gi used).
- 2026-07-16 (code fix): `pnpm --filter @herobids/domain run build` and `pnpm lint` (`tsc --noEmit` across the monorepo) both pass. Targeted `vitest run` on all 7 touched test files: **115/115 tests pass**. Deploy to staging pending to confirm the persisted `docker-compose.yaml` cap and `MAXLEN` behavior hold under live agent traffic.
