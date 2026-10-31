# Capacity fixtures (synthetic)

**P0 status: NOT complete. Synthetic fixtures and baseline only; live effective config capture and baseline phase timings are outstanding.**

These JSON files are **synthetic and sanitized**. They are modelled on the Nomad HTTP API response
shapes (`/v1/evaluations`, `/v1/nodes`, `/v1/node/{id}`, `/v1/node/{id}/allocations`) as recalled from
memory, and on a generic cloud-server inventory. The shapes are **unverified** against the Nomad API
docs. The repo pins Nomad 1.9.7 (`staging.tfvars:59`, `production.tfvars:58`). The files are **NOT
captured from live staging or production**.

Conventions:

- All IDs are placeholder UUIDs (`00000000-0000-4000-8000-…`). No real node, job, eval, server or
  token values appear anywhere.
- Addresses use RFC 5737 documentation ranges (`192.0.2.0/24`), which are not real hosts.
- Resources use Nomad scheduler units: memory in MB, CPU in MHz (`CpuShares`).
- Window-based tests must fake the clock. `CreateTime` values are fixed at 2026-10-30T22:40:00Z, so the
  300-second placement-failure window (`check-placement-failures.sh:36`) only matches while the wall
  clock is within it.

## Files

| File | Covers |
| --- | --- |
| `nomad-evaluations.json` | `herobids-agents` namespace blocked eval with a UUID `BlockedEval`, a generic `StatusDescription` and a `FailedTGAllocs` memory-exhaustion diagnostic. A `default`-namespace decoy with the same blocked shape. A completed eval that must not be counted. |
| `nomad-nodes.json` | Node list (ready, eligible, down) and node-detail resources (`NodeResources`, `ReservedResources`) in scheduler units. |
| `nomad-node-allocations.json` | Current-shape running agent (`AllocatedResources.Tasks`). Legacy-shape running agent (`Resources.Memory`). Assigned-pending agent still downloading its image (`AllocatedResources` is null; see Assumptions). Running Browserless reservation in the `default` namespace. Failed allocation replaced by a running one (`NextAllocation` / `PreviousAllocation`). |
| `cloud-inventory.json` | Four servers: healthy, healthy, down (joined but Nomad `down`), and unjoined (present in cloud, absent from Nomad). |

P2 fixtures (synthetic, unverified against Nomad 1.9.7; server names are `synth-agent-N` in pool `synth`,
environment `synthetic`):

| File | Covers |
| --- | --- |
| `cloud-empty.json` | No managed servers (zero case). |
| `cloud-healthy.json` | Two managed agent servers, both `running`. |
| `cloud-mixed.json` | Running, initializing, and deleting agent servers, plus an other-environment server that must be ignored. |
| `cloud-gap.json` | Non-contiguous indices (1 and 3), which must block. |
| `cloud-mismatch.json` | A same-env server with `role=worker` instead of `agent`, which fails the ownership shape check. |
| `cloud-page-1.json`, `cloud-page-2.json` | One inventory split across two pages (pagination). |
| `nomad-empty.json` | Empty node list (zero Nomad nodes). |
| `nomad-healthy.json` | Two ready, eligible agent nodes that match `cloud-healthy.json`. |
| `nomad-mixed.json` | One ready and one down agent node, plus a non-agent node. |
| `nomad-joined-not-ready.json` | One agent node ready but ineligible, and one still initializing. |
| `nomad-orphan-live.json`, `nomad-orphan-down.json` | A live or down `synth-agent-9` with no cloud server. |
| `nomad-not-array.json` | A JSON object instead of an array, which must be treated as a fetch error. |
| `inflight-corrupt.json`, `inflight-unsupported.json`, `inflight-other-env.json` | Corrupt, unsupported-version, and other-environment in-flight records. |

## Consumers

- `tests/test-capacity-inventory.sh` (P2 reconcile and fetch), `tests/test-capacity-inflight-state.sh`
  (durable in-flight state, reboot), and `tests/test-capacity-readonly.sh` (dry-run mutation guard, which
  serves `nomad-healthy.json` as the `/v1/nodes` response). Each suite's header and `FX` references list
  the exact files it reads.
- Nothing in the live scale path reads these files. The P2 library (`scripts/capacity-inventory.sh`) is
  not yet called by `scale-out.sh` or `scale-in.sh`. That wiring is P4.
- No scaling logic was added in P0.

## Shapes exercised (observations for later packages, not fixed in P0)

These are read-only observations from the current source. They are recorded so later work packages
can test against them. P0 does not change any of this behaviour.

- `check-placement-failures.sh` calls `GET /v1/evaluations` at line 154 with no `namespace` parameter,
  and its jq filter (lines 187-198) has no namespace filter. The keyword test (lines 194-195) matches
  `BlockedEval` and `StatusDescription` against `resource|exhaust|capacity|memory|cpu`.
