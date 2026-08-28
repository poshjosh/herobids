# Nomad Production Scale-In Remediation Plan

## Status

`in-progress`

## Purpose

Close the confirmed implementation and operational gaps that currently make nightly Nomad scale-in unsafe for production use.

This plan covers review items 4 to 7 from the production-readiness checklist:

4. drain-timeout correctness
5. Terraform workspace and state handling on the control plane
6. production-safe private IP resolution
7. Nomad ACL and token alignment

Item 8, production validation, is intentionally split into a separate plan at:

- `docs/features/2026/08/28/001-nomad-production-scale-in-readiness/002-production-validation-plan.md`

## Handoff Order

Implement this plan in the following order:

1. **W2** — Make autoscale Terraform execution environment-safe.
2. **W4** — Align Nomad ACL and token behavior.
3. **W1** — Fix drain-timeout safety semantics.
4. **W3** — Generalize private IP resolution.
5. **W5** — Add tests and rollout-facing documentation.

Only after W1 through W5 are complete should the separate validation plan be executed.

## Confirmed Current State

The following points are confirmed from the current code, not inferred from old feature docs:

1. The scale-in script can continue to destroy a node even after the drain wait times out.
   - `infra/hetzner/scripts/scale-in.sh`
   - After `wait_for_drain_complete()` fails, the node is still added to `DRAIN_OK` and included in the later Terraform shrink.

2. The scale scripts are not workspace-aware in the same way as `provision.sh`.
   - `infra/hetzner/scripts/scale-in.sh`
   - `infra/hetzner/scripts/scale-out.sh`
   - `infra/hetzner/scripts/provision.sh`
   - `provision.sh` selects the environment workspace, but the autoscale scripts do not.

3. The scale scripts check only for `${TERRAFORM_DIR}/terraform.tfstate`, while the repo documents workspace-based state.
   - `infra/hetzner/scripts/scale-in.sh`
   - `infra/hetzner/scripts/scale-out.sh`
   - `infra/hetzner/README.md`

4. Both cloud-init templates resolve the private IP using a hard-coded `10.0.*` regex.
   - `infra/hetzner/cloud-init.yaml`
   - `infra/hetzner/cloud-init-nomad-client.yaml`
   - Production is documented with `10.1.0.0/16` in `infra/hetzner/production.tfvars`.

5. The worker-side Nomad adapter supports ACL tokens, but the shell autoscaler does not send them.
   - `apps/worker/src/agents/nomad-runtime-adapter.ts`
   - `infra/hetzner/scripts/scale-common.sh`

6. Control-plane bootstrap still documents Nomad ACLs as not yet enabled.
   - `infra/hetzner/cloud-init.yaml`

## Goals

1. Make scale-in fail closed when a candidate node does not drain cleanly.
2. Make all control-plane autoscale mutations target the correct Terraform environment deterministically.
3. Remove staging-specific private-network assumptions from Nomad bootstrap.
4. Make Nomad authentication consistent across worker, autoscale scripts, and operator docs.
5. Produce code, tests, and operator documentation that support production rollout without relying on tribal knowledge.

## Non-Goals

1. Do not redesign orchestration away from Nomad.
2. Do not introduce unrelated worker or trading-engine changes.
3. Do not enable production scale-in as part of this plan.
4. Do not switch away from the chosen AWS-backed remote-state direction unless a separate design decision is made.

## Confirmed Decisions

These decisions were confirmed on 2026-08-28 and should now be treated as implementation requirements, not open questions.

### D1. Terraform state model

Use a remote backend backed by AWS S3 as the authoritative Terraform state for autoscaling.

Implications:

1. local operator runs and control-plane autoscale runs must use the same authoritative state
2. control-plane autoscale logic must stop depending on a host-local `terraform.tfstate` file as the source of truth
3. staging and production must remain isolated in backend layout and access controls

### D2. Terraform credentials and environment-specific inputs

Use service environment variables on the control plane for backend access and required Terraform inputs.

Implications:

1. do not rely on environment-specific tfvars being manually copied onto the control plane
2. keep the runtime-required Terraform inputs explicit in systemd or equivalent service environment
3. credentials and backend configuration should be provisioned in a way that keeps production automation non-interactive

