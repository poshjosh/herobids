# Multi-Server Admin Dashboard

**Status:** Complete
**Created:** 2026-08-31
**Area:** Admin dashboard, infrastructure observability, Redis

---

## Problem Statement

The admin dashboard's "Resources" section reports memory and disk for a single host — whichever server the API process runs on (`os.totalmem()`, `os.freemem()`, `fs.statfsSync('/')` in `GET /admin/stats`). There is no concept of multiple servers.

The platform runs on multiple server types with different roles:

| Server type | What runs on it | Currently exists? |
|---|---|---|
| **control-plane** | API, worker, Postgres, Redis, web, Caddy, docker-proxy, skills-api, Nomad server | Yes — single Hetzner `hcloud_server.default` per environment |
| **agent-server** | Nomad client, Docker — hosts agent containers and browser-pool instances | Yes — 0-N Hetzner `hcloud_server.agent` nodes, auto-scaled |
| **browser-pool** | `ghcr.io/browserless/chromium` — headless browser service for agent browsing | Yes — Nomad job on agent-server nodes (not a separate server today, but metrics should be reported per-instance) |
| **trading** | Trading engine — venue connections, order execution, position management | Planned — not yet deployed |

As the platform scales, the operator needs to see resource utilisation across all servers from a single dashboard view, not just the control-plane host.

### Why not Prometheus/Grafana?

Adding a full observability stack for 2-5 servers is disproportionate. Redis is already the real-time state bus (actor health snapshots use the same pattern), and we already have a purpose-built admin dashboard. When the fleet grows large enough to justify Prometheus, the Redis publisher becomes a metrics source for a Prometheus exporter — the pattern doesn't lock us in.

## Goals

1. Each server process self-reports health metrics to Redis on a periodic interval.
2. The admin dashboard displays servers grouped by type, with per-server resource bars (CPU, memory, disk) and type-specific custom metrics.
3. Stale servers auto-expire from the view (TTL-based, same as actor health).
4. The pattern is easy to adopt for new server types (trading, future services) — a single integration point per service.

## Non-Goals

- Historical metrics or time-series storage. This is a live snapshot, not a monitoring history.
- Alerting on server health thresholds. The existing autoscale alerting pipeline handles capacity; this is for operator visibility.
- Replacing the existing per-agent-session CPU/memory display in the Runtime section. That stays as-is — it shows per-agent granularity, this shows per-server.

---

## Design Decisions

### D1. Server type taxonomy

**Decision:** Four server types: `control-plane`, `agent-server`, `browser-pool`, `trading`.

**Rationale:** Matches the actual deployment topology:
- The **control-plane** is a single Hetzner server running the Docker Compose stack (API + worker + Postgres + Redis + web + Caddy). The API and worker are separate containers but share one host — they don't need separate server entries because the operator cares about the host's resources, not individual container overhead. The worker and API don't run on separate servers, they're both part of the control-plane.
- **Agent-server** nodes are Nomad client machines that host agent containers. Each physical Hetzner node is a separate server entry.
- **Browser-pool** instances are Nomad task allocations (Browserless containers), not separate Hetzner servers. But they have their own resource profile and type-specific metrics (active sessions, queue depth), so they warrant their own server type. The publisher runs inside each Browserless sidecar or is polled from the worker via the Browserless `/pressure` endpoint.
- **Trading** servers will run the trading engine. When they exist, each instance publishes its own health.

### D2. Redis key scheme and TTL

**Decision:** Each server publishes to a Redis key `herobids:server-health:{serverType}:{serverId}` with a 60-second TTL. The value is a JSON-serialised `ServerHealthSnapshot`.

**Rationale:** Follows the existing `ActorHealthSnapshot` pattern (`herobids:actor-health:{type}:{id}`, 120s TTL). 60s TTL is appropriate because the publish interval is 15s — a server that misses 4 consecutive heartbeats disappears. This is tighter than actor health (120s) because server availability is more critical to diagnose quickly.

### D3. CPU collection via `process.cpuUsage()` delta

**Decision:** Use the same `process.cpuUsage()` delta approach already used by agent containers, plus `os.loadavg()` as supplemental context.

**Rationale:** The agent heartbeat pipeline already uses `process.cpuUsage()` + `process.hrtime()` to compute CPU% as a delta between measurements (see `getResourceUsage()` in `apps/worker/src/agent.ts`, lines 1313-1337). This pattern is proven and understood. For server-level reporting, we extend it to measure the Node.js process CPU on the control-plane (API and worker processes).

