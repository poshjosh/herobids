# Controlled maintenance and recovery - implementation plan

**Date:** 2026-10-30  
**Status:** Future implementation; not an operational authorization or readiness report.  
**Dependencies:** [001 safe expansion](001-safe-capacity-expansion-plan.md) and
[002 durable continuation](002-durable-agent-continuation-plan.md) must supply
tested waiting/startup, committed progress, runtime fencing and reconciliation.
Read [roadmap](000-roadmap.md), [objectives](010-objectives.md) and
[options](011-scale-out-options.md).

## 1. Goal and non-goals

Provide a bounded, owner-approved path for planned node maintenance and a
separate safe recovery path for unexpected runtime/node loss. Planned maintenance
may briefly pause an agent while it resumes on another allocation. The initial
aim is **tens of seconds**, not a verified contractual SLO. Measure baseline
timings first, choose an exact owner-approved target and validate that target
explicitly. Do not claim a hard RTO/RPO from a plan.

Acknowledged work must remain recoverable and supported effects must not be
duplicated, including when the old process never checkpoints or exits cleanly.
Nomad replaces allocations, not memory; use committed continuation and uncertain
effect reconciliation from 002. Never infer that a missing terminal effect record
means no action happened. Traderton remains authoritative for positions, orders
and execution; Herobids recovery must not stop or duplicate its accepted safety
execution or change trading policy.

**Non-goals:** milestone-1 active-node consolidation/automatic replacement;
automatic destruction on failed health checks; fleet-wide unattended draining;
live process migration; provider failover/state mirroring; a general workflow
engine; initial switch from Terraform/Nomad; snapshots/warm pools or alternate
provisioners without evidence and a separate decision.

This plan does not lift the incident freeze. The owner stopped staging
`nomad-autoscale.timer`; keep it stopped until unknown agent startup-script drift
is identified, replacement guard is implemented/tested, milestone-1 gates pass
and the owner explicitly approves re-enablement. Production exposure is unknown;
assess read-only before any separately approved mutation. Historical scale-in
documents are not authority to delete nodes.

Milestone 1's section 0 exposure/drift gate and disposable acceptance precede
shared mutation. Its mutation guard applies unconditionally to legacy,
feature-gate-off and rollback paths. An old binary without that guard requires
timers to remain stopped.

Use 002's explicit effect support matrix. Arbitrary `execute_shell`, browser and
web/direct HTTP effects remain unsupported for the no-duplicate guarantee unless
ownership plus idempotency/reconciliation can be enforced for the specific path,
including delayed/in-flight requests. Database fencing alone is insufficient.
Exclude unsupported agents from automatic maintenance continuation or mediate
their effects under an approved contract; never claim universal duplicate safety.

## 2. Evidence and mandatory rediscovery

Local code anchors, not deployed-state claims:

- [Nomad adapter](../../../../../../apps/worker/src/agents/nomad-runtime-adapter.ts),
  `buildNomadJobSpec`: stable `agent-<id>` job, session metadata, no persistent
  workspace volume and restart attempts zero. Scheduler drain alone cannot
  restore process-local state or distinguish concurrent attempts.
- [agent.ts](../../../../../../apps/worker/src/agent.ts), `shutdown`: eight-second
  tick-drain bound, then teardown and `session_ended` even for an active tick.
  A successful stop response is not proof of durable progress.
- [AgentSessionManager](../../../../../../apps/worker/src/agents/agent-session-manager.ts),
  `registerSurvivedSessions`, `handleRuntimeFailure`, `handleRuntimeSessionEnd`,
  `markUnhealthy`; [launcher](../../../../../../apps/worker/src/agents/agent-runtime-launcher.ts),
  `reconcile`, `launch`, `stop`, `kill`: existing lifecycle/recovery seams to extend,
  not proof that durable continuation already exists.
- [Cleanup](../../../../../../apps/worker/src/agents/agent-ephemeral-redis-cleanup.ts)
  deletes ephemeral streams on terminal paths. Recovery must not accidentally
  erase accepted unfinished inputs.
