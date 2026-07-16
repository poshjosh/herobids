# Staging Prerequisite Evidence: Seven Storming Agents Stop Verification

**Date:** 2026-07-16 ~17:18 UTC
**Checklist Item:** Item 1 from [005-scanner-gated-hardening-plan.md](005-scanner-gated-hardening-plan.md) — Coordinator Execution Checklist
**Status:** ❌ PREREQUISITE NOT MET — agents still actively storming

---

## Summary

The seven staging agents (tcontrarian, tmomentum-d, tmomentum-p, trange, tscalper, tswing, tswing-playbook) were marked `status = 'stopped'` in the database at approximately 16:41 UTC. However, the worker process was not restarted afterward, and the in-memory actor scan timers continue to run. The scanner storm is **ongoing** with the same broken pattern documented in the earlier diagnostic.

**The prerequisite is NOT met. Per the plan's stop condition, implementation cannot proceed until the agents are fully stopped (worker process restarted or actors terminated in-memory).**

---

## Evidence Item 1: Database Agent Status

**Evidence item:** DB agent status check
**Date/time:** 2026-07-16 17:17 UTC
**Environment:** staging (128.140.55.192), herobids-postgres-1
**Commit/image identity:** Git HEAD `913f4ae0` (worker image created 2026-07-16T13:45:52Z)
**Command or source:**
```sql
SELECT id, name, status, unified_config->>'hybridMode' as hybrid_mode, updated_at AT TIME ZONE 'UTC' as updated_at_utc
FROM agents
WHERE name IN ('tcontrarian', 'tmomentum-d', 'tmomentum-p', 'trange', 'tscalper', 'tswing', 'tswing-playbook')
ORDER BY name;
```

**Raw evidence location:** DB query output below.

| Short ID | Name | Status | Hybrid Mode | Updated At (UTC) |
|----------|------|:------:|:-----------:|-------------------|
| `70b3d865` | tcontrarian | **stopped** | scanner_gated | 2026-07-16 16:41:50 |
| `51403f2e` | tmomentum-d | **stopped** | scanner_gated | 2026-07-16 16:41:23 |
| `93552994` | tmomentum-p | **stopped** | scanner_gated | 2026-07-16 16:41:26 |
| `64afd699` | trange | **stopped** | scanner_gated | 2026-07-16 16:41:30 |
| `3fa538e3` | tscalper | **stopped** | scanner_gated | 2026-07-16 16:41:59 |
| `b4f67404` | tswing | **stopped** | scanner_gated | 2026-07-16 16:41:35 |
| `15bfaf97` | tswing-playbook | **stopped** | scanner_gated | 2026-07-16 16:41:42 |

**Observed result:** All 7 agents have `status = 'stopped'` in the database, updated between 16:41:23 and 16:41:59 UTC. This implies a user/operator issued stop commands via API.

**Interpretation:**
- **What this proves:** The agents were intentionally stopped via the API layer (DB status updated to `stopped`).
- **What this does not prove:** The agents are actually stopped at runtime. The DB status change does not terminate in-memory actor timers in the already-running worker process.

**Release relevance:** Checklist item 1 — DB status check.

---

## Evidence Item 2: Worker Scanner Log Activity

**Evidence item:** Worker log scanner activity for all seven agents
**Date/time:** 2026-07-16 17:16–17:18 UTC
**Environment:** staging (128.140.55.192), herobids-worker-1
**Commit/image identity:** Git HEAD `913f4ae0` (worker image created 2026-07-16T13:45:52Z)
**Command or source:**
```bash
docker logs herobids-worker-1 --since 2m | grep -o 'agent-actor-[a-f0-9]*' | sort -u
```

**Raw evidence location:** All seven agent-actor IDs present in logs from 17:16–17:18 UTC:

```
agent-actor-15bfaf97  (tswing-playbook)
agent-actor-3fa538e3  (tscalper)
agent-actor-51403f2e  (tmomentum-d)
agent-actor-64afd699  (trange)
agent-actor-70b3d865  (tcontrarian)
agent-actor-93552994  (tmomentum-p)
agent-actor-b4f67404  (tswing)
```

Sample log excerpt (all within the same second, 17:18:03):

```
[17:18:03] INFO (agent-actor-70b3d865): Technical phase: advisory mode — skipping entry submissions
    signalCount: 0
[17:18:03] INFO (agent-actor-70b3d865): Technical phase complete
    candidatesDiscovered: 232
    candidatesScored: 0
    signalsGenerated: 0
    entriesSubmitted: 0
    exitsSubmitted: 0
    regimeBlocked: false
    errorCount: 0
[17:18:03] INFO (agent-actor-15bfaf97): Technical phase: advisory mode — skipping entry submissions
    ...
[17:18:03] INFO (agent-actor-51403f2e): Technical phase complete
    candidatesDiscovered: 232
    candidatesScored: 0
    ...
```

The same pattern repeats for all 7 agents, multiple times per second.

**Observed result:** All seven agents are actively running scanner loops. Each scan discovers 232 candidates, scores 0, generates 0 signals, with sub-second intervals. Log volume is ~15,730 "Technical phase complete" lines per minute.

**Interpretation:**
- **What this proves:** The scanner storm is **still ongoing**. The DB `status = 'stopped'` change did not stop the in-memory actor timers. The worker was not restarted after the stop commands were issued.
- **What this does not prove:** N/A — the evidence is definitive.

**Release relevance:** Checklist item 1 — scanner activity check. **PREREQUISITE FAILED.**