However, `process.cpuUsage()` only measures the Node.js process, not the entire host. For a more complete picture (especially on the control-plane which runs Postgres, Redis, Caddy, etc.), we also report `os.loadavg()` — the 1/5/15-minute system load averages. These are free (single syscall, no sampling interval needed) and give the operator a sense of overall host saturation.

For browser-pool instances, CPU comes from the Browserless `/pressure` endpoint (`cpu` field) which reports Chromium-level CPU pressure — more meaningful than Node.js process CPU for a headless browser.

Memory collection uses the same cgroup-aware fallback chain: cgroup v2 → cgroup v1 → `os.totalmem()`/`os.freemem()` for host-level reporting. Inside containers, cgroup gives container-scoped memory; on bare processes, `os.*` gives host memory.

### D4. Custom metadata per server type

**Decision:** The snapshot includes a `metadata: Record<string, unknown>` field for type-specific metrics.

**Rationale:** Different server types have different interesting metrics:

| Server type | Custom metadata fields |
|---|---|
| **control-plane** | `runningAgentSessions`, `runningContainers`, `postgresStatus`, `redisStatus` |
| **agent-server** | `runningAgentContainers`, `nomadAllocations`, `availableMemoryMb` |
| **browser-pool** | `activeSessions`, `maxConcurrentSessions`, `queuedRequests`, `recentlyRejected`, `isAvailable` |
| **trading** | `activeConnections`, `openPositions`, `executionMode` (to be defined when trading ships) |

A generic `Record<string, unknown>` avoids coupling the domain type to every server type's specifics. The frontend can render known fields per server type and ignore unknown ones.

### D5. Replace the existing Resources section

**Decision:** Replace the current `AdminResourcesSection` (which shows single-host memory and disk) with a new `AdminServersSection` that shows all servers grouped by type, each with resource bars and type-specific metrics.

**Rationale:** Keeping both would be confusing — the old section would show the control-plane host's resources, and the new section would show it again as part of the multi-server view. The new section subsumes the old one entirely. The control-plane appears in the grouped view alongside other servers.

The "Overview" section's Postgres/Redis health indicators remain as-is — they're platform-level health, not server-level.

### D6. Publisher placement

**Decision:** The publisher runs in the API process for the control-plane, and as a new lightweight utility for other server types.

| Server type | Publisher location | Notes |
|---|---|---|
| **control-plane** | `apps/api/` startup — the API already has Redis access and runs on the control-plane host | Includes worker-derived metadata (running sessions, containers) by reading from Redis/DB |
| **agent-server** | Shell-based publisher on each Nomad client node, or a small Nomad system job that runs on every client | Agent nodes don't run Node.js application code; a shell script using `redis-cli` or a minimal Nomad system job is simpler than adding a Node.js process |
| **browser-pool** | Worker polls each Browserless instance's `/pressure` endpoint and publishes on its behalf | Browserless is a third-party image — we can't inject a publisher into it. The worker already resolves browser-pool addresses via Nomad service catalog |
| **trading** | Trading server process startup — same pattern as API | When it exists |

### D7. API endpoint design

**Decision:** New `GET /admin/servers` endpoint returns all server health snapshots grouped by type.

**Rationale:** A single endpoint that SCANs for `herobids:server-health:*` keys and returns them grouped. This is simpler than separate endpoints per type and matches how the frontend will render the data (grouped cards).

Response shape:

```ts
{
  servers: {
    'control-plane': ServerHealthSnapshot[];
    'agent-server': ServerHealthSnapshot[];
    'browser-pool': ServerHealthSnapshot[];
    'trading': ServerHealthSnapshot[];
  }
}
```

Empty arrays for types with no reporting servers.

---

## Implementation

### Phase 1: Domain types and Redis publisher for control-plane — DONE

**Effort:** ~2 hours
**Risk:** Low — additive, no existing behaviour changes.

#### Tasks

**1.1 — Define `ServerHealthSnapshot` type and key helpers**

New file: `packages/domain/src/infra/server-health.ts`

```ts
export const SERVER_TYPES = ['control-plane', 'agent-server', 'browser-pool', 'trading'] as const;
export type ServerType = typeof SERVER_TYPES[number];

export interface ServerHealthSnapshot {
  serverType: ServerType;
  serverId: string;
  hostname: string;
  memory: { totalBytes: number; usedBytes: number; freeBytes: number };
  disk: { totalBytes: number; usedBytes: number; freeBytes: number } | null;
  cpuPct: number | null;
  loadAvg: [number, number, number];
  uptimeSeconds: number;
  version: string;
  updatedAt: string; // ISO timestamp
  metadata: Record<string, unknown>;
}

export function serverHealthKey(serverType: ServerType, serverId: string): string {
  return `herobids:server-health:${serverType}:${serverId}`;
}

export function serverHealthKeyPattern(): string {
  return 'herobids:server-health:*';
}

export const SERVER_HEALTH_TTL_SECONDS = 60;
export const SERVER_HEALTH_PUBLISH_INTERVAL_MS = 15_000;
```

