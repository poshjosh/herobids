# Autoscaler coupling analysis (reference)

**Produced:** 2026-11-11 by a read-only analysis of `infra/hetzner/scripts` at commit `ee532da6`. **Grade:** V for the cited lines; "no direct test" claims are name-based searches (I).
**Used by:** [F1.1](../f1-1-tier-aware-guard/plan.md) and later M1 plans. **Also answers** brief 001 unknowns U1, U2, U5, U7 ([brief](../../../../../../../decisions/briefs/001-autoscaling-architecture.md)).
Paths are under `infra/hetzner/scripts` unless stated.

## 1. Classification summary

About 34 of 44 functions in `scale-common.sh` are generic by behaviour. The rest carry agent identity or agent-only demand logic.

| Class | Meaning | Where |
|---|---|---|
| GENERIC | Reuse as is | logging, `require_uint`, `nomad_api`, `tf_var`, `acquire_lock`/`release_lock`, Terraform helpers (`tf_ensure_env`, `tf_use_env_data_dir`, `tf_select_workspace`, `tf_ensure_ready`, `tf_apply_var`, `tf_apply_plan`), drain helpers (`drain_node`, `wait_for_drain_complete`, `mark_node_*`, `restore_node_schedulable`, `node_ready_for_grace`, `node_is_idle`), in-flight record helpers, `scale_in_new_count_ok`, `scale_in_names_unique`, `capacity_plan_fit` (algorithm), SMTP/alert sending |
| PARAMETERISABLE | Generic logic with hard-coded agent identity | path defaults (`scale-common.sh:49-76`, `capacity-controller.sh:36-37`, `alert-common.sh:52-53`); `tf_init_backend` state key (`scale-common.sh:536`); `sync_tfvars_node_count` key `agent_node_count` (`:345`); `max_agent_nodes`/`min_agent_nodes`; the reconcile jq (`capacity-inventory.sh:122-209`); `capacity_observe_after_apply` duplicate filter (`:410-413`); `capacity_scale_gate` inflight path (`:427`); the plan allowlist (`capacity-controller.sh:193-244`); `scale_in_refresh_plan_ok` firewall regex (`scale-in-guard.sh:106`); `scale_in_plan_validate` (`:23-58`); alert state files and context |
| AGENT-SPECIFIC | Memory/slot demand logic | `controller_decide`, `controller_fetch_demand`, `demand_classify`, `capacity_node_fit`, `capacity_node_slots`, `parse_capacity_output`, `validate_demand_template_env`, `scale_in_remaining_slots`, `scale_in_leading_run`, the legacy flow in `scale-out.sh:503-764`, top-suffix selection in `scale-in.sh:292-366` |

## 2. Hard-coded agent identity to turn into profile values

| Item | Current literal | Where |
|---|---|---|
| Role label | `agent` | `capacity-inventory.sh:125,142,411` |
| Name shape | `^<pool>-agent-[0-9]+$` and `-agent-(\d+)$` | `capacity-inventory.sh:126-127,157,413`; `capacity-controller.sh:200` |
| Exempt roles from "foreign" | only `control-plane` | `capacity-inventory.sh:142` |
| Contiguous indices | required | `capacity-inventory.sh:151-152,177`; top-suffix scale-in |
| Nomad node class | `agent` | `check-nomad-capacity.sh:137,162`; `scale-in.sh:307`; `scale-common.sh` (`list_eligible_agent_nodes`) |
| Terraform addresses | `hcloud_server.agent[i]`, `hcloud_server_network.agent[i]`, `hcloud_firewall.agent[i]` | `capacity-controller.sh:214-220`; `scale-in-guard.sh:24-26,106` |
| Count variable | `agent_node_count` | `scale-common.sh:345`; `scale-out.sh:468`; `scale-in.sh:508,544`; `scale-in-guard.sh:35` |
| State key | `herobids/${env}/terraform.tfstate` | `scale-common.sh:536`; `alert-common.sh:303` |
| State, lock, cooldown, failure, streak, deferral, inflight, count files | shared paths | see section 1 |

## 3. Proposed tier profile (a proposal, not existing code)

Profile values set **before** sourcing, because defaults resolve at source time: `TIER_STATE_DIR`, `TIER_LOCKFILE`, `TIER_COOLDOWN_FILE`, `TIER_NODE_COUNT_FILE`, `TIER_FAILURE_COUNT_FILE`, `TIER_LAST_ALERT_FILE`, `TIER_ROLE_LABEL`, `TIER_NAME_INFIX`, `TIER_NODE_CLASS`, `TIER_REQUIRE_CONTIGUOUS`, `TIER_OTHER_ROLES`, `TIER_TF_DIR`, `TIER_STATE_KEY`, `TIER_TF_COUNT_VAR`, `TIER_ADDR_STYLE` (`count` or `for_each`), `TIER_SERVER_RES`, `TIER_NETWORK_RES`, `TIER_FIREWALL_RES_RE`, `TIER_DEMAND_FLAG`, `TIER_MIN_VAR`, `TIER_MAX_VAR`, `TIER_ALERT_LABEL`. The agent profile equals today's literals.

Hooks a tier supplies: `tier_demand_snapshot`, `tier_select_victims`, `tier_pre_drain`, `tier_tf_target_args`, `tier_expected_additions`, `tier_plan_validate_scale_in`.

## 4. What the plan allowlist needs for a for_each tier (capacity-controller.sh)

