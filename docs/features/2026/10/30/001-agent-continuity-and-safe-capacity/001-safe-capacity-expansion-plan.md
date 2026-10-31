# Milestone 1: Safe Capacity Expansion and Capacity-Aware Starts

**Status:** Implementation handoff; exposure and drift gates open; no activation authorised  
**Date:** 2026-10-30  
**Repository:** herobids  
**Programme:** [Roadmap](./000-roadmap.md), [objectives](./010-objectives.md), [options](./011-scale-out-options.md)  
**Approach:** Exposure first, mutation barriers, corrected demand and bounded batch sizing, persistent waiting; retain Terraform provisioning  
**Production activation:** Requires separate owner approval after staging acceptance

## 0. Mandatory entry gates and corrected operational baseline

### 0.1 Goal and handoff boundary

Make adding capacity safe and useful: existing occupied servers are not changed,
and the original requested agent sessions can wait, be placed and reach first
heartbeat without manual restart. This is the first milestone, not a claim that
running-agent continuation, migration or automatic node replacement is safe.

The user approved this direction and preparation of the documents, not live
execution. Keep staging's owner-stopped `nomad-autoscale.timer` stopped.
No deployment, migration, timer change, apply, drain, scale-in or shared load
test is authorised by this plan alone. Obtain approval at the gates below.

### 0.2 Incident correction: do not guess the replacement cause

At the owner's last staging plan at **23:06 on 2026-10-30** (timezone
unspecified), saved state and configuration disagreed on agent-node
`user_data`. The plan proposed destroy/recreate of `hcloud_server.agent[0]`
and replacement of its network attachment. **The input that differs has not
been identified.** This is owner-reported evidence, not a newly executed plan.

Current [main.tf](../../../../../../infra/hetzner/main.tf) establishes:

- Alert settings feed `cloud-init.yaml` for `hcloud_server.default`; that
  resource has `ignore_changes = [user_data]`.
- Agent `user_data` comes from `cloud-init-nomad-client.yaml` with server name,
  environment, Nomad server address, pool/index, Nomad version, private subnet,
  control-plane private IP and registry credentials. Alert settings are not
  supplied to this template.
- Agent servers have `prevent_destroy = false` and no `user_data` ignore.
- `hcloud_server_network.agent[index]` references the server identity, so its
  replacement can follow the server's replacement.

The reported alert change is **output-only**, not a cause of agent replacement.
Check actual source and provider plan semantics before assigning any cause.
Do not "fix" the incident by changing alert settings, ignoring all agent
`user_data`, removing state, applying with `-target`, or replacing the server.

### 0.3 First execution gate: bounded exposure and drift assessment

Before any shared-environment mutation:

1. Read the repo rules, current source, worktree and relevant history. Preserve
   the allocation-memory fix and unrelated work.
2. With the owner's access approval, record sanitized production and staging
   timer enablement/activity, in-flight operations, effective settings,
   inventory, deployed revision and all mutation entry points. Use GET/read
   commands; do not run the existing autoscale dry-run or maintenance restart
   as an investigation shortcut. Do not stop production services on discovery.
3. Analyse the existing private saved plan if available. If absent or stale,
   seek approval to generate a diagnostic saved plan against the known existing
   backend/workspace. Even a non-applying plan may acquire a backend lock or
   require initialization; this is a separate operational permission from
   strictly read-only GET collection. Never create a workspace or state, disable
   locking, apply a refresh, or infer current safety from an old plan.
4. Using private local artifacts, compare the state-side and planned rendered
   agent startup scripts and the exact `replace_paths`/resource actions.
   Correlate changed script sections with the template and its inputs, resolved
   private-network values, template history and provider behavior. The old
   plaintext may be unavailable; if so, state that evidence gap and request the
   needed historical artifact rather than claiming the input is known.
5. Identify the differing input or template content and explain why it changed.
   If credential material differs, report the field/section and rotation context
   only, never its value. Derive a reviewed correction that does not destroy or
   replace an existing occupied node. If no such correction is available, keep
   the hold and return the blocker; do not hide the drift.
6. Record exposure, root-cause evidence, proposed correction, owner approvals
   and remaining unknowns in a sanitized assessment record in this directory
   when work is actually performed. A code finding, a reported plan and a fresh
   environment observation must have distinct labels and timestamps.

Saved plans, Terraform state, plan JSON and rendered scripts may contain
credentials. Use private permissions and restricted local temporary files;
never commit, attach or log raw artifacts. Delete only named temporary artifacts
after producing sanitized conclusions. No production mutation is implied.

### 0.4 Mutation barrier before tuning or enabling

Implementation can proceed locally while assessment/activation remains blocked.
Prioritise and test the section 5.7 saved-plan allowlist before any new scaling
policy is enabled. Cover every automated apply path, including legacy watcher
entry points and scale-in, and prevent manual deploy/provision paths from
silently racing an approved operation. Read-only shadow must remain possible
without entering the apply path.

For count-based scale-in, require the exact verified-empty highest-index suffix.
Sorting idle candidates is insufficient: with node 3 busy and node 2 idle,
shrinking count from 3 to 2 still destroys node 3. Test that case explicitly.
Unknown allocation status/API failures must not become "idle"; validate the
actual planned server IDs before removal. No active-node consolidation or
automatic unhealthy-node replacement is in scope.

Apply the safety guard independently of the demand-policy feature gate. Disabling
the new policy or rolling back to legacy must not restore unrestricted apply.
If older binaries cannot enforce the guard, leave their mutation timers stopped.
The guard has no `--force`, safety-net, cooldown or operator convenience bypass.
Any later destructive operation belongs to the separately approved
[maintenance plan](./003-controlled-maintenance-and-recovery-plan.md).

### 0.5 Gate sequence and future evidence

1. Local source/fixture tests and exact saved-plan rejection tests pass.
2. Owner-approved disposable infrastructure exercises real add-only scaling,
   waiting, partial-failure and rejection paths before shared-infrastructure use.
3. Exposure and agent-node drift are understood; reviewed correction produces
   a refreshed plan with no changes to existing protected resources.
4. Read-only staging shadow, configuration convergence and section 12 preflight
   satisfy all prerequisites. The replacement guard is implemented/tested.
5. Owner explicitly approves named staging mutations and timer activation.
6. Section 12 acceptance proves original-session first heartbeat, cap/cooldown
   and existing-agent preservation; production activation remains separate.

An unexecuted gate is pending, not passed. If production is exposed, notify the
owner with evidence and request a decision; do not silently change its timers.
The later [continuation plan](./002-durable-agent-continuation-plan.md) and
[maintenance plan](./003-controlled-maintenance-and-recovery-plan.md) are not
prerequisites for strictly add-only expansion, but are prerequisites for claiming
running-agent migration and recovery guarantees. Start the
[economics measurement](./004-capacity-economics-and-latency-plan.md) alongside
this milestone without changing billing or the approved cap.

## 1. Purpose and instructions for the implementing agent

Agents currently wait for a place to run, but the platform can stop them before
new servers arrive. The autoscaler also has an unreliable picture of how much
work is waiting and how much capacity is available. Adding servers faster will
not help if the waiting agents have already been stopped.

Implement a single, demand-aware scale-out controller that adds the right
bounded amount of capacity and lets the original waiting sessions start. Keep
Terraform as the only writer of cloud infrastructure. Correct the observations
below as part of this feature, not as optional follow-ups.

This document is a handoff, not evidence that changes are implemented or deployed.
Repository observations were made on 2026-10-30. Re-read the current source,
worktree status, relevant git history and referenced bug reports before editing.
Paths and symbols are discovery anchors; line numbers in older reports are not
authoritative. Preserve changes made by others. Do not copy secrets into code,
fixtures, documentation or logs.

Read [AGENTS.md](../../../../../../AGENTS.md),
[best practices](../../../../../best-practices/README.md),
[configuration conventions](../../../../../best-practices/configuration.md),
[agent runtime rules](../../../../../best-practices/agent-runtime.md) and
[Docker conventions](../../../../../best-practices/docker.md).
Do not invoke a full test/deployment workflow merely to prepare this feature.
Use targeted checks first and the acceptance sequence in section 12.

### Decisions and initial operating values

The owner accepted the recommended direction and preparation of these handoffs.
Use the settings below as configurable initial implementation settings, not
measured production guarantees or permission to activate shared services.

| Decision | Required behaviour |
|---|---|
| Capacity waiting | Allow up to 600,000 ms from session creation to placement for a successfully registered Nomad job |
| Placed startup | Allow 120,000 ms from first placement to first accepted heartbeat; image pull is included |
| Unregistered launch | Preserve the existing `worker.agents.startTimeoutMs` deadline for a session whose job was never successfully submitted; default currently 60,000 ms |
| Overall startup bound | No first heartbeat by session creation + capacity-wait budget + placed-start budget is terminal, even if scheduler inspection fails |
| Steady-state health | Preserve existing running-session heartbeat timeout and recovery semantics |
| Demand persistence | The same outstanding capacity-blocked workload must appear in 2 consecutive successful observations, normally 60 seconds apart |
| Batch ceiling | At most 2 nodes per scale event initially, additionally bounded by remaining node-cap headroom |
| Existing headroom policy | Retain each environment's effective memory/slot thresholds and cooldown initially; headroom can trigger without demand persistence |
| Floor | Actively restore `min_agent_nodes`; it is not merely a scale-in constraint |
| No ready nodes | Provision automatically from zero, or add recovery capacity within spare node-cap headroom, using verified inventory and a calibrated node template |
| Failed nodes | Never automatically delete, replace in place, or remove unhealthy servers from the cap calculation |
| At cap / unknown inventory | Do not add capacity; alert with a specific reason and operator guidance |
| Rollout | Disabled by default; local/disposable verification, staging read-only shadow, then separately approved staging activation; production new gates remain disabled |

Important meaning of "recovery": if three managed servers exist and all are down
with a cap of three, this feature alerts. It does not pretend the count is zero
or destroy servers to make room. Adding a fourth under a cap of five is possible
after the controller has classified the existing nodes as unavailable rather
than still booting. Existing workload recovery/rescheduling remains Nomad and
the application's responsibility; adding a node alone cannot guarantee recovery
of a partitioned allocation.

## 2. Scope and non-goals

### In scope

- Correctly scoped, current outstanding Nomad placement demand.
- Accurate managed-pool capacity accounting and conservative resource fitting.
- A single bounded scaling policy, including proactive headroom and floor.
- Authoritative managed inventory, in-flight accounting, and safe Terraform
  execution with protected-resource/change checks.
- Durable convergence of effective autoscale configuration on deploy.
- A restart-safe distinction between queueing for capacity and booting.
- Clear API/UI startup progress and failure reasons; cancellation during waiting.
- Unit/integration tests, read-only shadow observation, staging acceptance,
  operator documentation, feature gates and rollback.

### Explicitly not in scope

- Direct Hetzner API provisioning, a second infrastructure owner, or a switch to
  Nomad Autoscaler. Read-only Hetzner inventory requests are allowed.
- Warm servers, snapshot baking, scheduled capacity automation, new instance
  types, relocating Browserless, or a general-purpose scheduler/bin-packing
  service.
- Automatic unhealthy-node deletion, Terraform state surgery, or relaxing the
  server cap.
- Trading policy, trading backend changes, or extra LLM wakes/invocations.
- Refactoring unrelated runtime termination handling or unrelated infrastructure
  defects.
- Durable continuation of running agents, active-node consolidation, automatic
  occupied-node replacement, or a claim of no lost work after abrupt failure.
  Those are the subsequent continuation and maintenance plans.

## 3. Verified starting point and the defects this work must address

1. The source configures `nomad-autoscale.timer` to invoke `scale-out.sh` about
   every 60 seconds; staging's timer is owner-stopped per section 0.
   The script checks room-based thresholds, adds the configured fixed increment,
   uses a local `flock`, and records a cooldown after successful Terraform apply.
2. `nomad-placement-failure-watcher.timer` runs about every 120 seconds. Its
   watcher counts recent evaluations and invokes `scale-out.sh
   --bypass-cooldown --force`, with a separate trigger cooldown.
3. The watcher queries `/v1/evaluations` without an explicit namespace. Nomad
   defaults that endpoint to `default`, whereas an incident report records agent
   jobs in `herobids-agents`. Resolve the configured namespace; do not hard-code
   the example or use a cluster-wide query without explicit policy.
4. The watcher tests `BlockedEval` and `StatusDescription` for resource keywords.
   `BlockedEval` is an evaluation ID, not a reason. A legitimate blocked status
   description can be `created to place remaining allocations`, which does not
   match. The creation-time window also forgets still-blocked old demand.
5. Evaluation/API/JSON failures can be converted to `[]` or `0`. These are
   observation failures, not an idle cluster.
