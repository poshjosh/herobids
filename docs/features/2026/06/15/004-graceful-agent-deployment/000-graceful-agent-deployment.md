# Graceful Agent Deployment — Zero/Low Downtime

**Status:** Done  
**Date:** 2026-06-14  
**Related:** [Bug 008 — 409 orphaned containers](../../../bug-reports/2026/06/14/008-agent-start-fails-409-orphaned-running-containers.md), [Orchestration notes](../orchestration.md)

---

## Problem

When the worker is redeployed, agent containers experience an uncontrolled lifecycle transition:

1. **Abrupt termination** — Old containers are force-removed (`docker rm -f`) by the new worker when it tries to claim the container name. The agent process receives SIGKILL with no opportunity to clean up.

2. **Execution gap** — Between the old container's death and the new container's first heartbeat, the agent is offline. For a trading agent, this means missed market moves and no protective actions (e.g. trailing stop-losses aren't updated).

3. **Duplicate execution risk** — If the old container was mid-trade when killed, the new container may re-evaluate the same market state and submit a duplicate order before reconciliation catches up.

4. **No agent awareness** — The agent has no "I was restarted" context. It resumes cold, potentially repeating analysis it already performed or losing conversational continuity with the user.

### Current behavior (post bug-008 fix)

```
Deploy → new worker boots → health monitor marks old sessions stale →
new starting sessions created → reconcileStartingSessions →
removeExistingContainer (force-kill running container) → create new container
```

The agent process inside the old container never receives SIGTERM. Total agent downtime ≈ health check interval + container startup time (30–90s typical).

---

## Goal

- **Low downtime** (< 5s agent unavailability) during planned deployments.
- **Graceful shutdown** — Agent gets a window to finish in-flight work, persist state, and exit cleanly.
- **No duplicate trades** — Handoff protocol ensures at-most-once execution during transitions.
- **Orchestrator-agnostic** — The application-level protocol works whether the signal comes from Nomad, Swarm, a deploy script, or a manual `docker stop`.
- **Evolvable** — Solution layers cleanly so migrating from Docker+Nomad to K8s (or another orchestrator) requires zero application-level changes.

---

## Possible Solutions

### A. Application-level graceful shutdown (agent-side)

The agent container handles SIGTERM gracefully:

```
SIGTERM received →
  1. Stop accepting new ticks / LLM calls
  2. Wait for in-flight operations (with timeout, e.g. 15s)
  3. Persist "shutdown-clean" marker to DB (session metadata)
  4. Exit 0
```

The worker's `removeExistingContainer` switches from `docker rm -f` to:
```
docker stop --time=20 <container>   (sends SIGTERM, waits 20s, then SIGKILL)
docker rm <container>
```

**Pros:** Simple, no new infrastructure, works with any orchestrator.  
**Cons:** Still has a gap (old stops → new starts). Agent-side code must handle SIGTERM properly.

---

### B. Rolling replacement (orchestrator-level)

The orchestrator (Nomad / Swarm / script) manages the handoff:

```
1. Start new container (different temporary name or network alias)
2. New container sends "ready" signal (first heartbeat / health check passes)
3. Old container receives SIGTERM → drains gracefully
4. Old container exits → name/port freed
5. New container assumes the canonical identity
```

**Pros:** Near-zero downtime. Agent is always available.  
**Cons:** More complex naming/routing. Requires orchestrator support or a custom deploy script. Potential for two containers running simultaneously (must guard against duplicate execution).

---

### C. Drain-before-deploy (deploy script coordination)

The deploy script explicitly drains agents before replacing the worker:

```bash
# 1. Signal all agents to enter "draining" state
curl -X POST worker:3001/admin/drain-agents

# 2. Wait for all agents to confirm drained (or timeout)
# 3. Deploy new worker
# 4. New worker starts agents fresh
```

**Pros:** Simple to reason about. Clear separation of concerns.  
**Cons:** Longer total deployment time (drain timeout × number of agents). All agents are simultaneously offline during the deploy window.

---

### D. Session handoff with fencing token

Combine graceful shutdown with a fencing mechanism:

```
1. New worker boots, generates a monotonic "epoch" token
2. New worker writes epoch to each agent's session metadata
3. Old container's next heartbeat/trade submission is rejected (stale epoch)
4. Old container sees rejection → enters graceful shutdown
5. New container starts with current epoch → accepted
```

**Pros:** No duplicate execution (stale epoch rejected at API level). Works even if SIGTERM delivery fails.  
**Cons:** Adds a coordination protocol. Agent must handle "epoch rejected" as a shutdown signal.

---

## Recommended Solution

**Phase 1 (now):** Solution A — Application-level graceful shutdown.

This is the minimal change that gives immediate value:

1. **Agent container handles SIGTERM** — Stop ticking, wait for in-flight ops (bounded timeout), persist clean-shutdown marker, exit 0.
2. **Worker uses `docker stop` instead of `docker rm -f`** — Give the container the SIGTERM grace period before force-killing.
3. **Log and surface the distinction** — "Agent stopped gracefully" vs "Agent force-killed (timeout exceeded)".

Implementation:

| Component | Change |
|-----------|--------|
| Agent runtime (container entrypoint) | Trap SIGTERM, drain in-flight work, exit |
| `DockerAgentManager.removeExistingContainer()` | Use `POST /containers/{id}/stop?t=20` then `DELETE` |
| `AgentSessionManager` | Recognize clean-shutdown marker to skip unnecessary "crashed" alerts |
| Deploy script / Nomad job spec | Set `kill_timeout = 25s` (> container stop timeout) |

**Phase 2 (with Nomad):** Solution B — Rolling replacement via Nomad's `update` stanza:

```hcl
update {
  max_parallel     = 1
  canary           = 1
  health_check     = "checks"
  min_healthy_time = "10s"
  healthy_deadline = "60s"
}
```

Nomad natively supports canary deployments — start new, verify healthy, drain old. The application-level SIGTERM handling from Phase 1 is reused as-is.

**Phase 3 (if needed):** Solution D — Fencing tokens as a safety net for edge cases where SIGTERM delivery is unreliable (e.g. frozen container, network partition). This becomes the at-most-once execution guarantee layer.

---

## Design Constraints

- The SIGTERM handler must be **bounded** — if the agent is stuck in an LLM call, it cannot wait forever. Hard timeout (e.g. 20s) then exit regardless.
- During the drain window, the agent must **not open new positions**. It may close or adjust existing ones.
- The worker must distinguish "container exited from SIGTERM" (expected, don't alert) from "container crashed" (unexpected, alert + potentially restart).
- Container exit code convention: `0` = clean shutdown, `137` = SIGKILL (timeout exceeded), other = crash.

---

## Non-Goals (for now)

- Hot migration of in-memory agent state between containers (complex, low ROI).
- Multi-worker agent failover (requires distributed consensus — save for K8s phase).
- Zero-downtime for the worker/API process itself (handled separately by load balancer + rolling deploy).
