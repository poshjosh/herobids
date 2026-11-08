# Staged Agent Node Rollout (Sandbox Capabilities)

**Status:** Proposed
**Estimated effort:** ~5–7 days engineering, plus staged rollout windows
**Dependencies:** [Bug 001](../../../bug-reports/2026/11/07/001-nomad-agent-tasks-missing-sandbox-caps.md), [Bug 002](../../../bug-reports/2026/11/07/002-staging-agents-fail-boot-after-cap-change-reverted.md)

## Summary

Shipping a Nomad job change that needs node-level configuration broke every staging agent. The job asked for `NET_ADMIN` and `SYS_ADMIN`, but existing agent nodes did not allow them. Cloud-init changes only reach new nodes. Commit `83ff639d` reverted the change.

This plan re-applies the sandbox capabilities safely. It does so by:

1. Shipping code **dark**, behind a flag, so deploying it changes nothing.
2. Building a **new node class** with the capability allowed from first boot.
3. Proving it on one canary node and one canary agent.
4. Moving agents to the new class **in waves**, with automatic stop conditions.
5. Draining and retiring the old nodes only after the new class is stable.

The same method must work for 1,000 agents. Nothing in it depends on hand-editing live nodes.

## Goals

- `execute_shell` and `execute_code` run inside the sandbox on every agent that is moved, with no `sandbox_infrastructure_error`.
- No agent is left unable to boot. A boot failure stops the rollout before it reaches more agents.
- Any wave can be reversed without a new deploy.
- Every node that receives agents has a verified identity and a verified Nomad version.
- The process is driven by a script with explicit thresholds, not by memory.

## Non-goals

- Replacing the sandbox with a capability-free design (tracked separately; see Open questions).
- Changing production before staging has passed every gate.
- Rewriting the maintenance restart script (only the parts this rollout needs; see Phase 0).

## Current state (verified)

| Item | Where | Current behaviour |
|---|---|---|
| Cap request | [nomad-runtime-adapter.ts](../../../../apps/worker/src/agents/nomad-runtime-adapter.ts) `buildNomadJobSpec` | Reverted. Was `cap_add: ['NET_ADMIN','SYS_ADMIN']` |
| Node capability allow-list | [cloud-init-nomad-client.yaml](../../../../infra/hetzner/cloud-init-nomad-client.yaml) plugin `docker` | Default `allow_caps`. Applies to new nodes only |
| Node class | cloud-init `client { node_class = "agent" }` | Fixed to `agent` for all nodes |
| Node identity labels | cloud-init `meta { environment, node_pool, node_index }` | `node_pool = var.server_name` |
| Node creation | [main.tf](../../../../infra/hetzner/main.tf) (`user_data` templatefile, ~line 264) | Terraform creates nodes from cloud-init |
| Scale-out | `infra/hetzner/scripts/scale-out.sh` | Adds nodes via Terraform; single-flight with `flock` |
| Scale-in | `infra/hetzner/scripts/scale-in.sh`, `scale-in-guard.sh` | Removes nodes; has a guard |
| Restart | `infra/hetzner/scripts/maintenance-restart.sh` | Docker-only. Its "running agents" check does not see Nomad jobs |
| Boot deadline | [config/default.yaml](../../../../config/default.yaml) `placedStartTimeoutMs: 120000` | Agent must heartbeat within 120 s of placement |
| Nomad versions | Live staging nodes | `agent-2` = 1.9.7, `agent-3` = 2.1.1 (mismatch) |
| Node identity | Live staging nodes | Host keys changed since last record; not yet confirmed |

## Design

### D1. New node class for sandboxed agents

Add a `node_class` template variable to cloud-init. Default stays `agent`. New sandboxed pool uses `agent-caps`.

- The `docker` plugin `allow_caps` list includes `net_admin` and `sys_admin` only on `agent-caps` nodes.
- Existing `agent` nodes never receive the caps. Their config does not change.

