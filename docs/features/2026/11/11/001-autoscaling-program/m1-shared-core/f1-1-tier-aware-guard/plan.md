# F1.1: Tier-aware ownership guard and caps-pool fix

**Status:** ready
**Milestone:** [M1](../README.md) · **Program:** [README](../../README.md)
**Created:** 2026-11-11 **Verified against:** `herobids` `ee532da6`; staging control plane log on 2026-11-11 16:25 to 16:33 UTC
**Size:** 5 phases, about 20 tasks

## Goal

The autoscaler's ownership guard and in-flight observation take their identity (role, name shape, contiguity, exempt roles) from a tier profile whose agent values equal today's literals. The caps pool no longer makes the guard refuse staging scale-out. Agent behaviour is byte-identical.

## Context and facts

| # | Fact | Source | Env | Grade |
|---|---|---|---|---|
| 1 | Staging autoscale-out is refused every timer run: `Capacity guard BLOCKED scale-out: ["ownership_mismatch"]`. The last five entries were 16:25, 16:27, 16:28, 16:30, 16:32 UTC on 2026-11-11. The timer runs about every 60 s | `/var/log/nomad-autoscale.log` on the control plane (read-only) | staging | V |
| 2 | The guard treats a live owned server that is not "shaped" and not `control-plane` as foreign and raises `ownership_mismatch`. "Shaped" means label `role=agent`, label `node_pool=<pool>` and name `^<pool>-agent-[0-9]+$` | `capacity-inventory.sh:122-126,142,175` | both | V |
| 3 | Caps servers are named `<server_name>-agent-caps-N`, labelled `role=agent`, `node_pool=<server_name>`. Their name does not match the shaped regex | `infra/hetzner/main.tf:307-346` | both | V |
| 4 | So the caps servers are very likely the "foreign" servers. Not yet reproduced | facts 2 and 3 | staging | I |
| 5 | The caps pool is the sandbox rollout's replacement pool: `herobids-staging-agent-caps-1` and `-2` are live and eligible; the old nodes `agent-2` and `agent-3` are ineligible and will be retired | live Nomad (2026-11-10), [sandbox plan](../../../../../../pending/000-sandbox-uid-egress/001-plan.md) Phase 6 | staging | V |
| 6 | `check-nomad-capacity.sh` filters `NodeClass == "agent"` and `Meta.node_pool == pool`; the capacity guard and the capacity check use different filters | `check-nomad-capacity.sh:137,162` | both | V |
| 7 | The duplicated `shaped` filter in `capacity_observe_after_apply` must change with the reconcile filter | `capacity-inventory.sh:410-413` | both | V |
| 8 | The infra suite passes today: `tests/run-all.sh` exit 0 and `check-nomad-capacity.test.sh` passes (the latter is not run by `run-all.sh`) | local run, 2026-11-11 | local | V |
| 9 | `scale-out.sh --dry-run` is not guaranteed read-only (Terraform init and workspace preparation happen before its dry-run exit). Do not use it as a harmless check | safe-capacity roadmap | n/a | V |

Full coupling analysis: [reference](../reference/autoscaler-coupling-analysis.md).

## Decisions carried

| ID | Effect on this plan |
|---|---|
| C-12 (agents stay resident), SE-1 | No effect. The resident count assumption stands |
| C-13 (stop over-limit agents) | No effect now. It will reduce occupied slots later (M2) |
| INV-O1, INV-O2, INV-O6 | No Terraform apply, no state-writing command. The guard stays fail-closed; any change that makes it more permissive is a decision (OD-15) |
| INV-P1, INV-E6, INV-E9 | Done is a behaviour; reproduce before fixing; run the suite before declaring done |

## Decisions for this plan

| ID | Question | Tier | Status | Where recorded |
|---|---|---|---|---|
| OD-15 | How does the guard treat the caps pool? Changing what counts as "foreign" changes a fail-closed check (INV-O6) | T2 | open | brief `003` → `docs/decisions/records/` |
| T1-a | The profile mechanism: a sourced env file chosen by `NOMAD_AUTOSCALE_TIER`, default `agent`, so the systemd units need no change | T1 | decided here: default must equal today's literals | this plan, phase C |

## Exit checks (frozen; only the owner changes them)

1. A local test reproduces the staging block with a caps-named fixture, and after phase D the same fixture gives no `ownership_mismatch` under the chosen treatment.
2. For the agent pool without caps servers, golden outputs (reconcile snapshot, allowlist and plan-validate verdicts, resolved defaults) are byte-identical before and after.
3. `tests/run-all.sh` and `check-nomad-capacity.test.sh` pass.
4. On staging, after the owner approves the deploy, `/var/log/nomad-autoscale.log` shows no `ownership_mismatch` for 10 consecutive runs while the caps nodes exist, and no server is created or destroyed outside the bounds.
5. A bug report is filed and closed with this evidence; registers `03`, `04`, `05` are updated.

## Tasks

### Phase A: Reproduce and baseline (no behaviour change)

| ID | Task | Status | Evidence or notes |
|---|---|---|---|
| A1 | Record the staging evidence (fact 1) | done | log lines above |
| A2 | Capture golden outputs on current code: `capacity_reconcile` snapshots on the existing fixtures, allowlist and plan-validate verdicts, and the resolved env defaults after sourcing. Store under `infra/hetzner/scripts/tests/fixtures/golden/` | planned | |
| A3 | Add a test with a cloud fixture containing `herobids-staging-agent-1..2` and `herobids-staging-agent-caps-1` (all `role=agent`) and assert today's result: `ownership_mismatch`. **If it does not reproduce, stop**: the cause is something else; diagnose from the live inventory (read-only) before any change | planned | |
| A4 | File the bug report `docs/bug-reports/2026/11/11/001-staging-autoscale-blocked-by-ownership-mismatch-on-caps-pool.md` with the evidence and the reproduction; search `docs/bug-reports/` and `git log` for `capacity-inventory.sh` first | planned | |

