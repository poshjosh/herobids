# Agent Continuity and Capacity: Problem Statement and Objectives

**Status:** Agreed direction; implementation and environment verification pending
**Date:** 2026-10-30
**Area:** Agent runtime placement, autoscaling, and infrastructure changes (staging and production)
**Start here:** [Roadmap](./000-roadmap.md)
**Related:** [Scale-out options](./011-scale-out-options.md), [safe capacity expansion](./001-safe-capacity-expansion-plan.md), [bug report 002](../../../../../bug-reports/2026/10/30/002-capacity-check-reads-empty-allocation-memory-no-autoscale.md)

---

## 1. Problem statement

Our platform runs agents as Nomad jobs on Hetzner servers. Think of the server
as an office and the agent's unfinished work as notes on a desk. More offices
help only if we do not demolish occupied offices and lose the notes.

Three different problems need different protections:

1. **Changing infrastructure is not safely bounded.** The autoscale scripts
   apply the full Terraform stack, not a checked create-only plan. A scheduled
   scale-out can therefore change existing resources as well as add servers.
2. **Waiting and startup are confused.** A requested agent can hit its startup
   timeout while its Nomad job is still waiting for capacity. A server arriving
   later cannot revive that original stopped request.
3. **Restart is not yet demonstrated continuation.** Some state is external,
   but runtime conversation context is in memory and the local workspace lasts
   for the container's lifetime. Moving an allocation does not copy process
   memory, unfinished actions or arbitrary local files.

### 1.1 Corrected incident baseline

The owner reported the following from the last staging plan at **23:06 on
2026-10-30**; the timezone was not supplied. These are reported operational
facts, not a fresh inspection performed while preparing this documentation:

- Saved state and configuration disagree on the agent node's rendered startup
  script (`user_data`). Terraform proposes destroy/recreate of
  `hcloud_server.agent[0]` and replacement of its network attachment.
- **The differing input is unknown.** Diagnose it using a private saved plan
  and a comparison of the old and proposed rendered startup scripts.
- Alert settings are **not the cause**. In the current
  [Terraform definition](../../../../../../infra/hetzner/main.tf), alert inputs
  feed the control-plane template, whose lifecycle ignores `user_data`
  changes. They are not inputs to the agent template. The alert change in the
  reported plan is output-only.
- The owner stopped staging's `nomad-autoscale.timer`. It **must stay stopped**
  until the agent-node drift is identified and a replacement guard is
  implemented and tested. Re-enabling still requires explicit owner approval
  after the first milestone's acceptance gates.
- Production's effective timer, configuration and current plan exposure remain
  unverified. Shared staging has third-party testers; neither environment is
  disposable.

Code is authoritative for dependencies and behavior. Historical documents,
cached counts and this incident summary are not substitutes for current source
and verified environment evidence. Do not infer the unknown input from the
fact that an output changed.

The allocation-memory bug in [report 002](../../../../../bug-reports/2026/10/30/002-capacity-check-reads-empty-allocation-memory-no-autoscale.md)
is a separate defect: missing allocation memory was reported as unused
capacity. Preserve its fix. That fix does not establish safe infrastructure
mutation or continuity.

## 2. Objectives

These are the two outcomes the product has to deliver. Every design choice should be measured against them.

### O1. Infrastructure changes do not lose acknowledged work

- Brief automatic pauses are acceptable; live, in-memory migration is not
  promised.
- Planned maintenance preserves acknowledged work, hands off execution
  authority and verifies restoration before deleting the old server.
- Unexpected failure restores durably committed progress and reconciles
  uncertain external actions. It must not depend on a shutdown checkpoint.
- Supported external actions are not duplicated by recovery. A connector
  lacking idempotency or outcome lookup must expose uncertainty and stop for
  resolution rather than blindly replay an action.
- Conversation context, explicit memory, settings, durable files and pending
  work have defined recovery owners. Trading positions and execution state
  remain authoritative in Traderton; the agent restores their context rather
  than owning or recreating them.
- An unapproved destructive plan is blocked. Approval of a bounded maintenance
  operation does not authorise unrelated changes.
- Waiting, booting, recovery and terminal failure are shown honestly, with
  cancellation and an actionable retry or operator path.

Exact recovery deadlines must be measured and approved before activation.
Tens of seconds is an initial planned-maintenance aim, not a verified SLO.

### O2. Capacity grows with users, at a cost that revenue covers

- The system adds capacity for verified demand and approved headroom.
- Expected net contribution covers incremental cost and an explicit reliability
  reserve. Recovery headroom can intentionally be idle; free/test workloads
  need an explicit subsidy budget. Accrued revenue is not the scaling trigger.
- Hard spend and node caps remain enforceable, including during failure.
- Scale-in removes only exact verified-empty servers, protects pending work
  and incoming capacity, and respects the approved floor. Active consolidation
  is deferred until continuation and maintenance are proven.
- Scheduler reservations and per-node resource fit determine placement
  capacity; cloud/Terraform inventory determines owned server count and cost.
  Ready-node count is not total managed-node count.
- Missing required observations produce an explicit failure, not fictitious
  free capacity or an empty backlog.

## 3. Guardrails that apply to both objectives

- **No unattended destructive changes to occupied servers.** Scale-out may
  create approved capacity only. Later destruction is confined to exact,
  verified nodes within a separately approved maintenance operation.
- **Shared environments are changed only with an explicit owner decision.** Staging testers and production users are affected by infrastructure changes.
- **One source of truth for configuration.** Effective settings converge from
  validated operator configuration, and conflicts block mutation.
- **Tested before it runs on shared infrastructure.** The scale path is exercised on a throwaway environment first.
- **No concealed drift.** Do not use blanket `ignore_changes`, targeted apply,
  state removal or count resets to hide the unknown replacement cause.
- **No secret-bearing evidence in documents.** Plans, state and startup scripts
  can contain credentials. Compare privately and publish sanitized conclusions.

## 4. Evidence and decisions still required

1. Exact agent `user_data` drift input and a safe correction, without replacing
   the occupied node.
2. Production exposure, measured through approved read-only collection.
3. Complete state/side-effect inventory and tested restore behavior, including
   Redis durability, stream cleanup and local workspace semantics.
4. Measured and owner-approved planned/unplanned recovery deadlines.
5. Realized net revenue, resource costs, workload mix, reserve and subsidy
   budgets; committed default rates are not measured margins.

These are execution or activation gates assigned to the plans, not permission
to guess values or postpone all safety work.

## 5. Agreed delivery sequence and exclusions

1. [Safe capacity expansion](./001-safe-capacity-expansion-plan.md): exposure,
   drift diagnosis, mutation guard, accurate demand, persistent waiting and
   original-session acceptance.
2. [Durable continuation](./002-durable-agent-continuation-plan.md): committed
   context, work, artifacts, replay and side-effect ownership.
3. [Controlled maintenance and recovery](./003-controlled-maintenance-and-recovery-plan.md):
   verified handover, failure recovery and exact-node removal.
4. [Capacity economics and latency](./004-capacity-economics-and-latency-plan.md):
   begin measurements alongside step 1; approve later tuning from evidence.

No plan is implemented or deployed by writing these documents. Keep Nomad and
Terraform initially. Node-pool state separation, provider API provisioning,
another autoscaler, warm capacity and snapshot baking remain explicit later
decisions, not implied work or reasons to bypass the first safety gate.