### D3. Nomad ACL posture

Nomad ACLs must be enabled before production scale-in is considered ready.

Implications:

1. the worker and shell autoscaler must both authenticate to Nomad
2. bootstrap comments, config validation, and runbooks must stop describing an unauthenticated production cluster
3. any temporary non-ACL staging shortcuts must not leak into the production plan

### D4. Failure injection for validation

Use explicit staging-only failure-injection hooks for:

1. stuck drain or drain-timeout validation
2. Terraform apply failure validation

Implications:

1. do not rely on ad hoc live breakage or manual environment corruption to exercise failure paths
2. the implementation should make failure scenarios deterministic and reversible in staging

## Workstreams

### W1. Fix drain-timeout safety semantics `DONE`

#### Problem

`scale-in.sh` currently logs a warning on drain timeout, but still keeps the node in the destroy set.

#### Files likely to change

1. `infra/hetzner/scripts/scale-in.sh`
2. `infra/hetzner/scripts/scale-common.sh`
3. `infra/hetzner/README.md`
4. `infra/hetzner/docs/auto-scaling/setup-auto-scaling.md`
5. `infra/hetzner/docs/auto-scaling/useful.md`
6. `docs/features/2026/08/28/001-nomad-production-scale-in-readiness/002-production-validation-plan.md`
7. any shell test or script-level test harness introduced for autoscale behavior

#### Task breakdown

##### W1.1 Fix the timeout branch in `scale-in.sh`

1. Change the control flow so a node that fails `wait_for_drain_complete()` is not added to `DRAIN_OK`.
2. Ensure the scale-in loop continues safely to the next candidate rather than treating the timed-out node as a successful drain.
3. Preserve clear warning logs so operators can distinguish timeout from success.

##### W1.2 Align shrink-count computation with actual safe drains

1. Ensure `NEW_COUNT` is derived only from nodes that truly completed the required drain path.
2. Verify that the script cannot reduce `agent_node_count` when every candidate timed out or otherwise failed processing.
3. Keep the `min_agent_nodes` guard intact after the timeout fix.

##### W1.3 Fix misleading shared-helper messaging

1. Update the timeout wording in `wait_for_drain_complete()` so it no longer implies force-stop-on-destroy is acceptable in the normal path.
2. Ensure shared logs and top-level script logs describe the same safety behavior.

##### W1.4 Define the operator outcome on timeout

1. Document what the script does after timeout:
   - leaves the node present
   - leaves scale-in incomplete for that candidate
   - requires operator investigation or a later retry
2. Document what operators should inspect next when a timeout occurs.
3. Update the `infra/hetzner/docs/auto-scaling/` docs so timeout behavior and manual follow-up steps match the remediated script.

##### W1.5 Add deterministic validation coverage

1. Add a narrow automated test for the timeout branch.
2. Ensure the test proves both:
   - the node is excluded from the destroy set
   - Terraform shrink is skipped or reduced accordingly
3. Tie the behavior to the staging-only drain-timeout hook used by the validation plan so the same branch can be exercised end to end later.

#### Validation

1. A simulated drain-timeout run leaves the timed-out node out of `DRAIN_OK`.
2. A run where all candidates time out does not execute a destructive Terraform shrink.
3. A mixed run where one node drains and one times out shrinks only by the successfully drained count.
4. The shared helper log message and the top-level scale-in log message no longer contradict the intended safety policy.
5. The validation plan's timeout stage matches the implemented script behavior exactly.

#### Acceptance criteria

1. A timed-out node is not destroyed.
2. The run exits cleanly with a visible warning and no silent shrink.
3. The README and any relevant runbook describe the same behavior the code enforces.

### W2. Make autoscale Terraform execution environment-safe `DONE`

#### Problem

The scale scripts are less robust than `provision.sh`:

1. they do not select a Terraform workspace
2. they require a root `terraform.tfstate` file
3. they rely on environment-specific tfvars and credentials being present, but that source of truth is not fully codified in the scale services

#### Files likely to change