---

## Evidence Item 3: Redis Scanner-Gated Keys

**Evidence item:** Redis `agent:scanner_gated:*` key presence
**Date/time:** 2026-07-16 17:17 UTC
**Environment:** staging (128.140.55.192), herobids-redis-1
**Commit/image identity:** Same as above.
**Command or source:**
```bash
docker exec herobids-redis-1 redis-cli KEYS 'agent:scanner_gated:*'
```

**Raw evidence location:** Empty result — no `agent:scanner_gated:*` keys exist.

However, other agent keys are present:

```
agent:sessions:active
agent:inbound:<id>  (for all 7 agent IDs)
agent:outbound:<id> (for all 7 agent IDs)
agent:wake:prefs:<id> (for all 7 agent IDs)
agent:sessions:count:<id> (for all 7 agent IDs)
```

**Observed result:** No `agent:scanner_gated:*` keys in Redis. Active session, inbound/outbound streams, and wake preference keys exist for all 7 agents.

**Interpretation:**
- **What this proves:** The `scanner_gated` registration keys (which were present in the earlier diagnostic at 16:30 UTC, ~50 minutes prior) have been cleaned up — likely expired or removed when the agents were stopped via API. This is consistent with a stop action.
- **What this does not prove:** That the scanner loops stopped. The agent session, inbound, outbound, and wake preference keys still exist, and the worker logs show active scanning.

**Release relevance:** Checklist item 1 — Redis key check.

---

## Evidence Item 4: Worker CPU Usage

**Evidence item:** Worker container CPU usage
**Date/time:** 2026-07-16 17:17 UTC
**Environment:** staging (128.140.55.192), herobids-worker-1
**Commit/image identity:** Same as above.
**Command or source:**
```bash
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemPerc}}\t{{.MemUsage}}' | grep worker
```

**Raw evidence location:**

```
NAME                      CPU %     MEM %     MEM USAGE / LIMIT
herobids-worker-1         89.83%    17.65%    674.3MiB / 3.73GiB
```

Server load average: `2.18, 2.35, 2.43` (from `uptime`).

**Observed result:** Worker CPU is at 89.83% — **higher** than the 62.53% reported in the earlier diagnostic (003-staging-read-only-diagnostic.md). This is consistent with 7 agents running sub-second scan intervals (each `setInterval(fn, undefined)` effectively becomes a ~1ms loop). Memory is 674 MiB.

**Interpretation:**
- **What this proves:** The scanner storm is consuming extreme CPU resources. The CPU usage is worse than before (89.83% vs 62.53%), possibly because the worker has been running longer with accumulated timer drift or because no other processes are competing.
- **What this does not prove:** N/A — the evidence is definitive.

**Release relevance:** Checklist item 1 — CPU usage check.

---

## Timeline Reconstruction

| Time (UTC) | Event |
|-------------|-------|
| 2026-07-16 00:58 | Agent `tcontrarian` created |
| 2026-07-16 13:45 | Worker container started (current uptime: ~3.5 hours at evidence capture) |
| 2026-07-16 ~16:30 | Earlier diagnostic captured — agents actively storming, CPU 62.53% |
| 2026-07-16 16:41:23–16:41:59 | All 7 agents marked `status = 'stopped'` in DB |
| 2026-07-16 17:16–17:18 | **Current evidence capture** — all 7 agents still storming, CPU 89.83% |

The DB status change from ~16:41 UTC was not followed by a worker restart. The worker container has been running continuously since 13:45 UTC, and the in-memory actor timers were never terminated.

---

## Stop Condition Assessment

**Per the plan (005-scanner-gated-hardening-plan.md):**

> "If the agents are still active/storming, STOP and report the finding. Do NOT mutate staging."

| Check | Expected | Actual | Pass? |
|-------|----------|--------|:-----:|
| DB agent status | `stopped` | `stopped` | ✅ |
| Worker scanner logs | No scanner activity | All 7 agents scanning at sub-second intervals | ❌ |
| Redis scanner_gated keys | Absent | Absent | ✅ |
| Worker CPU | Normal/idle (~5–10%) | 89.83% | ❌ |

**Result: PREREQUISITE NOT MET.** The agents are stopped in the database but still actively storming in the running worker process. The worker needs to be restarted for the DB status change to take effect at runtime.

---

## Required Action Before Implementation Can Proceed

The worker process must be restarted to terminate the in-memory actor timers. This requires a mutation of staging (restart), which this read-only evidence-gathering task is not authorized to perform.

The following options are available to resolve this:

1. **Restart the worker** via `docker compose restart worker` on the staging server. This is the simplest fix — it will reload all agents from DB, and since they are `status = 'stopped'`, they will not start new scan loops.
2. **Full maintenance restart** via `infra/hetzner/scripts/maintenance-restart-from-local.sh --env staging`.

After the worker restart, this evidence checklist item should be re-executed to confirm all four checks pass before implementation proceeds.

---

## Evidence Capture Metadata

- **Captured by:** AI agent (Implementer mode)
- **SSH access:** `ssh -i ~/.ssh/herobids_deploy_key root@128.140.55.192`
- **Commands used:** All read-only (`docker ps`, `docker logs`, `docker stats --no-stream`, `docker exec postgres psql`, `docker exec redis redis-cli KEYS`)
- **No mutations performed:** Confirmed — no `docker restart`, `docker compose`, agent API calls, or any write operations were issued against staging.
