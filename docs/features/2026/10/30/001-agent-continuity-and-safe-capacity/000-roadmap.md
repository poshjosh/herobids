# Agent continuity and safe capacity - roadmap

**Date:** 2026-10-30  
**Status:** Documentation-only implementation handoff; no implementation, deployment, or readiness measurement implied.  
**Initial architecture:** Retain Nomad scheduling and Terraform infrastructure ownership.

## 1. Operator incident: immediate safety constraint

As of the operator's last plan at **23:06 on 2026-10-30 (timezone unspecified)**,
saved state versus rendered agent `user_data` differs; Terraform proposes
destroy/recreate of `hcloud_server.agent[0]` and its network attachment.
**The differing input is UNKNOWN.** Diagnose using the private saved plan and a
rendered startup-script comparison. Alert settings are control-plane-only inputs
in `main.tf`, and the control plane lifecycle ignores `user_data`; the alert
change in the reported plan is **OUTPUT-ONLY, NOT the cause of agent replacement**.
Code is the source of truth for dependencies; the reported plan has not been
freshly verified here.

The staging `nomad-autoscale.timer` was **stopped BY THE OWNER and MUST STAY
STOPPED** until agent-node drift is identified and a replacement guard is
implemented and tested. Even then, re-enable only with **explicit owner approval
after all first-milestone gates**. Production timer state and plan exposure are
unknown: begin with a read-only assessment; no production mutations.

Read-only GET inspection and analysis of existing artifacts are separate from
generating a new Terraform plan or preparing/locking a live backend. Obtain owner
approval if backend preparation or locking is needed. The existing autoscaler
`--dry-run` is **not guaranteed read-only**: Terraform initialization and workspace
preparation occur before its dry-run exit. Do not prescribe it as harmless.
Saved plans may contain secrets: use private local permissions, sanitized
summaries, and no raw plan/document artifact. Never use global lifecycle ignores,
`-target` shortcuts, state removal, invented workspaces, or a managed desired
count reset from ready-node count.

The mutation guard is unconditional: legacy behavior, feature-gate-off paths
and rollback must not bypass it. If an old binary lacks the guard, leave timers
stopped rather than restoring unguarded automation. Milestone 1's section 0
exposure/drift gate precedes all shared mutation; disposable acceptance is
required before separately approved shared-environment work.

Source anchors:
[main.tf](../../../../../../infra/hetzner/main.tf),
[scale-common.sh](../../../../../../infra/hetzner/scripts/scale-common.sh)
(`tf_init_backend`, `tf_select_workspace`, preparation sequence), and
[scale-out.sh](../../../../../../infra/hetzner/scripts/scale-out.sh).
These are local code observations, not proof of deployed versions or settings.

## 2. What the document set promises - and does not

The approved direction accepts a brief automatic pause, but acknowledged work
must not be lost and supported external actions must not be duplicated.
Implementation must define acknowledgment/commit boundaries, supported connector
guarantees, runtime fencing, durable recovery, and explicit ambiguous-outcome
handling before claiming those properties. Arbitrary external effects cannot be
made exactly once without provider idempotency or reconciliation. Unsupported or
uncertain effects must enter a visible safe pending state, not blind replay.
Arbitrary `execute_shell`, browser and web side effects are **unsupported** for
the no-duplicate guarantee unless enforceable ownership plus idempotency/
reconciliation is demonstrated for that specific path. Database fencing alone
cannot fence external requests or revoke arbitrary direct credentials.

Nomad replaces allocations, **not process memory**. No live process migration,
instantaneous recovery, blanket exactly-once execution, or achieved hard RTO/RPO
is promised. The initial planned-maintenance aim is **tens of seconds**, not a
verified contractual SLO; choose the exact owner-approved target after measuring
the baseline and test it explicitly. Unexpected loss requires recovery of
committed progress and reconciliation of uncertain effects; a graceful shutdown
checkpoint alone cannot guarantee no loss.

This set delivers implementation scope, ordering, discovery requirements,
acceptance criteria, activation gates, and rollback requirements. It does not
deliver code, migrations, live service inspection, timer changes, deployment,
production capacity values, a measured readiness result, or authorization to
operate infrastructure. Trading execution authority stays in Traderton; recovery
must preserve already-accepted safety execution, not mirror positions/orders or
change trading policy.

## 3. Consolidated document map and prior-plan disposition

| Document | Disposition and authority |
|---|---|
| [010-objectives.md](010-objectives.md) | Consolidated objectives, relocated from `docs/agents/agent-continuity-and-capacity-objectives.md`; requirements, not completion evidence. |
| [011-scale-out-options.md](011-scale-out-options.md) | Options, relocated from `docs/agents/nomad-scale-out-options.md`; alternatives remain decisions, not installed features. |
| [001-safe-capacity-expansion-plan.md](001-safe-capacity-expansion-plan.md) | First executable milestone; existing `docs/features/2026/10/30/001-demand-aware-nomad-scale-out/001-plan.md` is moved largely intact and corrected. Do not discard its detailed implementation/tests in favor of this summary. |
| [002-durable-agent-continuation-plan.md](002-durable-agent-continuation-plan.md) | Durable committed state, message handoff, attempt fencing, external intent reconciliation, workspace semantics and recovery accounting. |
| [003-controlled-maintenance-and-recovery-plan.md](003-controlled-maintenance-and-recovery-plan.md) | Bounded owner-approved maintenance and unexpected-loss recovery using proven continuation. |
| [004-capacity-economics-and-latency-plan.md](004-capacity-economics-and-latency-plan.md) | Measurement, net contribution/cost ceilings, resource/latency experiments; invasive changes require evidence and continuity. |

