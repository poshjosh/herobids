# Bug Report: agents intermittently fail to reach "active" within 30s — cumulative launch latency across sequential agents

- **Status:** OPEN (root cause investigated; not fixed — see "Why not fixed yet")
- **Severity:** Medium (fails two Tier-5 smoke tests reliably; unclear production impact)
- **Date:** 2026-09-05
- **Discovered By:** `scripts/shell/tests/run-extra-tests.sh --all` → `agent-trade-test` and `preset-review-gap-closure` FAIL. Reproduced in isolation with `docker-compose.dev.yaml` (worker logs accessible) + a warm Ollama.
- **Components:** `apps/worker` agent launch pipeline (`AgentSessionManager`, `AgentRuntimeLauncher`, `docker-agent-manager`), and the smoke tests' 30s activation budget.

## Summary

When several agents are created and started in quick succession (as the preset-review and agent-trade smoke tests do), the **first one or two** reach `active` quickly (~3–15s) but **every subsequent agent** exceeds the test's 30s activation timeout. The test then deletes the still-starting agent (SIGTERM), which the worker records as a `runtime_crash`. This is NOT an LLM cold-start problem: it reproduces with a fully warm Ollama.

## Evidence (reproduction 2026-09-05, warm Ollama, dev overlay)

### 1. The temporal pattern is deterministic

`preset-review-gap-closure` (SCENARIOS=R1..R5), from the test's own log:

| Scenario | start issued | reached active? |
|---|---|---|
| R1 (hybrid)        | 14:30:52 | ✓ active by 14:30:55 (~3s) |
| R2 (intelligence)  | 14:31:01 | ✓ by ~14:31:16 (~15s) |
| R3 (intelligence)  | 14:31:22 | ✗ "did not become active within 30000ms" |
| R4 (intelligence)  | 14:31:59 | ✗ same |
| R5 (hybrid)        | 14:33:26 | ✗ same |

Early scenarios pass; later ones consistently time out.

### 2. Container create→start is NOT the bottleneck

`docker inspect` on each agent container (Created vs StartedAt) shows ~30 ms create→start for all five. Docker itself is fast.

### 3. The delay is between "start requested" and "container created"

Comparing the test's start timestamp to the container's `Created` time (docker inspect):

| Scenario | start issued | container created | gap |
|---|---|---|---|
| R1 | 14:30:52.2 | 14:30:53.6 | ~1.4s |
| R2 | 14:31:01.6 | 14:31:15.9 | ~14s |
| R3 | 14:31:22.9 | 14:31:26.1 | ~3s |
| R4 | 14:31:59.4 | 14:32:10.8 | ~11s |
| R5 | 14:33:26.5 | 14:33:41.1 | ~15s |

The worker takes up to ~15s to *create* the agent container after the session is marked "starting". Then the container boots and runs its first LLM tick before "active" is reported — adding several more seconds.

### 4. The agent that "crashed" was actually healthy and killed by the test

R4 agent (`092dcafe`) container logs show it was working normally — `LLM response received` (latency 8.7s then 2.6s), executing tools (`send_message`, `get_market_overview`, `check_regime`, `get_funding_rates`) — then:
```
[14:32:28] WARN (agent-runtime): Drain timeout reached — proceeding with shutdown while tick still in flight
    reason: "SIGTERM"
```
The SIGTERM is the test's cleanup after its 30s timeout. The worker classified this SIGTERM-mid-tick as `runtime_crash`:
```
[14:32:20] WARN (docker-agent-manager): Agent container died — runtime_crash
```
So "crashed" (seen in the full-suite run) is an **artifact of the test killing a still-starting agent**, not an independent agent defect. In the isolated reproduction all agent containers exited 0.

### 5. Launch is poll-driven, not event-driven

`apps/worker/src/index.ts` (~line 1056):
```
// bug-008: reduced from default 10 000 ms to 2 000 ms so agents start within
// ~2 s instead of up to 10 s after the API sets the session to 'starting'.
healthCheckIntervalMs: appConfig.worker.agents.healthCheckIntervalMs,
```
`AgentSessionManager` polls for `starting` sessions and launches them on this timer (`reconcileStartingSessions`). There is also a separate Docker **container-reconciliation** timer (`containerReconcileIntervalMs`, default 60_000ms — `agent-session-manager.ts:141`) that runs `docker-agent-manager` reconciliation; its "Agent container reconciliation complete" lines appear on a fixed 60s cadence (e.g. 14:2x:38 every minute) and each pass took ~10–13s in the reproduction window.