6. `check-nomad-capacity.sh` counts ready eligible clients without the managed
   class/pool filter, counts only running allocations, estimates slots from
   aggregate memory, and ignores CPU fit. Free fragments on different machines
   cannot be combined into an agent slot.
7. A recent fix reads memory from `AllocatedResources.Tasks` with a legacy
   fallback and fails on missing figures. Preserve that fix. Browserless and
   other allocations consume the same nodes and must be included in occupied
   resources, even though they are not agent demand.
8. `current_agent_node_count()` trusts a cached file, including a stale `0`,
   then falls back to counting non-down Nomad nodes. Neither is authoritative
   cloud/Terraform inventory. Cloud-init seeds the file to `0`; `/var/run` is
   ephemeral. Down/not-yet-joined servers still exist and cost money.
9. The pending convergence plan documents first-boot systemd settings that drift
   from environment tfvars. Current convergence installs an `EnvironmentFile`
   hookup, not the complete autoscale configuration. Cloud-init changes alone
   do not update existing control planes (`ignore_changes = [user_data]`).
10. Existing `--dry-run` reaches Terraform initialization/workspace selection
    before its no-apply exit. It is not a strictly read-only observation mode.
11. A fixed increment exceeding remaining cap headroom currently aborts instead
    of adding the smaller allowable remainder. A count of evaluations is not a
    count of required nodes.
12. `NomadRuntimeAdapter.launch()` returns after job registration, not placement.
    Its returned `startedAt` is not proof of container startup. `inspect()` takes
    the first allocation and exposes no explicit placement state.
13. `AgentHealthMonitor` uses session creation time for its 60-second default
    start deadline. `handleStartTimeout()` wins a conditional DB update, stops
    the job and agent, and emits a failure. New nodes arriving later cannot
    revive the original request.
14. Raising `min_agent_nodes` currently constrains scale-in but does not by itself
    create nodes. A scheduled floor would therefore require active reconciliation.
15. A second loop bypassing cooldown can independently add capacity. In-flight
    servers and partial Terraform success are not sufficient grounds for another
    blind increment.

### Prior work to preserve and supersede explicitly

- [Allocation memory incident and fix](../../../../../bug-reports/2026/10/30/002-capacity-check-reads-empty-allocation-memory-no-autoscale.md):
  code fixed; the report records deployment to staging. Deployment was not
  independently rechecked for this document. Adding capacity remains blocked by
  the owner-stopped timer and unresolved agent-node drift.
- [Start-timeout race report](../../../../../bug-reports/2026/10/05/002-agent-start-timeout-race-kills-healthy-runtime.md):
  historical text describes an older 30-second budget. Current code has a
  separate 60-second startup budget and conditional transitions. Do not undo
  those protections or assume all historical descriptions are still current.
- [Burst activation latency report](../../../../../bug-reports/2026/09/05/001-agent-activation-timeout-cumulative-launch-latency.md):
  distinguish real agent readiness from smoke-test timing and LLM work.
- [Pending autoscale convergence plan](../../../../pending/000-autoscale-unit-env-convergence/001-plan.md):
  absorb its configuration convergence work and mark the overlapping scope as
  superseded when implemented. Do NOT adopt its suggestion to replace managed
  count with ready-node count.
- [Autoscaling lessons](../../../../../../infra/hetzner/docs/auto-scaling/lessons-learnt.md):
  historical lessons are not all current. Preserve the removal of dynamic
  `agent_node_count` from control-plane cloud-init.

## 4. File and integration map

All paths below are relative to the repository root.

| Surface | Existing entry points and responsibilities |
|---|---|
| Scale-out policy | `infra/hetzner/scripts/scale-out.sh` |
| Shared infra helpers | `infra/hetzner/scripts/scale-common.sh`: API/auth, Terraform env/backend, count/cache, lock, cooldown, node helpers |
| Demand watcher | `infra/hetzner/scripts/check-placement-failures.sh` |
| Capacity | `infra/hetzner/scripts/check-nomad-capacity.sh` |
| Scale-in coordination | `infra/hetzner/scripts/scale-in.sh`: shared lock, drain verification, count-based shrink |
| Alerts | `infra/hetzner/scripts/alert-common.sh` |
| Deploy convergence | `infra/hetzner/scripts/converge-control-plane.sh`, `setup-control-plane.sh`, `setup-autoscale-env.sh`, `infra/hetzner/deploy.sh` |
| IaC/config plumbing | `infra/hetzner/{variables.tf,outputs.tf,main.tf,cloud-init.yaml,cloud-init-nomad-client.yaml,environment.tfvars.example,terraform.tfvars.example}` and applicable committed backend/env examples |
| Nomad transport | `apps/worker/src/agents/nomad-client.ts` |
| Scheduler adapter | `apps/worker/src/agents/nomad-runtime-adapter.ts`: build job, inspect/select allocation, namespace paths |
| Runtime contract | `packages/domain/src/ports/runtime.ts`, its barrel exports and all port implementations/mocks |
| Other adapters | `apps/worker/src/agents/{docker-runtime-adapter,stub-runtime-adapter}.ts` |
| Launcher | `apps/worker/src/agents/agent-runtime-launcher.ts`: port access, handles, restart recovery, stop |
| Session lifecycle | `apps/worker/src/agents/agent-session-manager.ts`: launch claim, job submission, heartbeat, timeout, cancellation |
| Health | `apps/worker/src/agents/agent-health-monitor.ts`; worker wiring in `apps/worker/src/index.ts` |
| Persistence | `packages/db/src/schema/agent-runtime-sessions.ts`, `packages/db/src/agent-repository.ts`, repository interfaces/types, Drizzle migrations and journal |
| Application configuration | `config/default.yaml`, `packages/domain/src/config/schema.ts`, `apps/worker/src/config.ts` and related env examples |
| Public startup progress | `apps/api/src/services/agent-runtime-session-projection.ts`, agent/session response contracts/routes, status/realtime payload producers and consumers |
| UI discovery anchors | `apps/web/src/features/agents/AgentConversation.tsx`, relevant shared agent status display/types, `apps/web/src/app/i18n/locales/en.ts` and the existing localization pattern |
| Infrastructure tests | `infra/hetzner/scripts/tests/{test-harness.sh,source-helper.sh,test-tf-runtime-helpers.sh,test-converge-control-plane.sh,test-nomad-token.sh,test-drain-timeout.sh,check-nomad-capacity.test.sh,run-all.sh}` |
| Runtime tests | Adjacent Nomad adapter, health monitor, session manager, launcher/stub tests; `packages/db/src/agent-repository.test.ts`; related API/UI tests |

Prefer existing Bash/curl/jq infrastructure and TypeScript/Vitest application
patterns. Add small helpers only where they remove duplicated collection or make
the decision algorithm independently testable. Do not introduce a new daemon,
package dependency or separate application-to-autoscaler demand queue.

## 5. Architecture and data contracts

### 5.1 One decision owner

`scale-out.sh` remains the sole capacity-increase entry point. In demand-aware
mode it gathers a normalized snapshot, calculates a target, validates a saved
Terraform plan and applies that exact plan. There is one shared lock, one scale
event cooldown and one in-flight inventory model.

The placement watcher becomes a read-only health/stall observer in this mode.
It may report unresolved backlog or stale controller progress; it must not run a
second scale-out or bypass cooldown. Retain the legacy demand policy only when
the feature is explicitly disabled; never retain an unguarded apply path.
Section 0's mutation barriers apply in both modes. Update help text and document compatibility behaviour
for `--force`, `--safety-net` and `--bypass-cooldown`. In demand-aware mode:

- `--force` may request a minimal addition without a threshold, but still obeys
  cap, lock, cooldown, inventory/readiness safety and Terraform plan checks.
- A cooldown-bypass invocation must fail explicitly with a useful message;
  do not silently ignore the flag or retain a hidden emergency second policy.
- All units select the same policy gate and config revision. The old watcher
  cannot remain an active writer while the new main loop is enabled.

### 5.2 Normalized observation

Keep the snapshot compact JSON with a schema version. Separate collection from
pure decision logic. Bash orchestrates I/O; use jq or a small existing-runtime
helper for deterministic transformations, not a collection of ad hoc regexes.

The snapshot must contain:

- Environment, region/datacenter, namespace, managed class/pool metadata,
  timestamp, observation validity and configuration fingerprint.
- Managed infrastructure inventory: Terraform resource address, cloud server ID,
  name/index, server type, cloud status, creation time, network attachment and
  matching Nomad ID/status when known.
- Per-node allocatable/occupied/free scheduling memory and CPU, eligibility,
  drain status, datacenter and pool identity.
- Current outstanding workload keyed by `(namespace, jobId, taskGroup)`:
  current job/session identity, queued allocation count, resource reservation per
  allocation, classification, first-seen age and latest observation.
- In-flight capacity with cloud IDs, first requested/created time, deadline and
  capacity-template fingerprint. Do not count it as ready capacity.
- Limits, floor, thresholds, persistence and cooldown inputs.

Required classification values include `capacity_blocked`,
`not_capacity_remediable`, `unclassified` and `already_assigned`.
An invalid observation is not the same as a valid empty observation.

### 5.3 Demand collection

1. Query the configured agent namespace and region explicitly for jobs,
   evaluations, summaries and allocation/diagnostic details needed by the
   deployed Nomad version. Use the existing authenticated API helper.
2. Validate real response shapes against a sanitized staging fixture before
   enabling. Handle list pagination where applicable and do not assume every
   endpoint is paginated or contains full diagnostic detail.
3. Select active platform-managed agent jobs by metadata, not prefix alone.
   `buildNomadJobSpec` currently writes `herobids.role`, `herobids.agentId` and
   `herobids.sessionId`. Exclude deleted/stopped jobs and historical sessions.
4. Derive outstanding task-group allocation counts from current desired work,
   job summary/queued allocations and live allocations. Cross-check inconsistent
   sources; do not sum `QueuedAllocations` over repeated evaluations. Multiple
   evaluation IDs for one task group must not multiply demand.
5. Follow the relevant current evaluation/related diagnostics when list entries
   lack details. Use structured resource exhaustion information, such as
   `FailedTGAllocs`, dimension/resource exhaustion and filtering diagnostics.
   Empty/nil diagnostics are not proof of resource exhaustion.
6. Classify shortages that adding the configured node template can address.
   Wrong datacenter/class, absent driver, impossible constraint, quota, unsupported
   device/volume/port requirement and a request larger than any new node require
   a clear non-remediable/unclassified reason, not scaling to the cap.
7. Keep unresolved current demand regardless of evaluation creation age.
   Remove it when placed, cancelled, terminal or no longer desired.
8. Persist first/last observation per logical workload. Two successful,
   appropriately spaced consecutive observations of that same workload qualify
   it for demand-driven scaling. A different blocked job is not continuation of
   the first. Observation failures/gaps reset the consecutive-success streak,
   while durable age/history remains useful for diagnostics.
9. At zero ready nodes, classify an otherwise supported agent job as remediable
   only when its placement constraints and requests fit the calibrated node
   template. Do not require exhaustion on a nonexistent ready node.

API/ACL/JSON errors must return an explicit failure, log/alert via existing
mechanisms and prevent automatic mutation for that tick. Do not reinterpret a
403, missing field or failed curl as no backlog. Bounded API timeouts, completed
observations and a reentrancy guard must prevent timer overlap.

### 5.4 Capacity and workload fit

- Filter ready, scheduling-eligible, non-draining nodes to the intended agent
  class, environment and pool metadata, and the jobs' datacenter/placement policy.
  `client.meta.node_pool` in cloud-init is metadata; do not confuse it with
  Nomad's separate built-in node-pool feature.
- Ensure newly generated agent jobs use the same explicit managed class/pool
  placement policy. Inspect `buildNomadJobSpec`: configuration types mentioning
  constraints do not prove they are serialized. If missing, add the intended
  constraints and test the actual JSON payload. Do not re-register/reschedule
  all currently running jobs as a side effect of activation.
- Subtract all allocations holding scheduler reservations on those nodes,
  including assigned pending/image-pulling tasks and non-agent jobs such as
  Browserless. Validate Nomad's desired/client status rules against real fixtures
  so terminal or fully released allocations are not counted forever.
- Read scheduling memory, not RSS or `MemoryMaxMB`. Preserve current
  `AllocatedResources.Tasks` support and the explicit legacy fallback. Missing
  required figures fail the snapshot instead of becoming zero.
- Read CPU reservations in Nomad's scheduler units. Do not assume Docker's
  relative share units, core counts or a `1024 = one CPU` conversion are valid
  for the Nomad API's CPU capacity.
- Calculate reference-profile free slots per node and sum those integers.
  Never divide cluster-wide free fragments into fictitious slots.
- For demand sizing, use the actual serialized task-group requests. For the
  existing single-task agent group, sum the task requests. Explicitly handle or
  reject unsupported group shapes/resources rather than guessing.