- [scale-in.sh](../../../../../../infra/hetzner/scripts/scale-in.sh),
  [scale-out.sh](../../../../../../infra/hetzner/scripts/scale-out.sh),
  [scale-common.sh](../../../../../../infra/hetzner/scripts/scale-common.sh),
  [main.tf](../../../../../../infra/hetzner/main.tf),
  [agent-node-health.sh](../../../../../../infra/hetzner/scripts/agent-node-health.sh)
  and [maintenance-restart.sh](../../../../../../infra/hetzner/scripts/maintenance-restart.sh)
  are mandatory operational discovery anchors. Their names do not prove current
  safeguards, environment convergence or suitability for this operation.
- [API projection](../../../../../../apps/api/src/services/agent-runtime-session-projection.ts),
  [agents routes](../../../../../../apps/api/src/routes/agents.ts) and
  [AgentDetailPage](../../../../../../apps/web/src/features/agents/AgentDetailPage.tsx)
  are existing user status surfaces. [Usage billing](../../../../../../apps/worker/src/usage-billing-service.ts)
  needs continuation-aware accounting, not duplicate attempt charges.

Before editing, read [AGENTS.md](../../../../../../AGENTS.md),
[lessons](../../../../../../docs/lessons/lessons-from-previous-project.md),
[best practices](../../../../../../docs/best-practices/README.md),
[configuration](../../../../../../docs/best-practices/configuration.md),
[runtime contract](../../../../../../docs/tech/agents/runtime-boundary-and-message-contract.md),
[recovery/replay](../../../../../../docs/tech/agents/recovery-and-replay.md),
[infra index](../../../../../../infra/hetzner/docs/README.md) and
[infra lessons](../../../../../../infra/hetzner/docs/auto-scaling/lessons-learnt.md).
Inspect current relevant history, bug reports and worktree changes. Historical
engine recovery language must not reintroduce Herobids trading authority.

Mandatory discovery record:

1. Verify 001/002 acceptance artifacts and their actual implemented interfaces;
   enumerate unsupported tools/legacy sessions that cannot be safely moved.
2. Inventory node identities end-to-end: cloud server ID, Terraform resource
   address, Nomad node ID, allocations, pool, environment and current lifecycle
   state. Establish whether the count-indexed Terraform pool can remove the
   selected identity without replacing/reindexing others. If not, stop deletion;
   decide an approved identity-preserving design first.
3. Inspect current drain/deadline/kill semantics, node eligibility, allocation
   replacement rules, control-plane dependencies, health scripts, timer/service
   overlap and every infrastructure writer. Determine how old runtime credentials
   and direct HTTP paths are fenced. A drain completion event is not fencing.
4. Measure image pull, placement, checkpoint commit, restore, reconciliation and
   first successful post-resume useful operation in a disposable baseline.
   Include warm/cold images, browser-dependent work and slow provider outcomes.
5. Identify storage/control-plane failure domains and remaining spare capacity:
   memory reservations, actual CPU/RSS, browser pool, disk and cap/reserve limits.
   Shared DB/Redis/blob outage may prevent all recovery; acknowledge this limit.
6. Separate existing artifact/read-only GET analysis from new plans/locks.
   Existing `--dry-run` initializes Terraform/workspaces before exiting and is not
   a harmless read-only probe. Use environment-specific
   `TF_DATA_DIR=.terraform-envs/<env>` only for approved Terraform work; never
   invent workspaces or reset desired counts to ready counts.

## 3. Operation contract and infrastructure boundary

Propose a small durable maintenance-operation record in existing Postgres
infrastructure, not a new orchestration platform. Final table/module names follow
discovery. Minimum fields: operation ID, kind, owner approver, environment,
exact cloud/Terraform/Nomad identities, affected logical sessions and attempts,
expected inventory revision, state/version, deadlines, spend/node bounds,
checkpoint/fence/restore evidence references and abort/failure reason.

Proposed state sequence:

`proposed -> approved -> preflight -> reserving -> quiescing -> fenced ->
restoring -> verifying -> destruction_authorized -> completed`

with durable `aborted`, `failed_safe` and `pending_resolution` states.
Not every operation destroys a node; skip destruction for reboot/restart only
when its own identity and safety contract is approved. Persist state before each
irreversible action; make retries idempotent and recover the operation after
controller restart. Approval is bounded by exact identities, kind, deadlines and
maximum exposure, not a reusable permission for future nodes.