Why a separate class and not a config change on every node: a job that requests the caps can only be placed where the caps are allowed. A node-class constraint makes that a scheduler rule, not a convention.

### D2. Job constraint driven by a flag

In `buildNomadJobSpec`:

- If the sandbox-caps flag is **off**: no `cap_add`, no constraint. Behaviour is identical to v0.8.9.
- If the flag is **on** and the agent is in the rollout set: `cap_add: ['NET_ADMIN','SYS_ADMIN']` **and** a constraint `${node.class} = agent-caps`.
- If the flag is **on** and the agent is not yet in the set: as the flag-off case.

This means a cap request can never be scheduled on a node that lacks the allow-list. That is the failure we had.

The flag and the agent set live in config, so a wave is a config change plus a worker restart. No code deploy is needed to start, stop, or roll back a wave.

### D3. Config

Add to the nomad config section:

- `sandboxCaps.enabled` (default `false`).
- `sandboxCaps.nodeClass` (default `agent-caps`).
- `sandboxCaps.agentIds` (list). Used for waves. Empty = nobody. Use `*` = everyone, only after the final gate.

Exact schema location to be confirmed in `packages/domain/src/config/schema.ts` during implementation.

### D4. Node build

- Pin the Nomad version in cloud-init and in `setup-nomad.sh`. Both staging clients must run the same version before any wave.
- Pre-pull the agent image on the new node in cloud-init, so the boot window is not spent on `docker pull`.
- Record the node's ED25519 host key fingerprint in the rollout log at creation time.

### D5. Rollout script

New script `infra/hetzner/scripts/rollout-agent-caps.sh`. It:

- Takes `--env`, `--wave <percent|count>`, `--dry-run`, `--rollback`.
- Reads the agent list from the database (active, not live-mode unless `--include-live`).
- Adds the chosen agents to `sandboxCaps.agentIds` and restarts the worker.
- Relaunches each selected agent (stop, then start) at a fixed interval (default 30 s), as `maintenance-restart.sh` does, but targeting Nomad.
- After each batch, waits and evaluates the gates in G1–G4 below.
- Halts on any breach. Never continues past a failed gate.

The script must refuse to run unless `HEROBIDS_ENV` is set explicitly. It must print the resolved SSH key and target IP before doing anything.

## Phases

### Phase 0 — Preconditions and tooling

Goal: make the environment safe to operate.

- [ ] Confirm identity of `herobids-staging-agent-2` and `-3` (Hetzner console, ED25519 fingerprint). Record it in the rollout log.
- [ ] Align Nomad versions on existing staging nodes, or record the difference as a known risk.
- [ ] Move `browser-pool` off `agent-3` (or accept its drain) before any node work.
- [ ] Make `_ssh_opts.sh` fail when `HEROBIDS_ENV` is unset and a script uses SSH directly. Scripts that take `--env` keep working.
- [ ] Add a Nomad-aware check to the restart flow: count agent jobs by Nomad status, not Docker containers.
- [ ] Confirm whether agent workspace state (`/workspace`) survives a relaunch on another node. If not, wave relaunches lose user-visible state, and the wave design must change first.

**Exit:** all items checked, or each open item has a written decision.

### Phase 1 — Code, dark

Goal: ship code that changes nothing until the flag is turned on.

- [ ] Add `sandboxCaps` config with defaults (`enabled: false`, `agentIds: []`).
- [ ] Update `buildNomadJobSpec` per D2.
- [ ] Unit tests:
  - Flag off: no `cap_add`, no constraint (matches v0.8.9 output exactly).
  - Flag on, agent in set: `cap_add` and constraint present.
  - Flag on, agent not in set: no `cap_add`, no constraint.
  - Constraint value comes from `sandboxCaps.nodeClass`.
- [ ] Keep the fault-text change (already on `main`).
- [ ] Run the affected worker suites, then `tsc --noEmit`.

**Exit:** tests pass; flag-off output is byte-identical to v0.8.9 for a sample launch config.