- Against the fixtures, the current script counts the `default` decoy (StatusDescription "resources
  exhausted on 3 nodes" matches), so the count is 1. It does not count the `herobids-agents` blocked eval
  (BlockedEval is a UUID and StatusDescription is generic), so that count is 0. This is the defect the
  fixture exposes. The real capacity signal is only in `FailedTGAllocs`, which the script does not read.
- `check-nomad-capacity.sh` sums memory only for `ClientStatus == "running"`. `scale-common.sh`
  counts `running` **and** `pending` as occupied. Assigned-pending allocations (like the one in the
  fixture) therefore carry no memory reservation in the capacity math.
- The allocation-memory fix is present: `AllocatedResources.Tasks` is read first, the legacy
  `Resources.Memory.MemoryMB` is the fallback, and an allocation with no figure fails the check
  rather than reading as zero.

## Sanitized P0 baseline (2026-10-30)

Commands run from the repo root, with `env -i` and a minimal `PATH` and no `TF_*`, `AWS_*` or
`NOMAD_*` variables:

Evidence: the raw run output is not committed. A sanitised excerpt is in
`p0-baseline-2026-10-30.log` in this directory.

1. `bash infra/hetzner/scripts/tests/run-all.sh`
   - Result: exit 0. All 8 suites passed. Six suites print `Passed:` counts from `test_end()` in
     `test-harness.sh`: alert-context 23, converge-control-plane 149, drain-timeout 20, nomad-token 21,
     provision-destroy 30, tf-runtime-helpers 119. These sum to 362 (a floor). 0 `Failed` lines.
   - `test-provision-staging.sh` prints only a pass message, with no count. `test-harness.sh` is the
     assertion library and has no suite of its own, so it prints no count either.
2. `bash infra/hetzner/scripts/tests/check-nomad-capacity.test.sh`
   - Result: exit 0. 3 of 3 PASS. This runs against a local fake Nomad on 127.0.0.1 only.
3. `pnpm exec vitest run --reporter=verbose apps/worker/src/agents/nomad-runtime-adapter.test.ts apps/worker/src/agents/agent-health-monitor.test.ts apps/worker/src/agents/agent-session-manager.test.ts packages/db/src/agent-repository.test.ts`
   - Result: exit 0. 4 of 4 test files passed. 152 of 152 tests passed, 0 failed.
   - Per-file counts, in the order listed: nomad-runtime-adapter 3, agent-health-monitor 9,
     agent-session-manager 74, agent-repository 66 (3 + 9 + 74 + 66 = 152).
   - Pre-existing failures: none observed in these targeted runs.

## Assumptions (unverified)

- The Nomad shapes are from memory and have not been checked against the Nomad 1.9.7 API docs. They may
  differ on the pinned version.
- The assigned-pending allocation has `"AllocatedResources": null`. This is an assumption and may not
  occur on Nomad 1.9.7. It also carries a legacy `Resources.Memory.MemoryMB` of 256. The capacity math
  counts only `running` allocations, so the pending allocation is excluded either way.
- The current-shape allocations omit `Resources.Memory` entirely rather than setting `MemoryMB` to null.
  The header of `check-nomad-capacity.test.sh` says staging returns `MemoryMB` as null. That null case is
  covered by the test's own inline fixtures, not by these files.

Not performed under scope A (the owner-approved local-only scope: no live staging or production access,
and no calls to Hetzner, Nomad, or Terraform backends):

- No live staging or production effective config was read, and no live API captures were taken.
- No calls were made to Hetzner, Nomad, or any shared backend. No terraform init, plan, apply or
  workspace commands were run against a real backend. No deploys, timer changes or SSH.
- The autoscale dry-run and maintenance restart scripts were not run.
- Baseline phase timings were not measured.

## P3 demand and per-node fit fixtures (UNVERIFIED)

Added for `capacity-demand.sh` and its suite `test-capacity-demand.sh`. All of these are SYNTHETIC
and UNVERIFIED against live Nomad 1.9.7. No live capture was taken in scope A. Before P4 relies on
any of these shapes, check them against the owner's sanitized staging capture.

- `demand-namespace-evaluations.json`: `herobids-agents` evaluations, with a default-namespace job
  that must be ignored, and three evaluations for one task group that must count once.
- `demand-classes.json`: one job per demand class, covering memory and CPU exhaustion, template
  mismatch, larger than template, quota, every node filtered, an unknown dimension, and nothing queued.
- `demand-diagnostics-missing.json`: nil, empty and null `FailedTGAllocs`, and a BlockedEval-only job.
  All must classify as unclassified.
- `demand-canceled-newest.json`: SYNTHETIC and UNVERIFIED. A live blocked evaluation with a lower
  ModifyIndex than a newer canceled evaluation of the same job, which must still produce a row. A
  job with only a canceled evaluation must produce no row.
- `node-fragmentation.json`: two nodes, each with 400 MB free. The total is 800 MB, but no single node
  fits a 512 MB slot.
- `node-cpu-shortage.json`: spare RAM with only 400 MHz free.
- `node-assigned-pending.json`: running, assigned-pending, non-agent and legacy-shape allocations, with
  reserved memory.
- `node-terminal.json`: complete, failed and lost allocations, which must hold no capacity.

Assumed shapes that are unverified: `FailedTGAllocs` keys (`DimensionExhausted`, `NodesExhausted`,
`NodesFiltered`, `QuotaExhausted`), `NodeResources.Cpu.CpuShares`, `ReservedResources`, and the
`AllocatedResources.Tasks` and legacy `Resources` allocation fields.

## Not covered (deferred)

- Demand fit and the eval-driven controller (P3 and P4). These fixtures do not exercise them.
- Live Hetzner label and name formats, and whether a Nomad node `Name` equals the Hetzner server name.
  The join in `capacity-inventory.sh` assumes it does. This is unverified.
- Real Nomad 1.9.7 field shapes for `/v1/nodes`. The P2 fixtures are from memory.
- HCLOUD_TOKEN availability on the autoscale host. It is not provisioned by the autoscale units, so the
  live cloud fetch cannot run there until that is resolved.