Use typed domain ports for operation storage, continuation/fencing and node
inspection/control; implementations inject existing Nomad client and Terraform
boundary through worker/operator tooling. Keep Terraform the cloud writer
initially. A maintenance exception must not disable milestone-1 replacement
guards globally: use a narrowly scoped, owner-approved exact identity/action
allowlist, consumed only by this operation. Any unrelated replacement, delete,
unknown plan, cap violation, drift or stale approval aborts.

Deletion requires a final verified saved-plan review and identity revalidation
after restored workloads are healthy. Do not remove state, use `-target`, ignore
all `user_data` changes or make an index-count decrement select an arbitrary
active node. If resource addressing cannot express the requested operation
safely, stop and defer the necessary infrastructure identity/state redesign.

No new public port is required by default. Use existing authenticated operator
interfaces and private Nomad/API connectivity. Map actual ACL capabilities,
credentials, DB/Redis/blob reachability and network failure behavior before
implementation; a new control endpoint or proxy needs explicit access review.
Do not grant node-control privileges to agent containers.

## 4. Ordered tasks and dependencies

1. **Approve baseline and operating envelope.** Complete discovery; choose exact
   planned-pause target and measurement start/end, maximum concurrent affected
   agents/nodes, extra capacity budget, retry deadline, allowed session/connector
   classes and abort thresholds. Start with one owner-selected node per
   operation unless separately approved. Define pause as loss of ability to
   perform useful authorized work through first successful useful work after
   recovery, not merely heartbeat or HTTP readiness.
   **Depends on:** 001/002 evidence; unresolved durability/fencing blocks operation.
2. **Implement durable operation/approval state.** Add required typed ports under
   [domain ports](../../../../../../packages/domain/src/ports), additive schema/
   repository in [db](../../../../../../packages/db/src), generated migrations
   with matching [journal](../../../../../../packages/db/drizzle), CAS/lease
   ownership and idempotent operation transitions. Add proposal/preflight/status/
   abort entry points to the discovered operator surface; any proposed HTTP route
   is new, not assumed to exist. Fail closed on expired approval or unknown
   inventory. **Depends on:** task 1.
3. **Reserve capacity and quiesce exact workload.** Wire through
   [worker index](../../../../../../apps/worker/src/index.ts),
   [session manager](../../../../../../apps/worker/src/agents/agent-session-manager.ts)
   and [runtime port](../../../../../../packages/domain/src/ports/runtime.ts).
   Check admissible spare capacity/reserve or request bounded Terraform additions
   through the protected 001 path; at cap, wait/refuse visibly, never delete to
   create room. Stop new placement on the selected node, quiesce new agent work,
   commit known progress, retain incoming accepted inputs and durable intents.
   **Depends on:** task 2 and continuation APIs from 002.
4. **Fence, restore and reconcile before useful work.** Use 002 attempt epochs
   across broker, direct HTTP and external-backend requests, then create successor
   attempts through launcher/Nomad adapter. Unknown in-flight action outcome
   blocks dependent replay; reconcile using stable provider IDs or enter pending
   operator resolution. Lost/unreachable old node is not evidence that it cannot
   still act. No successor effects until fencing is proven. Preserve Traderton
   accepted execution. **Depends on:** task 3.
5. **Verify before any destruction.** Require committed sequence/input continuity,
   artifact availability, useful-work probe, singleton authority and billing
   reconciliation for every affected session. Revalidate exact identities,
   inventory/approval version and saved-plan changes. Only then authorize the
   exact approved maintenance mutation via existing Terraform ownership. If node
   mapping cannot be proven or any verification fails, no destruction.
   **Depends on:** task 4; separately approved irreversible step.
6. **Handle unexpected loss independently.** Extend `handleRuntimeFailure`,
   `markUnhealthy`, survived-session registration, launcher reconciliation and
   node-health reporting to use the same durable records/fencing/restore path,
   without requiring the failed runtime's cooperation. Bounded automatic
   application recovery may resume eligible work; it must not automatically
   destroy/replace cloud nodes. Unknown inventory or at-cap loss alerts with a
   specific safe failure reason. **Depends on:** tasks 2 and 4; can be tested
   independently of destructive task 5.
