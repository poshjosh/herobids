# Nomad Agent Node Scale-Out: Problem, Options, and Recommended Starting Point

**Status:** Options assessed; corrected starting direction agreed, implementation pending
**Area:** `infra/hetzner` autoscaling (Nomad agent nodes, staging and production)
**Related:** [Roadmap](./000-roadmap.md), [objectives](./010-objectives.md), [first milestone](./001-safe-capacity-expansion-plan.md), [autoscale setup](../../../../../../infra/hetzner/docs/auto-scaling/setup-auto-scaling.md), [lessons](../../../../../../infra/hetzner/docs/auto-scaling/lessons-learnt.md)

---

## 1. Problem

Agent workloads run as Nomad jobs on Hetzner nodes. When demand exceeds capacity,
jobs wait. Improving response time is useful, but cannot take precedence over
safe infrastructure changes and preservation of the original start request.

The original options document discussed general configuration drift, not the
specific replacement incident. That incident is now recorded explicitly below
and in the [objectives](./010-objectives.md); it must not be retroactively
attributed to alert configuration.

### How scale-out works today

The source defines two loops in
[the infrastructure scripts](../../../../../../infra/hetzner/scripts/).
These describe code paths and configured defaults, not verified active services.
The owner has stopped staging's main autoscale timer.

**Main loop (`nomad-autoscale.timer`, every 60s, `scale-out.sh`)**

1. Reads free memory percentage and free agent slots from the Nomad API
   (via `check-nomad-capacity.sh`).
2. Scales out by one node (`scale_out_increment`, default 1) if free memory is
   below `NOMAD_SCALE_OUT_MEMORY_THRESHOLD_PCT` or free slots are below
   `NOMAD_SCALE_OUT_SLOT_THRESHOLD`.
3. Refuses to exceed `max_agent_nodes`.
4. Waits for `NOMAD_SCALE_OUT_COOLDOWN_SECONDS` (default 300s) between
   scale-out events.
5. Runs `terraform apply` with an increased `agent_node_count`.

**Backup loop (`nomad-placement-failure-watcher.timer`, every 120s,
`check-placement-failures.sh`)**

1. Queries evaluations without an explicit agent namespace and filters recent
   `blocked` evaluations using `BlockedEval` and `StatusDescription` keyword
   matching. `BlockedEval` is an evaluation identifier, not a reason; this
   is not a reliable resource-shortage detector.
2. If the count is at least `NOMAD_PLACEMENT_FAILURE_THRESHOLD` (default 5), it
   runs `scale-out.sh --bypass-cooldown --force`, which still adds one node
   and still respects `max_agent_nodes`.
3. Enforces its own 600s cooldown between triggers.

### Consequences and corrected constraints

- **Slow ramp.** Going from 1 node to the cap takes roughly
  `(max - current) x cooldown`, plus Terraform apply time per node.
- **Demand is seen late.** Room-based thresholds react after capacity is
  already tight. The stuck-job signal is only used as a backup, and only after
  5 stuck evals within 5 minutes.
- **One node per event.** A backlog of 20 stuck jobs adds one node per event,
  not enough for the backlog.
- **Terraform in the hot path.** Each scale event runs `terraform apply` on the
  control plane, which is slow and contends for the state lock.
- **No ready nodes, no scaling.** If zero agent nodes are ready, scale-out
  exits with code 2 and only alerts.
- **Lost original requests.** The default startup watchdog can terminate a
  waiting session in about 60 seconds, before a new node is available.
- **Unsafe mutation scope.** Full-stack unattended apply is not a create-only
  operation. In the owner's last staging plan at 23:06 on 2026-10-30 (timezone
  unspecified), agent `user_data` drift caused proposed replacement of
  `hcloud_server.agent[0]` and its network attachment. The differing input is
  unknown. Alert changes were output-only, not the replacement cause.
- **Operational hold.** The owner-stopped staging timer stays stopped until the
  agent-node drift is identified and a replacement guard is implemented/tested,
  with explicit owner approval before re-enabling. Production exposure is
  unverified. No live verification was performed to prepare this document.

---

## 2. Options