## Root cause (what the evidence supports)

Agent activation latency is dominated by the **worker-side launch pipeline**, not the LLM and not Docker:
- Launch is gated by a polling reconcile loop, so each start waits for a poll tick.
- Launch latency grows across sequential agents (from ~1.4s to ~15s over five agents), i.e. it is load/state dependent, not constant.
- Combined with the agent's first-tick LLM work (~8–10s observed), later agents exceed the smoke tests' fixed **30s** activation budget.
- When the test gives up and SIGTERMs the still-starting agent, the worker mislabels it `runtime_crash`.

## What is NOT yet proven (no assumptions)

- The **exact source** of the growing per-launch delay (up to ~15s) is not pinned to a single line. Candidates observed but not confirmed as causal: contention with the 60s container-reconciliation pass (~10–13s each), serialized launch work in the poll loop, or accumulated container/state scanning as more agents exist. This needs targeted timing instrumentation inside `AgentSessionManager.reconcileStartingSessions` / `docker-agent-manager`.
- Whether `agent-trade-test`'s "Bot was not created within 30s" shares this exact cause. It is the same class of symptom (a 30s budget exceeded during agent/bot bring-up) and the same environment, but its container logs were not captured in this reproduction. Stated as likely-related, not proven.
- Whether this affects production (where agents are typically started spread out over time, not five in ~3 minutes) — the reproduction is a burst-start pattern specific to the smoke tests.

## Impact

- Two Tier-5 smoke tests fail (`agent-trade-test`, `preset-review-gap-closure`), so `run-extra-tests.sh` exits 1.
- The `runtime_crash` mislabel pollutes crash metrics/logs for agents that were merely killed while still starting.

## Why not fixed yet

The fix likely touches the worker's agent launch/reconcile pipeline (concurrency, poll cadence, or the reconciliation pass), which is core runtime code with broad blast radius. Two lower-risk directions exist but each needs a decision:
1. **Widen the smoke tests' activation budget** (e.g. 30s → 60–90s) and/or serialize agent creation with adequate spacing. Test-only, low risk, but masks the underlying latency.
2. **Investigate/fix the launch-latency growth** (instrument `reconcileStartingSessions` + `docker-agent-manager`; consider event-driven launch instead of poll; avoid reconcile-pass contention). Correct fix, higher risk.
Separately, the worker should not classify a **SIGTERM received before an agent reaches active** as `runtime_crash` (finding #4) — that is a smaller, self-contained correctness fix.

## Reproduction

```bash
# Warm Ollama models (blocking)
bash scripts/shell/run/load-ollama-agents.sh
# Bring up the stack with the dev overlay (worker logs visible)
bash scripts/shell/run/build-and-run.sh
# Run the failing test directly
DOCKER_COMPOSE_UP=0 bash scripts/shell/tests/preset-review-gap-closure-test.sh
# Inspect: test log shows R3/R4/R5 "did not become active within 30000ms".
# Correlate container Created vs test start:
docker inspect -f '{{.Created}} {{.State.StartedAt}}' $(docker ps -aqf name=herobids-agent-)
# Agent container logs show healthy LLM work then SIGTERM:
docker logs <herobids-agent-...> 2>&1 | sed 's/\x1b\[[0-9;]*m//g'
```

## References

- `apps/worker/src/agents/agent-session-manager.ts` — `reconcileStartingSessions`, `containerReconcileIntervalMs` (default 60_000ms, line ~141)
- `apps/worker/src/agents/docker-agent-manager.ts` — container launch (~line 344) and reconciliation (~line 520)
- `apps/worker/src/index.ts` (~line 1056) — `healthCheckIntervalMs` launch-poll cadence (bug-008 note)
- Tests with the 30s budget: `scripts/ts/preset-review-gap-closure-test.ts` (`waitForAgentActive`, 30000ms), `scripts/ts/agent-trade-test.ts`