1. `infra/hetzner/main.tf`
2. `infra/hetzner/variables.tf`
3. `infra/hetzner/README.md`
4. `infra/hetzner/cloud-init.yaml`
5. `infra/hetzner/scripts/scale-common.sh`
6. `infra/hetzner/scripts/scale-in.sh`
7. `infra/hetzner/scripts/scale-out.sh`
8. `infra/hetzner/scripts/alert-common.sh`
9. `infra/hetzner/scripts/provision.sh`
10. `infra/hetzner/docs/auto-scaling/setup-auto-scaling.md`
11. `infra/hetzner/docs/auto-scaling/useful.md`

#### Task breakdown

##### W2.1 Define the S3 backend contract

1. Add the Terraform backend configuration for AWS S3.
2. Decide how staging and production are isolated in the backend:
   - separate keys inside one bucket, or
   - separate buckets per environment
3. Document the exact naming convention for backend state objects so operators can predict where state lives.
4. Ensure the backend layout supports non-interactive control-plane automation.

##### W2.2 Define the control-plane environment contract

1. Enumerate the minimum environment variables the autoscale services require for Terraform backend access.
2. Enumerate the minimum environment variables the autoscale services require for Terraform input values.
3. Ensure the service-level environment is the single source of truth for autoscale-time Terraform inputs on the control plane.
4. Remove any plan assumptions that production tfvars files must exist on the server.

##### W2.3 Introduce shared Terraform runtime helpers

1. Add one shared helper layer for autoscale-time Terraform commands in `scale-common.sh`.
2. Centralize:
   - environment selection
   - backend readiness checks
   - common Terraform args
   - fatal error formatting for missing backend credentials or missing required inputs
3. Keep `scale-in.sh`, `scale-out.sh`, and `alert-common.sh` thin consumers of that shared helper path.

##### W2.4 Replace host-local state assumptions

1. Remove the `${TERRAFORM_DIR}/terraform.tfstate` readiness checks from scale-in and scale-out.
2. Replace them with backend-aware checks that answer the real question: can this host safely run Terraform against the intended environment?
3. Update any alert diagnostics that currently inspect only a local state file path.
4. Make the failure mode explicit when backend initialization succeeds but the selected environment has no state yet.

##### W2.5 Make Terraform environment targeting explicit

1. Ensure every autoscale-time Terraform command proves which environment it is targeting.
2. Reuse the same `HEROBIDS_ENV` semantics already used by provisioning and deploy scripts.
3. Ensure the autoscale path cannot silently fall back to `default` or another unintended environment.
4. Make environment mismatch a hard failure, not a warning.

##### W2.6 Update control-plane bootstrap

1. Add the chosen backend-related environment variables to the relevant systemd service units in `cloud-init.yaml`.
2. Ensure cloud-init leaves the control plane in a backend-ready state for autoscale runs.
3. Keep the bootstrap path compatible with first-boot setup and later reboots.

##### W2.7 Update operator documentation

1. Document the S3 backend setup requirements.
2. Document the control-plane environment variables required for autoscaling.
3. Document how an operator can verify backend connectivity and environment targeting on the control plane.
4. Remove or clearly supersede any remaining docs that imply autoscale depends on host-local tfstate.
5. Update the `infra/hetzner/docs/auto-scaling/` guides so setup and operational commands reflect the S3-backed remote backend path.

#### Validation

1. Provisioning still works for both environments with the S3 backend configured.
2. A control-plane `scale-out.sh --dry-run` can initialize Terraform non-interactively and prove the target environment.
3. A control-plane `scale-in.sh --dry-run` does not depend on a local `terraform.tfstate` file.
4. Missing backend credentials or missing required environment variables produce a clear fatal error before any Nomad drain or Terraform apply.
5. Alert diagnostics still provide useful Terraform context after the backend change.

#### Acceptance criteria

1. A production control-plane autoscale service can prove it is operating on the `production` environment, not just on whatever local default state exists.
2. A missing backend configuration, missing environment isolation, or missing credentials produces a clear fatal error before any drain or apply attempt.
3. The same mechanism is used by `scale-in.sh`, `scale-out.sh`, and alert diagnostics.

### W3. Generalize private IP resolution `PENDING`

#### Problem

Nomad advertise address patching is currently tied to `10.0.*`, which is a staging-shaped assumption.

#### Files likely to change