Export from `packages/domain/src/index.ts`.

**1.2 — Create `ServerHealthPublisher` utility**

New file: `packages/domain/src/infra/server-health-publisher.ts`

A reusable class that:
- Accepts a Redis client, `serverType`, `serverId`, `version`, and a `collectMetadata` callback.
- On a 15s interval, collects `os.totalmem()`, `os.freemem()`, `fs.statfsSync('/')`, CPU% via `process.cpuUsage()` delta (same pattern as agent.ts `getResourceUsage()`), `os.loadavg()`, and calls the metadata callback.
- Writes the JSON snapshot to Redis with `SET ... EX 60`.
- Has `start()` and `stop()` methods for lifecycle management.
- The `serverId` defaults to `os.hostname()` but can be overridden via env var `SERVER_ID`.

**1.3 — Wire publisher into the API process**

In `apps/api/src/index.ts`, after the Fastify server starts:

```ts
const publisher = new ServerHealthPublisher({
  redis,
  serverType: 'control-plane',
  serverId: process.env['SERVER_ID'] ?? os.hostname(),
  version: VERSION,
  collectMetadata: async () => ({
    runningAgentSessions: await getRunningSessionCount(db),
    postgresStatus: await checkPostgres(db),
    redisStatus: await checkRedis(redis),
  }),
});
publisher.start();
```

The metadata callback queries running session count from DB (lightweight, already done in `/admin/stats`) and Postgres/Redis health (already implemented as `checkPostgres`/`checkRedis` in admin.ts — extract into shared utilities).

#### Files Modified

| File | Changes |
|---|---|
| `packages/domain/src/infra/server-health.ts` | New — type definitions and key helpers |
| `packages/domain/src/infra/server-health-publisher.ts` | New — reusable publisher class |
| `packages/domain/src/index.ts` | Re-export new types |
| `apps/api/src/index.ts` | Start publisher on boot |
| `apps/api/src/routes/admin.ts` | Extract `checkPostgres`/`checkRedis`/`getDiskStats` into importable utilities |

#### Acceptance Criteria

- Publisher writes to Redis every 15s with correct key and TTL.
- Key expires after 60s if publisher stops.
- `pnpm lint` passes.
- `pnpm build` passes.

---

### Phase 2: API endpoint and frontend — DONE

**Effort:** ~3 hours
**Risk:** Low — additive endpoint, replaces one dashboard section.

#### Tasks

**2.1 — Add `GET /admin/servers` endpoint**

In `apps/api/src/routes/admin.ts`:
- Use `SCAN` (not `KEYS`) to find all `herobids:server-health:*` keys.
- `GET` each key, parse JSON, group by `serverType`.
- Return `{ servers: { 'control-plane': [...], 'agent-server': [...], ... } }`.

**2.2 — Add API client type and method**

In `apps/web/src/lib/api-client.ts`:
- Add `ServerHealthSnapshot` type (mirrors domain type).
- Add `admin.servers()` method calling `GET /admin/servers`.

**2.3 — Create `AdminServersSection` component**

New file: `apps/web/src/features/admin/AdminServersSection.tsx`

Layout: grouped by server type, each group has a heading with the type name and server count badge. Within each group, one card per server showing:

- Server ID / hostname (monospace)
- CPU % bar (or "—" if null, with load average as tooltip/subtitle)
- Memory bar (used/total with percentage, same colour thresholds as existing: green <65%, yellow 65-85%, red >85%)
- Disk bar (used/total, same thresholds)
- Uptime (formatted as days/hours)
- Version
- Type-specific metadata rendered as key-value pairs

Reuse existing `Card`, `Grid`, `KV` components and the `UsageBar` from `AdminResourcesSection`. Move `UsageBar` and `fmtBytes` into a shared utility if not already shared.

**2.4 — Replace Resources section in AdminPage**

In `AdminPage.tsx`:
- Add a query for `admin.servers()` with 15s refetch interval.
- Replace the "Resources" section with "Servers" section using `AdminServersSection`.
- Remove `AdminResourcesSection` import (the component file can be deleted or kept for reference).

**2.5 — Refactor `GET /admin/stats` to drop inline `os.*` calls**

The memory and disk data in `/admin/stats` was only used by `AdminResourcesSection`. Now that's replaced, remove the `memory` and `disk` fields from the stats response. Update `AdminOverviewSection` if it depends on them (check first — it may only use `counts`).

