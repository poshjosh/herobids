# Agent Runtime Rollout Guide

This guide covers how to change and roll out anything that affects where agent runtimes run, what they are allowed to do, or how they are started. Examples: Nomad job specs, node capabilities, sandbox requirements, node pools, and worker configuration that changes job launches.

It complements [Tool Access And Sandboxing](./tool-access-and-sandboxing.md), which is the canonical policy for sandbox behaviour. It also applies [Infra lessons](../../../infra/hetzner/docs/auto-scaling/lessons-learnt.md) and [Docker conventions](../../best-practices/docker.md).

For the incident that produced this guide, see [002-learnings-and-state.md](../../features/pending/000-staged-agent-node-rollout/002-learnings-and-state.md). The rollout plan is [001-plan.md](../../features/pending/000-staged-agent-node-rollout/001-plan.md).

## 1. Principles

1. **Node configuration first, job requests second.** A job must never request something that a node does not yet allow. Ship the node change, prove it, then ship the job change.
2. **Ship dark.** New runtime behaviour sits behind a config flag that defaults to off. Deploying the code must change nothing.
3. **Prove the full chain on one target before touching agents.** The chain is node config, scheduler placement, container capabilities, LSM profile, and the tool itself.
4. **Read state from the source.** Check Nomad, the database, and the running container. Do not rely on memory or on a single wrapper script's summary.
5. **Keep a fast rollback.** The flag is the rollback path. Know the command before you start.
6. **Make steps reversible.** Eligibility changes and drains are reversible. Stopping jobs and destroying nodes are not, so do those last and only after the replacement is proven.

## 2. Sandbox requirements

The sandbox (`scripts/sandbox-exec.sh`) creates a network namespace. Creating one needs more than a capability grant:

| Requirement | Why | How to check (inside the container) |
|---|---|---|
| `CAP_NET_ADMIN` | iptables rules for allow and deny lists | `grep CapEff /proc/self/status` (bit 12) |
| `CAP_SYS_ADMIN` | `ip netns add` mounts `/var/run/netns` | `grep CapEff /proc/self/status` (bit 21) |
| LSM profile allows `mount` | Docker's default AppArmor profile (`docker-default`) denies `mount` even with `CAP_SYS_ADMIN` | `cat /proc/1/attr/current` should not be `docker-default`, or `mount -t tmpfs none /mnt` must succeed |
| Seccomp allows the syscalls | Docker's default seccomp profile allows them only when `CAP_SYS_ADMIN` is present | `grep Seccomp /proc/self/status` |

Lessons:

- **Granting a capability is not enough.** The first symptom changed from `Operation not permitted` (missing capability) to `Permission denied` (LSM denial). Read the error text as a clue.
- **Do not weaken the LSM profile to make a tool work.** Unconfined AppArmor on agent containers removes a control that protects against model-generated code. Treat it as a security decision, not a config fix.
- **Prefer designs that need fewer capabilities.** Avoid `SYS_ADMIN` where a user-based or cgroup-based rule can do the job. Track the target design in [tool-access-and-sandboxing.md](./tool-access-and-sandboxing.md).

Until the sandbox design is changed, sandboxed execution does not work on Nomad agent nodes. Do not treat a green deploy as proof that sandboxing works.

## 3. Nomad rules

- **Node config is per node.** The docker plugin's `allow_caps` (and similar settings) lives on each Nomad client. Cloud-init applies only when a node is created. Editing a template does not change existing nodes.
- **Node classes or pools separate capability sets.** When a job needs a capability that only some nodes allow, place it on a dedicated node class or pool with a scheduler constraint. Do not rely on every node being equivalent.
- **Match Nomad versions.** Keep client versions identical within a pool. Mixed versions (1.9.x and 2.x) make behaviour hard to reason about.
- **Eligibility before drain.** Use `nomad node eligibility -disable <id>` to stop new placements without moving anything. Use `nomad node drain` only when you are ready to move running work.
- **Check the namespace.** Agent jobs run in `herobids-agents`. Queries without `NOMAD_NAMESPACE=herobids-agents` will miss them and can look like missing jobs.
- **Rescheduling can resurrect old specs.** Stopping a task can make Nomad reschedule it with an earlier job spec. For agent jobs, stop with `nomad job stop -purge` and let the worker launch a fresh job. Verify the spec afterwards with `nomad job inspect`.
- **Pre-pull images.** New nodes should have the agent image before they receive agents. A cold pull can exhaust the boot window (120 s by default, `placedStartTimeoutMs`).
- **Boot window is a fail-safe, not a retry.** When the window expires, the worker purges the job. A rollout that starts many agents at once can fail all of them the same way.

## 4. Terraform rules

- **Always set the environment's data dir.** Use `TF_DATA_DIR=.terraform-envs/<env>` and `terraform workspace select <env>`. Never run from the shared `.terraform/` dir. The default workspace on a developer machine can be production.
- **Plan before any apply, and read the plan.** The plan must show exactly the resources you expect. A destroy in a plan you did not intend is a stop signal.
- **Reconcile counts with reality first.** If an autoscaler changes a count at runtime, the variable file can drift from live state. A plan then shows a destroy. Align the count (a no-change plan), then make the next change.
- **`ignore_changes` on `user_data` is deliberate.** It protects live agents from template edits. Use `terraform apply -replace` or a new resource group to roll new config to existing nodes.
- **Add new capacity as new resources.** A separate resource group with its own names lets old and new nodes run side by side. Index-based names (`agent-1`, `agent-2`) cannot coexist with a rebuilt pool of the same names.
- **Variable files can be gitignored.** A change to a gitignored `*.tfvars` exists only on the machine that made it. Record it in the rollout log, or move it to a committed example.

