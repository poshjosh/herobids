# Agent-node drift note (staging, 2026-10-31)

Gate 1 of `000-roadmap.md` (steps 1–3). Plan reference: `001-safe-capacity-expansion-plan.md`.
Scope: staging only. Production was not touched.

## What drifted

| Layer | Before 2026-10-31 | After |
|---|---|---|
| Hetzner | `herobids-staging-agent-1` (173706055), `-agent-2` (173705990) | `-agent-1` = former agent-3 (173731633, 178.105.68.146, private 10.0.0.5). Both old servers deleted. |
| Terraform state (`staging` workspace) | `agent[0]`, `agent[1]` | `agent[0]` only, bound to server 173731633 |
| Nomad | `agent-1`, `agent-2` ready | `herobids-staging-agent-1` ready and eligible. Old `agent-1`/`agent-2` entries are `down`, not purged. |
| API DB agent rows | Oso (`6f0d6e1b-…`) active | Oso stopped (container kept, owned by a third party). Eight other stopped agents on the operator account. |

## How it happened (root causes)

1. **Unplanned replacement.** A first `apply` replaced agent-1 and created agent-2 without a reviewed plan. Operator error.
2. **cloud-init failure on agent-2.** An unquoted `: ` in `runcmd` broke boot. The node was set up by hand, and agent-1 never registered.
3. **Unmanaged containers.** Six containers on agent-2 hit DB foreign-key errors.
4. **Index-based network attachments.** `hcloud_server_network.agent[count.index]` is positional. A targeted destroy pulled in an unrelated attachment.
5. **cloud-init `init-local` race** on Ubuntu 24.04 / cloud-init 26.1. A `device_driver` TypeError before sysfs settles. `cloud-init clean --reboot` clears it. The fix is not yet in `cloud-init-nomad-client.yaml`.

## Recovery actions taken (2026-10-31)

- Backups on control plane: `/root/recovery-20261031T105800Z/` (`agent-2-alloc.tgz`, `terraform.tfstate.json`, `staging.tfvars`). **Keep.**
- Five containers on old agent-2 were stopped (kept, not removed).
- State surgery: removed `agent[0]`/`agent[1]`, moved `agent[2]` to `[0]`. Plan showed 0 add, 1 in-place rename, 0 destroy. Applied.
- Deleted Hetzner servers 173706055 and 173705990 (both now return 404).

## Verification (read-only)

- `terraform plan -var-file=staging.tfvars` (local, staging workspace): **No changes.** Confirms state matches config and the staging Hetzner token is valid.
- Control plane Nomad: one `ready` eligible node, two `down` stale entries.
- Control-plane API healthy (HTTP 200); worker, web, caddy, postgres, redis, skills-api healthy.

## Known open items carried forward

- **Name mismatch.** Nomad shows `herobids-staging-agent-3` for the surviving node while Hetzner shows `-agent-1`. Verify before any write (P9).
- **Stale env.** `BROWSER_POOL_URL` / `AGENT_BROWSER_CDP_URL` in agent containers point at the deleted agent-1 IP.
- **Control-plane `/etc/herobids/autoscale.env`** dated Oct 26, no `HCLOUD_TOKEN`. Regenerate with `setup-autoscale-env.sh`.
- **API image** predates the P-series code (container created 2026-10-30 21:43 UTC).
- **Timers.** `nomad-autoscale.timer` and `nomad-scale-in.timer` enabled, inactive. Enablement is still gated (see `000-roadmap.md`).
- **Cleanup candidates.** `staging.tfvars.bak-20261031T074913Z` and a modified `.terraform.lock.hcl` line on the control plane; `herobids-redis-p8` container (removal needs data-risk review).

## Autoscale pool defect (found and fixed in repo)