### Phase 2 — Infrastructure

Goal: build the new node class without touching the old one.

- [ ] Add `node_class` variable to cloud-init. Default `agent`.
- [ ] Add `allow_caps` (default list + `net_admin`, `sys_admin`) only when `node_class == "agent-caps"`.
- [ ] Add a Terraform server group for `agent-caps`, separate from the existing group. Its `server_name` / `node_pool` must be distinct.
- [ ] Pin the Nomad version (D4).
- [ ] `terraform plan` on staging shows **only** new resources. No change to existing agent nodes.

**Exit:** plan reviewed; no changes to existing nodes.

### Phase 3 — Canary node and canary job

Goal: prove the node class works before any agent uses it.

- [ ] Create one `agent-caps` node with `scale-out.sh`-equivalent Terraform apply.
- [ ] Verify node identity and Nomad version. Record in rollout log.
- [ ] Submit a test job (not an agent) to that node with the cap request and constraint. It must reach `running`.
- [ ] Inside the test container, `grep CapEff /proc/self/status` includes the `NET_ADMIN` and `SYS_ADMIN` bits.
- [ ] Run the sandbox probe (`sandbox-exec.sh true`) inside the container. It must exit 0.

**Exit:** test job runs; both checks pass; test job is removed.

### Phase 4 — One agent (canary wave)

Goal: prove an agent boots and the sandbox works end to end.

- [ ] Set `sandboxCaps.enabled: true` and `agentIds: [<one test agent>]` on staging.
- [ ] Restart the worker. Relaunch that one agent.
- [ ] Gates (all must pass within 15 minutes):
  - G1 Boot: first heartbeat within `placedStartTimeoutMs` (120 s).
  - G2 Sandbox: one `execute_shell` call returns success, with no `sandbox_infrastructure_error`.
  - G3 Placement: job placed on an `agent-caps` node.
  - G4 Errors: no new `agent-health-monitor` deadline warnings for that agent.

**Exit:** all four gates pass. Failure = stop, roll back (see Rollback), and file a bug report.

### Phase 5 — Waves

Goal: move agents to the new class in controlled steps.

| Wave | Share of agents | Hold before next wave | Notes |
|---|---|---|---|
| W1 | 1 agent | 1 h | Phase 4 |
| W2 | 5 agents or 5% | 1 h | Mix of agent types |
| W3 | 20% | 2 h | |
| W4 | 50% | 4 h | |
| W5 | 100% | — | Final gate before Phase 6 |

Per wave, the rollout script:

1. Adds the wave's agent IDs to `sandboxCaps.agentIds`.
2. Restarts the worker once.
3. Relaunches each wave agent, 30 s apart.
4. Evaluates gates across the whole wave:
   - **G1 Boot success ≥ 95%** within the boot window. Any agent that misses it counts as a failure.
   - **G2 Sandbox success ≥ 95%** on the first `execute_shell` / `execute_code` call per agent.
   - **G3 Placement failures = 0** (`check-placement-failures.sh` in observer mode).
   - **G4 No `sandbox_infrastructure_error`** in the platform fault stream.
5. Stops on any breach. Waits for a human decision before continuing.

Capacity check before each wave: free capacity on `agent-caps` nodes ≥ wave size + 20% headroom. If not, scale `agent-caps` first.

### Phase 6 — Drain and retire the old class

Goal: make `agent-caps` the only class in use, then remove the old nodes.

- [ ] After W5 passes and holds for 24 h, drain one old node at a time with `nomad node drain`.
- [ ] After each drain, confirm no agent is placed on it and placement failures stay at 0.
- [ ] Remove drained nodes with `scale-in.sh` (respecting `scale-in-guard.sh`).
- [ ] Keep at least one old node until the rollback window closes (Phase 7).

### Phase 7 — Production

Repeat Phases 2–6 for production, **only after** staging has held for at least 7 days across two deploys.

