# Nomad Production Scale-In Validation Plan

## Status

`approved`

## Purpose

Produce the evidence required to decide whether Nomad scale-in is safe enough to enable in production after the remediation plan is complete.

This plan covers item 8 from the readiness checklist: staging-first validation and final production go or no-go.

## Scope

This is a validation plan, not an implementation plan.

It assumes the remediation work in:

- `docs/features/2026/08/28/001-nomad-production-scale-in-readiness/001-remediation-plan.md`

has already landed.

## Preconditions

Before running this plan, confirm all of the following:

1. DONE The remediation plan is complete (all workstreams W1–W5 marked DONE).
2. DONE The AWS S3-backed remote Terraform state is configured and documented (see `infra/hetzner/README.md` — "Terraform Remote Backend (S3)").
3. DONE The Nomad ACL posture for production is implemented and documented (see `infra/hetzner/README.md` — "Nomad ACL Authentication").
4. DONE Staging Nomad orchestration is healthy.
5. DONE Staging has enough disposable capacity to test both safe drain and blocked drain scenarios.
6. DONE (we use `ssh root@78.46.192.37 'journalctl -t nomad-autoscale-alert -n 20'
`) Alert delivery is configured for the environment being tested.
7. DONE The staging-only failure-injection hooks exist at `infra/hetzner/scripts/tests/staging-hooks.sh` and have been verified to load correctly:
   ```bash
   ssh root@<control-plane-ip>
   HEROBIDS_ENV=staging source /opt/herobids/infra/hetzner/scripts/tests/staging-hooks.sh
   # Expected: "[STAGING-HOOK] Sourced but no hooks active ..."
   ```

## Evidence Standard

For each step below, record:

1. exact command run
2. relevant log lines
3. before and after node status
4. before and after allocation status
5. pass or fail result
6. any operator intervention required

If a step needs manual judgment, write down the observed behavior instead of paraphrasing it later from memory.

## Decision Gate

Do not enable production scale-in unless every required validation step below passes.

If any step fails, return to the remediation plan and open a follow-up item rather than papering over the failure with a runbook note.

## Validation Stages

### V1. Baseline and no-op checks in staging

#### Goal

Prove the control-plane services, Nomad cluster, and scale scripts are healthy before inducing any change.

#### Steps

1. DONE Verify Nomad server and client nodes are all healthy.
2. DONE Verify the worker is using the Nomad backend.
3. DONE Run `check-nomad-capacity.sh` and confirm the output is sane.
4. DONE Run `scale-in.sh --dry-run` and confirm candidate selection is understandable.
5. DONE Run a no-op scale-in where `current_count <= min_agent_nodes` and confirm the script exits safely without mutation.

#### Pass criteria

1. No command targets the wrong environment.
2. Dry-run output matches the real cluster inventory.
3. The no-op path makes no Nomad drain or Terraform mutation.

### V2. Safe idle-node drain in staging

#### Goal

Prove that an actually idle agent node is drained and removed without side effects.

#### Steps

1. DONE Identify a ready, eligible agent node with zero running or pending allocations.
2. DONE Run `scale-in.sh --dry-run` and confirm that node is selected.
3. DONE Execute a real scale-in.
4. DONE Verify the node becomes ineligible, drains, and is then removed by Terraform.
5. DONE Verify remaining nodes stay healthy and ready.

#### Pass criteria

1. Only the intended idle node is removed.
2. Remaining cluster health is unchanged except for expected capacity reduction.
3. Node-count tracking is updated consistently after the shrink.

### V3. Active-node protection in staging

#### Goal

Prove the scale-in path does not evict a node that still has active work.

#### Steps

1. DONE Ensure at least one candidate node has an active agent allocation.
2. DONE Run `scale-in.sh --dry-run` and confirm the active node is skipped.
3. DONE Run a real scale-in and confirm only verified-idle nodes are considered.
4. DONE Confirm the active allocation remains running throughout the operation.

#### Pass criteria

1. Active nodes are not selected for destruction.
2. The running allocation remains healthy.
3. No manual repair is required after the run.

### V4. Drain-timeout protection in staging

#### Goal

Prove a node that fails to drain within the deadline is preserved rather than destroyed.

#### Important note

Use the staging-only drain-timeout hook at `infra/hetzner/scripts/tests/staging-hooks.sh`.
Setting `INJECT_DRAIN_TIMEOUT=true` overrides `wait_for_drain_complete` to always return
failure, simulating a node that never finishes draining.

#### Steps

1. DONE Create a staging scenario where a node remains non-empty past the configured drain deadline:
   ```bash
   ssh root@<control-plane-ip>
   ```

2. DONE Run a real scale-in with the injected drain timeout via `STAGING_HOOKS=true`:
   ```bash
   ENABLE_SCALE_IN=true STAGING_HOOKS=true INJECT_DRAIN_TIMEOUT=true \
     /opt/herobids/infra/hetzner/scripts/scale-in.sh
   ```
   The `STAGING_HOOKS=true` env var causes `scale-in.sh` to auto-source `staging-hooks.sh`,
   which overrides `wait_for_drain_complete` to always return failure. The production guard
   in the hooks file prevents this from activating when `HEROBIDS_ENV=production`.