- The autoscale units never exported `NOMAD_AUTOSCALE_NODE_POOL`. The guard fell back to `herobids`, found no managed servers, and refused with `empty_inventory` and `ownership_mismatch`. Staging's pool is `herobids-staging`. Fail-closed worked as designed; the config was wrong.
- Repo fix: `cloud-init.yaml` sets the pool for both units on new boots. `converge-control-plane.sh` (step 3c3) writes a `15-autoscale-node-pool.conf` drop-in for existing control planes. Tests added to `test-converge-control-plane.sh`. Local `run-all.sh` exit 0.
- Applied on staging with `setup-control-plane.sh --env staging`. Converge installed the node-pool drop-ins for both units and did not restart Nomad.
- Verified on staging (read-only dry-run): the guard now reads pool `herobids-staging`. `empty_inventory` is gone.

## Remaining scale-out blockers (resolved 2026-10-31; see Resolution)

1. `ownership_mismatch`: control plane `167421976` has labels `app` and `environment` only. The guard counts any owned server that is not `role=agent` as foreign.
2. `orphan_nomad_node`: live Nomad node `herobids-staging-agent-3` (hostname `-agent-3`, public IP 178.105.68.146, 0 running allocations) matches the pool pattern but no cloud server has that name. Hetzner `173731633` (IP 178.105.68.146) is named `herobids-staging-agent-1`. The mismatch came from the earlier state-surgery rename.
3. Stale Nomad `down` entries `herobids-staging-agent-1` and `-agent-2` (not blocking; orphan_down only).

Options under consideration: label the control plane with a non-agent role and teach the guard to ignore it (with tests); match Nomad nodes to cloud servers by IP as well as name, or rename the node's hostname and restart its Nomad client (0 allocations, low workload risk); or replace the node (data-loss review required).

Also observed: `nomad-scale-in.service` has `ENABLE_SCALE_IN=true`. The roadmap requires scale-in to stay off until its scenario passes.

## Gate status

- Gate 1 (drift identified and recorded): **met by this note.**
- Gate 2 (replacement guard implemented and tested): run-all.sh passed locally (24 suites, 0 failed).
- Gate 3 (milestone-1 gates): **not met**. Pending P9 scenarios.

## Resolution (2026-10-31)

