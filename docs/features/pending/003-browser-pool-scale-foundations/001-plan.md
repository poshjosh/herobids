# Browser Pool — Scale Foundations

**Status:** Draft. Not started. Mostly superseded by [Plan 005, dedicated browser tier](../005-browser-pool-dedicated-tier/001-plan.md) (2026-11-11).
**Superseded:** Phase 1 (dynamic port) is dropped: one instance per machine, so static port 3100 stays. Phase 3 (count preservation) is obsolete: the job becomes `system`, one allocation per browser node, so there is no count to preserve. Phase 2 (multi-instance selection in the worker and agents) is replaced by a Hetzner load balancer as one stable agent-facing address; Phase 2 is kept only as the fallback (Option A) if Plan 005's front-door spike fails.
**Still valid:** Phase 4 (gate checks every instance). Plan 005 extends it to also check the front door. The "redeploy test for static port release" in the Decision section is not meaningful: a same-spec resubmit is applied in place. Plan 005 Phase 4 replaces it with a destructive-update test.
**Created:** 2026-11-08
**Area:** Infrastructure, browser-pool, worker, Nomad
**Depends on:** the staging fix in [bug 2026/11/08 001](../../../bug-reports/2026/11/08/001-browser-pool-registered-on-public-address-blocked-by-ufw.md)
**Leads to:** [Plan 004 — scale to thousands](../004-browser-pool-scale-to-thousands/001-plan.md)

---

## Goal

Make the pool able to run **more than one instance**, with each new browser session sent to a concrete instance. Nothing here adds autoscaling. That is Plan 002 and Plan 004.

## Why this comes first

The current state ([browser-pool.md](../../../tech/architecture/browser-pool.md)) blocks scale-out in three places:

1. **Static port.** Port `3100` allows one allocation per node.
2. **One URL.** The worker and the agents take one pool address at startup.
3. **Count reset.** `push.sh` re-submits the job with `count = 1`, which undoes any scale-out on every deploy.

## Decision needed: port strategy

| Option | Instances per node | Firewall | Fit for scale |
|---|---|---|---|
| A. Static per instance (`3100`, `3101`, …) | Up to the number of reserved ports | One rule per port, or a range such as `3100:3199` | Needs one job per instance or templated jobs. Limited to 100 per node. |
| **B. Dynamic port on the private network (recommended)** | Many | One rule for Nomad's dynamic range on `10.0.0.0/24`. Nomad's default range is `20000–32000`, so about 12,000 ports. | Nomad assigns the port, and the service catalog carries the address. The worker already reads it through `resolveAllServices`. |

**Recommendation:** B. Option A caps the design at 100 instances per node and needs job edits to grow. Option B needs no job edits to grow. The cost is a wider firewall range, limited to the private subnet.

**Consequence for the current staging job:** B reverts the static port. Each change is a new deploy, so decide before the redeploy test in [browser-pool.md](../../../tech/architecture/browser-pool.md) runs.

## Phases

### Phase 1 — Port strategy and firewall

- [ ] Choose option A or B (above). Record the decision in an ADR under [docs/tech/architecture/adrs](../../../tech/architecture/adrs).
- [ ] If B: remove `static` from [browser-pool.nomad.hcl](../../../../infra/nomad/browser-pool.nomad.hcl). Keep `host_network = "private"`.
- [ ] If B: replace the single-port UFW rules in [cloud-init-nomad-client.yaml](../../../../infra/hetzner/cloud-init-nomad-client.yaml) and [converge-control-plane.sh](../../../../infra/hetzner/scripts/converge-control-plane.sh) with the dynamic range, from `10.0.0.0/24` and from the Docker bridges. Update the converge tests.
- [ ] Make the gate read the port from Nomad, not assume `3100`. Converge's `BROWSER_POOL_PORT` default must go with the static port.

**Acceptance:** two allocations of the job run on one node, each with its own port, and the gate passes for both.

### Phase 2 — Multi-instance in the worker and agents

- [ ] Resolve all healthy instances, not one. Reuse `resolveAllServices` from the health publisher.
- [ ] Pick one concrete instance per **new** browser session in the adapter (RQ2 in Plan 002). Keep that instance for the whole session, because CDP stays on one WebSocket.
- [ ] Give agents the pool list, or a resolver, instead of `BROWSER_POOL_URL`. Keep `BROWSER_POOL_URL` working for dev and single-instance deploys.
- [ ] Refresh the instance list on a timer, with a cache. Drop an instance that fails a health check.
- [ ] Add the sandbox allowlist entry for each instance address (see [browser-automation.md](../../../tech/agents/tools/browser-automation.md)).

**Acceptance:** with `count = 2`, sessions spread across both instances, and a stopped instance stops receiving sessions within one refresh.

### Phase 3 — Count preservation on deploy

- [ ] Change `push.sh` so a redeploy keeps the running count. Read the live count from `GET /v1/job/browser-pool` and submit that count, not the file's value. This closes RQ3 in Plan 002.
- [ ] Test: scale to 2, redeploy, count stays 2.

**Acceptance:** a deploy never reduces browser-pool capacity.

### Phase 4 — Operational tooling for many instances

- [ ] Gate: check every registered instance, not only the first entry. Today the gate probes only the first one.
- [ ] Health: one admin row per instance. Already true (`bp-<host>:<port>` keys). Confirm it at count = 2.
- [ ] Runbook: how to add, drain, and remove an instance.

## Risks

| Risk | Mitigation |
|---|---|
| A dynamic port changes on reschedule, so cached addresses go stale | Phase 2 refresh timer; drop unhealthy instances. |
| Wider firewall range | Private subnet only. Browserless has no authentication, so never open it to the public internet. |
| Per-session selection adds latency | Cache the instance list. Measure session acquisition. |
| Sandbox allowlist grows with instance count | Check whether the sandbox accepts a prefix. Otherwise, one entry per address, verified in Phase 2. |

## Out of scope

- Autoscaling, the scale loop, and the Nomad scale API (Plan 002 Phase 1, Plan 004).
- Scale-in and session draining (Plan 002 Phase 3).
- Browserless authentication (Plan 004).