## 5. Access and secrets

- **Source the SSH helper after setting the environment.** `HEROBIDS_ENV` must be set before `source infra/hetzner/scripts/_ssh_opts.sh`. Otherwise the production key is used, and staging returns `Permission denied`.
- **Never accept a changed host key blindly.** When a host key changes, confirm the new fingerprint through a trusted channel (for example, the provider console or a fresh node you created). Use [reset-agent-node-host-key.sh](../../../infra/hetzner/scripts/reset-agent-node-host-key.sh) to read the fingerprint, and do not overwrite `known_hosts` silently.
- **A console login is not needed for most work.** Hetzner's server console asks for the root password. Resetting it reboots the server. Prefer SSH with the deploy key, or create new nodes whose keys you control.
- **Do not reuse production credentials on staging.** Use the environment's own tfvars and env files.

## 6. Rollout procedure

Use this order. Do not skip a step because the previous one "looked fine".

1. **Write the plan.** Create a feature plan in `docs/features/` with the gates, the rollback, and the owner of each step.
2. **Ship code dark.** Flag defaults to off. Tests cover flag-off output being identical to the previous behaviour.
3. **Prepare the node class.** Add the new pool in Terraform as new resources. Plan and read the plan.
4. **Create one node.** Record its identity (ID, private and public IP, ED25519 fingerprint, Nomad version, `allow_caps`) in the rollout log.
5. **Prove the chain on the node.** Run a throwaway container with the same image, capabilities, and security options. Check the capability bits, the LSM profile, and the probe command. Only then move on.
6. **Canary one agent.** Turn the flag on for one agent. Verify placement, boot within the window, one `execute_shell` success, and no `sandbox_infrastructure_error`.
7. **Move the rest.** Relaunch agents in small groups with spacing. After each group, check placement and heartbeat in the database and the worker logs.
8. **Drain and retire the old pool last.** Set eligibility to ineligible, move the remaining work (for example, `browser-pool`), verify it is healthy, and only then remove nodes.
9. **Record the outcome.** Update the bug report and the rollout log. Note the flag state and the image tag.

## 7. Agent relaunch

Relaunch uses database state and Nomad jobs together. Doing one without the other causes confusion.

1. Mark the session and agent `stopped` in the database, skipping rows already `stopped` or `crashed`.
2. Stop the Nomad job: `nomad job stop -purge agent-<agentId>` (namespace `herobids-agents`).
3. Claim the agent (`status IN ('stopped','crashed')`), set it to `starting`, and insert an `agent_runtime_sessions` row with `status='starting'`.
4. Wait for the worker to launch the job. Check the job spec (`nomad job inspect`), the allocation node, and the session status.

[maintenance-restart.sh](../../../infra/hetzner/scripts/maintenance-restart.sh) implements the same database steps, but its container stop is Docker-only. Do not use it for Nomad agents until it is made Nomad-aware.

Skip live-mode agents unless the owner approves. Check `agents.unified_config.execution.mode` first.

## 8. Verification checklist

For each target (node, canary, then the group):

- [ ] Node: `nomad node status` shows `ready`, the intended eligibility, and the expected class.
- [ ] Node: identity and version recorded.
- [ ] Node: docker plugin allows the required capabilities (check the live config, not the template).
- [ ] Job: `nomad job inspect` shows the expected `cap_add` and constraints.
- [ ] Allocation: running on the intended node.
- [ ] Container: capability bits and LSM profile as in section 2.
- [ ] Sandbox: probe succeeds, and an agent `execute_shell` call returns without `sandbox_infrastructure_error`.
- [ ] Worker: flag value from the running process (`printenv` in the container), and no new error spikes in logs.
- [ ] Database: session status `running`, heartbeat recent.

## 9. Anti-patterns

- Shipping a job change that depends on node config that has not been rolled out.
- Treating "deployed" as "working". Verify the running container and the running job.
- Editing live nodes by hand, or changing `known_hosts` to get past a failure.
- Running Terraform in the shared default workspace.
- Applying a plan that destroys nodes without reading it.
- Stopping jobs by hand without updating the database.
- Weakening a security profile to make a tool pass, without a recorded decision.
- Letting a wrapper script's "running count" stand in for the real state.

## References

- [Tool Access And Sandboxing](./tool-access-and-sandboxing.md): sandbox policy and requirements
- [Agent Runtime Boundary And Message Contract](./runtime-boundary-and-message-contract.md)
- [Docker conventions](../../best-practices/docker.md)
- [Infra lessons](../../../infra/hetzner/docs/auto-scaling/lessons-learnt.md)
- [Incident learnings](../../features/pending/000-staged-agent-node-rollout/002-learnings-and-state.md)
- [Rollout plan](../../features/pending/000-staged-agent-node-rollout/001-plan.md)
- [Permission levels](./tools/permission-levels.md)