- Use deterministic first-fit-decreasing placement for supported requests:
  descending memory, then CPU, then logical workload key. Fit onto actual free
  node bins, then viable in-flight bins, then hypothetical new-node bins.
  This is a conservative estimate, not a replacement for Nomad's scheduler.
- Introduce a calibrated new-node usable-memory/CPU template tied to server
  type, pool and relevant configuration revision. Derive/calibrate it from
  representative ready-node resources minus platform reservations and expected
  non-agent overhead, with explicit operator-configurable inputs. Never bake
  an assumed MB/CPU capacity for `cx23` or derive Nomad CPU from provider core
  count alone. Persist the calibration/config so scale-from-zero works.
- Changing type/template invalidates old estimates. Reject feature activation
  without a complete matching calibration, including the zero-node case.

Reference-profile headroom remains an approximation for proactive capacity;
actual queued requests drive backlog fitting. Larger-than-template workloads
must produce an actionable alert without repeated scale attempts.

### 5.5 Node inventory, in-flight capacity and state

Terraform remains infrastructure owner; Nomad is the readiness authority.
Use read-only Terraform state inspection plus authenticated, read-only Hetzner
inventory to reconcile the pool by environment/role/pool labels and server ID.
Inspect only the known environment/backend; never invent a workspace.

- Count every live managed cloud server toward `max_agent_nodes`, including
  down, draining, partitioned, booting and unjoined servers. Reconcile ownership
  before using any count. Unexpected/untracked labelled servers, stale state,
  ambiguous pool membership or contradictory observations block apply and alert.
- Terraform state, cloud existence and Nomad readiness are different facts.
  A cached count is a diagnostic cache, never an authority.
- Verify name/index/address contiguity for the current count-based Terraform
  pool. Noncontiguous state or required replacement is an operator case, not an
  excuse for blind count arithmetic.
- Record requested additions and observed server IDs durably under a protected
  application-specific state directory, e.g. `/var/lib/herobids-autoscale`.
  Use versioned, atomic writes under the shared lock. Keep secrets out.
- Add the directory to unit write permissions and create it via convergence.
  Keep the lock in the existing shared location; do not create per-unit locks.
- After successful apply, capacity remains in-flight until the matching clients
  are ready/eligible. Count viable in-flight capacity in sizing, not in free
  headroom metrics. Suppress further headroom-only additions while a viable
  batch is still joining; additional proven backlog may justify another batch
  after cooldown if in-flight capacity cannot cover it.
- Configure a provisioning/readiness deadline, initially 600 seconds. Expiry
  marks that capacity unavailable, alerts and allows additions only into
  remaining cap headroom; the failed server still counts toward the cap.
- Reconstruct state after restart/reboot from Terraform/cloud creation times,
  matching IDs and the recorded event. Never grant a fresh boot deadline on
  every restart. Missing/contradictory history must not cause blind replay.
- On failed/partial apply, reconcile actual resources before deciding again.
  An exit failure does not prove that no servers were created. Retain the
  requested target/in-flight record; do not just restore a stale count.

### 5.6 Decision order and limits

Under the common lock, collect/revalidate current inputs and use this order:

1. Abort mutation on invalid config, inventory or required observations.
2. Classify active, viable in-flight and unavailable managed nodes.
3. Calculate additions for a floor deficit, mature remediable backlog and
   existing proactive headroom policy. Combine overlapping needs by simulating
   the same bins; do not add three independently calculated increments.
4. A floor of one with one unavailable node and no viable in-flight node should
   request recovery capacity if cap headroom exists. A floor of zero and no
   demand must not create nodes merely because the zero-node free percentage
   is zero.
5. Apply the retained cooldown and bounded batch limit:

   ```text
   remaining_headroom = max(0, max_agent_nodes - verified_live_managed_count)
   nodes_to_add = min(estimated_uncovered_nodes, increment_max, remaining_headroom)
   target_count = reconciled_count_based_pool_count + nodes_to_add
   ```

6. Recheck cap and allowed changes against the saved refreshed Terraform plan
   before apply, accounting for all planned creations and any existing in-flight
   servers. Zero additions is a reasoned no-op, not an apply.
7. Record the event/cooldown and in-flight resources durably. Rate-limit failed
   retries as well as successful additions so a cloud failure does not trigger
   a Terraform attempt every minute. Keep failure backoff distinct from a
   successful scale-event cooldown; report both.

No background emergency path may override these limits. If mature demand cannot
be covered within the remaining user's wait budget because of cooldown, cap or
boot latency, surface that explicitly. Do not silently relax the cap/cooldown.

### 5.7 Terraform safety and truly read-only observation

**Live scale-out:**

- Acquire the existing common autoscale lock before backend preparation or
  state/count decisions, not only before apply. Coordinate scale-in and deploy
  operations that use the same checkout/data directory; keep remote Terraform
  state locking enabled. Local `flock` alone does not serialize local-machine
  applies, so saved-plan state freshness and change checks remain mandatory.
- Use `TF_DATA_DIR=.terraform-envs/<env>` and the existing verified environment
  backend. Live autoscaling may initialize an already provisioned environment,
  but must fail if the expected workspace/state is absent instead of creating
  a new empty workspace.
- Produce a saved plan, inspect its JSON and apply that exact saved plan.
  Scale-out may create only the expected new `hcloud_server.agent[index]` and
  corresponding `hcloud_server_network.agent[index]` resources for the current
  topology. Validate names, counts, environment, type, network and addresses.
- Reject deletes, delete/create replacements, unexpected updates, unrelated
  creates or changes to control plane, network, firewall, SSH keys, DNS or other
  protected resources. Also verify the prospective final node count/cap.
  Output-only changes do not authorize resource changes.
- If existing infrastructure drift prevents a create-only plan, report it and
  stop. Do not use blanket `-target`, `ignore_changes`, state removal or a
  weaker cap to hide the drift.
- Saved plans/JSON can contain secrets: use private permissions, do not log
  their contents or upload them as artifacts, and clean named temporary files.

**Dry-run/shadow:**

- Rework `--dry-run` into a genuinely read-only collection/decision path. It
  must not call `terraform init`, select/create workspaces, plan/apply, write
  controller state/cooldowns/count caches, change scheduling eligibility, or
  send real incident/recovery notifications.
- Read only an already initialized, verified backend/state and GET APIs.
  If required state/config is unavailable, exit explicitly, not with a guessed
  success. Emit sanitized diagnostics to stdout/stderr.
- For multi-tick shadow/persistence simulation, permit a separately named,
  operator-specified shadow state/output directory only. Never share live
  controller state, cooldowns or alert counters. Identify mode in all output.
- Standalone `check-nomad-capacity.sh --dry-run` currently returns synthetic
  zeros without API calls. Do not use that as proof of real capacity; preserve
  compatibility explicitly or document/test its replacement.

## 6. Restart-safe capacity waiting and boot deadlines

### 6.1 Preserve public lifecycle statuses

Keep `starting | launching | running | unhealthy | stopped | crashed`.
Represent `waiting_for_capacity` and `booting` as startup progress/subphases,
not new globally active/terminal statuses. This avoids changing every status
guard, unique index and authorization branch.

Extend the scheduler-neutral runtime inspection result with a typed optional
startup observation, for example a discriminated union:

- `queued`: registered current-session job, no selected assigned allocation.
- `placed`: matching allocation ID and a validated first placement timestamp.

Adapters not providing the observation retain existing startup behaviour.
Implement Nomad observation completely. Docker/stub existing behaviour must not
be widened to ten-minute waiting by accident. Update contract exports and mocks.
Expose inspection through the launcher via the port; the health monitor must
not import/use a concrete Nomad client.

### 6.2 Persistent facts and allocation selection

Add nullable, additive session fields (using repository naming conventions) for:

- Runtime registration time.
- First runtime placement time.
- Selected placement/allocation identity.

Keep `started_at` meaning session creation. Do not reset it to disguise queueing
latency. Generate the migration and journal using Drizzle tooling.

Requirements:

1. Mark successful registration after the Nomad submission succeeds. Recover
   the fact after a worker crash between submission and DB update by inspecting
   the current job and matching its session metadata.
2. Select a current-session allocation that is actually assigned to a node,
   still desired/live and not a historical stopped/replaced allocation. Never
   use `allocations[0]` without deterministic filtering/ordering. Validate the
   allocation creation/placement timestamp against session/job identity.
3. Persist the first placement time once with a conditional monotonic update.
   Re-observation, allocation replacement and worker restart cannot repeatedly
   reset the startup budget. A first heartbeat can win before this observation.
4. A placed allocation waiting for its image is booting, not unplaced demand.
   Resource reservations already belong in occupied capacity.
5. A missing job is not "queued". Distinguish cancellation, registration not
   completed, confirmed not-found and API errors.
6. Bounded periodic inspection of starting/launching sessions must not overlap.
   Reuse health/reconcile scheduling where possible; avoid an unbounded per-agent
   timer or one slow API call blocking health checks of running sessions.

### 6.3 Deadline and race contract

With the application feature gate enabled:

- `starting`, not submitted: retain current `startTimeoutMs` handling.
- `launching`, registered, not placed: capacity deadline is
  `session.startedAt + capacityWaitTimeoutMs`.
- Placed, no first heartbeat: boot deadline is
  `firstPlacementAt + placedStartTimeoutMs`, bounded by the overall deadline
  `session.startedAt + capacityWaitTimeoutMs + placedStartTimeoutMs`.
- Scheduler inspection failure never grants a deadline extension or fabricates
  placement. Retry with explicit logs/alerts; the overall bound still applies.
- Before claiming a placement timeout, refresh placement/heartbeat facts where
  possible. A newly discovered earlier valid placement changes the applicable
  deadline before evaluating expiration.
- At expiration, use an atomic repository transition with expected active
  status and expected startup facts/deadline. Competing placement/heartbeat
  updates must make a stale timeout claim fail and be reevaluated.
- Only the successful terminal claimant stops the current session's runtime,
  updates the agent, emits failure/status/guardrail events and cleans ephemeral
  state. Preserve the existing no-decrement-before-first-heartbeat behaviour.
- A stop request wins permanently. Late inspection, heartbeat, job registration
  completion or recovery must not resurrect the session. Recheck cancellation
  after a slow launch and stop any just-created matching job.
- Do not let cleanup from an old session purge a newer session's `agent-<id>`
  job. Match session metadata on destructive startup cleanup; extend the port
  operation/precondition narrowly if needed. Stable job IDs alone are not a
  session identity.

For legacy in-flight sessions with null new fields, recover from matching
scheduler facts. Do not assign "now" as a new placement time on deployment.
If facts are unavailable, maintain the absolute bound and an explicit degraded
observation reason. Gate-off and non-Nomad modes keep the old deadline logic.

### 6.4 User-visible behaviour and accounting

- Keep the agent broadly `starting`, but expose typed startup progress with
  `waiting_for_capacity` or `booting`, relevant timestamps/deadline and a safe
  reason. Do not return secrets, job environment, Terraform state or raw API
  diagnostics. The current public session projection automatically includes
  all columns except `apiKeyHash`; review deliberately when adding fields.
- Wire the existing status/read/realtime path and existing agent status UI so a
  waiting user sees "Waiting for capacity" and can stop. No additional polling
  system or standalone dashboard is needed. Use existing localization.
- Emit distinct, actionable timeout reasons for queue deadline, boot deadline
  and startup observation failure, while preserving terminal status semantics.
  Emit progress only on a real transition, not every health sweep.
- Do not count a queued session as running, start usage/session counters early,
  or trigger trading/LLM activation before the existing first-heartbeat path.
- Worker restart must restore subscriptions/handles and the same deadlines.
  Verify pending registered jobs are not treated as missing/orphan runtimes.

## 7. Configuration and deploy convergence

Implement the relevant pending convergence work as a prerequisite to activation.
Configuration remains operator/deploy-time configuration, never agent-editable
instance settings.

### Infra settings

Use the existing Terraform -> cloud-init -> systemd pattern, but generate a
durable non-secret autoscale settings file on every deployment as well as first
boot. Prefer a small shared validated renderer at the existing deploy boundary,
not a second hand-maintained defaults table or shell `source` of tfvars.
Terraform defaults + environment overrides must resolve identically for
first boot and convergence. Never `eval` arbitrary tfvars text; reject unsupported
or invalid input instead of guessing. If extracting structured Terraform
configuration, keep it separate from secrets and do not dump all outputs.

At minimum wire:

- Demand-aware enabled/mode, namespace, region/datacenter, managed class/pool.
- Increment maximum (2), demand consecutive observations (2), interval (60 s).
- Node-template usable memory/CPU, server-type/config fingerprint.
- Provisioning/readiness timeout (600 s), bounded failure retry/backoff settings.
- Existing min/max, fixed legacy increment, memory/slot thresholds, cooldown,
  reference memory reservation, and scale-in enabled/limits.
- State directory/path, observation mode and alerting integration as applicable.

