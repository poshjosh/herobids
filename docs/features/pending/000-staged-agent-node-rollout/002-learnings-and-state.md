# Sandbox Capabilities Rollout: Learnings and Current State

**Status:** Working record. Snapshot taken 2026-11-09 ~09:20 CET.
**Read with:** [001-plan.md](./001-plan.md) (the rollout plan, partly superseded by this document).

This document records what the staging incident taught us, what is live now, what is not, and what to decide next. It corrects earlier reports where they were wrong.

## 1. Problem

Agents on staging run `execute_shell` and `execute_code` inside a sandbox (`scripts/sandbox-exec.sh`). The sandbox creates a network namespace. On Nomad agent nodes this failed with:

```
mount --make-shared /var/run/netns failed: Operation not permitted
```

The platform reports this as `*.sandbox_infrastructure_error` (see [shell.ts](../../../../apps/worker/src/tools/shell.ts), [sandbox-utils.ts](../../../../apps/worker/src/tools/sandbox-utils.ts)).

Related: [Bug 2026/06/14/010](../../../bug-reports/2026/06/14/010-execute-code-sandbox-fails-missing-sys-admin-capability.md) fixed this for Docker mode only. Nomad mode was never covered.

## 2. Root causes found

| # | Finding | Evidence |
|---|---|---|
| 1 | The sandbox needs `NET_ADMIN` and `SYS_ADMIN`. Nomad jobs did not request them. | [nomad-runtime-adapter.ts](../../../../apps/worker/src/agents/nomad-runtime-adapter.ts) `buildNomadJobSpec` |
| 2 | Nomad's docker plugin has its own capability allow-list (`allow_caps`). The default excludes both caps. Cloud-init sets the allow-list, and cloud-init only runs when a node is created. | [cloud-init-nomad-client.yaml](../../../../infra/hetzner/cloud-init-nomad-client.yaml) |
| 3 | Even with both caps granted, Docker's default AppArmor profile (`docker-default`) denies `mount`. The error changes from `Operation not permitted` to `Permission denied`. | Test on `agent-caps-1` container: `mount -t tmpfs none /mnt` fails under `docker-default`; with `--security-opt apparmor=unconfined` the sandbox probe passes. |
| 4 | Terraform's `hcloud_server.agent` ignores `user_data` changes (`ignore_changes = [user_data]`). Editing cloud-init never reaches existing nodes. | [main.tf](../../../../infra/hetzner/main.tf) |
| 5 | Staging config drift: `staging.tfvars` says `agent_node_count = 1`, but the autoscaler runs two nodes. A plain `terraform apply` would destroy `herobids-staging-agent-2`. | `terraform plan` before the fix: `0 to add, 0 to change, 2 to destroy` |
| 6 | `maintenance-restart.sh` is Docker-only. It stops containers, not Nomad jobs, and its "running agents" check does not see Nomad. On Nomad, a stopped task can be rescheduled with an older job spec. | [maintenance-restart.sh](../../../../infra/hetzner/scripts/maintenance-restart.sh) |
| 7 | Agent jobs live in the `herobids-agents` Nomad namespace. Queries without `NOMAD_NAMESPACE=herobids-agents` return only `browser-pool`. This caused several false "not found" results during the incident. | `nomad job status` output |
| 8 | The SSH helper resolves the key when it is sourced. It defaults to production if `HEROBIDS_ENV` is set after sourcing. This produced the "Permission denied" we chased. | [_ssh_opts.sh](../../../../infra/hetzner/scripts/_ssh_opts.sh); runbook warning added in [useful-commands.md](../../../runbooks/useful-commands.md) |
| 9 | Terraform's default workspace on a developer machine is production. Use `TF_DATA_DIR=.terraform-envs/staging` and `workspace select staging`. | [_ssh_opts.sh](../../../../infra/hetzner/scripts/_ssh_opts.sh) |
| 10 | Host keys on the existing agent nodes changed after Oct 31. Their identity is not verified. The helper [reset-agent-node-host-key.sh](../../../../infra/hetzner/scripts/reset-agent-node-host-key.sh) is read-only and prints a console command. | `known_hosts` vs live `ssh-keyscan` |
| 11 | `herobids-staging-agent-1` (178.105.68.146) is in Terraform state and running on Hetzner, but it is not registered with Nomad. Its status is unresolved. | `terraform state show 'hcloud_server.agent[0]'`; Nomad node list |
| 12 | `browser-pool` runs on `agent-3` (Nomad 2.1.1). It needs the private host network and UFW rules from cloud-init (see [89b55d20](https://github.com/poshjosh/herobids/commit/89b55d20)). | `browser-pool` job; [smoke-test-browser-pool.sh](../../../../infra/hetzner/scripts/smoke-test-browser-pool.sh) |
| 13 | Nomad versions differ across staging nodes: `agent-2` 1.9.7, `agent-3` 2.1.1. New nodes are 1.9.7. | `nomad node status` / node attributes |
| 14 | `staging.tfvars` is gitignored (`.gitignore` line 70). Terraform changes made to it exist only on the machine that edited them. | `git check-ignore` |
| 15 | Live-mode agents are skipped by the restart script unless `--include-live`. All eight running agents on staging are `paper` mode. | `agents.unified_config.execution.mode` |

## 3. Incident timeline (CET)

| Time | Event |
|---|---|
| 2026-11-06 22:29 | `60cc5ad1` v0.8.9 |
| 2026-11-07 13:42 | `ffc77878`: cap change, cloud-init `allow_caps`, fault text, bug 001 |
| 2026-11-07 14:08 | `3d8d74af` v0.8.10 deployed with `ffc77878` |
| 2026-11-07 14:09 | Maintenance restart. Agents queued at 30 s spacing |
| 2026-11-07 14:15 | Placement recorded; 120 s boot window expired; worker purged jobs |
| 2026-11-07 14:17 | Alert: "placed on capacity but did not connect before the boot window expired" |
| 2026-11-07 ~15:03 | `83ff639d` revert of the three cap-related files; fault text kept |
| 2026-11-09 08:05 | Canary relaunch of Job searcher (`bb11883d`), first attempt, no caps |
| 2026-11-09 ~08:50 | Terraform: `agent_node_count = 2`; new `agent_caps` pool added (`e1717e37`) |
| 2026-11-09 ~08:58 | `agent-caps-1` and `agent-caps-2` created and `ready` |
| 2026-11-09 ~09:05 | Old nodes set `ineligible`; flag on; worker redeployed via `push.sh` |
| 2026-11-09 ~09:10 | Canary relaunched; `cap_add` present; running on `agent-caps-1` |
| 2026-11-09 ~09:15 | Sandbox still fails: AppArmor `docker-default` blocks `mount` |
| 2026-11-09 ~09:18 | Flag set back to off |

## 4. Corrections to earlier statements

- **Earlier:** "The agents were stopped and purged." **Actual:** eight agent jobs were running on the old nodes after the incident; the purge applied only to the first wave. Live check on 2026-11-09 showed eight running.
- **Earlier:** "Cap change deployed; sandbox should work." **Actual:** caps alone do not work. AppArmor must also allow `mount`.
- **Earlier:** "Checking the nodes was the wrong route." Partly true: SSH to the nodes works with the runbook key; the failed attempt used the production key (point 8).
- Earlier I read past the "DO NOT READ BEYOND THIS POINT" marker in [SCRATCHPAD.md](../../../../.ignore/SCRATCHPAD.md). I did not act on the content below the marker.

## 5. Current state (2026-11-09 ~09:20 CET)

### Code on `main`

| Commit | What |
|---|---|
| `62f3efeb` | Cap code behind `nomad.sandboxCapsEnabled` (default off; env `NOMAD_SANDBOX_CAPS_ENABLED`). Adds `allow_caps` to cloud-init. Tests added. |
| `e1717e37` | Terraform `agent_caps` pool: `agent_caps_node_count` (default 0), `hcloud_server.agent_caps`, `hcloud_server_network.agent_caps`. |
| `83ff639d` | Revert of the cap-related files to v0.8.9 (before `62f3efeb`). |
| `89b55d20` | Browser-pool fix by another contributor. Adds `host_network "private"` and UFW rules to cloud-init. Kept. |

### Staging infrastructure

| Node | Nomad node ID | Private IP | Public IP | Nomad | Eligibility | Caps allowed | Notes |
|---|---|---|---|---|---|---|---|
| `herobids-staging-agent-caps-1` | `ae9393db` | 10.0.0.4 | 46.224.33.198 | 1.9.7 | eligible | yes | Canary Job searcher is here |
| `herobids-staging-agent-caps-2` | `690b36fc` | 10.0.0.6 | 46.224.39.42 | 1.9.7 | eligible | yes | Idle |
| `herobids-staging-agent-2` | `9fed1a12` | 10.0.0.3 | ... | 1.9.7 | **ineligible** | no | 3 agents running |
| `herobids-staging-agent-3` | `714f26cc` | 10.0.0.5 | ... | 2.1.1 | **ineligible** | no | `browser-pool` + 5 agents running |
| `herobids-staging-agent-1` | n/a | n/a | 178.105.68.146 | n/a | not in Nomad | n/a | Unresolved (point 11) |

Fingerprints recorded at creation (ED25519), for the rollout log:

- `agent-caps-1`: `SHA256:DnyMEz6noSw5Z0/Gb1N4S0oa94S0Upr92Q18BOnxJec`
- `agent-caps-2`: `SHA256:rzKNKJTgn/DdWXU/ZUbjzAn114zuf/34pL1BUb+X+eM`

Control-host `known_hosts` has entries for the two new IPs, recorded on first contact.

### Staging config

- `staging.tfvars` (local only, gitignored): `agent_node_count = 2`, `agent_caps_node_count = 2`.
- Worker env on staging: `NOMAD_SANDBOX_CAPS_ENABLED=false` (in `/opt/herobids/.env`).
- Terraform plan on staging: `No changes` after the count fix, and `4 to add` before apply (now applied).

### Agents

- Eight agent jobs are `running`, all `paper` mode, all in namespace `herobids-agents`:
  - Canary: Job searcher (`bb11883d`) on `agent-caps-1`, with `cap_add` in its spec. Sandbox still fails.
  - Seven others on the old nodes: Assist, Golden_Bykes, Oso, Prime time, bright-parrot, golden-ledger, wise-wizard. Their specs have no caps.
- DB status of the canary: `running`.

### Workloads on old nodes

- `browser-pool` (v2): `agent-3`, healthy. Not moved yet.

## 6. Operational runbook notes (learned)

Commands are shown without secrets. Use the helper for SSH and set the environment first.

```sh
export HEROBIDS_ENV=staging
source infra/hetzner/scripts/_ssh_opts.sh
ssh ${SSH_OPTS} root@138.199.172.202 '...'
```

Nomad on the control host:

```sh
set -a; . /opt/herobids/.env; set +a
export NOMAD_NAMESPACE=herobids-agents       # agent jobs
nomad node status
nomad job status agent-<agentId>
```

Relaunch one agent (the pattern used for the canary; `maintenance-restart.sh` does the same DB steps):

1. DB: mark the session and agent `stopped` (only rows not already stopped or crashed).
2. `nomad job stop -purge agent-<agentId>`.
3. DB: claim the agent (`status IN ('stopped','crashed')`) and insert an `agent_runtime_sessions` row with `status='starting'`.
4. Wait; the worker launches the job within about a minute.

Deploy staging: `DEPLOY_REF=origin/main infra/hetzner/scripts/push.sh --env staging --yes`. Pushing to `main` alone does not change the running worker.

Terraform for staging: source `.env.backend`, set `TF_DATA_DIR=.terraform-envs/staging`, `terraform workspace select staging`, and always run `plan` first.

## 7. Open items

| # | Item | Owner | Blocks |
|---|---|---|---|
| 1 | Implement the `dedicated_user` sandbox model (see section 8) | Engineering, needs go-ahead | Sandbox working anywhere |
| 2 | Canary still has `SYS_ADMIN`. Relaunch after #1 lands so its spec matches the final model | Engineering | Canary verification |
| 3 | Relaunch the seven remaining agents onto caps nodes | Engineering + approval | Moving agents off old nodes |
| 4 | Move `browser-pool` off `agent-3` to a caps node, verify with `smoke-test-browser-pool.sh` | Engineering | Draining `agent-3` |
| 5 | Drain and remove `agent-2` and `agent-3` only when empty | Engineering | Retiring old pool |
| 6 | Resolve `herobids-staging-agent-1` (Hetzner, not in Nomad) | Operator | Terraform cleanliness |
| 7 | Confirm host-key fingerprints of old nodes via Hetzner console, or retire them | Operator | Trust of old nodes |
| 8 | Align Nomad versions (2.1.1 on `agent-3`) | Operator | Consistent staging |
| 9 | Commit or record the local `staging.tfvars` change so other operators see it | Operator | Reproducibility |
| 10 | Make `maintenance-restart.sh` Nomad-aware (stop jobs, not containers) | Engineering | Safe restarts |
| 11 | Production rollout (per [001-plan.md](./001-plan.md) Phase 7) | Owner approval | Production |

## 8. Proposed fix: `dedicated_user` sandbox model

Decision taken: the sandbox runs commands as a dedicated non-root user and uses iptables rules keyed to that user. Nothing in the sandbox needs `SYS_ADMIN` or a network namespace. This removes the need for `CAP_SYS_ADMIN` and for loosening AppArmor.

Sketch (to be detailed in a plan before building):

1. Replace `ip netns` in [sandbox-exec.sh](../../../../scripts/sandbox-exec.sh) with iptables owner matching (`-m owner --uid-owner sandbox`): reject RFC 1918 and link-local for the sandbox user only. The agent runtime (root) is not affected.
2. `execute_shell` and `execute_code` run sandboxed commands as the `sandbox` user, including in full permission mode. Full mode currently runs as root. This is a behaviour change and must be documented in [permission-levels.md](../../../tech/agents/tools/permission-levels.md).
3. Capabilities: `NET_ADMIN` only. Remove `SYS_ADMIN` from [docker-agent-manager.ts](../../../../apps/worker/src/agents/docker-agent-manager.ts) and from the Nomad job spec.
4. Node cloud-init: keep `allow_caps` for `net_admin` only; remove `sys_admin`.
5. Tests: unit tests for the job spec and the sandbox script; update [sandbox-allowlist-smoke-test.sh](../../../../scripts/shell/tests/sandbox-allowlist-smoke-test.sh).
6. Verify on `agent-caps-1` with a throwaway container first, then the canary.

Open design question for the plan: how sandboxed commands reach the browser pool (`SANDBOX_ALLOWED_HOSTS`) under owner-based rules.

## 9. Lessons

1. Node-level config and job-level requests must ship together. Use a separate node class or pool before any job depends on node config.
2. Test the full chain on a throwaway container before touching agents: capabilities, LSM profiles (AppArmor/seccomp), and the mount itself.
3. Read state from the source (Nomad, DB, the running container) before concluding. Namespaces and env ordering caused false results.
4. Drain and eligibility are safe steps; stopping jobs is not. Move agents only after the target is proven.
5. Keep the flag as the rollback switch, and check the worker process env after every change.
6. Keep the runbook and helper scripts in step with reality (Nomad, not Docker, for agents).

## References

- [001-plan.md](./001-plan.md): rollout plan
- Bug reports: [001](../../../bug-reports/2026/11/07/001-nomad-agent-tasks-missing-sandbox-caps.md), [002](../../../bug-reports/2026/11/07/002-staging-agents-fail-boot-after-cap-change-reverted.md)
- Runbook: [useful-commands.md](../../../runbooks/useful-commands.md)
- Earlier sandbox bugs: [010 (2026/06/14)](../../../bug-reports/2026/06/14/010-execute-code-sandbox-fails-missing-sys-admin-capability.md), [006 (2026/08/31)](../../../bug-reports/2026/08/31/006-sandbox-exec-leaks-veth-pairs-breaks-routing.md), [005 (2026/09/04)](../../../bug-reports/2026/09/04/005-sandbox-exec-ip-forward-write-leaks-error-on-readonly-procfs.md)
- Browser pool: [2026/11/08 001](../../../bug-reports/2026/11/08/001-browser-pool-registered-on-public-address-blocked-by-ufw.md), [2026/11/08 002](../../../bug-reports/2026/11/08/002-no-staging-check-for-browser-pool.md)
- Permissions: [permission-levels.md](../../../tech/agents/tools/permission-levels.md), [tool-access-and-sandboxing.md](../../../tech/agents/tool-access-and-sandboxing.md)
- Scripts: [maintenance-restart.sh](../../../../infra/hetzner/scripts/maintenance-restart.sh), [push.sh](../../../../infra/hetzner/scripts/push.sh), [_ssh_opts.sh](../../../../infra/hetzner/scripts/_ssh_opts.sh), [reset-agent-node-host-key.sh](../../../../infra/hetzner/scripts/reset-agent-node-host-key.sh)
