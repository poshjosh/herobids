# Agent fleet visibility on the admin dashboard — roadmap

Two related admin-dashboard improvements that share one foundation. This roadmap
holds the shared context; each phase has its own plan file. Do them in order —
phase 2 reuses the Nomad node queries phase 1 builds.

- Phase 1: [`001-agent-server-health.md`](./001-agent-server-health.md) — agent-server
  health + containers/allocations per agent node.
- Phase 2: [`002-autoscaler-capacity.md`](./002-autoscaler-capacity.md) — cluster
  capacity (nodes vs. max, free slots) surfaced to the dashboard.

Sibling feature (already shipped, same dashboard section):
[`../001-browser-pool-utilization/plan.md`](../001-browser-pool-utilization/plan.md).

## Why one roadmap, two phases

The two phases share their hardest, riskiest component: new `NomadClient` methods to
list nodes and read per-node allocations. Phase 1 needs them to count
containers/allocations per agent node; phase 2 reuses the same reads to compute live
free slots. Designing that foundation once — and gating both phases on the same
reachability question — is why these live under one roadmap rather than two
independent plans. They stay separate *phases* (not one merged plan) because they
publish different things, phase 2 drags in operator config that phase 1 does not, and
each should ship and be reviewed on its own.

## Resolved gating question: where the Nomad queries run

The original open question was whether the control-plane **API** could reach Nomad.
Verified answer: **no for the API, yes for the worker.**

- `apps/api` has zero Nomad wiring — no `NOMAD_ADDR`/`NOMAD_TOKEN`, no `NomadClient`.
- `apps/worker` already constructs a `NomadClient` with addr + token
  (`apps/worker/src/index.ts`, gated on `runtimeBackend === 'nomad'`) and already
  passes it into `BrowserPoolHealthPublisher`. Env is wired in
  `apps/worker/src/config.ts` (`NOMAD_ADDR` → `nomad.addr`, `NOMAD_TOKEN` →
  `nomad.token`) and set in production via `infra/hetzner/.env.environment.example`.

**Decision: both phases build on the worker's existing `NomadClient` and publish to
Redis; the admin API stays a reader.** This matches the current architecture — the API
`/admin/servers` route already reads `ServerHealthSnapshot`s from Redis
(`herobids:server-health:*`) and the dashboard already renders them. It removes the
biggest risk (no new API↔Nomad networking, config, or token plumbing).

## Shared foundation (built in phase 1, reused in phase 2)

New read-only methods on `NomadClient` (`apps/worker/src/agents/nomad-client.ts`),
using the existing authenticated `request()`:

- `listNodes()` → `GET /v1/nodes`
- `getNode(id)` → `GET /v1/node/{id}` (node class, pool, `NodeResources`, status)
- `getNodeAllocations(id)` → `GET /v1/node/{id}/allocations`

The in-repo reference for exactly these calls and the node-filter logic is the
autoscaler script `infra/hetzner/scripts/check-nomad-capacity.sh`: it enumerates
`/v1/nodes`, keeps nodes where `Status == "ready"`, `SchedulingEligibility ==
"eligible"`, `NodeClass == "agent"`, and `Meta.node_pool == <pool>`, then reads each
node's allocations. Phase 1 ports that filter into TypeScript; phase 2 reuses it to
compute free slots the same way the script does (`free_slots = free_memory /
agent_memory_reservation_mb`, summed per node, never pooling fragments across nodes).

## Invariant for both phases: degrade when not on Nomad

`NomadClient` only exists when `runtimeBackend === 'nomad'`. In `docker`/`stub` mode
there is no client. Both publishers must no-op gracefully in that case (publish
nothing, log at most once), exactly like the browser-pool publisher degrades when it
cannot resolve instances. The dashboard groups already render "No servers reporting."
for an empty group, so absence is handled end to end.

## Shared architecture (both phases)

Worker-side publisher → Redis snapshot → existing admin read → dashboard section.

- Publisher runs in `apps/worker` on the `SERVER_HEALTH_PUBLISH_INTERVAL_MS` (15s)
  cadence, writing TTL'd (`SERVER_HEALTH_TTL_SECONDS`, 60s) JSON to Redis, reusing the
  `ServerHealthPublisher` base or its pattern (`packages/domain/src/infra/`).
- `GET /admin/servers` (`apps/api/src/routes/admin.ts`) already SCANs
  `herobids:server-health:*` and groups by `serverType` over `SERVER_TYPES`
  (`control-plane`, `agent-server`, `browser-pool`, `trading`). No route change needed
  for phase 1 (it fills the existing empty `agent-server` group). Phase 2 adds a new
  read for capacity (either a new `serverType`-shaped snapshot or a dedicated endpoint —
  decided in its plan).
- The dashboard already has `agent-server` labels wired in `AdminServersSection.tsx`
  (`nomadAllocations` → "Allocations", `availableMemoryMb` → "Free Memory").

## Out of scope for both

- No per-node Docker/OS container counts beyond what Nomad reports as allocations.
- No changes to autoscaler behaviour; phase 2 only *reads/surfaces* capacity, it never
  triggers scaling.
- No mirroring of trading state; this is operator/infra visibility only.

## Verification baseline (both phases)

`pnpm lint` clean; new worker unit tests for the Nomad parsing/aggregation; web tests
for any new/changed dashboard rendering; manual check on a Nomad-backed environment
(dev with `runtimeBackend` stub confirms graceful no-op).