Use repository-consistent names, e.g. `NOMAD_AUTOSCALE_DEMAND_ENABLED`,
`NOMAD_SCALE_OUT_INCREMENT_MAX`, and `NOMAD_DEMAND_CONSECUTIVE_OBSERVATIONS`;
choose and document one mapping, not several aliases for each new setting.
Add Terraform validation for integer counts, positive time/resource values,
`0 <= min <= max`, and valid environment/mode. Validate the resolved cross-field
configuration again at controller startup.

The non-secret settings file must be distinct from the existing 0600
`/etc/herobids/autoscale.env` credentials file. Explicitly define precedence for
settings, secrets, unit `Environment=` values and temporary operator drop-ins.
Detect conflicting obsolete overrides and require migration instead of silently
letting stale values win. Update all three units consistently and daemon-reload
only when content changes. Do not restart Nomad or live agents for this.
Create/protect the persistent state directory and update systemd write paths.

### Application settings

Add the disabled-by-default capacity-aware startup gate and the 600,000/120,000
ms budgets under `worker.agents` with typed schema validation, default YAML,
worker wiring and config tests. Keep `startTimeoutMs` for legacy/unregistered
starts. Any env overrides must follow existing mapping conventions and have
matching committed `.example` updates in the same change.

Do not assume staging and production have identical cooldowns/thresholds. Before
activation, capture **effective** settings without credentials. A production
cooldown longer than the waiting budget is a real incompatibility, not a reason
to quietly change production configuration.

## 8. Scale-in and deployment coordination

This is not a scale-in redesign, but it shares inventory, locks and state:

- Update scale-in to consume the reconciled managed count rather than the stale
  cache, and acquire the shared lock before mutable Terraform preparation.
- Do not remove fresh viable in-flight capacity or nodes required by outstanding
  demand/floor; defer scale-in when the controller snapshot is invalid.
- Preserve existing drain-deadline safety. With count-based resources, any
  scale-in saved plan must delete exactly the verified drained contiguous
  highest-index suffix, not an arbitrary number of lower idle nodes. Reject
  any plan that would delete an active/undrained different server. This guard is
  required because the new inventory/plan path must not make shrink unsafe.
- Keep newly created capacity through its readiness grace period. Do not add a
  new aggressive scale-in policy or new destruction automation.
- Coordinate deploy/provision commands with autoscale operations using existing
  lock facilities; document manual maintenance locking. Do not disable remote
  state locks or use local cached counts to work around lock contention.

Scale-in status (P7, local tests only, nothing run against infrastructure):

- Fail-closed node reads (C1): unreadable, unparseable or empty Nomad responses
  count as not idle, so the node is deferred and never deleted.
- Saved-plan binding (H1): every Terraform snapshot name must match a Nomad node
  name exactly. The drain loop re-checks the live name before draining. Unproven
  bindings are refused.
- Apply seam (H2): scale-in applies through `tf_apply_plan`, which the
  `INJECT_TF_APPLY_FAILURE` hook overrides. The failure branch restores drained nodes.
- Demand gate (approved H4): scale-in exits 0 with a deferral while
  `NOMAD_AUTOSCALE_DEMAND_ENABLED` is true.
- New-node grace (approved H5): a candidate must be idle and registered longer
  than `NOMAD_SCALE_IN_NODE_GRACE_SECONDS` (default 600). Unknown age defers.
- Deferral alert (approved M1): consecutive deferrals are counted in
  `${NOMAD_AUTOSCALE_STATE_DIR}/scale-in-deferrals`. An alert fires at
  `NOMAD_SCALE_IN_DEFERRAL_ALERT_AFTER` (default 3). A successful scale-in resets it.
- Count bounds (M2): NEW outside [MIN, CURRENT) is refused, not clamped.
  Duplicate or blank node names are refused (M3).
- Restore/undrain clears the drain with `POST /v1/node/{id}/drain` and body
  `{"DrainSpec": null}`, then sets eligibility. The exact endpoint and body are
  UNVERIFIED until P9 (no live Nomad call has been made). A failed clear or
  eligibility change is recorded and the run ends in an error.
- Node registration age uses the Nomad node `StatusUpdatedAt` as a proxy. This
  is UNVERIFIED until P9. An unknown or unreadable time defers deletion.
- The saved-plan binding assumes the terraform show JSON `change.before.name`
  for `hcloud_server` deletes. This is UNVERIFIED until P9.
- Scale-in refuses to delete while `NOMAD_AUTOSCALE_DEMAND_ENABLED` is true. The
  equivalence of this flag to the worker's demand config is UNVERIFIED.

## 9. Implementation work packages and dependencies

Complete small coherent changes. Check off work only when its tests pass.
Stages describe dependencies, not mandatory separate services/files.

| ID | Work package | Depends on | Completion evidence | Status |
|---|---|---|---|---|
| P0 | Re-read source/history, preserve memory fix, capture sanitized API fixtures and effective config; record baseline phase timings | None | Fixtures cover namespace, blocked diagnostics, assigned pending allocations, cloud inventory and node resources | DONE (local, scope A; live capture and phase timings outstanding) |
| P1 | Define validated config, shared snapshot/decision contract, disabled gates and durable convergence renderer | P0 | Fresh-boot/convergence parity, invalid-input and stale-override tests | DONE (gates off; see Outstanding Issues) |
| P2 | Implement reconciled managed inventory, durable state, in-flight/readiness accounting and read-only mode | P1 | Zero/stale-cache/down/unjoined/partial-apply/reboot tests; no mutation in dry-run | DONE (read-only; see Outstanding Issues) |
| P3 | Correct demand collection, classification and per-node resource/fit calculations | P0, P1 | Real-shape namespace/diagnostic/dedup/fragmentation/CPU fixtures pass | DONE (pure library and per-node fit; fixtures UNVERIFIED; see Outstanding Issues) |
| P4 | Implement single controller, floor/headroom/backlog composition, caps/cooldown, saved-plan allowlist and watcher observer mode | P2, P3 | Mock end-to-end decisions and protected-resource rejection tests | DONE (demand mode disabled; activation blocked by H2, H3, H4, M4 in P4 Outstanding Issues) |
| P5 | Add optional runtime startup observation, additive DB facts/migration and repository race guards | P0, P1 | Adapter/DB tests; old statuses and non-Nomad behaviour preserved | DONE (uncommitted; see P5 outstanding issues) |
| P6 | Wire session/health deadlines, cancellation, restart recovery and session-safe cleanup | P5 | Fake-clock and real-DB race tests; original session survives slow placement | DONE (uncommitted; see P6 outstanding issues) |
| P7 | Wire safe API/status/UI progress, reasons, config plumbing and scale-in coordination | P2, P4, P6 | Contract/UI tests and exact-drained-suffix protection | DONE (app and scale-in halves; see P7 and §8 records; scale-in endpoints and fields still UNVERIFIED until P9) |
| P8 | Update documentation, run local integration/validation and complete shadow acceptance | P4, P6, P7 | Check output and evidence with no infrastructure writes in shadow | PARTIAL (local validation, H3 runbook, fixture shadow and live read-only shadow DONE 2026-10-31; multi-tick demand comparison NOT run; see P8 record) |
| P9 | Obtain explicit staging mutation approval, deploy/migrate and execute controlled staging scenarios | P8 | Section 12 acceptance evidence; production still disabled | PENDING |

Do not activate the new infrastructure controller before the waiting lifecycle
and configuration convergence are available. Conversely, do not enable long
capacity waits for production while the production scaler remains unverified.

## 10. Required tests

### 10.1 Shell/decision fixtures

Use the existing infra test harness and isolated mock executables/HTTP servers.
No live credentials, cloud accounts or shared backend are required for these.
Mock Terraform command arguments and saved-plan JSON; assert both intended
actions and forbidden actions.

| Group | Required cases |
|---|---|
| Namespace and ownership | Explicit non-default namespace; unrelated/default-namespace jobs ignored; metadata/session identity; region/pool filtering; pagination where supported; ACL 403/API timeout/malformed JSON fail loudly |
| Current demand | One current blocked job; duplicate/retried evaluations count once; old still-blocked evaluation remains; cancelled/dead/placed work removed; queued count >1; inconsistent summary/detail rejected |
| Diagnostics | `BlockedEval` contains UUID; generic blocked description; actual resource exhaustion; constraint/driver/DC/quota mismatch; oversized job; no ready nodes with supported template |
| Persistence | One observation no demand action; second of same key after interval qualifies; unrelated key does not; API failure/gap resets streak; backlog resolution clears; shadow history never touches live state |
| Capacity | Current/legacy memory shapes; missing memory/CPU rejected; running and assigned pending allocations; Browserless reservations; exclude drained/ineligible/wrong-class/pool clients; terminal release; per-node fragmentation; CPU shortage with spare RAM |
| Sizing | Mixed reservations; deterministic packing; existing free and viable in-flight capacity; headroom + backlog overlap; floor restoration; zero-floor idle cluster; at most 2 additions; one remaining cap slot produces one addition |
| Inventory | Stale cache 0 with live node; down servers count; booting/unjoined count; noncontiguous addresses; unexpected labelled node; ownership mismatch; readiness expiry; reboot reconstruction; partial apply |
| Control safety | Common lock contention; post-lock refresh; cooldown retained; disabled mode; watcher cannot write in new mode; bypass rejected; failed retry backoff; valid empty cluster differs from failed collection |
| Terraform | Expected create-only plan accepted; replacement/delete/control-plane/network/firewall/DNS/unexpected update rejected; saved plan applied exactly; stale plan rejected; missing workspace never created |
| Read-only | No init/workspace/plan/apply/drain/state-cache/cooldown/alert writes; synthetic capacity dry-run not mistaken for live observation; unavailable initialized state is explicit failure |
| Convergence | First boot and deploy resolve same values; absent optional keys use one source of defaults; override migration; secrets preserved/redacted; write paths survive; second converge no-op; invalid counts/type/template fail |
| Scale-in | Active backlog/in-flight prevents unsafe shrink; only verified drained highest-index suffix is allowed; timeout node never destroyed; shared inventory/count and lock |

Keep or extend the allocation memory regression fixture. The existing
`run-all.sh` discovers only `test-*.sh`; `check-nomad-capacity.test.sh` currently
does not match. Explicitly include it in the validation command or wire it into
the runner. Do not claim it ran because the generic runner passed.

### 10.2 TypeScript unit and database integration tests

- Nomad inspection: registered/unplaced, assigned pending/image pull, running,
  failed/historical/replaced allocations, unsorted lists, current session
  metadata, namespace/auth, invalid timestamp and observation errors.
- Docker/stub and gate-off retain their previous timeout/health behaviour.
- Delayed placement beyond 60 seconds preserves the same session and queued job.
- Queue timeout at 600 seconds, then boot timeout at first-placement +120 seconds.
  Test exact deadline boundaries with a fake clock and the actual health interval.
- Placement just before queue deadline receives its boot budget, subject to the
  creation +720-second absolute bound. No-heartbeat/API-failure sessions terminate
  by that bound plus one configured health sweep.
- Registration never completes: the existing unregistered-start deadline still
  terminates the attempt; no ten-minute success-shaped waiting fallback.
- Persisted registration/placement survive worker restart. Recovered facts use
  original scheduler times, not restart time. Allocation replacement cannot
  repeatedly extend the budget.
- Heartbeat versus timeout and placement versus timeout: exactly one valid DB
  transition; stale timeout does not stop a healthy runtime.
- Stop/delete versus delayed launch/placement/heartbeat: no resurrection, no
  orphan matching job, no cleanup of a newer session sharing the agent job ID.
- API error is not queued/not-found; diagnostic reason and absolute bound hold.
- Old nullable-field rows recover conservatively without changing `started_at`.
- Unique active-session constraint, API-key authorization and first-heartbeat
  accounting/activation are unchanged. Queued work incurs no LLM wake.
- Public projection contains safe startup progress, never credentials/raw
  scheduler payload; UI displays waiting/booting/localized failure and stop.
- Use a real isolated PostgreSQL integration test for conditional-update races
  and the migration, not only mocked repository calls. Respect the repo's
  service/test isolation; never use staging/production DBs for local tests.

## 11. Observability and acceptance measurements

Reuse existing logs/alerts; do not require a new monitoring stack. Each decision
should produce one structured/sanitized record containing mode, observation
time, config fingerprint, valid/invalid status, logical backlog size/age,
ready/in-flight/unavailable/live managed counts, per-resource headroom summary,
proposed additions/target, cooldown/backoff remaining and decision reason.

Include specific reasons such as `capacity_backlog`, `low_headroom`,
`floor_deficit`, `cooldown`, `at_cap`, `inflight_covers_demand`,
`non_remediable_placement`, `inventory_mismatch`, `observation_failed`,
`provisioning_stalled` and `unsafe_terraform_plan`. Rate-limit repeated alerts
through existing helpers. Observation failure must not emit a recovery alert.