1. `infra/hetzner/cloud-init.yaml`
2. `infra/hetzner/cloud-init-nomad-client.yaml`
3. `infra/hetzner/README.md`
4. `infra/hetzner/docs/auto-scaling/lessons-learnt.md`
5. `infra/hetzner/docs/auto-scaling/setup-auto-scaling.md`
6. `infra/hetzner/docs/auto-scaling/useful.md`

#### Task breakdown

##### W3.1 Replace the staging-only address match

1. Remove the hard-coded `10.0.*` extraction logic from both cloud-init templates.
2. Replace it with a method that works for both staging and production network ranges.
3. Prefer a method tied to the configured private subnet or private interface rather than a single CIDR prefix.

##### W3.2 Keep server and client bootstrap behavior aligned

1. Use the same private-IP resolution strategy on the control-plane Nomad server and on Nomad client nodes.
2. Ensure the chosen method patches the Nomad config before the service starts.
3. Preserve loud logging when resolution fails.

##### W3.3 Make the resolution path inspectable

1. Keep the logic simple enough that an operator can understand it from the rendered cloud-init and journal logs.
2. Document how to verify the final advertised address after boot.
3. Ensure the failure log tells the operator what to inspect next.

##### W3.4 Update docs and lessons

1. Update the README to remove staging-shaped assumptions.
2. Update the lessons doc so it records both the old failure mode and the generalized fix.
3. Update the `infra/hetzner/docs/auto-scaling/` setup and reference docs so production-safe private-IP verification steps are accurate.

#### Validation

1. In staging, the Nomad server advertises the intended private IP after bootstrap.
2. In production, the same bootstrap logic works for the documented `10.1.*` range.
3. A Nomad client node joins successfully using the generalized address logic.
4. Failure logging is still present and understandable if address resolution fails.

#### Acceptance criteria

1. The control plane advertises the correct private IP in production.
2. Agent nodes advertise the correct private IP in production.
3. The chosen mechanism does not depend on a staging-only subnet prefix.

### W4. Align Nomad ACL and token behavior `DONE`

#### Problem

The worker adapter and the shell autoscaler are inconsistent. The adapter supports tokens; the shell scripts do not; the bootstrap comments still describe an unauthenticated cluster.

#### Files likely to change

1. `infra/hetzner/cloud-init.yaml`
2. `infra/hetzner/scripts/scale-common.sh`
3. `infra/hetzner/scripts/check-nomad-capacity.sh`
4. `infra/hetzner/scripts/check-placement-failures.sh`
5. `infra/hetzner/scripts/scale-in.sh`
6. `infra/hetzner/scripts/scale-out.sh`
7. `infra/hetzner/scripts/alert-common.sh`
8. `apps/worker/src/config.ts`
9. `packages/domain/src/config/schema.ts`
10. `infra/hetzner/README.md`
11. `infra/hetzner/docs/auto-scaling/setup-auto-scaling.md`
12. `infra/hetzner/docs/auto-scaling/useful.md`

#### Task breakdown

##### W4.1 Enable Nomad ACLs at the infrastructure layer

1. Update the Nomad bootstrap path so ACLs are actually enabled, not just mentioned as future work.
2. Ensure the bootstrap process yields a usable token model for automation and worker access.
3. Keep the implementation explicit about which token or policy each consumer uses.

##### W4.2 Add token-aware shell access

1. Extend `nomad_api()` in `scale-common.sh` to attach the Nomad token when configured.
2. Ensure all scripts that go through `nomad_api()` inherit the same auth behavior automatically.
3. Make missing token configuration fail clearly where ACLs are required.

##### W4.3 Inject tokens into systemd services

1. Add the required Nomad token environment variables to all relevant autoscale and watcher services.
2. Ensure the environment injection path is compatible with control-plane automation and reboot recovery.
3. Keep token handling out of hard-coded script literals.

##### W4.4 Align worker config and schema

1. Re-check worker config mapping so the worker continues to resolve `NOMAD_TOKEN` and related values correctly.
2. Ensure the schema, bootstrap docs, and production expectations all agree that authenticated Nomad access is required.
3. Tighten any stale comments or defaults that imply anonymous production access.

##### W4.5 Update operator docs