7. **Expose operation and accounting truth.** Update API session projections/
   agents routes and AgentDetailPage: maintenance pause, recovery, pending
   resolution, useful-work restoration and terminal failure must differ from
   user stop. Operator UI/API exposes exact node/operation scope and sanitized
   evidence, not secrets. Reuse 002 logical runtime intervals: no waiting charge
   or attempt-overlap double billing; audited downtime policy remains explicit.
   Config schema/defaults carry disabled feature flag, bounds/deadlines and
   approved target; wire through one resolved config and update env example
   twins if keys change. **Depends on:** tasks 1-6.
8. **Prove and seek rollout approval.** Run section 5 matrix in disposable
   infrastructure, rehearse abort and compatible rollback, then present staging
   canary proposal. **Depends on:** prior tasks. No actual maintenance or timer
   enablement is authorized by implementation completion.

## 5. Acceptance and failure-injection matrix

Unit-test operation transition CAS, approval scope/expiry, target identity
matching, plan allowlist, retry bounds, pause measurement and billing intervals.
Integration-test durable operation recovery, authentication, session projections
and concurrent controllers. Use disposable Nomad/cloud substitutes first; any
real disposable-cloud test needs bounded owner approval.

| Scenario | Required pass/fail evidence |
|---|---|
| Planned move with active messages, durable file writes and supported actions | Zero lost accepted input IDs, verified committed sequences/manifests, zero duplicate supported effects, one authorized attempt; pause measured against exact approved target. |
| Cold image or slow checkpoint/restore exceeds target | Explicit target failure and bounded safe abort/pause; no destructive success or hidden SLO claim. |
| Old allocation partitioned but can reach provider | Stale actions fenced at all supported accepting boundaries; replacement cannot duplicate a delayed in-flight action. |
| Abrupt process/node loss with no final checkpoint | Last committed progress restored; accepted work accounted for; uncertain effects reconciled or pending, never assumed absent. |
| Operator controller dies at every operation transition | Resumption is idempotent, approval remains scoped, no repeated cloud mutation; durable audit identifies outcome. |
| Destination full, at cap, browser exhausted, DB/Redis/blob unavailable | No unsafe drain/destruction; bounded pause/refusal with correct reason; reserve limits respected. |
| Different node/resource selected, unrelated replacement in plan, expired approval | Zero infrastructure mutation; fail-closed operation requiring renewed evidence/approval. |
| New demand during drain or another operation starts | Exact scope/concurrency bounds enforced, accepted work preserved, reserve not oversubscribed. |
| Reappearing old node; late heartbeat/farewell; terminal cleanup race | No authority reversal or deletion of successor/accepted unfinished work. |
| Stop/cancel during restore; rollback before/after fencing | User intent persists; no unfenced return to old attempt; no automatic deletion to "finish" rollback. |

Visually verify paused/recovering/pending-resolution and resumed states after
browser reconnect, plus meaningful billing/audit details. Collect monotonic
per-stage timings, warm/cold p50/p95/p99 where sample size supports them, maximum
observed pause and target breaches. Separately report unexpected-loss detection,
fence, restore and reconciliation timings. No invented measurements or universal
no-loss claim beyond the declared persistence/connector fault model.

## 6. Approval, rollout, rollback and evidence

Gates: approved exact target/envelope -> 002 guarantees proven for selected agents
-> complete disposable matrix -> compatibility/abort rehearsal -> explicit staging
operation approval -> reviewed canary evidence -> separate production approval.
Milestone-1 timer approval remains independent. Each destructive operation
requires exact identities and an up-to-date bounded authorization.

Abort before fencing: stop operation, release temporary reservations and restore
eligibility only if workload safety and current ownership are verified. Abort
after fencing: do not resurrect old credentials/epoch; retain safe paused state
or finish restoring the current authorized attempt. After cloud destruction,
there is no instantaneous undo: recover on retained/new approved capacity using
committed durable state. Retain operation/action records and checkpoints; do not
drop additive schema or deploy unfenced old binaries over new active attempts.
Extra capacity removal is another reviewed safe operation, not automatic cleanup.

Final evidence: revision/config/migrations, exact identity mapping, approval
scope, sanitized plan summary, checkpoint/accepted-input/action audit, stale-owner
rejection tests, measured target result, billing/UI checks, controller restart/
abort/rollback results, known unsupported agents/connectors and operator signoff.
Unverified node addressing, direct-effect fencing, persistence failure domains,
exact pause target, reserve/spend envelope and downtime policy are activation
blockers until resolved. Never substitute a historical scale-in result for these
operation-specific checks.