| Lines | Dependency | Change |
|---|---|---|
| 200 | expected name is `sn + "-agent-" + (.index+1)` | expected name equals the key; validate against the pattern |
| 214-220 | address `hcloud_server.agent[\(.index)]`, index must be a number | address `hcloud_server.<res>["<name>"]`, index is a string |
| 222-228 | collects numeric indices, compares to `range($cur; $cur+$exp)` | compare to a caller-supplied expected key set |
| 231 | network read from `hcloud_network.private[0]` in prior state | a separate root module reads the network as a data source or remote state |
| 285-286 | `--arg cur/exp/cap/sn/st/loc/env` | add `--argjson want`, `--arg infix`, `--arg res` |

## 5. What stays agent-specific

Memory and CPU bin-packing demand (`controller_decide`, `demand_classify`, node fit and slots); the Nomad evaluations model (`controller_fetch_demand`, namespace `herobids-agents`); `check-nomad-capacity.sh`; the placement watcher; the legacy policy; top-suffix scale-in selection; `scale_in_remaining_slots`; the count-based `sync_tfvars_node_count`; `variables.tf` `agent_*` and `render-autoscale-settings.sh` `ALLOWED_KEYS`.

## 6. Risks to agent behaviour and the parity gate

1. **Source-text tests.** Many tests grep the text and line order of `scale-in.sh` and `scale-out.sh` (for example `test-capacity-scale-in-guard.sh:290-317,359-363,559-581`, `test-capacity-scale-in-wiring.sh:56-115`, `test-capacity-scale-out-demand.sh:241-243`). A rename breaks them with no behaviour change. Update tests in the same commit.
2. **jq program text is safety logic.** Pass parameters as `--arg`; keep the default program semantically identical.
3. **Source-time evaluation.** A profile applied after sourcing has no effect on state paths.
4. **Shared `NOMAD_AUTOSCALE_*` names** are set by the systemd units (`cloud-init.yaml:191-203,283-296,364-376`) and `converge-control-plane.sh`. Renaming is a deployment change.
5. **Duplicated `shaped` filter** (`capacity-inventory.sh:125-126` and `410-413`) must change together.
6. **Ownership change.** For the agent guard to tolerate other tiers' servers, the agent profile must exempt their role. That is one deliberate behaviour change.
7. **Fixtures are synthetic.** The allowlist and plan-validate fixtures must be re-verified against a captured real plan (`capacity-controller.sh:191-192`).

## 7. Test coverage (parity gate)

`tests/run-all.sh` globs only `test-*.sh`. `check-nomad-capacity.test.sh` is **not** run by it and must be run separately (2026-11-11: both pass). Coverage by area: inventory and reconcile (`test-capacity-inventory.sh`, `test-capacity-inflight-state.sh`); controller and allowlist (`test-capacity-controller.sh`); scale-in guards (`test-capacity-scale-in-guard.sh`, `test-capacity-scale-in-wiring.sh`); scale-out (`test-capacity-scale-out-demand.sh`, `test-capacity-scale-out-wiring.sh`); drain (`test-drain-timeout.sh`); Terraform helpers (`test-tf-runtime-helpers.sh`); alerts (`test-alert-context.sh`).

**No direct test (name search, may have indirect coverage):** `capacity_inflight_record_servers`, `capacity_observe_after_apply` (post-apply path untested), `controller_fetch_demand`, `_controller_write_file`, `tf_var`, `tf_use_env_data_dir`, `demand_mode_enabled`, `validate_demand_template_env`, `check_cooldown_expired` (only via subprocess), the alert state helpers, `clear_node_drain`, `mark_node_eligible`, `is_node_draining`, `demand_scale_out` and its helpers (subprocess only), `_capacity_record_ok`.

## 8. Reasons sharing needs care

- **Ownership collision (highest risk).** Any live owned server that is not "shaped" and not `control-plane` raises `ownership_mismatch` (`capacity-inventory.sh:142,175`). A second tier's servers, and the caps pool, are foreign today.
- **Contiguity.** Indices 1..N are required; named-node removal leaves gaps by design.
- **One lock per process** (fd 9). Separate lockfiles per tier are safe because the states are separate.
- **Shared cooldown file.** `scale-in.sh:571` touches the cooldown to suppress scale-out. Shared, one tier would throttle the other.
- **Shared alert state** (`alert-common.sh:52-53`) accumulates unrelated failures and shares the one-alert-per-hour limit.
- **Scale-in is disabled while the agent demand flag is on** (`scale-in.sh:139`), the opposite of what a browser tier needs.
- **Terraform state.** A second root module needs its own state key and data dir. The units' `ReadWritePaths` cover only `/opt/herobids/infra/hetzner` (`cloud-init.yaml:242`).
- **In-flight record** has no tier field; use separate files.

## 9. Other brief-001 unknowns, closed

| Unknown | Finding | Grade |
|---|---|---|
| U2 test suite | `run-all.sh` exit 0 and `check-nomad-capacity.test.sh` passes (2026-11-11, local) | V |
| U3 Traderton Phase 10 module library | No sign it has started: Traderton's infra history shows deploy-toolchain work only; no mention in its ledgers or backlogs | I |
| U5 Nomad Autoscaler Hetzner plugin | The community plugin creates and deletes Hetzner servers directly (token, cloud-init, networks, labels, drain, purge). That is a second infrastructure owner outside Terraform, which the safe-capacity plan listed as out of scope | V (README) |
| U7 control-plane runtime | Autoscaler runs as systemd timer units calling shell scripts. Packages are `jq`, Docker, Nomad and Terraform; no Node runtime is installed (`cloud-init.yaml:22-27,510-534`). A TypeScript core would need Node or a container on the control plane | V |
| U4 shared Hetzner project, U8 capacity | Owner facts; asked in [owner-inbox.md](../../owner-inbox.md) | open |