1. Document how ACL bootstrap works.
2. Document what secrets must exist on the control plane for autoscale services.
3. Document how to verify authenticated Nomad API access from the worker and from the control plane.
4. Update the `infra/hetzner/docs/auto-scaling/` guides so their commands and prerequisites assume authenticated Nomad access where required.

#### Validation

1. Worker startup succeeds with authenticated Nomad access.
2. `check-nomad-capacity.sh`, `scale-out.sh --dry-run`, and `scale-in.sh --dry-run` all succeed when the token is present.
3. The same commands fail loudly and early when the token is missing in an ACL-enabled environment.
4. Updated docs no longer describe an unauthenticated production Nomad cluster.

#### Acceptance criteria

1. Worker and autoscale scripts use the same authentication model.
2. Production documentation no longer says two conflicting things about Nomad authentication.
3. A production operator can verify the expected auth path without reading source code.

### W5. Add tests and rollout-facing documentation `PENDING`

#### Problem

The current scale-in path has little direct test evidence, and some older orchestration docs are now stale relative to the code.

#### Files likely to change

1. shell tests or script-level test harness files under `infra/hetzner/scripts/` if introduced
2. `infra/hetzner/README.md`
3. `infra/hetzner/docs/auto-scaling/setup-auto-scaling.md`
4. `docs/features/2026/07/08/004-orchestration/005-production-runbook.md`
5. `docs/features/2026/08/28/001-nomad-production-scale-in-readiness/002-production-validation-plan.md`
6. any new bug report or lessons doc produced during implementation
7. `infra/hetzner/docs/auto-scaling/useful.md`
8. `infra/hetzner/docs/auto-scaling/lessons-learnt.md`

#### Task breakdown

##### W5.1 Add focused coverage for W2

1. Add automated checks around backend-readiness logic.
2. Add automated checks around environment targeting and failure messages.
3. Ensure the tests exercise the shared helper layer rather than only the top-level scripts.

##### W5.2 Add focused coverage for W4

1. Add automated checks proving `nomad_api()` sends the token when configured.
2. Add automated checks proving ACL-enabled flows fail clearly when the token is missing.

##### W5.3 Add focused coverage for W1 and failure hooks

1. Add a deterministic test for the drain-timeout branch after the W1 fix.
2. Add or document a staging-only hook that simulates drain timeout without relying on real cluster instability.
3. Add or document a staging-only hook that simulates Terraform apply failure without damaging staging state.
4. Ensure those hooks are guarded so they cannot be used accidentally in production.

##### W5.4 Refresh rollout-facing docs

1. Update the main Hetzner README so it matches the new backend, ACL, and scale-in behavior.
2. Update the setup and orchestration runbooks so they no longer rely on stale local-state assumptions.
3. Update the production validation plan with the exact operator steps that use the new hooks.
4. Update `infra/hetzner/docs/auto-scaling/` so setup, troubleshooting, and command references all match the final implementation.

##### W5.5 Capture operator recovery guidance

1. Document what an operator should inspect when backend initialization fails.
2. Document what an operator should inspect when Nomad token auth fails.
3. Document what an operator should inspect when a drain timeout is intentionally induced during staging validation.

#### Validation

1. The highest-risk shell helper logic is covered by automated checks.
2. The staging validation plan contains concrete commands for both failure-injection hooks.
3. The runbooks and README agree on backend, auth, and recovery behavior.
4. Production-facing docs no longer depend on tribal knowledge about local tfstate or anonymous Nomad access.

#### Acceptance criteria

1. The highest-risk branches are covered by automated checks.
2. The production validation plan can reference current docs rather than stale assumptions.

## Suggested Order

1. Implement W2.
2. Implement W4.
3. Implement W1.
4. Implement W3.
5. Implement W5.

## Exit Criteria

This plan is complete when:

1. the code no longer destroys nodes after a failed drain window
2. server-side autoscale operations use the agreed AWS S3-backed remote backend safely in both staging and production
3. Nomad bootstrap no longer assumes a staging-only private subnet
4. Nomad authentication behavior is internally consistent and documented
5. the separate production validation plan can be executed without unresolved design ambiguity

## Production Readiness Boundary

Completion of this plan means the implementation is ready for serious staging validation.

It does **not** mean production scale-in should be enabled immediately.

Production becomes eligible only after the separate validation plan has been executed successfully and reviewed.