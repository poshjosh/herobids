# Phase 2: Autoscaler capacity on the admin dashboard

Roadmap: [`000-roadmap.md`](./000-roadmap.md). Depends on phase 1
([`001-agent-server-health.md`](./001-agent-server-health.md)) for the `NomadClient`
node reads.

## Problem

Operators have no dashboard visibility into cluster capacity: how many agent nodes are
running, the scale-out ceiling (`max_agent_nodes`), and how many free agent slots
remain. That data lives only in Nomad (live), Terraform state / tfvars (`max_agent_nodes`,
`agent_memory_reservation_mb`), and a host file on the control plane
(`/var/run/nomad-autoscale-node-count`). None of it reaches the app. "Containers per
node" (phase 1) tells an operator what is running; capacity tells them what is about to
break — this is the higher-value signal.

## Goal

Surface, on the admin dashboard: current ready agent nodes, `max_agent_nodes`
(ceiling), and free agent slots / free memory — so an operator sees headroom and
proximity to the ceiling at a glance.

## Non-goals

- Never trigger scaling. Read/display only.
- No scraping of autoscaler host files or shelling out to scripts (brittle; couples the
  app to infra file layout). Compute live capacity in TypeScript from the same Nomad
  reads the script uses.
- No new Nomad plumbing beyond phase 1's methods.

## Approach

### 1. Reuse phase 1's Nomad node reads to compute capacity

A pure helper (worker side) replicates `check-nomad-capacity.sh`'s math over the ready
agent nodes phase 1 already enumerates: per node, `free_memory_mb` =
total − reserved − allocated; `free_slots` = `floor(free_memory_mb /
agentMemoryReservationMb)` summed per node (never pool fragments across nodes, matching
the script). Output: `{ readyNodes, freeSlots, freeMemoryMb, totalMemoryMb }`.

Factor phase 1's per-node parsing so this helper consumes the same parsed node objects
— the whole reason phases share the foundation.

### 2. Make `max_agent_nodes` and the reservation readable by the app (config)

These are Terraform vars today, not app config. Thread them in as **operator config**
per `docs/best-practices/configuration.md`:

- Add to the config schema + `config/default.yaml` under `nomad` (or a new
  `agentCapacity` block), e.g. `maxAgentNodes`, and reuse the existing
  `agentMemoryReservationMb` notion (align with the autoscaler's
  `NOMAD_AGENT_MEMORY_RESERVATION_MB` / `agent_memory_reservation_mb`).
- Add env overrides and update **every** `.env*.example` twin in the same change
  (`.env.example`, `infra/hetzner/.env.environment.example`) with a one-line comment —
  the `.example` twins are the committed source of truth (AGENTS.md).
- Source of truth caution: the real ceiling is enforced by Terraform. Document that the
  dashboard value mirrors operator config and can disagree with live TF if misconfigured;
  do not present it as authoritative enforcement.

### 3. Publish capacity + expose to the dashboard

Two viable shapes — pick in implementation review:

- **(a) A `trading`-style extra snapshot** reusing `/admin/servers`: publish a single
  capacity snapshot (e.g. a synthetic `serverId` under a capacity-oriented group) and
  render it. Cheapest plumbing, but bends the "one snapshot per server" meaning.
- **(b) A dedicated read**: worker publishes a `herobids:cluster-capacity` JSON to
  Redis; add `GET /admin/capacity` (reader, `requireAdmin`) + `AdminCapacitySection.tsx`
  + a `useQuery` and section in `AdminPage.tsx`. Cleaner semantics; slightly more code.

Recommended: **(b)** — capacity is a cluster fact, not a per-server health row, and a
dedicated section reads better. Keep the API a pure Redis reader (roadmap).

### 4. Render

A compact capacity panel: `Nodes R / max M` (highlight as R approaches M), `Free slots
N`, `Free memory X / Y`. Reuse the `UsageBar` pattern from `AdminServersSection.tsx` for
nodes-vs-max and memory. No-op / "capacity unavailable" when not on Nomad.

## Files

- `apps/worker/src/agents/nomad-client.ts` — (none new; reuses phase 1 methods).
- Worker capacity helper + publisher (new) + tests.
- `packages/domain` config schema + `config/default.yaml` — `maxAgentNodes` etc.
- `apps/worker/src/config.ts` — env overrides.
- `.env.example`, `infra/hetzner/.env.environment.example` — twin updates (+ `.gitignore`
  un-ignore only if a new twin is introduced).
- If shape (b): `apps/api/src/routes/admin.ts` (+ api-client type + `admin.capacity()`),
  `apps/web/src/features/admin/AdminCapacitySection.tsx`, `AdminPage.tsx`.

## Testing

- Capacity math helper: free slots per node, summed, no fragment pooling; zero ready
  nodes → zero capacity, not error; missing figure fails that cycle fail-soft.
- Config: schema parse of `maxAgentNodes`; env override applied; fail-fast on invalid
  operator value (Zod at startup, per config best-practices).
- API reader + section render (shape b): endpoint returns the snapshot; section renders
  nodes/slots/memory and the "unavailable" state.

## Verification

`pnpm lint`; worker + api + web vitest for touched areas; manual on a Nomad env
confirming the numbers match `check-nomad-capacity.sh --json` on the same cluster.

## Effort

~2–2.5 days on top of phase 1 (most of the Nomad reads already exist; config threading +
the new read/section are the work). Standalone (without phase 1) it would be ~3–3.5.

## Risks / notes

- Two sources of "max": operator config vs. Terraform-enforced ceiling. Keep them named
  consistently and document the dashboard mirrors config, not live TF state.
- Reconciling the dashboard's live `free_slots` with the autoscaler's own reading: both
  derive from the same Nomad reads and the same reservation constant, so they should
  agree; call out in tests/docs that divergence means a config drift between
  `agentMemoryReservationMb` and `NOMAD_AGENT_MEMORY_RESERVATION_MB`.
- Keep this strictly read-only; it must never be able to initiate a scale action.