Record these timestamps separately, linked by session/job/scale event IDs:

1. Session/start request created.
2. Job successfully registered.
3. Capacity shortage first observed and demand becomes mature.
4. Scaling decision and Terraform start/end.
5. Cloud server created and Nomad client ready.
6. Allocation assigned; image ready/task started where observable.
7. First accepted runtime heartbeat.

Primary success metric: original requested sessions reach first heartbeat
without manual restart. Node-ready time alone is insufficient.

Initial measurable local acceptance:

- With no applicable cooldown, mature demand is eligible on its second
  successful ~60-second observation, not after five evaluations in a
  five-minute creation window.
- A valid one-node remaining cap slot is used even when the batch maximum is two.
- No extra batch when existing free + viable incoming capacity covers the work.
- No mutation on invalid observation, unknown inventory, unsafe plan or cap hit.
- Deadline outcomes match section 6 within one configured health sweep.

Before staging activation, calculate:

```text
remaining cooldown
  + demand observation delay
  + measured provisioning-to-ready time
  + placement delay
```

This must fit the applicable remaining 600-second capacity budget for the
controlled acceptance workload; boot/image/heartbeat must fit its 120-second
budget and the 720-second overall bound. Multiple batches may not fit. Record
p50/p95 when the sample size supports them, and individual timings otherwise;
do not label a handful of samples a reliable p95.

If existing thresholds/cooldown/boot times make this impossible, record a failed
activation gate and obtain an explicit tuning decision. Do not claim success by
restarting agents, ignoring original sessions, widening deadlines mid-test,
bypassing cooldown, or changing the cap. A later warm-capacity/snapshot/direct-API
decision should be based on these measured phases.

## 12. Validation, staging rollout and approval boundaries

### 12.1 Local checks

Use commands from the repository root. Start with new/changed tests, then run:

```bash
bash infra/hetzner/scripts/tests/run-all.sh
bash infra/hetzner/scripts/tests/check-nomad-capacity.test.sh

pnpm exec vitest run \
  apps/worker/src/agents/nomad-runtime-adapter.test.ts \
  apps/worker/src/agents/stub-runtime-adapter.test.ts \
  apps/worker/src/agents/agent-health-monitor.test.ts \
  apps/worker/src/agents/agent-session-manager.test.ts \
  packages/db/src/agent-repository.test.ts

pnpm lint
pnpm --filter @herobids/domain --filter @herobids/db --filter @herobids/worker run build
```

Confirm package names/current paths before executing; add the actual new
launcher/config/API/UI tests and isolated DB integration selector to the
targeted run. Run the existing web type/build check if its contract/UI changed.
Do not install packages unless a chosen check reports a missing dependency or
the manifest legitimately changed. Use existing lint/format tooling; if
available, run shell lint and Terraform formatting checks on affected files.
Do not initialize a shared Terraform backend for local validation.

Generate and test the additive migration using existing DB tooling:
`pnpm --filter @herobids/db run db:generate` with the repository's configured
schema/migration setup. Review generated SQL/journal and test against an isolated
database, including an old row with null new fields and a second migration run.
Never hand-invent a journal sequence.

### 12.2 Prepare staging without mutation

- Record current deployed revision, node inventory, active sessions, effective
  autoscale unit settings and current feature gates using read-only methods.
  Confirm the allocation-memory fix is actually deployed or include it in the
  approved deployment.
- Calibrate the new-node resource template against the actual staging type and
  reservations. Verify the configured namespace/class/pool and Nomad API shapes.
- Record baseline phase timings and the old controller's observed decisions.
- Rehearse shadow mode against captured fixtures, then approved staging GETs,
  without Terraform initialization/planning or live controller-state writes.
  Compare proposed decisions to actual demand/capacity over an idle period,
  a pending-work period if available, and at least one full configured cooldown.

### 12.3 Obtain explicit approval before mutations

Code implementation is not permission to spend money or disrupt running agents.
Before DB migration, deploy, controlled backlog, node provisioning, disabling
timers or fault injection, request staging approval covering:

- Maximum extra nodes and budget/duration, bounded by the existing cap.
- Test accounts/jobs and safe workload; avoid actual trading/orders and
  unnecessary LLM calls when exercising infrastructure placement.
- Which timers/gates are changed and the starting topology.
- Zero-ready/recovery test method and the exact nodes/jobs that can be affected.
- Cleanup owner and restoration procedure.

Do not simulate zero capacity by stopping all shared staging nodes without
approval. Prefer mocked tests for dangerous cases; use an approved isolated
staging pool/window if live zero-ready verification is required. Mark live
scenarios not executed, rather than inventing evidence.

### 12.4 Approved staging execution

Prerequisites: section 0 exposure/drift record, replacement-guard tests,
disposable-environment acceptance and explicit owner approval. Do not interpret
this section as permission to restart the held staging timer. Record who
approved the restart and its exact scope before executing it.

Deploy the additive migration and compatible disabled code, converge settings,
then verify the effective configuration. Enable application capacity-aware
startup first, then switch the main controller to demand-aware mode with the
watcher observer-only; ensure no old safety-net writer remains. If this cannot
be switched consistently, stop and restore the prior approved state.

Execute and record:

| Scenario | Required evidence |
|---|---|
| Idle and normal start | No unnecessary nodes; normal first heartbeat and existing running agents unaffected |
| Controlled shortage | Original session/job IDs survive beyond 60 s, two observations mature demand, bounded additions, first heartbeat before applicable deadlines |
| Backlog requiring more than one node | Resource-based batch calculation, at most 2 additions, no per-evaluation multiplication |
| Pending/image-pulling | Reservations included; boot phase shown; no duplicate provisioning for already-covered work |
| Cap and partial headroom | Cap never exceeded; one remaining slot usable; unmet work has explicit waiting/failure reason |
| Unplaceable request | No scale loop to cap; precise unsupported constraint/resource alert |
| Cancellation | Waiting user can stop; no later heartbeat/resurrection and no orphan job |
| Worker/controller restart | Same original session/deadlines and in-flight batch; no replay/duplicate nodes |
| Provisioning delay/failure | Partial inventory reconciled, backoff honoured, stalled node still counts |
| Zero ready | Approved live or mocked evidence distinguishes zero managed, viable booting nodes, unavailable existing nodes, and at-cap alert |
| Scale-in coexistence | No deletion of newly joining/required capacity; allowed shrink matches only drained suffix |

Never delete unrelated sessions/jobs as cleanup. Remove only named test jobs and
resources approved for the scenario, using normal ownership/drain safeguards.
Restore the agreed staging baseline without destroying active allocations.
Record unresolved acceptance failures as blockers.

### 12.5 Production

Do not enable either new gate in production under this plan's staging approval.
Provide the measured staging report, effective production config comparison,
capacity/cooldown feasibility analysis, migration status and rollback rehearsal
for the owner to approve separately. No production cap, deadline, threshold,
credential or server changes are implied.

## 13. Rollback

- Keep migrations additive; do not drop new columns to roll back application
  code. Old code must tolerate the schema.
- Snapshot sanitized effective settings and controller state version before
  enabling; never save secrets in the feature report.
- If only the new scaling policy is faulty, disable its gate and restore one
  legacy decision/watcher policy with the agreed old thresholds/cooldown.
  Retain the unconditional saved-plan mutation guard and exact-node shrink
  protection. If the legacy version lacks those barriers, leave mutations
  stopped rather than restoring unrestricted apply.
  Keep capacity-aware waiting enabled while queued sessions drain, if safe.
- Do not immediately switch waiting sessions back to the old 60-second timeout:
  they could all be stopped at once. Stop admitting new test starts, drain or
  cancel existing waiting sessions with owner agreement, then disable the
  application gate. Retain the compatible binary during this transition.
- Do not roll back node count in Terraform merely to restore code/settings.
  Additional nodes remain until a separate safe drain/shrink is approved.
- Preserve enough durable event/inventory history to avoid duplicate additions
  after re-enabling. Never delete live state files as a generic reset.
- Recheck original agents, heartbeat processing, subscriptions, effective units,
  active scaler owner and alert health after rollback.

## 14. Documentation and final handoff requirements

Update directly related documentation in the implementation change:

- [Options analysis](./011-scale-out-options.md): preserve the corrected signal
  and incident distinctions, and update selected design/timings from evidence.
  Provider API calls do not imply instantly usable capacity, and a changed
  minimum alone does not prewarm nodes.
- [Autoscale setup](../../../../../../infra/hetzner/docs/auto-scaling/setup-auto-scaling.md)
  and [infrastructure README](../../../../../../infra/hetzner/README.md): gates,
  namespace, state/inventory ownership, convergence, new config, dry-run,
  troubleshooting, calibration, cap behaviour, safe recovery and rollback.
- Pending convergence plan: identify the completed/superseded sections and link
  here, including why ready-node count is not the managed count.
- Relevant bug reports: preserve historical evidence, add exact fix/tests and
  deployment status; do not mark deployed until verified.
- Example config/env files and existing startup/status API documentation.
- A staging validation record under this feature directory, only when actual
  verification is performed; no secret/raw Terraform payloads.

The implementing agent's final report must state:

1. Implemented behaviours and intentional compatibility changes.
2. Exact checks run and outcomes, including the separate memory regression test.
3. Migration generated/tested/applied status by environment.
4. Original-session-to-first-heartbeat evidence and measured phase timings.
5. Effective settings, node changes, cap/cooldown results and remaining blockers.
6. Staging enabled/disabled state, cleanup/rollback result and explicit statement
   that production activation is still awaiting approval.

### Final acceptance checklist

- [ ] Production/staging exposure is recorded without unapproved mutations.
- [ ] Exact agent-node startup-script drift cause is evidenced; alert changes
  are not incorrectly blamed for the replacement.
- [ ] Staging timer remained stopped until drift/guard gates and explicit
  restart approval; disposable acceptance preceded shared mutation.
- [ ] Mutation barriers remain active in legacy/gate-off/rollback paths.
- [ ] Current demand is namespace-correct, deduplicated and not aged out.
- [ ] Resource/constraint classification prevents futile additions.
- [ ] CPU/memory fit is per-node and includes assigned pending/non-agent work.
- [ ] Managed inventory, ready capacity and in-flight servers are distinct.
- [ ] One controller owns additions; cap, batch, cooldown and failure backoff hold.
- [ ] Floor/zero-ready recovery works only within verified ownership/cap limits.
- [ ] Create-only saved-plan checks protect all unrelated infrastructure.
- [ ] Read-only observation demonstrably performs no live mutations.
- [ ] Effective settings converge durably on first boot and every deployment.
- [ ] Original waiting sessions survive provisioning and reach first heartbeat.
- [ ] Queue/boot deadlines, race guards, restart recovery and cancellation hold.
- [ ] UI/API progress is accurate, localized and credential-safe.
- [ ] Existing Docker/stub/running-agent/accounting behaviours are preserved.
- [ ] Scale-in cannot remove undrained/required/newly joining capacity.
- [ ] Local tests/build/typecheck and approved staging acceptance are evidenced.
- [ ] Production remains disabled pending separate approval.

## Outstanding Issues

### P0 (baseline and fixtures)

- Placement-failure count in the fixture README depends on the wall clock (300 s window around fixed `CreateTime`). State the time qualifier or fake the clock in tests.
- The README assumes `GET /v1/evaluations` without a namespace is unscoped. Verify against the Nomad 1.9.7 API docs before P3 relies on it; the default-namespace behaviour may differ.
- `_comment` keys in fixture JSON are non-API keys; document them or strip them in P3.
- Node `…0003` is `down` without a `detail` entry; document as intentional or add detail.
- `test-harness.sh` wording in the fixture README: it is a sourced library, executed by `run-all.sh` but prints no count.
- Live effective config capture and baseline phase timings remain outstanding (P0 not complete).

### P1 (config and convergence)

- MEDIUM: `write_if_changed` in `converge-control-plane.sh` (~144-154) runs inside an `if`, so a failed `cp`/`chmod` returns 0. Fix: `cp ... || return 2` and treat status 2 as `SETTINGS_FAILED`.
- MEDIUM: missing `autoscale-settings.input` in converge (~278-280) warns and exits 0 without the failed marker. Fix: set `SETTINGS_FAILED` and write the marker. Decide the rollout order first (existing control planes will lack the input until setup runs once), or keep it a warning for one release.
- LOW: cloud-init renderer call (`cloud-init.yaml` ~481) omits `--systemd-dir` and `--secrets-file`; pass the same arguments as converge for parity.
- LOW: cloud-init comment (~468) says a consumer defaults to demand-disabled; no consumer exists until P2. Reword.
- LOW: the `locals` block sits in `outputs.tf` (~40-54); move to `main.tf` or `locals.tf`.
- LOW: converge skips steps 6-7 after a settings failure; document in the converge header.
- Scope (M3/M4 from review 1): only five settings are wired and nothing consumes them yet. The remaining section 7 keys (namespace, datacenter, pool, fingerprint, state dir, min/max cross-check) are deferred to P2/P4. Consumers land in P2.
- Known residual: if a main unit already has the settings `EnvironmentFile=` line and a secrets drop-in is added later, converge's skip logic could diverge from cloud-init order. No released unit has this shape.