If `AdminOverviewSection` or other consumers still reference `memory`/`disk` from stats, keep the fields but mark them as deprecated in a comment — the Servers section is now the canonical source.

#### Files Modified

| File | Changes |
|---|---|
| `apps/api/src/routes/admin.ts` | New `GET /admin/servers` endpoint |
| `apps/web/src/lib/api-client.ts` | Add `ServerHealthSnapshot` type and `admin.servers()` |
| `apps/web/src/features/admin/AdminServersSection.tsx` | New — multi-server grouped display |
| `apps/web/src/features/admin/AdminPage.tsx` | Replace Resources section with Servers, add query |
| `apps/web/src/features/admin/AdminResourcesSection.tsx` | Remove or deprecate |
| `apps/api/src/routes/admin.ts` | Optionally remove `memory`/`disk` from stats response |

#### Acceptance Criteria

- `GET /admin/servers` returns grouped server snapshots.
- Dashboard shows servers grouped by type with resource bars.
- Control-plane server appears with memory, disk, CPU, and metadata.
- Server types with no reporters show an empty state (not an error).
- `pnpm lint` passes.
- `pnpm build` passes.

---

### Phase 3: Agent-server reporting — DONE

**Effort:** ~2 hours
**Risk:** Low — runs on Nomad client nodes, no impact on control-plane.

#### Tasks

**3.1 — Create agent-node health publisher script**

New file: `infra/hetzner/scripts/agent-node-health.sh`

A lightweight shell script that:
- Reads system metrics via standard Linux tools (`free`, `df`, `nproc`, `/proc/loadavg`, `/proc/stat` for CPU%).
- Builds a JSON `ServerHealthSnapshot` with `serverType: "agent-server"`, `serverId` from hostname.
- Metadata: `nomadAllocations` (from `nomad node status -self -json | jq '.Allocations | length'`), `availableMemoryMb` (from `free`).
- Writes to Redis via `redis-cli -u $REDIS_URL SET herobids:server-health:agent-server:$(hostname) '$JSON' EX 60`.
- Runs once per invocation (invoked by systemd timer).

This approach avoids adding a Node.js process to agent nodes (which only run Docker + Nomad client).

**3.2 — Add systemd units to `cloud-init-nomad-client.yaml`**

Add `agent-node-health.service` (oneshot) and `agent-node-health.timer` (every 15s) to the Nomad client cloud-init, following the same pattern as the autoscale units.

Environment variables: `REDIS_URL` (control-plane Redis, accessible over private network).

**3.3 — Install `redis-cli` on agent nodes**

Add `redis-tools` (or `redis`) to the `packages` list in `cloud-init-nomad-client.yaml`.

#### Files Modified

| File | Changes |
|---|---|
| `infra/hetzner/scripts/agent-node-health.sh` | New — shell-based health publisher |
| `infra/hetzner/cloud-init-nomad-client.yaml` | Add systemd units, add redis-tools package |

#### Acceptance Criteria

- Script runs on a Linux machine with `redis-cli`, `free`, `df`, `jq` installed.
- Redis key is written with correct format and 60s TTL.
- Agent nodes appear in the admin dashboard under "agent-server" group.

---

### Phase 4: Browser-pool reporting — DONE

**Effort:** ~1.5 hours
**Risk:** Low — reads from existing Browserless `/pressure` endpoint; additive.

#### Tasks

**4.1 — Add browser-pool health publisher to the worker**