- [ ] Separate approval for each wave.
- [ ] Production wave sizes start smaller (W1 = 1 agent, W2 = 2%).
- [ ] Rollback window of 7 days before old nodes are removed.

## Rollback

Fastest to slowest:

1. **Flag off.** Set `sandboxCaps.enabled: false` (or empty `agentIds`) and restart the worker. New launches go back to the old class. Takes minutes. Does not stop running agents; relaunch them with the rollout script in `--rollback` mode.
2. **Scale old class back up.** If the old class was scaled in, use `scale-out.sh` to restore capacity.
3. **Revert code.** Only if the flag path itself is broken. Use `git revert` on `main` and deploy with `push.sh`.

Rollback must not require a live-node edit.

## Observability

- Per-wave dashboard or log summary: boot success, sandbox success, placement failures, deadline expiries.
- Log every gate result to the rollout log with timestamp, wave, and agent IDs.
- Alert if any agent is placed on a node whose `node_class` is not in the allow-list (should be impossible; treat as a bug).

## Testing

| Level | What | Where |
|---|---|---|
| Unit | Job spec with flag on/off; constraint value; cap list | `nomad-runtime-adapter.test.ts` |
| Unit | Gate evaluation logic (thresholds, halting) | rollout script tests |
| Integration | Test job on `agent-caps` canary node | staging |
| End-to-end | One agent, then a 5-agent wave | staging |
| Load | Simulated 1,000-agent wave plan against the gate logic (dry-run, no real launches) | local |

## Acceptance criteria

- [ ] Flag-off launches are identical to v0.8.9.
- [ ] Every cap-requesting job is scheduled only on `agent-caps` nodes.
- [ ] Every node in the `agent-caps` class has a recorded identity and Nomad version.
- [ ] Staging W1–W5 completed, with every gate recorded.
- [ ] Zero `sandbox_infrastructure_error` in staging for 7 days after W5.
- [ ] Rollback tested on staging (flag off → agents back on old class) before W1.
- [ ] Runbook updated: the rollout script replaces the manual restart for sandboxed agents.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Node config drift again (cloud-init applies to new nodes only) | High without this plan | High | Separate class; allow-list only on `agent-caps`; identity and version recorded |
| Cap job lands on an old node | Medium | High (boot failure) | Constraint on `node.class`; alert on mismatch |
| Boot window too short at scale (image pull, placement queue) | Medium | High | Pre-pull image; wave sizes; 30 s spacing; capacity headroom |
| Workspace state lost on relaunch | Unknown | High | Verify in Phase 0 before any wave |
| Browser-pool disruption on `agent-3` | High if not moved | Medium | Move or drain browser-pool in Phase 0 |
| Operator error (wrong env, wrong key) | Medium | High | `HEROBIDS_ENV` must be explicit; script prints target IP and key |
| Runbook and scripts describe Docker, live system runs Nomad | High | Medium | Phase 0 restart check; runbook update in Acceptance |
| Staging and production drift (Nomad versions, node counts) | Medium | Medium | Pinned versions; Phase 7 only after staging holds |

## Open questions

1. **Node class vs node pool.** Plan uses `node.class` for the constraint. Confirm this is preferred over a Nomad node pool (`NodePool` in the job spec). Nomad 1.9 and 2.1 both support both; pick one.
2. **Workspace persistence.** Does `/workspace` survive a relaunch on a different node? Answer decides whether waves are safe or need a state-migration step.
3. **Gate thresholds.** 95% is a proposal. Confirm, or set per-environment values.
4. **Approval.** Who approves each wave? Proposal: one named operator per wave, with a second for production.
5. **Long-term alternative.** Can the sandbox avoid `SYS_ADMIN` (for example, egress control via iptables owner rules, which need only `NET_ADMIN`)? If yes, this plan's risk profile improves and the node class may be unnecessary. Worth a separate evaluation, not a blocker here.
6. **Existing agents with the old image.** Confirm the agent image tag strategy (`latest` vs `sha-<commit>`) so each wave runs a known image.