- **Ownership (`ownership_mismatch`).** Control plane `167421976` now carries `role=control-plane`. Applied with `provision.sh` (1 changed). The guard ignores `role=control-plane` servers. Branch commit `08cf41b3`.
- **Orphan Nomad node (`orphan_nomad_node`).** Decision: match by IP. Deviation: Nomad `/v1/nodes` reports the private address, so matching uses private IP (not public IP). One `GET /v1/nodes` call is kept. Name OR private-IP match, preferring non-down entries. Tests: `test-capacity-inventory.sh` (123 pass).
- **Name mismatch still open.** Hetzner `173731633` is `herobids-staging-agent-1` and Nomad shows `herobids-staging-agent-3`. Scale-in selects nodes by exact Nomad name, so it skips this node until names match. Fail-safe, not fixed. A live node-identity change needs approval.
- **Scale-in flag.** Decision: keep scale-in OFF on staging (read from the user's "true" answer; not separately confirmed). Cloud-init bakes `ENABLE_SCALE_IN=true` into the unit at first boot, and `user_data` is ignored after that. Fix: converge step 3c4 writes `nomad-scale-in.service.d/16-scale-in-flag.conf` from the Terraform output `enable_scale_in`. Setup fails closed on a non true/false value. Commit `34fc0648`. Tests: `test-converge-control-plane.sh` (316 pass).
- **Terraform output.** A duplicate `enable_scale_in` output was introduced and removed before commit. The existing bool output is kept with a comment.
- **Server sync and converge.** `/opt/herobids` is at `34fc0648` on `feat/safe-capacity-p9-staging`. Leftover `.terraform.lock.hcl` edit and `staging.tfvars.bak-20261031T074913Z` are kept untouched. `setup-control-plane.sh --env staging 138.199.172.202` exit 0. Verified: unit `ENABLE_SCALE_IN=false`, drop-in present, `nomad-scale-in` and `nomad-autoscale` timers enabled but inactive, `nomad` active.
- **Scale-out dry-run.** Passes (exit 0) at `34fc0648`: managed agent nodes 1, max 3, candidate new count 2, no changes. Note: the dry-run needs `/etc/herobids/autoscale.env` and `autoscale-settings.env` sourced as well as the unit `Environment=`. `HCLOUD_TOKEN` is in the env file. Without it the guard refuses with "cloud inventory unavailable". This is expected fail-closed behaviour. The dry-run does not evaluate live capacity thresholds.
- **Production (report only).** Production shares the Hetzner project and token. Its control plane probably has the same missing `role=control-plane` label. Not changed.

## Staging deploy (2026-10-31)

- `deploy.sh --env staging` ran. Its step 4 (`push.sh`) ran `git reset --hard origin/main`, which replaced the server's feature-branch infra scripts with main's. The server stash `stash@{0}` holds the lock-file hash line that reset removed. Recoverable with `git stash pop` on the server.
- Fix: [push.sh](/Users/chinomso.ikwuagwu/dev_ai/herobids/infra/hetzner/scripts/push.sh) takes `DEPLOY_REF` (default `origin/main`). Committed as `02917bc9` on `feat/safe-capacity-p9-staging`.
- Re-deployed with `DEPLOY_REF=origin/feat/safe-capacity-p9-staging`. Server HEAD is `02917bc9`.
- Verified: `herobids-api-1` healthy; migrate exited 0 (its Postgres NOTICEs are not errors); `runtime_registered_at`, `first_placed_at`, `placement_allocation_id`, `startup_failure_reason` exist in `agent_runtime_sessions`; the journal's newest entry is `0089`. Public `https://staging.openaidom.com/api/health` returns 200. Web returns 200.
- Scale-in still `ENABLE_SCALE_IN=false`. Both timers enabled, inactive.
- Scale-out dry-run from the restored branch: exit 0, managed 1, max 3, candidate 2, no changes.
- Nomad: only `browser-pool` job. Agent node `-agent-3` ready, `-agent-1` and `-agent-2` stale `down`. Agents were not restarted.

## Scale-out proof and fixes (2026-10-31, later)

- **Scale-in proven (2 to 1).** Approved. Nine agent jobs on the two extra nodes were stopped through the app's stop path first. Plan: 2 destroys, nothing else. Exit 0.
- **Start of a stopped agent.** `wise-falcon` was started with guarded SQL and landed on the surviving node. The `--start-stopped` restart path was refused: the wrapper fetches the script from `origin/main`, which does not have the flag. Nothing was changed by that attempt.
- **Stale node purge.** The down Nomad entry for `-agent-2` (`65dff029…`) was purged after confirming zero allocations. Approved.
- **Gate fix.** The capacity-aware start gate was OFF on staging. Without it, a placement that failed on a full node made the demand classifier withhold scale-out. Enabled in `config/staging.yaml` (commit `31a00ea3`) and deployed with `DEPLOY_REF=origin/feat/safe-capacity-p9-staging`.
- **Refused run.** The first live scale-out was refused by the drift check (saved plan showed drift; nothing applied). Cause: Terraform state still listed the scaled-in server in `hcloud_firewall.agent[0]`.
- **Firewall-record fix.** Manual fix, approved: a state-only refresh-only apply, then a re-plan with `agent_node_count=2` showed creates only. Code fix in `scale-in.sh` (`scale_in_sync_state`, predicate `scale_in_refresh_plan_ok` in `scale-in-guard.sh`, commit `c34da864`) so the record is synced after each scale-in. Checked 2026-10-31 after deploy: a read-only refresh-only plan on staging reports "No changes". Not yet proven by a real scale-in.
- **Successful add (1 to 2).** Approved. `herobids-staging-agent-2` (10.0.0.3) joined Nomad as ready. The re-queued security-auditor ran on it.
- **Timers.** Approved. `nomad-autoscale.timer` enabled and active, with demand mode on. `nomad-scale-in.timer` enabled with no schedule, so scale-in stays manual. `nomad-placement-failure-watcher.timer` disabled.
- **Settings drop risk.** Neither tfvars set demand mode, so a converge would have re-uploaded the Terraform default `false`. Fix in `variables.tf`, `outputs.tf`, `staging.tfvars`, and `render-autoscale-settings.sh` (commit `c34da864`). Deployed and migrated on staging 2026-10-31 after approval. Verified: demand on, template sizes 3819 and 4000.
- **Test fix.** `test-capacity-readonly.sh` had 3 failing scale-in dry-run assertions, present on this branch since `146baed8`. Cause: the synthetic Nomad nodes have no private address, so the new duplicate-address check refused them. The check is unchanged. The test now gives each synthetic node its own address. The full infra suite passes (`run-all.sh`, exit 0).

## Still open

- Name mismatch (above). Requires approval before any live change.
- Stale Nomad `down` entries `-agent-1` (`db4e22b4-efbd-b70c-d3ca-d0f173da7e55`) and `-agent-2` (`1525bbd6-95d6-d91c-e221-7f9038d000d0`) were **purged** on 2026-10-31 after confirming zero allocations and user approval. Nomad node list now shows only `herobids-staging-agent-3` (`714f26cc`, 10.0.0.5, ready).
- Purge note: `POST /v1/node/<full-36-char-uuid>/purge` (short IDs return 500 "UUID must be 36 characters").
- Capacity blocker: the original sole node had 3.5 of 3.7 GiB allocated, so further agent starts failed with `DimensionExhausted: memory`. **Resolved 2026-10-31** by applying the create-only plan (approved by the user): Hetzner `herobids-staging-agent-2` (cx23, fsn1, private network) was added and joined Nomad as `ready`/`eligible` with 3819 MB and 4000 MHz. Agent starts re-tested on it: yes, `wise-falcon` (see the section above). *(Superseded.)*
- Plan-ordering and provider-lock fixes that made the create-only plan work: `72d74635` (`-var-file` before `-var agent_node_count`), `bfef2f08` (linux_amd64 checksum in the lock file).
- API image predates the P-series code. Deployed 2026-10-31 (see Staging deploy below). Migrations 0088 and 0089 applied.
- P8 live shadow GETs against staging. Single-pass read-only checks ran 2026-10-31 (see the plan's P8 record). The multi-tick demand comparison (§12.2) has not run.
- Timers stay inactive. `000-roadmap.md` and `010-objectives.md` say they stay stopped until the gates pass. The user's earlier "approve turning on the timers" conflicts with this. Not enabled. *(Superseded 2026-10-31: the scale-out timer is now on for staging. See the section above.)*
- Oso (owned by the user's brother) stays stopped. Not started.
- 8 stopped agents on the operator's account are not started.

## Follow-up (2026-10-31, evening)

- **Stale count in the server's tfvars (found, fixed).** Staging's `/opt/herobids/infra/hetzner/staging.tfvars` said `agent_node_count = 1` while two agents ran. A manual `terraform apply -var-file` would have planned to remove the second agent. Permanent fix in `0147f9e5`: scale-out and scale-in record the applied count in the tfvars file after each successful apply (`sync_tfvars_node_count`). Deployed. Approved one-time correction on the server: the line changed from 1 to 2, backup `/root/backups/staging.tfvars-20261031T203558Z`, mode 0600. No Terraform run, no state or node change.
- **Verification.** Read-only refresh-only plan on staging: "No changes". Shell suites for the scale-in guard, tfvars sync, settings renderer, and converge all pass.
- **Not yet proven.** The firewall sync and the tfvars sync have not run after a real scale-in. The next scale-in on staging is the proof.

## Scale-in proof attempt and reversal (2026-10-31, night)

This record covers what happened, not a decision.

- **Stopped session.** The security-auditor session `e193f8e7` was on `-agent-2`. It blocked the drain for about 8 minutes. On your instruction it was stopped: Nomad job `agent-11d3ec90-…` was deleted (eval `1bb6783c`), and the DB session was set to `stopped`. Its work was lost.
- **Demand-off window.** `NOMAD_AUTOSCALE_DEMAND_ENABLED` was set to `false` in `/etc/herobids/autoscale-settings.input` (backup `/root/backups/autoscale-settings.input-20261031T210704Z`) and converged, so scale-in could run.
- **Dry run (21:09).** Selected suffix 2, plan 2 to 1, no changes.
- **Real scale-in, first run (21:09).** Refused with a Terraform state lock error (`Who root@herobids-staging`). No process held the lock, and I did not force-unlock. Nothing changed.
- **Real scale-in, second run (21:10).** Exit 0. Drained `1d7ddf75`, destroyed Hetzner 173827316 (old agent-2), logged "Terraform state synced (agent firewall record)" and "Recorded agent_node_count=1".
- **Reversal (21:10:49Z).** The legacy scale-out saw one node at 94% memory and 0 free slots. Demand was off, so it ran with no cooldown. It created Hetzner 173843852 (new agent-2, 10.0.0.3) and recorded `agent_node_count=2` at 21:11:21. The cluster ended at 2 nodes, and the scale-in did not hold.
- **Root cause (two gaps).**
  1. `scale-in.sh` does not check that the remaining nodes can carry current allocations.
  2. `scale-out.sh` has no cooldown against a scale-in that just finished. Scale-in and scale-out share the lock, but the next timer tick ran two seconds after the lock was released.
  Scale-in also refuses to run while demand mode is on, so the proof can only run with demand off, which re-triggers the legacy scale-out.
- **Restored.** Demand mode was set back to `true` in `/etc/herobids/autoscale-settings.input` (timestamped copy `/root/backups/autoscale-settings.input-restore-*`) and converged, exit 0. The autoscale log now shows the demand-aware path and a cooldown after the scale-out.
- **Stale node purged.** Nomad `1d7ddf75` (down, ineligible, server gone) was purged with `POST /v1/node/<uuid>/purge`, HTTP 200.
- **Replacement joined.** Nomad `61a04027` (`herobids-staging-agent-2`, 10.0.0.3) is ready and eligible. Nomad now lists agent-2 and agent-3 (`714f26cc`, 10.0.0.5).
- **Not proven.** The firewall and tfvars syncs still have not been proven on a real scale-in. The refresh-only plan has not been re-run since the replacement.
- **Stopped-session cleanup.** Nothing was done to the 8 stopped operator agents or the Oso agent.

### Code fixes for the two gaps (2026-10-31, night, uncommitted)

- **Gap 1, remaining capacity.** `scale-in.sh` now reads the Nomad snapshot (`check-nomad-capacity.sh --bins-json`) and counts the free slots the remaining nodes would have. If that is below `NOMAD_SCALE_OUT_SLOT_THRESHOLD` (default 3), it logs "Scale-in deferred" and exits 0 with nothing deleted. The check runs before the dry-run exit and before any drain. The count is `scale_in_remaining_slots` in `scale-in-guard.sh`.
- **Gap 2, cooldown.** After a successful scale-in apply, `scale-in.sh` writes the scale-out cooldown stamp (`touch_cooldown`), before the state sync. A failure to write it only logs a warning.
- **Tests.** `test-capacity-scale-in-guard.sh` (19 pass: slot arithmetic and ordering). `test-capacity-readonly.sh` (its `check-nomad-capacity.sh` stub now answers `--bins-json`; new case: a scale-in with no remaining capacity defers and changes nothing). Full `run-all.sh` passes with zero failures.
- **Status (2026-10-31, 22:00Z, read-only checks).** The fixes are committed in `8b41b2a4` on `feat/safe-capacity-p9-staging`. Staging runs that commit: `scale-in.sh` on the server contains `scale_in_remaining_slots`, and the server checkout is at `8b41b2a4`. Staging has 2 ready agent nodes (Nomad `61a04027` at 10.0.0.3 and `714f26cc` at 10.0.0.5), demand mode `true`, and tfvars `agent_node_count = 2`. The timer's scale-out run at 22:01Z saw 2 ready nodes, 14 free slots, and made no change.
- **Proof blocked by capacity.** Scale-in removes the highest index, which is `61a04027` (10.0.0.3, 3819 MB free, 14 slots). The remaining node `714f26cc` had 235 MB free, so 0 slots, and six agent jobs were running. The new guard would therefore defer the scale-in. A deferral proves the refusal path only, not the firewall and tfvars sync.
- **Stop path did not free the node (2026-10-31, 22:18Z).** The user stopped the six agents (`tintel`, `external-skills-tester`, `system-skills-tester`, `pa`, `bright-engine`, `wise-falcon`) in the UI. The database marked all six `stopped`, and the worker logged "Agent runtime stopped". Their Nomad jobs kept running. Root cause: after a worker restart, `registerRecoveredRuntime` gave the handle the ID `recovered-<sessionId>`. The Nomad adapter turned that into `agent-recovered-<sessionId>`, which does not exist. Nomad returned 404, which the adapter treats as success, so the real `agent-<agentId>` job was never purged.
- **Workaround (approved, 22:20Z).** The six `agent-<id>` jobs in `herobids-agents` were purged directly through the Nomad API (`DELETE ?purge=true`). The database was not changed. `browser-pool` and the other jobs were untouched. Remaining node `714f26cc` now carries only `browser-pool`: 1771 MB and 3500 MHz free, which is 6 slots. Cluster total is 20 slots.
- **Code fix (committed `55a37376`, deployed 22:28Z).** `registerRecoveredRuntime` now sets the handle's `containerId` to the agentId, which matches the missing-handle fallback. Regression tests were added in `agent-runtime-launcher.test.ts`. The four worker suites pass (114 tests). Staging now runs `55a37376`.
- **Operator note.** Run `check-nomad-capacity.sh` by hand with `TF_VAR_server_name=herobids-staging`. Without it, the pool defaults to `herobids`, the nodes do not match, and the script reports 0 ready nodes. The timer path sets it correctly.
- **Still open for the proof.** The proof itself is not yet run. It needs demand mode off, which re-enables the legacy scale-out path. Unverified: whether that path honours the cooldown.

### Stop-path fix deployed, then the 2 to 1 scale-in proof (2026-10-31, 22:28Z to 22:37Z)

- **Deploy.** The stop-path fix (`55a37376`) was deployed with `push.sh --env staging`. The server checkout is at `55a37376`, and the worker and API are healthy.
- **Settings.** Approved. `autoscale-settings.input` was backed up to `/root/backups/autoscale-settings.input-proof-20261031T222950Z`. Demand mode was set to `false` and converge was run with `PRIVATE_SUBNET=10.0.0.0/24` (the first run failed its precheck and changed nothing). The rendered env read `false`.
- **Scale-in.** The dry run came first and matched the plan. The real run used the unit's effective environment (`systemctl show`) with `ENABLE_SCALE_IN=true` overridden in the shell only. The unit and drop-ins were not edited. The run removed suffix 2 (Nomad `61a04027`, 10.0.0.3, empty, drained in 0s), 2 → 1 nodes, 6 free slots left (threshold 3). The cooldown stamp was written. Terraform state synced (agent firewall record), and `agent_node_count = 1` was written to tfvars.
- **Result (checked 22:36Z).**
  - Hetzner: only `herobids-staging-agent-1` (`173731633`, 10.0.0.5) remains. `herobids-staging-agent-2` (`173843852`, 10.0.0.3) is gone.
  - Agent firewall `herobids-staging-agent`: `applied_to` lists only `173731633`.
  - Nomad: `714f26cc` ready and eligible. `61a04027` `down` and `ineligible`, a stale entry for the destroyed server.
  - tfvars: `agent_node_count = 1`.
  - No reversal. The legacy 60s timer ran with demand off from 22:31 to 22:36 and reported "Capacity sufficient" (46% memory free, 6 slots). No scale-out, and no server was re-created.
- **Restore.** Demand mode was restored from the backup, and converge was run. The rendered env reads `NOMAD_AUTOSCALE_DEMAND_ENABLED=true`. `ENABLE_SCALE_IN` is still `false` at the unit level.
- **Open.** P9-e is closed by this proof. P9-f (converge must not drop demand-mode settings) is not covered by this proof. Still open: whether a refused scale-in should alert, whether the launcher's "stopped" log should reflect port failures, and whether the adapter's 404-as-success should change. Next scale-out: no further action needed unless demand triggers it.
