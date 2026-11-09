# Browser Pool — Scale to Thousands

**Status:** Draft. Target is not yet confirmed (see Open questions).
**Created:** 2026-11-08
**Area:** Infrastructure, browser-pool, Nomad, agent-node autoscaling
**Depends on:** [Plan 003 — scale foundations](../003-browser-pool-scale-foundations/001-plan.md)
**Supersedes the goal of:** [Plan 002 — browser-pool autoscaling](../002-browser-pool-autoscale/001-plan.md) (Plan 002 remains the detailed design for the scale loop)

---

## Goal

Run **thousands of concurrent browser sessions** on Nomad, with capacity added and removed automatically as demand changes.

## Interpretation (please confirm)

The request said "thousands of nodes". This plan reads it as **thousands of concurrent browser sessions**, which needs thousands of browser-pool instances spread over agent nodes. If you meant something else, change this section before the phases are scheduled.

## Sizing

Inputs from the repo:

- One browser session is about **1 GB** (from the comment in [browser-pool.nomad.hcl](../../../../infra/nomad/browser-pool.nomad.hcl)). This is a starting estimate, not a measurement.
- Today one instance runs 2 sessions in 2048 MB, and each agent node is shared with agent containers.

Estimates, assuming about **3 GB** usable per agent node for browser memory:

| Concurrent sessions | Browser memory | Agent nodes (approx.) |
|---|---|---|
| 100 | ~100 GB | ~34 |
| 1,000 | ~1 TB | ~340 |
| 3,000 | ~3 TB | ~1,000 |

The node count is driven by memory per session, not by the number of pool instances. Measure real memory per session before committing to a node budget.

## Open questions

1. **Target.** Is "thousands" concurrent sessions, or something else? What is the peak, and how long does a session last? (`maxSessionDurationMs` is 180 s in config, but no code reads it. Browserless cuts sessions at 60 s.)
2. **Memory per session.** Measure it under load. The 1 GB figure is unverified.
3. **Authentication.** Browserless has no token. Thousands of instances behind a private network still need an auth decision before scale-out. Is private-network-only enough?
4. **Budget.** Who pays for agent nodes at this scale, and is there a cost ceiling per session?

## Phases

### Phase 0 — Confirm target and measure

- [ ] Answer the open questions above.
- [ ] Measure browser memory and session duration under a load test on staging, with one instance and then several.

**Acceptance:** a written target with memory per session measured, not assumed.

### Phase 1 — Scale out the pool (Plan 002 Phase 1)

- [ ] Build the scale loop in [Plan 002](../002-browser-pool-autoscale/001-plan.md): read Browserless `/pressure` on each instance, scale up through the Nomad scale API, respect min and max and a cooldown.
- [ ] Depends on [Plan 003](../003-browser-pool-scale-foundations/001-plan.md) Phases 1–3 (port strategy, multi-instance, count preservation).

**Acceptance:** under synthetic load the count rises and falls within the configured bounds, and no deploy resets it.

### Phase 2 — Agent-node capacity follows browser demand

- [ ] Confirm the agent-node capacity check counts browser-pool allocations. Check [check-nomad-capacity.sh](../../../../infra/hetzner/scripts/check-nomad-capacity.sh) and the capacity inventory. Today it is not verified.
- [ ] Enable demand-aware node scaling (`NOMAD_AUTOSCALE_DEMAND_ENABLED`, off by default) once the capacity check accounts for browser memory. Plan 002 D1 relies on the placement-failure watcher as the second level.
- [ ] Confirm placement failures from the pool trigger a node addition.

**Acceptance:** when browser allocations cannot be placed, a new agent node joins and the allocation is placed on it, without manual steps.

### Phase 3 — Session-aware scale-in

- [ ] Scale in only an instance that reports zero live sessions (Plan 002 Phase 3).
- [ ] Drain an instance: stop routing new sessions to it (Plan 003 Phase 2), wait for running sessions to finish or time out, then remove it.
- [ ] Fix the session timeout mismatch (Browserless 60 s, config 180 s) so draining has one timeout to reason about.

**Acceptance:** no live session is cut by a scale-in. Measured across a scale-down under load.

### Phase 4 — Security and isolation

- [ ] Decide the Browserless authentication approach (open question 3) and implement it.
- [ ] Confirm the pool is unreachable from the public internet on every node, with the gate and an external probe.
- [ ] Review the sandbox allowlist for browser addresses, since many instances widen it.

**Acceptance:** no pool port answers from outside the private network, and the auth decision is recorded.

### Phase 5 — Observability and cost

- [ ] Per-instance metrics: sessions, queue, rejected, memory. Use the existing health snapshot and [observability.md](../../../tech/architecture/observability.md).
- [ ] Cost: confirm `browser.session_ms` metering covers every instance, and show cost per session.
- [ ] Alerts: queue depth and rejections above a threshold for longer than the cooldown.

**Acceptance:** a dashboard shows sessions, capacity, and cost per instance.

### Phase 6 — Beyond one cluster (only if needed)

- [ ] Shard the pool across Nomad node pools, or regions, if one cluster cannot hold the target. Defer this decision until Phase 0 measurements are in.

## Risks

| Risk | Mitigation |
|---|---|
| Memory per session is far above 1 GB | Phase 0 measurement. Revise the sizing table. |
| Scale-out lags demand | Cooldown and headroom tuned in Phase 1; alerts in Phase 5. |
| Scale-in kills live sessions | Phase 3 drain. Never remove an instance with live sessions. |
| Agent nodes cost more than the value of the sessions | Phase 0 budget answer; cost metrics in Phase 5. |
| Unauthenticated pool exposed by a firewall mistake | Phase 4 external probe; private-network-only rules verified by the gate. |

## Links

- Current state: [browser-pool.md](../../../tech/architecture/browser-pool.md)
- Known limits: [browser-pool.md — Known limits](../../../tech/architecture/browser-pool.md#known-limits)
- Agent-node autoscaler: [scale-out.sh](../../../../infra/hetzner/scripts/scale-out.sh)
