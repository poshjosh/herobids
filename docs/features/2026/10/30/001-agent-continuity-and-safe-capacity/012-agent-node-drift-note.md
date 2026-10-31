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

## Still open

- Name mismatch (above). Requires approval before any live change.
- Stale Nomad `down` entries `-agent-1` and `-agent-2`. Purge after confirming no allocations.
- API image predates the P-series code. Deploy not yet done.
- P8 live shadow GETs against staging. Not yet run.
- Timers stay inactive. `000-roadmap.md` and `010-objectives.md` say they stay stopped until the gates pass. The user's earlier "approve turning on the timers" conflicts with this. Not enabled.
- Oso (owned by the user's brother) stays stopped. Not started.
- 8 stopped agents on the operator's account are not started.