Overlapping requirements in the former
[pending environment-convergence plan](../../../../../../docs/features/pending/000-autoscale-unit-env-convergence/001-plan.md)
are absorbed by milestone 1. Its ready-node-count advice is rejected: failed,
booting, and unready managed servers still matter to inventory and cap accounting.
The [historical scale-in plan](../../../../../../docs/features/2026/08/28/001-nomad-production-scale-in-readiness/001-remediation-plan.md)
remains historical context, not new proof of scale-in safety. It does not authorize
active-node consolidation or automatic replacement.

The relocated objectives, options and first-milestone plan are maintained by the
coordinating documentation owner. This roadmap and plans 002-004 do not replace
their detailed scope. If requirements conflict, stop and reconcile with the owner;
do not silently weaken the incident freeze or the safe expansion gates.

## 4. Sequence and dependency gates

1. **Re-establish evidence and exposure, without mutation.** Read
   [AGENTS.md](../../../../../../AGENTS.md), related source/history and the incident
   report; inventory staging/production automation exposure using approved
   read-only methods. Diagnose the existing private saved plan. Backend
   preparation/new plan generation needs separate approval where it can mutate
   or lock shared state. Keep the staging timer stopped.
2. **Implement and prove milestone 1 in a disposable environment.** Follow
   [001](001-safe-capacity-expansion-plan.md): mutation barriers and fail-closed
   saved-plan replacement guard first; then demand-aware bounded scale-out,
   persistent capacity-wait and placed-start state/deadlines, and truthful UI.
   Preserve managed inventory, unhealthy-node accounting and owner-approved
   spend/node limits. Test unexpected replacement, failed observations, zero
   ready nodes, at-cap refusal, worker restart while waiting, and no waiting
   runtime billing. No active-node consolidation/automatic replacement.
3. **Separately approve staging activation of milestone 1.** Require identified
   drift, guard tests, disposable acceptance evidence, sanitized intended-change
   review, rollback and explicit owner approval. Timer enablement is a separate
   operator action, never an incidental script side effect. Production remains a
   separate approval after staging evidence and production read-only assessment.
4. **Implement continuation using [002](002-durable-agent-continuation-plan.md).**
   Reuse milestone 1 waiting/startup semantics. Prove durable committed progress,
   safe message recovery, attempt fencing and supported-effect reconciliation
   before destructive maintenance. Pauses must not masquerade as terminal stops.
5. **Implement controlled operations using [003](003-controlled-maintenance-and-recovery-plan.md).**
   Only after continuation is proven: bounded owner-approved operations on exact
   identities, measured pause targets and safe aborts. Unexpected-loss recovery
   must work without the old process cooperating.
6. **Run [004](004-capacity-economics-and-latency-plan.md) measurement in parallel
   with milestone 1 where non-invasive.** No new capacity policy activation is
   implied. Evaluate invasive cost/performance options only after measured need,
   continuation acceptance and separate owner decisions. Do not make fairness,
   pricing or guaranteed reserve changes implicitly.

## 5. Evidence and limits that shape the later plans

Local source observations on 2026-10-30:

- [agent.ts](../../../../../../apps/worker/src/agent.ts) initializes
  `conversationHistory`, `judgeResponseHistory` and pending wake buffers in memory.
  `shutdown` waits at most eight seconds for a tick, then continues teardown and
  publishes `session_ended` even if that tick remains active.
- [Nomad adapter](../../../../../../apps/worker/src/agents/nomad-runtime-adapter.ts)
  `buildNomadJobSpec` has no persistent workspace volume and uses restart
  attempts zero. Job ID `agent-<id>` and `herobids.sessionId` metadata do not
  identify a unique runtime attempt.
- [outbound reader](../../../../../../apps/worker/src/agents/outbound-message-reader.ts)
  acknowledges stream entries before returning them for processing.
  [Broker](../../../../../../apps/worker/src/agents/agent-message-broker.ts)
  message-ID deduplication and active-session gating already exist; strengthen
  these rather than create independent competing guarantees.
- [Memory tool](../../../../../../apps/worker/src/tools/memory.ts) uses Redis
  hashes. Product-critical Redis durability must be demonstrated or replaced by
  an appropriate durable source, not assumed from the word "Redis".
- [Default billing](../../../../../../config/default.yaml) seeds runtime pricing
  at 100 microusd per 60,000 ms, or **$0.006/hour**, not realized revenue.
  [UsageBillingService](../../../../../../apps/worker/src/usage-billing-service.ts)
  and active database rate cards determine actual charges.

Direct Hetzner API provisioning, an autoscaler/plugin, snapshots/warm pools and
Terraform state separation are deferred evidence-based decisions, not
automatically separate implemented features. Check any claimed official plugin
support against current authoritative sources at decision time; Hetzner community
plugin support is not automatically HashiCorp support.

## 6. Next-agent handoff and completion record

**Order:** read roadmap -> objectives/options -> 001 discovery/guard/disposable
acceptance -> owner staging decision -> 002 -> 003. A separate bounded 004
measurement task may start alongside 001; invasive optimization waits for its
gates. Each agent must read its whole plan and re-discover the current code;
filenames and symbols are anchors, not assertions about deployed behavior.

For each milestone, require source revision and worktree notes, migration/config
diffs, targeted unit/integration results, disposable fault-injection results,
sanitized operator evidence, API/UI/billing checks, limits/unsupported cases,
rollback rehearsal and explicit activation decisions. Record achieved recovery
measurements only after testing. No document status or historical run is a
substitute for these records.

Unresolved activation decisions include the unknown agent startup-script drift,
production exposure, live backend access approval, persistence durability,
supported connector contracts, exact maintenance target, capacity/spend/reserve
budgets, downtime accounting and any pricing/fairness changes. These are gates
for future work, not permission to fill in production defaults. Documentation
creation is complete independently of those operational decisions.