| # | Option | Benefit | Cost or limitation | Decision |
|---|---|---|---|---|
| 1 | Correct current Nomad demand and retain Terraform | Reuses the existing ownership boundary; can add a bounded batch for real outstanding requests | Needs reliable observations, safe saved-plan apply and waiting lifecycle, not just threshold tuning | Selected first milestone |
| 2 | Direct Hetzner provisioning | Can avoid full Terraform execution in the provisioning hot path | Still waits for boot, join and image readiness; needs durable inventory, reconciliation and exclusive ownership, not a small unchecked state file | Defer until timing evidence justifies an ownership redesign |
| 3 | Nomad Autoscaler plus a Hetzner plugin | Reuses policy/cooldown machinery | Adds an operated component; plugin support and compatibility must be verified; does not solve continuation | Defer; compare against measured controller limits |
| 4 | Warm nodes, pre-pulled images or baked snapshots | Reduces the measured cold-start stages it actually targets | Warm capacity costs money; snapshots still boot/join and need updates | Candidate if first-milestone timings miss the agreed wait budget |
| 5 | Scheduled floor | Prepares for predictable peaks | Requires active floor reconciliation; changing a minimum alone does not provision; cannot cover unexpected demand | Later complement |
| 6 | Application-owned demand signal | Can represent admitted requests before scheduler submission | Adds cross-system consistency and ownership work; current Nomad jobs already express submitted demand | Defer unless observed demand gaps require it |

Earlier effort estimates were unverified and are withdrawn. A count of
evaluations is not a count of jobs, and a count of jobs is not a count of nodes.
Hetzner integrations must not be assumed officially supported merely because
the autoscaler itself is a HashiCorp project; check the actual plugin against
the [external/community plugin documentation](https://developer.hashicorp.com/nomad/tools/autoscaling/plugins/external).

---

## 3. Recommendation: safety and waiting before demand-aware activation

Implement [safe capacity expansion](./001-safe-capacity-expansion-plan.md).
This replaces the original "promote the tested signal" proposal:

1. Establish exposure using genuinely read-only collection, and diagnose the
   unknown agent startup-script difference privately.
2. Enforce an exact create-only saved-plan allowlist. Correct configuration
   drift without hiding it. Do not use a blanket ignore to force a clean plan.
3. Collect current workload by namespace/job/task group, deduplicate evaluations
   and use structured diagnostics to distinguish capacity from other failures.
4. Fit actual memory/CPU requests on individual nodes; account for Browserless,
   pending reservations, incoming servers and all owned nodes under the cap.
5. Keep original sessions alive through bounded waiting and placed-start
   deadlines, with safe cancellation, restart persistence and UI progress.
6. Use one controller with bounded batches, floor, cap, cooldown and failure
   backoff. The watcher is observation-only in the new mode.

This is the simplest complete starting point, not the smallest script edit.
It preserves the infrastructure owner while making the original user request
the acceptance criterion. It does not establish running-agent continuation,
live migration or safe active consolidation.

---

## 4. Validation and later decision gates

- Existing `--dry-run` reaches Terraform preparation and is not certified
  harmless. Do not invoke it on shared infrastructure as read-only evidence.
- Start with local fixture tests, including namespace mismatches, malformed
  data, fragmentation, partial provisioning and proposed replacement.
- Exercise the live scale path in an owner-approved disposable environment
  before any shared staging mutation.
- Use approved read-only staging shadow observations, then separately approved
  staging acceptance. Observe original session IDs to first heartbeat and
  existing agents' continuity, not only server creation.
- Preserve node and spend caps, test cancellation/restart/race behavior and
  record each stage of the wait/provision/join/placement/boot timing.
- Production activation is a separate approval after exposure and acceptance
  evidence. No timer changes are authorised by this document.
- Use measured latency and the [economics plan](./004-capacity-economics-and-latency-plan.md)
  to choose warm capacity or a provisioning redesign. Use the
  [continuation](./002-durable-agent-continuation-plan.md) and
  [maintenance](./003-controlled-maintenance-and-recovery-plan.md) plans before
  allowing occupied-node replacement.