3. DONE Confirm the script logs the timeout condition (look for `[STAGING-HOOK]` and `did not drain within`).
4. DONE Confirm the node is not destroyed by the subsequent Terraform step.
5. DONE Confirm the node can be restored to normal scheduling state after the test:
   ```bash
   # The script re-marks timed-out nodes as eligible automatically.
   # Verify:
   NOMAD_TOKEN=<token> nomad node status <node-id>
   # Expected: SchedulingEligibility = eligible
   ```

#### Pass criteria

1. Timeout is loud and visible (grep for `[STAGING-HOOK]` and `WARNING` in logs).
2. The timed-out node remains present after the run.
3. No live allocation is force-stopped as part of the normal scale-in path.

### V5. Failed Terraform apply recovery in staging

#### Goal

Prove that a scale-in run fails safely when Terraform apply fails mid-process.

#### Important note

Use the staging-only Terraform failure hook at `infra/hetzner/scripts/tests/staging-hooks.sh`.
Setting `INJECT_TF_APPLY_FAILURE=true` overrides `tf_apply_var` to always return failure,
simulating a Terraform apply crash without damaging staging state.

#### Steps

1. DONE Induce a safe, reversible Terraform apply failure in staging:
   ```bash
   ssh root@<control-plane-ip>
   ```

2. DONE Run scale-in with the injected Terraform failure via `STAGING_HOOKS=true`:
   ```bash
   ENABLE_SCALE_IN=true STAGING_HOOKS=true INJECT_TF_APPLY_FAILURE=true \
     /opt/herobids/infra/hetzner/scripts/scale-in.sh
   ```

3. DONE Confirm the script reports the apply failure loudly (grep for `[STAGING-HOOK]` and `ERROR`).
4. DONE Confirm nodes already marked ineligible are restored to eligible state:
   ```bash
   # The script re-marks drained nodes as eligible on apply failure.
   # Verify:
   NOMAD_TOKEN=<token> nomad node status <node-id>
   # Expected: SchedulingEligibility = eligible
   ```
5. DONE Confirm no partial cluster damage remains after cleanup:
   ```bash
   NOMAD_TOKEN=<token> nomad node status
   # All nodes should be ready and eligible
   ```

#### Pass criteria

1. Failure is loud and obvious (visible in autoscale log and grep-able).
2. The cluster remains serviceable afterward.
3. Recovery steps are documented and repeatable.

### V6. Alerting and observability validation

#### Goal

Prove the operators will know when scale-in fails or behaves unexpectedly.

#### Steps

1. DONE Verify alert delivery path using the supported alert tooling.
2. DONE Verify failure count increments on a real or safely induced failure.
3. DONE Verify rate limiting works.
4. DONE Verify recovery signal handling if recovery alerts are enabled.
5. DONE Verify the combined logs are sufficient to explain what happened without code spelunking.

#### Pass criteria

1. Alerts are delivered to the intended operator channel.
2. Logs clearly distinguish no-op, success, timeout, and apply-failure cases.

### V7. Documentation and operator drill

#### Goal

Prove the runbook is usable by an operator who did not author the implementation.

#### Steps

1. DONE Update the active runbook to match the remediated implementation.
2. DONE Have one operator follow the runbook in staging end to end.
3. DONE Record any gaps, hidden assumptions, or missing recovery commands.

#### Pass criteria

1. The runbook matches reality.
2. No critical step requires private background knowledge.

### V8. Production go or no-go review

#### Goal

Make the production decision from evidence, not confidence.

#### Steps

1. DONE Review the evidence from V1 through V7.
2. DONE Confirm that all failures found in staging were either fixed or explicitly accepted.
3. DONE Confirm production prerequisites remain satisfied:
   - correct AWS S3 backend configuration and environment isolation
   - correct Nomad auth model
   - alerting configured
   - rollback path documented
4. Decide whether production scale-in should remain disabled, be canaried, or be enabled normally.

#### Pass criteria

1. There are no unresolved high-severity failures.
2. The reviewers can explain exactly why production is safe enough.

## Recommended Enablement Sequence

1. Complete V1 through V7 in staging.
2. Hold a short go or no-go review for V8.
3. If V8 passes, enable production scale-in conservatively:
   - keep `scale_in_max_nodes_per_run=1`
   - keep a conservative drain deadline
   - observe the first scheduled production run closely

## Production Readiness Boundary

Production scale-in should be considered eligible only after V8 passes.

If you want a simpler statement:

1. remediation complete means the system is ready to test
2. validation complete means the system is ready to consider production enablement

## Deliverables

This plan is complete when you have:

1. a recorded validation log for V1 through V7
2. a written go or no-go conclusion for V8
3. an updated operator runbook that matches the final implementation