The worker already resolves browser-pool instance addresses via the Nomad service catalog (or static URL in dev). Add a periodic task in the worker that:
- Resolves all browser-pool instance addresses (in dev: single static URL; in production: Nomad service catalog query for all healthy instances).
- For each instance, calls `GET /pressure` (with fallback to `GET /config` + `GET /sessions` per the browser-pool autoscale plan's D2 decision).
- Publishes a `ServerHealthSnapshot` per instance to Redis with `serverType: "browser-pool"`, `serverId` derived from the instance address.
- Metadata: `activeSessions` (running), `maxConcurrentSessions`, `queuedRequests`, `recentlyRejected`, `isAvailable`, `cpuPressure` (from `/pressure` `cpu` field), `memoryPressure` (from `/pressure` `memory` field).

This runs on a 15s interval, aligned with the health publish cadence.

**4.2 — Handle dev environment**

In development (Docker Compose), browser-pool runs as a single container at a static URL (`http://browser-pool:3000`). The publisher should work with either static URL or Nomad service discovery — same resolution logic already exists in the worker's `ServiceRegistry`.

#### Files Modified

| File | Changes |
|---|---|
| `apps/worker/src/browser-pool-health-publisher.ts` | New — polls Browserless instances and publishes to Redis |
| `apps/worker/src/index.ts` | Start browser-pool health publisher on boot (if browser-pool is enabled) |

#### Acceptance Criteria

- Browser-pool instances appear in the admin dashboard under "browser-pool" group.
- Metadata shows active sessions, max concurrent, queued count.
- Publisher handles `/pressure` unavailability gracefully (falls back to `/config` + `/sessions`).
- Publisher handles browser-pool being disabled (no-op).
- `pnpm lint` passes.

---

### Phase 5: Trading server reporting (future) — DONE (N/A — trading server does not exist yet)

**Effort:** ~30 min when the trading server exists.
**Risk:** N/A — not yet applicable.

#### Tasks

**5.1 — Wire publisher into trading server startup**

Same pattern as Phase 1.3: instantiate `ServerHealthPublisher` with `serverType: 'trading'` and a metadata callback that reports trading-specific metrics (active connections, open positions, execution mode).

This is a single integration point — the reusable publisher class from Phase 1.2 handles everything else.

#### Acceptance Criteria

- Trading server appears in the admin dashboard under "trading" group when running.

---

## Server Health Snapshot Schema

```ts
interface ServerHealthSnapshot {
  serverType: 'control-plane' | 'agent-server' | 'browser-pool' | 'trading';
  serverId: string;          // os.hostname() or env var override
  hostname: string;          // always os.hostname()
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
  };
  disk: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
  } | null;
  cpuPct: number | null;     // process.cpuUsage() delta for Node.js; /proc/stat for shell; /pressure for browser-pool
  loadAvg: [number, number, number]; // os.loadavg() or /proc/loadavg
  uptimeSeconds: number;     // process.uptime() or system uptime
  version: string;           // app version or "n/a" for infra-only nodes
  updatedAt: string;         // ISO 8601
  metadata: Record<string, unknown>; // type-specific extras
}
```

## Redis Key Scheme

```
herobids:server-health:control-plane:cp-prod-01     TTL 60s
herobids:server-health:agent-server:agent-prod-01   TTL 60s
herobids:server-health:agent-server:agent-prod-02   TTL 60s
herobids:server-health:browser-pool:bp-10.0.0.5     TTL 60s
herobids:server-health:trading:trading-prod-01       TTL 60s
```

## Dashboard Layout

```
┌─ Servers ─────────────────────────────────────────────────────────────┐
│                                                                       │
│  control-plane (1)                                                    │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │ cp-prod-01  │ CPU 18% ████░░░░░░  │ Mem 5.2/8 GB ██████░░░ 65% │ │
│  │             │ Disk 42/80 GB ████░░░░░ 53%  │ Up 12d 4h │ v1.8.0│ │
│  │             │ Sessions: 3  │ Postgres: ok  │ Redis: ok           │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  agent-server (2)                                                     │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │ agent-01  │ CPU 45% ████████░░  │ Mem 12/16 GB ██████████░ 75% │ │
│  │           │ Disk 8/40 GB ██░░░░░░░ 20%  │ Up 3d 8h │ Allocs: 4 │ │
│  ├──────────────────────────────────────────────────────────────────┤ │
│  │ agent-02  │ CPU 22% ████░░░░░░  │ Mem 8/16 GB ████████░░░ 50% │ │
│  │           │ Disk 6/40 GB █░░░░░░░░ 15%  │ Up 1d 2h │ Allocs: 2 │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  browser-pool (1)                                                     │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │ bp-10.0.0.5  │ CPU 8%  │ Mem pressure: 62%  │ Sessions: 1/2    │ │
│  │              │ Queued: 0  │ Rejected: 0  │ Available: yes        │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  trading (0)                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │ No trading servers reporting.                                    │ │
│  └──────────────────────────────────────────────────────────────────┘ │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## Effort Summary

| Phase | Scope | Effort |
|---|---|---|
| 1 | Domain types + control-plane publisher | ~2 hours |
| 2 | API endpoint + frontend | ~3 hours |
| 3 | Agent-server reporting (shell script + systemd) | ~2 hours |
| 4 | Browser-pool reporting (worker-side poller) | ~1.5 hours |
| 5 | Trading server (future, when it exists) | ~30 min |
| **Total** | | **~9 hours** |

Phases 1-2 are the core — after those, the control-plane appears in the dashboard and the architecture is proven. Phases 3-4 add coverage for the remaining server types and can be done incrementally.

---

## Open Questions

None — all clarifying questions have been resolved during planning.
