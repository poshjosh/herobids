# Phase 1: Agent-server health + containers per agent node

Roadmap: [`000-roadmap.md`](./000-roadmap.md). Read it first for the shared Nomad
foundation and the "runs on the worker, publishes to Redis" decision.

## Problem

The admin dashboard's Servers section has an `agent-server` group, but nothing
publishes it, so it always renders "No servers reporting." Operators cannot see how
many agent nodes exist, how loaded each is, or how many agent containers/allocations
each node is running. The only agent-container figure anywhere is the control-plane's
`runningContainers`, which is a single Docker-socket count on the API host — not a
per-node fleet view, and misleading in a multi-node Nomad deployment.

## Goal

Populate the `agent-server` group with one card per agent node, showing per-node
resource usage and the number of agent allocations (containers) on that node, sourced
from Nomad via the worker.

## Non-goals

- No autoscaler/capacity numbers (nodes-vs-max, free slots) — that is phase 2.
- No OS/Docker container counts beyond Nomad allocations.
- No API↔Nomad wiring; the worker owns the Nomad reads (see roadmap).
- No new dashboard group or route — this fills the existing `agent-server` group that
  `/admin/servers` and `AdminServersSection.tsx` already handle.

## Approach

### 1. Extend `NomadClient` with node reads (shared foundation)

In `apps/worker/src/agents/nomad-client.ts`, add read-only methods on top of the
existing authenticated `request()`:

- `listNodes()` → `GET /v1/nodes`
- `getNode(id)` → `GET /v1/node/{id}`
- `getNodeAllocations(id)` → `GET /v1/node/{id}/allocations`

Port the node filter from `infra/hetzner/scripts/check-nomad-capacity.sh`: keep nodes
with `Status == "ready"`, `SchedulingEligibility == "eligible"`, `NodeClass == "agent"`,
and `Meta.node_pool == <pool>` (pool from `nomad` config). Parse defensively — a Nomad
error body is not an empty cluster; treat non-array / missing fields as a failure to
report for that node, never as zero (mirror the script's "refuse to report partial
capacity" stance, but fail-soft at the publisher level: skip this cycle, keep the last
snapshot until TTL).

These three methods are the foundation phase 2 reuses; keep them generic and well
unit-tested here.

### 2. Agent-server health publisher (worker)

New `apps/worker/src/agent-server-health-publisher.ts`, following the
`BrowserPoolHealthPublisher` shape (constructor-injected `redis`, `nomadClient`,
`logger`, `appVersion`; `start()`/`stop()`; 15s interval; TTL 60s). Per ready agent
node, publish one `ServerHealthSnapshot`:

- `serverType: 'agent-server'`, `serverId` = node ID or node name, `hostname` = node
  name.
- `memory` from the node's `NodeResources` (total) minus allocated (used) — same
  figures the capacity script derives per node.
- `cpuPct`/`loadAvg`: Nomad does not expose live host CPU%; set `cpuPct: null` and
  `loadAvg: [0,0,0]` unless a cheap source exists. Do not fake it.
- `metadata`: `{ nomadAllocations, availableMemoryMb }` — the two keys the dashboard
  already has labels for ("Allocations", "Free Memory"). `nomadAllocations` = count of
  running+pending agent allocations on the node (the "containers per node" figure).

Gate on `runtimeBackend === 'nomad'` and a present `nomadClient`; otherwise the
publisher is a no-op (roadmap invariant).

### 3. Wire into worker startup

In `apps/worker/src/index.ts`, construct and `start()` the publisher next to
`BrowserPoolHealthPublisher`, passing the same `nomadClient`. Add `stop()` to the
existing shutdown paths (the two `browserPoolHealthPublisher?.stop()` sites).

### 4. Frontend

Likely **zero** change: `AdminServersSection.tsx` already renders standard resource
bars for non-browser-pool types and already maps `nomadAllocations`/`availableMemoryMb`
labels. Confirm the card reads well; only adjust if `cpuPct: null` or the metadata
needs nicer formatting. Keep any change minimal.

## Files

- `apps/worker/src/agents/nomad-client.ts` — new node-read methods (+ its test).
- `apps/worker/src/agent-server-health-publisher.ts` (new) + test.
- `apps/worker/src/index.ts` — construct/start/stop wiring.
- `apps/web/src/features/admin/AdminServersSection.tsx` — only if formatting needs it.
- No config/`.env` changes (reuses existing `nomad.*`).

## Testing

- `NomadClient` node reads: parse a nodes array, filter by status/eligibility/class/pool,
  count allocations; reject non-array/error bodies without throwing.
- Publisher: one snapshot per ready node with correct `nomadAllocations` and
  `availableMemoryMb`; no-op when backend is not nomad or `nomadClient` is undefined;
  fail-soft on a Nomad error (no throw, no partial/zeroed snapshot).
- Behavior-named tests, consistent with `browser-pool-health-publisher.test.ts`.

## Verification

`pnpm lint`; worker vitest for the new files; web vitest if the section changed;
manual check on a Nomad env (and stub-mode no-op). See roadmap baseline.

## Effort

~1.5–2 days (the Nomad node reads + filter are the bulk; publisher and wiring mirror an
existing one).

## Risks / notes

- Fail-soft vs. the script's fail-hard: the autoscaler *must* refuse partial capacity;
  a dashboard publisher should instead skip a cycle and let the last snapshot expire —
  decide and encode this explicitly so a flaky node read does not blank the group.
- `cpuPct` is honestly unavailable from Nomad; prefer `null` over a fabricated number.
- Node identity: prefer a stable, human-readable `serverId` (node name) over the raw
  Nomad UUID where available, for a readable card.
