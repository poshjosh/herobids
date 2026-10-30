# Bug Report 002 — Capacity check reads empty allocation memory, so the agent node looks empty and autoscale never adds a node

- **Status:** FIXED AND DEPLOYED to staging (2026-10-30, commit `ee90ca48`). The regression test passes. The autoscaler now reads the real capacity (235 MB free, 6%, 0 slots). Adding a node is blocked by a separate issue: the autoscale timer is stopped because its apply would replace the agent node. See [Fix](#10-fix) and [Verification](#11-verification).
- **Severity:** High. Agents fail to start once the agent node's memory is full, and the autoscaler that exists to add capacity never does. This blocks paying users as the platform grows.
- **Date:** 2026-10-30
- **Environment:** Staging (Nomad, one agent node `herobids-staging-agent-1`). The bug is in the infrastructure scripts, so it affects every environment that autoscales.
- **Reviewer:** Please check the fix against [Acceptance criteria](#8-acceptance-criteria) and the scenarios in [Required tests](#9-required-tests).

---

## 1. Summary

A new agent (`wise-falcon`, id `9e029545-934d-4c46-854e-ec72730e4fb9`) failed to start after about 60 seconds. The agent node had no memory left. Nomad could not place the agent's job, so the runtime never started, and the start-timeout watchdog stopped it.

The autoscaler should have added a node. It did not, because its capacity check reported the node as empty. [`check-nomad-capacity.sh`](../../../../infra/hetzner/scripts/check-nomad-capacity.sh) adds up each allocation's `.Resources.Memory.MemoryMB`. Current Nomad leaves that field empty and puts each task's memory under `AllocatedResources`. The sum was 0. The script treated the missing figure as zero and reported 3,819 MB free (100%) and 14 free slots. The autoscaler then logged "Capacity sufficient — no scale-out needed."

| What the node actually had | What the autoscaler saw |
|---|---|
| 3,584 MB reserved: 6 agents × 256 MB plus Browserless 2,048 MB | 0 MB allocated |
| 235 MB free, so no room for a 256 MB agent | 3,819 MB free (100%) and 14 free slots |
| Decision: scale out | Decision: no scale-out needed |

---

## 2. Background a fixer needs

- **Who places agents:** the worker submits an agent job to Nomad, namespace `herobids-agents`. Nomad places it on a node in the `agent` class, datacenter `dc1`. Each agent reserves 256 MB (`NOMAD_AGENT_MEMORY_RESERVATION_MB`).
- **Who scales:** `nomad-autoscale.timer` runs `scale-out.sh`, which calls `check-nomad-capacity.sh`. Scale-out triggers when free memory is below 20% or free slots are below 3. The maximum is `max_agent_nodes`, set to **3** on staging (`TF_VAR_max_agent_nodes=3`).
- **Backup trigger:** the placement-failure safety net, which runs `scale-out.sh --safety-net` when there are 5 blocked evaluations in 300 seconds.
- **Start watchdog:** a session that never sends its first heartbeat is marked timed out after about 60 seconds. The watchdog then stops the Nomad job and sends a runtime-failed alert.

---

## 3. Evidence (staging, 2026-10-30)

### 3.1 Timeline (worker log, `docker logs herobids-worker-1`)

| Time (UTC) | Event |
|---|---|
| 21:12:46 | Start of `wise-falcon` recorded (`startedAt`) |
| 21:12:50 | `Nomad job registered`, job `agent-9e029545-…` |
| 21:12:55 | Subscribed to the agent's inbound stream |
| 21:13:26 | `Runtime reconcile complete via port`: `runningCount: 7`, `orphans: []`, `missing: []`. The new agent is not among the running runtimes |
| 21:13:47 | `Stale agent start detected`. `Nomad job stopped and purged` |
| 21:13:50 | `Agent session start timed out`. `Platform safety alert sent` (`agent.runtime.failed`) |

The Nomad client on the node logged nothing for 21:12:40–21:14:00. No allocation for the job was ever placed on the node.

### 3.2 Why Nomad could not place the job

The job-register evaluation `284fd677` (namespace `herobids-agents`) reports:

```text
Task Group "agent" (failed to place 1 allocation):
  * Resources exhausted on 1 nodes
  * Class "agent" exhausted on 1 nodes
  * Dimension "memory" exhausted on 1 nodes
```

Node `herobids-staging-agent-1` (`db4e22b4`, `dc1`, class `agent`): `NodeResources.Memory.MemoryMB = 3819`, `ReservedResources = 0`. Running allocations:

| Allocation | Memory (MB) |
|---|---|
| 6 agent runtimes (Oso and others) | 256 each = 1,536 |
| Browserless (`browserless-…`) | 2,048 |
| **Total** | **3,584** (235 free) |

### 3.3 What the autoscaler saw

`/var/log/nomad-autoscale.log` at 21:22:52:

```text
Capacity snapshot:
  Free memory:     3819 MB (100%)
  Free slots:      14
  Ready nodes:     1
  Memory threshold: 20%
  Slot threshold:   3

Capacity sufficient — no scale-out needed.
```

The safety net at 21:23:29 counted 0 blocked evaluations, below its threshold of 5, so it also took no action.

### 3.4 Why the sum was zero

The Nomad API response for the node's allocations (`GET /v1/node/<id>/allocations`), read on staging:

| Field | Value |
|---|---|
| `.Resources.Memory.MemoryMB` | `null` for every allocation |
| `.AllocatedResources.Tasks.agent.Memory.MemoryMB` | `256` |
| `.AllocatedResources.Tasks.<browserless>.Memory.MemoryMB` | `2048` |

The script's jq filter, `[.[] | select(.ClientStatus == "running") | .Resources.Memory.MemoryMB // 0] | add // 0`, took the `// 0` default for every allocation. A missing figure was treated as zero, not as an error.

---

## 4. Root cause

### 4.1 (Primary) The capacity script reads a field Nomad no longer populates

`check-nomad-capacity.sh` took allocated memory from `.Resources.Memory.MemoryMB`. Current Nomad reports task memory under `AllocatedResources`. The result is always 0, so free memory equals total memory.

### 4.2 (Contributing) Missing data was treated as zero

A `// 0` default turned "no figure" into "no memory used". The script then reported a healthy cluster with no error or warning. The same pattern would hide any future change to Nomad's response shape.

### 4.3 (Contributing) No test covers the capacity script

Nothing ran the script against a Nomad response, so the change in Nomad's response shape went unnoticed.

---

## 5. Required behaviour after the fix

- **R1.** Allocated memory is read from `AllocatedResources`, summed across each allocation's tasks.
- **R2.** The older `.Resources.Memory.MemoryMB` field is used only when `AllocatedResources` is absent.
- **R3.** A running allocation that has neither figure fails the check with a clear error. It must not be reported as zero.
- **R4.** On the staging snapshot above, the script reports 107 MB free and 0 free slots, which is correct: 3,819 − 3,712 = 107 MB.
- **R5.** Autoscale must add a node in this situation, up to `max_agent_nodes`.

---

## 6. Must not regress

- Scale-out still respects `max_agent_nodes`, the cooldown and the lock file.
- Scale-in still works.
- The placement-failure safety net still runs. It is a second trigger, not a replacement for the memory check.
- Failed or completed allocations are ignored in the sum.

---

## 7. Out of scope

- Moving Browserless off the agent node pool, and choosing the node size, are capacity-planning decisions. They are not part of this fix.
- The safety net's blocked-evaluation threshold (5 in 300 seconds) is unchanged. A single blocked evaluation still does not trigger it.

---

## 8. Acceptance criteria

- [x] AC1. `check-nomad-capacity.sh` reports allocated memory from `AllocatedResources` (R1).
- [x] AC2. A response with only the legacy field still produces a correct figure (R2).
- [x] AC3. A running allocation with no memory figure makes the script fail with exit code 1 (R3).
- [x] AC4 (partly). After deploy to staging, `nomad-autoscale.log` reports free memory consistent with Nomad (235 MB, 6%, 0 slots) and decides to scale out (R1–R4 verified). Adding a node (R5) is **not yet verified**: the apply it runs would replace the existing agent node, so the timer is stopped.
- [x] AC5. The regression test in `infra/hetzner/scripts/tests/` passes on the fixed script and fails on the previous script.

---

## 9. Required tests

- **T1 (passes after fix):** a fake Nomad API with the staging response shape. Free memory is 107 MB and free slots is 0.
- **T2 (passes after fix):** a fake Nomad API with only the legacy field. The figure is still computed.
- **T3 (passes after fix):** a fake Nomad API with a running allocation that has no memory figure. The script exits 1.
- **T4 (manual, staging):** run `nomad-autoscale.service` once after deploy and check the log for the free-memory figure.

---

## 10. Fix

The fix is in [`check-nomad-capacity.sh`](../../../../infra/hetzner/scripts/check-nomad-capacity.sh):

- Memory per running allocation is read from `AllocatedResources.Tasks[*].Memory.MemoryMB`. The fallback is `Resources.Memory.MemoryMB`.
- An allocation with neither figure stops the check with `die … 1`.
- The API call for allocations no longer uses `|| echo "[]"`. A failed request now stops the check, instead of looking like an empty node.

Added [`tests/check-nomad-capacity.test.sh`](../../../../infra/hetzner/scripts/tests/check-nomad-capacity.test.sh). It runs the real script against a fake Nomad API. `CHECK_NOMAD_CAPACITY_SCRIPT` points it at another copy of the script.

---

## 11. Verification

- `infra/hetzner/scripts/tests/check-nomad-capacity.test.sh`: all three checks pass on the fixed script.
- The same test against the previous script: fails all three checks (free memory 3,691 MB and 14 slots, where the correct values are 107 MB and 0; and no failure on a missing figure).
- Syntax check: `bash -n` passes for both scripts.
- **Done on staging:** the fixed script was deployed in `ee90ca48`. The log shows the correct free memory and a scale-out decision.
- **Not yet done:** confirm that a scale-out adds a node (AC4, T4). This is blocked until the Terraform drift is fixed and the replacement guard exists.

---

## 12. Related code

- [`infra/hetzner/scripts/check-nomad-capacity.sh`](../../../../infra/hetzner/scripts/check-nomad-capacity.sh) (the bug)
- [`infra/hetzner/scripts/scale-out.sh`](../../../../infra/hetzner/scripts/scale-out.sh) (consumer of the capacity figures)
- [`infra/hetzner/scripts/scale-common.sh`](../../../../infra/hetzner/scripts/scale-common.sh) (`NOMAD_AGENT_MEMORY_RESERVATION_MB`, `NOMAD_AUTOSCALE_LOG_FILE`)
- [`apps/worker/src/agents/nomad-runtime-adapter.ts`](../../../../apps/worker/src/agents/nomad-runtime-adapter.ts) (job submission, 256 MB reservation)
- [`apps/worker/src/agents/agent-session-manager.ts`](../../../../apps/worker/src/agents/agent-session-manager.ts) (`handleStartTimeout`, the 60-second watchdog)