### P2 (inventory and state, read-only mode)

Review rounds 1–4 raised CRITICAL/HIGH findings that were fixed in rework. The final review (round 5) found no CRITICAL or HIGH. The items below are the remaining MEDIUM/LOW findings and deferrals.

- FIXED (pre-P3): `setup-autoscale-env.sh` dry-run redaction now masks `AWS_ACCESS_KEY_ID` as well (covered by `test-setup-autoscale-env.sh`).
- FIXED (pre-P3): operator-set numeric knobs are validated before any arithmetic. `require_uint` and `validate_scale_numeric_env` in `scale-common.sh` run at load in `scale-out.sh`, `scale-in.sh` and `check-nomad-capacity.sh`. Covered by `test-capacity-numeric-env.sh`. The increment upper bound of 100 is still provisional; P4 tightens it to the batch cap of 2.
- MEDIUM (question): a malformed capacity output exits 1 and alerts only at the streak threshold, so the first malformed output is silent apart from the exit code. Decide whether it should alert immediately.
- LOW: ACL token write (`setup-autoscale-env.sh` ~206) uses `rm -f` then `cat >`, not tmp plus `mv` like the other two writes.
- LOW: the `write_if_changed` failed-write matrix covers mkdir only for 3c and the state dir. Add mkdir cases for 3a, 3b and 3d.
- LOW: several setup-autoscale-env tests assert literal command text. Behavioural checks would survive refactors better.
- LOW: die messages for converge sites 3a–3d do not warn that earlier steps may already have changed the host.
- Pre-existing: `check-nomad-capacity.sh` (~137–145) counts nodes that fail detail or lack `MemoryMB` in ready totals but skips them from memory totals.
- Deferred to P4: saved-plan apply and JSON inspection; DECLARED comes from the in-flight record rather than Terraform state; cap headroom after expiry (M9); `scale-out.sh` still uses `terraform apply -auto-approve -var agent_node_count=N`.
- Deferred to P4 or owner decision: orphan and deleting semantics for multi-pool (owned servers of another pool fail closed; confirm).
- Deferred: dry-run log lines are not labelled as dry-run (L6); the parser's lowercase keys (`free_memory_mb`) deviate from the uppercase form suggested in review.
- Unverified against live systems: Hetzner label and name formats; the Nomad node-name to server-name join; Nomad 1.9.7 `/v1/nodes` response shapes; GNU `stat` and `ln` (only macOS tested); `/var/run` tmpfs on target hosts; systemd `ReadWritePaths` behaviour; whether the operator environment provides `HCLOUD_TOKEN` or `hcloud_token` in `<env>.tfvars`.
- Security hygiene: a real-looking `hcloud_token` is present in a gitignored `*.tfvars` in the working tree. It was not printed. Rotate it if that file has ever been shared.
- Pre-existing: `_ssh_opts.sh` aborts silently under pipefail when `ssh_public_key_path` is missing.
- Residual: a transient orphan block can occur after scale-in destroy until the Nomad heartbeat timeout (fails closed).

### P3 (demand fit)

Review rounds 1–3 raised one CRITICAL and four HIGH findings in round 1, two HIGH in round 2, and none at HIGH+ in round 3. All were fixed in rework (canceled-representative order, missing Namespace refused, node-pool filter, planner range checks, array guard, node identity, integer figures, non-negative reservations, detail-object ready/eligible check). The items below are the remaining MEDIUM/LOW findings and deferrals.

- MEDIUM (defer to P4): `ready == 0` maps to `capacity_blocked`, which could hide a dead cluster. P4 must cross-check the ready-node count against inventory.
- MEDIUM (defer to P4): the controller does not yet supply asks. Classification is unusable until P4 sources them.
- MEDIUM (defer to P4): in-flight scale-out bins are not subtracted from fit, so pending nodes can be double-counted until P4.
- MEDIUM (product decision): `_CAPACITY_PLAN_FIT_JQ` first-fit is O(n²) (1000 items 0.07 s, 3000 items 0.40 s) with no total-items cap. Set the cap in P4.
- MEDIUM (noted): each agent-class candidate costs one extra `GET /v1/node/<id>` per run. Fetch failures are fatal.
- LOW: a canceled representative is excluded from representative selection but kept in `evaluation_ids` for audit.
- LOW: `occupies` ignores `DesiredStatus`, so a pending allocation with desired `stop` still counts as occupying. Conservative; document in P4.
- LOW: `unknown` allocation status counts as occupying. Conservative, unverified against Nomad 1.9.7.
- LOW (pre-existing): `NOMAD_TOKEN` is passed in curl argv via `-H` in `scale-common.sh` `nomad_api`, visible to `ps`. Move to a curl config on stdin in a later hardening package.
- Behaviour change: `check-nomad-capacity.sh` maps any invalid `NOMAD_SCALE_*` knob to exit 1, not 2. Exit 2 is reserved for a genuine zero-ready state.
- Unverified against live systems: every fixture is SYNTHETIC/UNVERIFIED. Nomad 1.9.7 `FailedTGAllocs` keys, `NodeResources.Cpu.CpuShares`, `ReservedResources`, `AllocatedResources.Tasks` versus legacy `Resources`, `NodeClass` on `/v1/nodes` stubs, and the 256 MHz per-agent CPU reservation are assumptions.

### P4 (controller)

Scope: single demand-aware controller in `scale-out.sh` (gate `NOMAD_AUTOSCALE_DEMAND_ENABLED`, default `false`), `capacity-controller.sh`, observer mode in `check-placement-failures.sh`, dry-run in `scale-out.sh`, and the saved-plan allowlist. Tests: `test-capacity-controller.sh`, `test-capacity-observer.sh`, `test-capacity-scale-out-demand.sh`, plus the `converge-control-plane` 7g case.

Decisions taken:

- 7a (ready==0): `check-nomad-capacity.sh` exit 2 is cross-checked against the reconciled inventory. A disagreement on ready nodes fails closed (exit 1, no mutation). Both zero with managed nodes present is `dead_pool`, which allows recovery capacity only. Both zero with no managed nodes is `capacity_blocked`.
- 7b (asks): the controller sources asks from `demand_classify`. Classification is usable only when it is mature. Otherwise backlog and headroom are excluded.
- 7c (in-flight): viable in-flight scale-out bins are subtracted from fit. The floor deficit is simulated as template-sized bins in the same fit, so no increment is calculated independently.
- 7d (increment bounds, M3): only the demand-mode batch cap `NOMAD_SCALE_OUT_INCREMENT_MAX` is bounded to 1..2, in `scale-common.sh` (`validate_scale_numeric_env`), `render-autoscale-settings.sh` (`^[12]$`) and `variables.tf` (`nomad_scale_out_increment_max`, `<= 2`). Default 2. The legacy `NOMAD_SCALE_OUT_INCREMENT` keeps its HEAD bound (1..100 in `scale-common.sh`, `scale_out_increment >= 1` in `variables.tf`) so the gate-disabled path is unchanged. `require_uint` is kept. The one fixture that used `4` (`test-converge-control-plane.sh`) now uses `2`. No `.example` file references the bound.
- 7e (fit cap): `CAPACITY_PLAN_FIT_MAX_ITEMS=500`. Exceeding it exits 1. It is not silently truncated. Tested.
- 7f (`occupies`): ignores `DesiredStatus`. This is conservative and is documented in the `capacity-demand.sh` header.
- 7g (missing `autoscale-settings.input` on an existing control plane): FATAL when demand-aware mode is enabled, WARNING only when it is disabled. "Enabled" is read from the last rendered `autoscale-settings.env`. If that file has `NOMAD_AUTOSCALE_DEMAND_ENABLED=true` and the input is missing, converge sets the failed marker and exits non-zero at the end of step 3d (the private-IP patch and daemon-reload still run). Otherwise the warning is unchanged. Production config is not changed. Tested in `test-converge-control-plane.sh`. Known gap: a host that never rendered demand mode stays warning-only.
- 7h (malformed-output alert): streak-gated behaviour is unchanged. The streak is one global counter, not per job. This is an approximation, to be revisited if the alert is noisy.

Defaults and rules:

- Demand mode is disabled everywhere. Nothing in production enables it.
- Success cooldown is 300 s. Failure backoff is a separate 300 s. A corrupt backoff record fails closed.
- Add = `min(uncovered, increment_max, remaining)`, where `remaining = max(0, cap - live_managed)`. Zero additions is a logged no-op, not an apply.
- Percent-only pressure never triggers headroom. Headroom needs usable classification, a sized item and `headroom_pressure`.
- Deleting servers count toward the cap (conservative).
- `CONTROLLER_MAX_DEMAND_JOBS=200`.
- `--force` adds at most one node, only when the computed add is zero and remaining headroom exists. It never bypasses cooldown or failure backoff, and it obeys the cap, the lock and the Terraform checks.
- `--bypass-cooldown` and `--safety-net` exit 1 with an explicit message in demand-aware mode. No hidden second policy. `--safety-net` has no dedicated test yet.
- Live path order: lock, then `tf_init_backend` (existing backend only), then `terraform workspace select` (existing workspace only, never create), then gate and inventory, then `terraform plan -out` under a `umask 077` temp dir, then `terraform show -json` (piped, never written or logged), then the allowlist, then `terraform apply` on the exact saved plan. No `-auto-approve`, no `-target`.
- Allowlist: only create actions on `hcloud_server.agent[i]` and `hcloud_server_network.agent[i]`, with indices exactly `[CUR, CUR+EXP)`, and `CUR+EXP <= cap`. Any drift, delete, replace, update, unrelated create, or protected-resource change rejects the plan. Output-only changes do not authorise anything.
- Dry-run: calls no `terraform` command. Writes no state, cooldown or count cache. Exits 1 when state is missing. Identifies itself as dry-run in all output.
- Watcher in demand mode: observer only. Logs `OBSERVER`, exits 0, writes no cooldown and calls no scale-out. The namespace bug (`?namespace=${NOMAD_AGENT_NAMESPACE}`) is fixed.
- Synthetic fixtures are documented as SYNTHETIC and UNVERIFIED in `tests/fixtures/capacity/README.md`.

Test-harness and pre-existing findings:

- `test_end` was passed as an assertion argument in `test-capacity-numeric-env.sh`, which hid a failure. Fixed.
- `require_uint` (`scale-common.sh`) accepts only 9-digit values, so epoch NOW values were rejected. Pre-existing. The controller uses `_controller_require_epoch` and the shared validator is unchanged.
- `_CONTROLLER_PREP_JQ` needed parentheses around `(A) - (B)` for jq 1.7.1. The brew jq 1.8.1 accepted it, so the test passing under brew alone was misleading. The controller and scale-out suites pass with `PATH=/usr/bin:/bin:/opt/homebrew/bin` (jq 1.7.1 first) as well.
- `acquire_lock` uses `exec {fd}>` (bash ≥4.1). Under `/bin/bash` 3.2 the live lock and gate sections of `test-capacity-scale-out-demand.sh` SKIP. Pre-existing, MEDIUM.

Rework round (H1, M2, M3, LOW-7) — FIXED:

- H1 (HIGH, FIXED): the saved-plan allowlist (`controller_plan_allowlist`, `_CONTROLLER_ALLOWLIST_JQ`) now checks `change.after` on every accepted `hcloud_server.agent[i]` and `hcloud_server_network.agent[i]` create. It fails closed on a null `after`, on an unknown checked field, and on a missing field. Checked: `server_type`, `labels.environment`, `location`, the agent name for the index, `network_id`, and the prior-state network's environment label. Expected values come from the tfvars literal, or `TF_VAR_<name>` if the tfvars file lacks the key (`controller_tf_input`). Nothing falls back to `variables.tf` defaults. Documented exception: `hcloud_server_network.server_id` may be unknown (the server is created in the same plan); a known `server_id` on a create is rejected. Tests (`test-capacity-controller.sh`): the `allowlist H1:` series, including "rejects a server of the wrong type", "rejects a server with the wrong environment label", "rejects a server in the wrong location", "rejects a network attachment to the wrong network", "rejects a server create with a null after", "rejects an unknown server_type on a checked field"; each asserts rc 1. The positive case "allowlist H1: accepts the create with the expected shape (documented server_id exception included)" passes. Mutation: removing each checked guard fails a test (m1–m10, m13 killed). m11 and m12 (the empty-input and prior-network-presence jq guards) survive: the bash empty-value checks and the equality checks reject the same inputs, so they are redundant layers, not untested behaviour.
- M2 (MEDIUM, FIXED): the demand success path calls `record_scale_success` (`scale-common.sh`), which runs `touch_cooldown` before `write_node_count`. A count-write failure after a successful apply still leaves the cooldown. The in-flight record semantics are unchanged. Tests (`test-capacity-scale-out-demand.sh`): "M2: a node-count write failure after a successful apply still records the cooldown" and "the cooldown file exists after the count-write failure"; call-order guards "scale-out.sh records the success through record_scale_success (cooldown first)" and "scale-out.sh no longer calls write_node_count before the cooldown". Mutation m14 (write before touch) killed. Note: the M2 test is unit-level (it sources `scale-common.sh` and fails `write_node_count`); it does not run the full demand script.
- M3 (MEDIUM, FIXED): legacy `NOMAD_SCALE_OUT_INCREMENT` and `scale_out_increment` are back to HEAD (1..100 and `>= 1`). Only the demand batch cap is 1..2. Tests (`test-capacity-numeric-env.sh`): "legacy increment 3 is still accepted (the gate-disabled path is unchanged)", "legacy increment 100 is still accepted (HEAD upper bound)", "legacy increment 101 is refused", "demand increment max 3 is refused", "demand increment max 2 is accepted", "demand increment max 1 is accepted". Mutations m15 (legacy bound narrowed) and m16 (demand bound widened) killed.
- LOW-7 (FIXED): `_controller_require_epoch` and the failure-file read use the same grammar as `require_uint` (`^(0|[1-9][0-9]{0,9})$`) with the 9999999999 bound. Tests: "epoch: a current 10-digit epoch is accepted", "epoch: the 10-digit upper bound is accepted", "epoch: a leading zero is rejected (same grammar as require_uint)", "epoch: an 11-digit value is rejected". Mutation m13 (both guards removed) killed.
- Caller wiring: `scale-out.sh` computes the four expected values before the plan (a `die` inside the pipeline would not stop the caller), then passes them to the allowlist. Mutation m17 (wrong expected server name) killed by the `--force` block.

Rollout requirements that follow from H1:

- The autoscale environment must export `TF_VAR_server_name` and `TF_VAR_location` unless the tfvars file sets them as literals. The controller fails closed otherwise. `staging.tfvars` and `production.tfvars` do not set `location`.
- Owner decision (not implemented): whether `location` and `server_name` should fall back to the `variables.tf` defaults. The current design deliberately does not.

Deferred MEDIUM/LOW (not closed in P4):

- MEDIUM: the watcher keyword filter (~194–195 in `check-placement-failures.sh`) matches `.BlockedEval`, which is likely never matched. Unverified against Nomad 1.9.7. Deferred.
- MEDIUM: `cloud-init.yaml` still enables the scale-out and watcher units. Observer mode in the script keeps the watcher non-writing, but the unit files are not changed in P4. Rollout must confirm this before enabling demand mode.
- MEDIUM: `write_node_count` (`scale-common.sh`) runs after apply. If it fails, the script exits 1 after a mutation. Partly mitigated by M2 (the cooldown is now recorded first), but the count file can still be stale. Open.
- MEDIUM: unjoined pending servers are counted as viable. Imprecise.
- MEDIUM: the bin-count check may fail closed on drained or ineligible ready nodes. Conservative; this may block recovery in some states.
- MEDIUM: `placement_matches_template` is true only with no constraints, affinities or spreads. Datacenter matching is unverified.
- MEDIUM: `gate rc 2 with add>0` currently defers with exit 0. Confirm whether that is intended.
- MEDIUM: the `--safety-net` message has no dedicated test.
- LOW: `require_uint` 9-digit limit (pre-existing, see above).
- LOW: the `NOMAD_TOKEN` curl argv exposure (pre-existing, carried from P3).
- UNVERIFIED: the `terraform show -json` shape (`resource_changes`, `actions`, `address`, `index`), the env-dir layout (`${TF_DATA_DIR}/terraform.tfstate`, `${TF_DATA_DIR}/environment`), and `NOMAD_SCALE_IN_DRAIN_DEADLINE_SECONDS` (defined elsewhere). Must be checked against a real init before demand mode is enabled.
OPEN items (not closed in P4). Owner-action notes are required before any activation:

- OPEN HIGH, H2 (activation blocker, values measured, rollout step pending): production node-template values were measured read-only from `herobids-production` (Nomad API `/v1/nodes` and `/v1/node/<id>`, plus Terraform state for the server type). There is one agent, `herobids-production-agent-1`, type `cx23`, location `fsn1`. Allocatable memory is 3819 MB (total 3819, reserved 0). Allocatable CPU is 4000 MHz (total 4000, reserved 0). The measured values are `NOMAD_NODE_TEMPLATE_MEMORY_MB=3819` and `NOMAD_NODE_TEMPLATE_CPU_MHZ=4000`. They were written to `/etc/herobids/autoscale.env` on `herobids-production` with owner approval, in place and not through `setup-autoscale-env.sh`. That script regenerates the whole file from a fixed key set and would drop them. The existing six keys were preserved (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `NOMAD_TOKEN`, `TF_BACKEND_BUCKET`, `TF_BACKEND_DYNAMODB_TABLE`, `TF_BACKEND_REGION`). The file is mode 600, and the pre-write backup is `/etc/herobids/autoscale.env.bak-h2-20261031044523`. Demand mode stays disabled, and no daemon-reload was run, because the unit reads `EnvironmentFile` at start. Open design question: `NOMAD_NODE_TEMPLATE_*` is not yet in the `render-autoscale-settings.sh` allowlist or the Terraform `autoscale_settings` output.
- OPEN HIGH, H3 (decided: option A, fail closed). With floor 1 and zero managed servers, `empty_inventory` fails closed, and scale-from-empty is not implemented. Recovery from a fully empty pool is manual. The runbook is written at `infra/hetzner/docs/auto-scaling/manual-recovery-empty-pool.md` and is rehearsed against the synthetic empty-pool fixtures only (P8). Its live steps are NOT executed. A bootstrap path with its own cap and approval is deferred and is not required for activation.
- OPEN HIGH, H4 (non-mutating staging capture done, rollout BLOCKER found): `terraform init` and `plan -refresh=false` were run read-only against staging (`TF_VAR_location=fsn1`). Nothing was applied. The extracted shape is 7 no-op, plus 2 `delete+create` actions. These are `hcloud_server.agent[0]` (replace on `user_data`) and `hcloud_server_network.agent[0]` (replace on `server_id`, as a consequence). Only agent resources change. The P4 create-only allowlist correctly rejects this plan, so scale-out on staging fails closed. ROOT CAUSE FOUND (read-only). Commit `dfae457a` (2026-10-30, "Fix agent start timeout") added a `docker pull` pre-pull block to `cloud-init-nomad-client.yaml`. The provider stores `hcloud_server.agent[0].user_data` as the base64 of its SHA-1 (28 characters). Its hex digest is `6e863c58…` and equals the SHA-1 of the template as it was BEFORE `dfae457a`, rendered with the current inputs. The HEAD template renders to `3bf24ca4…`, so the digest differs. The template inputs are unchanged. `hcloud_server.agent` has no `ignore_changes` on `user_data`, unlike the control plane, so any template change replaces every agent. P1–P4 did not cause this (P1 changed only the control-plane `hcloud_server.default`). Production has the same mismatch: its state digest `6f9097c6…` matches the pre-`dfae457a` template, and HEAD renders to `a32b945e…`. So a routine `provision.sh` apply on either environment would replace the agent. A read-only plan of a patched copy, with `ignore_changes = [user_data]` on `hcloud_server.agent`, shows zero non-no-op changes on both staging and production. Trade-off: existing agents no longer pick up template changes on apply, so template rollouts need an explicit, drained `-replace`. Owner decision needed before the repo change is committed or any apply runs. Do not fix it by removing state or using `-target`. The fixture shape is only partly verified: the `resource_changes` `actions` and `address` paths were confirmed against this real capture. The `change.after_unknown`, prior state, and `labels.environment` assumptions are still open.

### P5 (startup observation, DB facts, race guards)

Implemented: optional `RuntimePort.observeStartup` (queued/placed, with `RuntimeStartupObservation`), Nomad-only implementation, launcher pass-through, additive nullable columns `runtime_registered_at`, `first_placed_at`, and `placement_allocation_id` (migration `0088_superb_firelord.sql`), conditional repository methods `markRuntimeRegistered` and `recordFirstPlacement` (monotonic-min placement), and explicit public projection exclusion of the three columns. Verified: adapter tests 18/18, DB integration 87/87 against local postgres, worker/API/db unit suites green, and per-package `tsc --noEmit` clean. Root `pnpm lint` is a no-op (root `tsconfig.json` has `files: []`), so per-package type-checks are the real gate.

Review (CodeReviewer, no CRITICAL or HIGH confirmed). Fixed in P5 before commit:

- MEDIUM, fixed: `fetchJobAllocations` maps 404 to `[]`, so a job purged between the job and allocation GETs would report `queued`. `observeStartup` now re-checks the job before returning `queued` and returns NOT_FOUND if it is gone. Test added.
- Possible HIGH, removed: a `CreateTime >= SubmitTime` filter could drop a running allocation if Nomad updates `SubmitTime` on an identical re-registration, which would yield a false `queued`. Identity now rests on `JobVersion` alone. Not verified against Nomad's `upsertJobImpl`; P9 must confirm.

Deferred MEDIUM/LOW:

- UNVERIFIED (P9 gate): the Nomad 1.9.x shapes for job `Version`, `SubmitTime`, `Meta`, and allocation `NodeID`, `JobVersion`, `DesiredStatus`, `CreateTime` come from the API docs, not a live cluster. Confirm against a real job before the health monitor relies on `observeStartup` (P6).
- LOW: `queued` and `placed` timestamps are JS numbers from int64 nanoseconds (~256 ns resolution). Ties within that window fall back to allocation ID ordering. The code comment states this.
- LOW: job-level `Stop` and `Status === 'dead'` are not checked. A stopping, non-purged job could report `queued`. Likely transient, since stop purges. P6 should treat a stale queued state as a deadline issue, not a placement.
- LOW: `recordFirstPlacement` keeps the first writer's allocation ID on an equal-millisecond tie. Timestamp is unaffected.
- LOW (guard for P7): repository getters return full session rows, including `placementAllocationId`. The projection excludes the columns, and no HTTP path currently serialises raw rows, but P7 should add a route-level guard test.
- Pre-existing: root `pnpm lint` checks nothing. A follow-up should make it run `tsc --build` or the per-package checks.
- OPEN MEDIUM, M4 (decided: startup guard, mitigated). `acquire_lock` uses `exec {fd}`, which needs bash >= 4.1. `validate_scale_numeric_env` now refuses demand mode under bash < 4.1 with exit 2 and a message naming the requirement, before any side effect. The live-lock and `--force` assertions still SKIP under bash 3.2, and `run-all.sh` now counts and reports SKIP lines in its summary. Production is Ubuntu 24.04 with bash 5.2, so it is unaffected. The full suite passes under bash 5 and `/bin/bash` 3.2 (1284 checks each, rc=0).
- Final-round fix (review 2 LOW-1): `NOMAD_SCALE_OUT_INCREMENT_MAX` is validated only when `NOMAD_AUTOSCALE_DEMAND_ENABLED=true`, so an unused out-of-range value no longer aborts legacy runs. Covered by `test-capacity-numeric-env.sh`.
- Open LOWs from review 2 (not fixed): (a) legacy `write_node_count` still runs before `touch_cooldown` (same as HEAD; align later); (b) the streak counter regex `[1-9][0-9]{0,5}` caps at 999999, so a longer streak wedges the controller (saturate or widen); (c) the `CAPACITY_STDERR` temp file leaks on signal (add a trap); (d) a partial-apply pending record is conservative and may block recovery.
- The remaining LOW items (6, 8–10 in the review) are the Deferred entries above and remain open. Their owner notes are: the cloud-init units must be confirmed disabled before enabling demand mode; the `.BlockedEval` keyword must be checked against Nomad 1.9.7; `--safety-net` needs a test before use; `NOMAD_TOKEN` in curl argv is a pre-existing exposure to fix before production rollout.

### P6 (capacity-aware startup deadlines, atomic expiry, session-safe cleanup)

Implemented (uncommitted; not yet code-reviewed): the health monitor sweeps `starting` and `launching` sessions through `observeStartup` when `worker.agents.capacityAwareStart.enabled` is true and the runtime supports observation. The pure deadline rules are in `agent-startup-deadlines.ts`. Expiry is `AgentRepository.expireStartingSession`, a single conditional UPDATE that requires the expected status, `runtime_registered_at`, and `first_placed_at`. The session manager records registration after a successful submit (`markRuntimeRegistered`), and the stop path purges only a job whose Meta `herobids.sessionId` matches (`RuntimeStopOptions.sessionId`, `SESSION_MISMATCH`).