### Phase B: Decide the caps-pool treatment (T2, framework)

| ID | Task | Status | Evidence or notes |
|---|---|---|---|
| B1 | Write neutral brief `docs/decisions/briefs/003-guard-treatment-of-caps-pool.md`. Facts: names and labels (fact 3), the guard filters, the retirement plan for old nodes (fact 5), the capacity check's different filter (fact 6). Candidate options, unranked: (a) the guard ignores servers matching a caps pattern; (b) relabel caps servers with a distinct role through Terraform and exempt that role; (c) the shaped regex accepts `agent-caps-N` as part of the managed pool; (d) rebuild caps nodes as `agent-N` after retiring the old pool; (e) switch autoscaling to manage the caps resource. Baseline: leave it blocked. Ask the owner nothing the code answers | planned | |
| B2 | Run the decision agent and a challenger per `docs/decisions/07-agent-contract.md` | planned | |
| B3 | Apply the register updates after the challenger result. If the gate says "needs owner", add an inbox item with a recommended answer | planned | |

### Phase C: Tier profile (agent profile = today's literals). Can run in parallel with B

Every step ends with: run the suite, compare golden outputs, commit only if identical.

| ID | Task | Status | Evidence or notes |
|---|---|---|---|
| C1 | Add `infra/hetzner/scripts/tiers/agent.sh` holding today's literals as `TIER_*` values, and a loader that sources it (default tier `agent`). Nothing consumes it yet | planned | |
| C2 | Wire the path defaults (`scale-common.sh:49-76`, `capacity-controller.sh:36-37`, `alert-common.sh:52-53`) to the profile. Resolved values must be identical | planned | golden defaults |
| C3 | Parameterise the leaf helpers: state key in `tf_init_backend`, `write_node_count`, `sync_tfvars_node_count` key, `max/min_agent_nodes` var names (defaults equal today's) | planned | |
| C4 | Pass role, name infix, contiguity and exempt roles into the reconcile jq as `--arg`, and into `capacity_observe_after_apply` (change both copies of `shaped` together). Make `capacity_scale_gate` take the in-flight file as an argument | planned | golden snapshots |
| C5 | Update the source-text tests in the same commit as any wiring change (see the reference, section 6) | planned | |

### Phase D: Apply the decision (after B is settled)

| ID | Task | Status | Evidence or notes |
|---|---|---|---|
| D1 | Implement the chosen treatment through the profile (for example exempt roles or a name pattern). Flip A3 so the caps fixture is consistent. Add a negative test: a genuinely foreign server still raises `ownership_mismatch` | planned | blocked by OD-15 |
| D2 | If the decision needs a Terraform label change, write a separate plan and inbox item. Do not apply it from this plan | planned | |

### Phase E: Verify and ship

| ID | Task | Status | Evidence or notes |
|---|---|---|---|
| E1 | Run the full infra suite plus `check-nomad-capacity.test.sh`; compare golden outputs | planned | |
| E2 | Add inbox item for the staging deploy of the scripts: command `DEPLOY_REF=<ref> infra/hetzner/scripts/push.sh --env staging --yes` (confirm the exact flow from the script header first), expected effect, rollback, and the warning that unblocking the guard lets staging scale out up to the bound of 3 | planned | needs approval |
| E3 | After approval: deploy; read the autoscale log for 10 runs; confirm no `ownership_mismatch` and no unexpected create or destroy | planned | blocked by E2 |
| E4 | Update `docs/decisions` registers; update the milestone table; close the bug report; write the journal entry; draft F1.2 from the "Next plan hint" | planned | |

## Execution approvals needed

| Inbox ID | Action | Task |
|---|---|---|
| to be added | Staging deploy of the changed scripts | E2, E3 |
| to be added if D2 applies | Terraform label change on caps servers | D2 |

## Risks

| Risk | How we would notice | Response |
|---|---|---|
| Not the cause | A3 does not reproduce | Stop; diagnose read-only; update fact 4 |
| Regression of the agent tier | Golden or suite differ | Revert the step |
| Brittle source-text tests | Failures with no behaviour change | Update tests with the change (C5) |
| The guard becomes too permissive | The negative test in D1 fails | Do not ship; revisit OD-15 |
| Unblocking triggers a surprise scale-out | Autoscale log after deploy | Bounded by max 3; the owner approves the deploy; watch the first runs |

## Rollback and verification

**Rollback:** revert the commits; redeploy the previous ref with the same push command after approval. The autoscale timer keeps running with the old scripts.
**Verification:** the suite and golden comparison locally; the autoscale log on staging for ten runs; no change in node count outside the bounds.

## Out of scope

- A for_each-keyed allowlist and scale-in validator → F1.2.
- Isolation of lock, cooldown, state and alerts for a second tier → F1.3.
- A shared repository or a TypeScript core → decided by OD-01.
- Retiring the old nodes → M2 (sandbox rollout).

## Next plan hint

F1.2 should cover: the profile-driven plan allowlist for for_each-keyed addresses (reference section 4), a for_each scale-in validator that deletes exactly one named node, and fixtures for a `browser` profile. It waits for OD-01 and must keep the count-based branches textually unchanged.
