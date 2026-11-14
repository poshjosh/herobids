# Browser-pool per-node session utilization (admin dashboard)

## Problem

The admin dashboard's Servers section shows one card per browser-pool instance, but
the session view is a flat `Sessions N/M` text KV with no sense of how close a node
is to capacity, and there is no fleet-level total. An operator cannot see at a glance
which browser node is saturated or how much headroom the pool has overall.

All the data needed already arrives per instance in the health snapshot `metadata`:
`activeSessions`, `maxConcurrentSessions`, `queuedRequests`, `recentlyRejected`,
`isAvailable`, `cpuPressure`, `memoryPressure`. This is a presentation gap, not a
data gap.

## Goals

- Show per-node session utilization as a bar with a percentage, coloured by pressure
  (reuse the existing `UsageBar` thresholds: >85% danger, >65% warning).
- Highlight a node that is at or near capacity, or reporting `isAvailable: false`.
- Show a pool-level aggregate: total active sessions / total max across reporting
  instances, plus total queued and total recently-rejected.
- Keep queued / rejected / availability visible per node (they are the pressure
  signals that explain a high bar).

## Non-goals

- No new API endpoint, publisher, config, or data source. This is frontend-only; the
  data already lands via `GET /admin/servers`.
- No count of underlying OS/Docker containers per browser node (Browserless only
  reports session pressure, not containers). "Sessions" is the browser-pool unit of
  work and the right thing to show.
- No change to the agent-server / control-plane / trading cards.
- No change to the publish interval or snapshot shape.

## Current state (what exists today)

- `apps/web/src/features/admin/AdminServersSection.tsx`
  - `BrowserPoolResourceBars` renders a CPU bar (`cpuPct` = `cpuPressure`) and a
    memory-pressure text line only.
  - `renderMetadata` has a browser-pool branch that builds a single
    `Sessions {active}/{max}` KV and then lists `queuedRequests` (Queued),
    `recentlyRejected` (Rejected), `isAvailable` (Available). It skips
    `activeSessions`, `maxConcurrentSessions`, `memoryPressure` from the generic loop.
  - `UsageBar({ used, total, label })` already computes pct and colour; reuse it.
- `apps/worker/src/browser-pool-health-publisher.ts` publishes one snapshot per
  instance with the metadata fields above. No change needed.
- Types: `ServerHealthSnapshot` / `AdminServersResponse` in
  `apps/web/src/lib/api-client.ts`. `metadata` is `Record<string, unknown>`, so reads
  must narrow to `number`/`boolean` defensively. No type change required.

## Approach

Frontend-only, isolated to `AdminServersSection.tsx`, with pure helpers extracted so
they can be unit-tested without rendering.

### 1. Extract a typed reader for browser-pool metadata

Add a small pure helper (same file, or a sibling `browser-pool-metrics.ts` if it keeps
the component lean) that narrows the untyped `metadata` into a typed shape:

```
interface BrowserPoolMetrics {
  activeSessions: number | null;
  maxConcurrentSessions: number | null;
  queuedRequests: number | null;
  recentlyRejected: number | null;
  isAvailable: boolean | null;
  memoryPressure: number | null;
}
function readBrowserPoolMetrics(metadata: Record<string, unknown>): BrowserPoolMetrics
```

Guard every field (`typeof x === 'number' ? x : null`) — `metadata` is
`Record<string, unknown>` and a stale or partial snapshot must not throw.

### 2. Per-node session utilization bar

In `BrowserPoolResourceBars`, add a Sessions bar beside CPU and memory pressure:

- When `activeSessions` and `maxConcurrentSessions` are both present and max > 0,
  render `UsageBar(used=active, total=max, label="Sessions")` with the `N/M` and `%`
  underneath (mirror the Memory line in `StandardResourceBars`).
- When max is 0 or missing, fall back to the current `Sessions N/M` text (no divide-by-
  zero; `UsageBar` already guards `total > 0` but we should not imply 0% capacity).
- Near-capacity / unavailable indicator: if utilization ≥ a threshold (reuse the 85%
  danger line) OR `isAvailable === false` OR `queuedRequests > 0`, show a small
  "saturated" / "unavailable" badge on the card header so it stands out in the list.

### 3. De-duplicate the session KV

Once the bar shows sessions, drop the `Sessions N/M` KV from `renderMetadata`'s
browser-pool branch to avoid showing the same number twice. Keep Queued, Rejected,
Available as KVs (they are not on the bar). Update the skip-list comment accordingly.

### 4. Pool-level aggregate header

Above the browser-pool cards (only for the `browser-pool` group), render a one-line
summary computed from that group's snapshots:

- `Pool: {sumActive}/{sumMax} sessions ({pct}%)`, `Queued {sumQueued}`,
  `Rejected {sumRejected}`, and `{availableCount}/{total} available`.
- Sum only over instances that report the field; ignore `null`s. If no instance
  reports max, omit the utilization figure rather than show `0/0`.

Implement this as a pure `summarizeBrowserPool(servers: ServerHealthSnapshot[])` helper
returning the aggregate numbers, so the heading is a dumb renderer and the math is
unit-tested. The simplest wiring is to special-case the `browser-pool` group inside the
existing `ORDERED_TYPES.map(...)` to render the summary line under the group heading
(next to the existing count badge) before the card list.

## Files to change

- `apps/web/src/features/admin/AdminServersSection.tsx` — the bar, the aggregate
  header, the KV de-dup. Possibly extract helpers to a sibling module.
- `apps/web/src/features/admin/browser-pool-metrics.ts` (new, optional) — pure
  `readBrowserPoolMetrics` + `summarizeBrowserPool` if we keep them out of the TSX.
- `apps/web/src/features/admin/browser-pool-metrics.test.ts` (new) — unit tests for
  the two pure helpers.

No changes to `apps/api`, `apps/worker`, `packages/*`, config, or `.env` twins.

## Testing

Unit (vitest, pure helpers — behavior-named):

- `readBrowserPoolMetrics`:
  - reads all fields when present and correctly typed
  - returns `null` for missing fields and for wrong-typed values (e.g. string where a
    number is expected) without throwing
- `summarizeBrowserPool`:
  - sums active/max/queued/rejected across instances, ignoring `null`s
  - counts available instances
  - omits utilization when no instance reports a max (no `0/0`, no divide-by-zero)
  - empty input yields an empty/zeroed summary, not `NaN`

Component / manual:

- Existing admin section tests (`apps/web/src/features/admin/*.test.tsx`) still pass.
- Manual: with the worker's browser-pool publisher running (dev: static
  `browserPool.url`), open `/admin` as an admin and confirm the Sessions bar, the
  near-capacity/unavailable badge, and the pool summary line render and match the
  per-card numbers. Confirm the number is not shown twice.

## Verification

- `pnpm lint` (tsc --noEmit) passes.
- `pnpm --filter @herobids/web test` (or the web vitest run) passes, including the new
  helper tests.

## Effort

Small — about 0.5 to 1 day. No backend, no data-source, no config work.

## Risks / notes

- `metadata` is untyped (`Record<string, unknown>`); the typed reader must guard every
  field. A stale snapshot with a missing field must degrade (show `—` / omit), never
  throw.
- Avoid divide-by-zero and `NaN` when `maxConcurrentSessions` is 0 or missing.
- In dev with a single static Browserless URL there is one card; the aggregate line is
  still correct (sum of one). The multi-instance path only differs in prod (Nomad
  service discovery), so cover multi-instance in the unit tests rather than relying on
  dev to exercise it.
- Keep styling consistent with the existing inline-style conventions in this file
  (no new styling system introduced for one section).