Gate: when the flag is off, or the runtime has no `observeStartup`, the legacy `startTimeoutMs` path runs unchanged, including the `starting`+`launching` legacy query.

Deviations from the contract:
- `expireStartupDeadline` accepts any `StartupDeadlineReason` (it was `start_timeout` only). The monitor needs the other reasons.
- A registered job that the scheduler reports as NOT_FOUND expires at once with `observation_failure`. An unregistered session with an unconfirmed state gets the absolute bound, not the legacy 60s, so a submitted but unrecorded job is not killed early.

Tests: `agent-startup-deadlines.test.ts` (pure rules), `agent-health-monitor-capacity.test.ts` (fake clock: gate, queue and boot deadlines, overall bound, inspection failure, earlier placement, stop and claim races, non-overlap), `nomad-runtime-adapter.test.ts` (stop session guard), and `agent-repository-startup.integration.test.ts` (real Postgres: atomic claim, placement and heartbeat losing races, stop not resurrected).

Open risks:
- The Nomad purge has a TOCTOU window between the Meta check and the DELETE. Nomad DELETE has no index precondition.
- The Nomad field shapes remain UNVERIFIED (P9 gate), so P6 adds no new reliance beyond P5.
- The `waiting_for_capacity`/`booting` subphase is not computed or projected (P7).
- Inspection-failure warnings log on every sweep.

Review rework (P6 still uncommitted):

- MEDIUM, fixed: with `capacityAwareStart.enabled=false` the launcher stop passed `{ sessionId }`, which added a Nomad GET and a possible `SESSION_MISMATCH` before DELETE. The launcher now passes the option only when the startup-observation gate is active (same condition as the gated deadline logic). Gate-off stop issues the same port calls as f08709f5. Tests: `agent-runtime-launcher.test.ts`, describe "stop passes sessionId only under the P6 gate".
- HIGH, test gap, fixed: `agent-session-manager-startup.test.ts` (new, 12 tests) covers the expiry claim (a false repository claim leaves the runtime, agent and events untouched; the claim receives the expected status and facts; the successful claimant stops the runtime, marks the agent stopped and emits the failure event once; `start_timeout` emits no startup guardrail; a lost second claim repeats nothing). It also covers the post-submit `markRuntimeRegistered` hook (called after a successful submit; not called on submit failure, gate off, or non-observing port; a session stopped or crashed during the submit is not resurrected and its job is stopped; a live session already registered by another writer is kept). The Nomad stop refusal on a mismatched Meta `herobids.sessionId` is covered in `nomad-runtime-adapter.test.ts` ("refuses to purge a job that belongs to a different session").

DECISION (user-approved, option A): for an unregistered launching session whose inspection fails, the 12-minute overall bound (`startedAt + capacityWaitTimeoutMs + placedStartTimeoutMs`) applies, not the legacy 60s. Rationale: a job that was submitted but whose registration was not recorded (for example after a worker crash) must not be stopped early. The stop path still purges any matching job it finds. Gate-off keeps the legacy 60s. Implemented in `agent-startup-deadlines.ts`, which is unchanged in this rework.

Coverage: the crash-during-slow-submit orphan (review MEDIUM 4) is covered by the expiry path. An unregistered launching session expires at its overall bound, and `stop()` purges any matching job found by agentId.

RESIDUAL (HIGH, accepted, P9 to revisit): the Nomad DELETE purge has no precondition, so a check-then-delete window exists between the Meta `herobids.sessionId` check and the DELETE. A restart that submits a newer job for the same agent inside that window could have that job purged. Mitigation options to evaluate in P9 (for example, a Nomad job-version or index precondition on DELETE, or re-verifying the Meta before purge and treating a mismatch as a recoverable error).

LOW residuals:

- The placement timestamp is not validated against `startedAt`.
- The health monitor single-flight is per process. Multi-replica sweeps are protected by the atomic expiry claim, so at most one claimant stops the runtime and emits the failure event.

### P7 (app half: startup progress, failure reason, UI, config plumbing)

Implemented and committed. This record covers the app half. Scale-in coordination is recorded in §8.

Shipped:

- Pure progress and deadline rules in `packages/domain/src/capacity/agent-startup-deadlines.ts`. `computeStartupProgress` takes explicit inputs. Missing data (undefined placement, heartbeat, registration or startedAt) yields null, never `booting` (M2). Non-starting statuses (`running`, `unhealthy`, `stopped`, `crashed`) return null, with and without the gate (M3). Tests in `agent-startup-progress.test.ts`.
- Persisted failure reason (H1). Migration `packages/db/drizzle/0089_agent_startup_failure_reason.sql` adds one nullable text column, `agent_runtime_sessions.startup_failure_reason`. Only the worker writes it, through `markSessionStartTimedOut` (`start_timeout`) and `expireStartingSession` (`queue_deadline`, `boot_deadline`, `observation_failure`), in the same conditional UPDATE as the status change.
- Public exposure is a safe enum only. `toPublicRuntimeSession` returns `startupFailureReason` only if it passes `isStartupDeadlineReason`, otherwise null. Internal keys (`apiKeyHash`, `runtimeRegisteredAt`, `firstPlacedAt`, `placementAllocationId`) are never projected. The public column set used by analytics and dashboard routes excludes the failure column. Tests: `sessions.test.ts` (`startupFailureReason`, each reason, unknown value does not leak) and `agents.test.ts` (per-run enum on `GET /agents/:id/sessions`).
- The web detail page shows a localized message per reason (en, ar, hi keys under `agents.detail.startupFailure`), taken from the latest run of `GET /agents/:id/sessions`, and only when no active session exists. `GET /agents/:id` suppresses terminal sessions, so the sessions endpoint is the source. Render tests cover each reason, null, most-recent run, and active-session suppression.
- Typed i18n maps (`as const satisfies`) replace the dynamic key (L2). The catalog-consistency test asserts ar and hi against en in both directions.
- Worker dead guard removed. The launcher is threaded explicitly through the sweep (L3).

Findings and dispositions:

- H1 (HIGH), fixed: failure reason persisted (0089) and shown to the user, with no-leak tests.
- M2, fixed: explicit inputs; undefined and null are distinct and yield null progress. Unit tests.
- M3, fixed: domain tests for every non-starting status.
- M4, fixed (documented): missing-job display lag. A job removed out of band is shown as `booting` until the next health sweep observes `not_found` and expires the session. The lag is bounded by one sweep interval (`worker.agents.healthCheckIntervalMs`, passed to the monitor as `checkIntervalMs`). Recorded as a comment above `sweepLaunchingSessions` in `agent-health-monitor.ts`. No behaviour change.
- M5, fixed (test, with an open divergence): the API and worker both read the `worker.agents.capacityAwareStart` config key. A source-level test guards both references. The divergence is open. The worker also requires `runtimeLauncher.supportsStartupObservation()` (monitor and session manager), which the API cannot check. The API gates on `enabled` alone, so for a launcher that cannot observe, the API may show `startupProgress` for a session the worker does not enforce. The worker-side behaviour is pinned by the "legacy path when the runtime cannot observe startup" test. Open risk, not fixed.
- M1, deferred: realtime progress events (SSE or push) are NOT built in P7. Progress is polled from the session projection. Revisit only if polling latency is a user problem.
- L1, deferred: repository getters still return full rows. Narrowing them changes return types used by the worker and sweep code (`apiKeyHash`, `placementAllocationId`). The public exposure is controlled at the projection, and the no-leak route tests cover it, so narrowing is not cheap enough for this rework.
- L2, fixed: typed maps and a two-way parity check.
- L3, fixed: dead `if (!launcher)` guard removed; the launcher is passed explicitly.

Verification: `tsc --noEmit` clean for domain, db, worker, api, web. The DB integration test `agent-repository-startup.integration.test.ts` runs 17 of 17 against local Postgres with `--no-file-parallelism`, including the migration. Worker capacity tests 19 of 19. The full-suite failures seen under parallel load (API route timeouts, worker tool timeouts and env-drift, web i18n date formatting) pass when rerun alone or serially, so they are load-related, not logic regressions.

Open risks:

- M5 divergence: API gate versus worker observation gate (above).
- Realtime progress deferred (M1). Progress lags by up to one sweep interval.
- Missing-job display lag, bounded by one sweep (M4).
- Repository getters return full rows (L1). Narrowing is deferred.
- Scale-in coordination (the other half of P7) is recorded in §8, with its own unverified items.
- API integration: verified after the local dev DB was migrated to head and a local Redis was started. The full API suite passes (2004 pass, 0 fail, 252 skipped).

### P8 (documentation, local validation, fixture shadow)

Status: PARTIAL. Local validation, the fixture shadow, and the live read-only shadow are complete. The live shadow ran on 2026-10-31 after owner approval. Nothing was written to staging or production, and no Terraform plan was run. Live decisions are still not demand-driven (see Live shadow below). Production was not touched.

Done:

- H3 runbook: `infra/hetzner/docs/auto-scaling/manual-recovery-empty-pool.md`. It covers detection, pausing timers, a create-only saved-plan review, apply, joining, and rollback. Linked from `setup-auto-scaling.md` ("Clearing a blocked scale guard").
- `lessons-learnt.md` item 5 status updated. The `agent_node_count` seed was removed from `cloud-init.yaml`, and the control plane has `ignore_changes = [user_data]`.
- §12.1 build: `tsc --build` passed for domain, db, and worker.
- §12.1 unit: targeted run, 5 files, 184 passed.
- DB startup integration: 17 of 17 passed.
- `pnpm test:integration`: 11 files, 135 passed.
- Infra shell suites: `run-all.sh` and `check-nomad-capacity.test.sh` passed.
- Re-run 2026-10-31 ~12:19 (local only): `infra/hetzner/scripts/tests/run-all.sh` exit 0. 24 suites passed, 0 failed, 0 SKIP lines. Nothing on staging or production was touched.
- Fixture shadow: `test-capacity-controller.sh`, `test-capacity-readonly.sh`, `test-capacity-inventory.sh`, and `test-capacity-demand.sh` all exit 0, with no failure markers in the logs.
- Empty-pool replay, read-only, synthetic fixtures: declared 0 gives rc 2, blocked, `empty_inventory`. Declared 1 gives rc 2, blocked, `empty_inventory` and `partial_apply`.

Live shadow (2026-10-31, staging, read-only, run on `138.199.172.202` at `02917bc9`):

- `check-nomad-capacity.sh --json`: exit 0. 1 ready node, free 491 MB of 3819 MB, 1 free agent slot, 256 MB per-slot reservation.
- `scale-out.sh --dry-run`: exit 0. Managed 1, max 3, candidate 2. It reports "live capacity thresholds not evaluated", so this is a candidate count, not a demand verdict. No changes made.
- `scale-in.sh --dry-run`: exit 2 ("Nothing to do"). Scale-in is disabled (`ENABLE_SCALE_IN=false`), so no candidates were evaluated.
- Namespace check (watcher note 3, resolved). `/v1/evaluations` with no namespace is treated as `default` and returns 3 evaluations. `namespace=herobids-agents` returns 5. `namespace=*` returns 8. The watcher must pass `namespace=herobids-agents` explicitly. Read-only test: the unscoped call would miss the agent evaluations.
- Demand snapshot: all 5 `herobids-agents` evaluations are `complete`. No blocked evaluations. 5 agent service jobs are running. All 6 allocations are `running`.
- Nodes: `herobids-staging-agent-3` ready and eligible at `10.0.0.5`. `-agent-1` and `-agent-2` are `down` and still show private address `10.0.0.3`. The Hetzner server `173731633` is named `-agent-1` and has private `10.0.0.5`. This matches the private-IP matching in the guard. The name mismatch is kept as a known blocker, per the owner's decision.
- Shadow state: no controller state was written. No cooldown or alert counters were touched.

Not done:

- Multi-tick shadow comparison against demand over an idle period, a pending-work period, and a full cooldown (§12.2 last bullet). Not started. It needs a separately named shadow state directory.
- The H3 runbook's live steps. Not executed.

Findings:

- Staging zero-node gap, DECIDED: staging floor raised to 1 (user choice). Reason: at `min_agent_nodes = 0`, scale-in can drain the pool, and `empty_inventory` then blocks scale-out. Repo templates (`environment.tfvars.example`, `setup-auto-scaling.md`) carry the reason. The gitignored local `staging.tfvars` is set to 1. The live control plane still reads its floor from `TF_VAR_min_agent_nodes` in its own environment, so the live change is an approved P9 step, not done. Scale-from-empty stays deferred (H3).
- Stale test reference (pre-existing, not changed). Root `package.json` `test:integration` lists `packages/db/src/journal-pg.integration.test.ts`, which does not exist. Vitest skips it silently.
- Local P0–P7 commits are not pushed. `maintenance-restart-from-local.sh` deploys `origin/main`, so it cannot pick up local-only work.

