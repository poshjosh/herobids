# Bug: `terraform_output` init aborts on a workspace selection left over from the other env (staging deploy aborts at step 3)

**Date:** 2026-10-08
**Severity:** HIGH. After any production Terraform read on the operator machine, every
staging helper that reads Terraform outputs fails (`deploy.sh` step 3, IP auto-detect in
`push.sh`/`seed-admin.sh`/`reset.sh`/`smoke-test.sh`). The deploy aborts loudly. Nothing is
misdeployed. Workaround: `HEROBIDS_NOMAD_ENABLED=true HEROBIDS_PRIVATE_SUBNET=10.0.0.0/24`.
**Status:** FIXED. Not committed yet.
**Fix location:** herobids `infra/hetzner/scripts/_ssh_opts.sh` (`terraform_output`),
`infra/hetzner/scripts/setup-control-plane.sh`, `infra/hetzner/scripts/tests/test-converge-control-plane.sh`,
`.gitignore`, `infra/hetzner/README.md`.
**Related:** `001-terraform-output-reads-stale-state-from-last-init-backend-key.md` (this completes its fix).

## Symptom

```
$ infra/hetzner/deploy.sh --env staging 138.199.172.202 --env-file infra/hetzner/.env.staging
── Step 3/6: Converge control plane ──
ERROR: Could not determine whether Nomad is enabled for staging (terraform output nomad_enabled (workspace staging) = '').
  terraform said:
    │ Error: Currently selected workspace "production" does not exist
```

## Root cause

Every herobids script shares one data dir, `infra/hetzner/.terraform/`. It holds both the
backend config (`terraform.tfstate`, with the key) and the selected workspace (`environment`).

- Bug 001's fix made `terraform_output` run `terraform init -reconfigure` with
  `key=herobids/${HEROBIDS_ENV}/terraform.tfstate` and then `workspace select`.
- But `init` first checks the *currently selected* workspace against the new key's workspaces.
  `.terraform/environment` still said `production` from the last production read.
- So init against the staging key aborted with `Currently selected workspace "production" does
  not exist`, before `workspace select staging` could run. Reproduced by hand with the same
  init command (exit 1).
- It worked when 001 was verified (15:56) only because the legacy
  `env:/production/herobids/staging/terraform.tfstate` object made `production` a valid
  workspace under the staging key. Archiving and deleting it (15:57, 001's follow-up) exposed the bug.
- The `terraform said:` excerpt was cut at 5 lines (`head -5`). That hid the helper's own
  `terraform init failed` line, which pointed at the real step.

This is the second bug from the shared data dir. `docs/features/2026/09/24/002-staging-recovery-diagnostic-plan.md`
already prescribed an isolated `TF_DATA_DIR`, and `provision-staging.sh` (2b82052e) uses one.
`terraform_output` did not.

## Fix

- `terraform_output` uses a per-env data dir, `TF_DATA_DIR=${TF_DIR}/.terraform-envs/<env>`
  (gitignored). That dir only ever holds its own env's key and selection, so init cannot trip on
  the other env.
- It no longer re-inits the shared `.terraform/`, so operators' manual sessions are no longer
  silently repointed at whatever env a deploy last read.
- Inherited `TF_WORKSPACE` is unset in the helper's subshell, as `provision-staging.sh` does, so
  an operator's shell cannot override the selection.
- `workspace select` (never `new`) stays as the existence check. Rejected alternative: pinning
  `TF_WORKSPACE` and dropping `select`. `terraform output` against a missing workspace *writes*
  an empty state object to S3. A probe during this investigation created
  `env:/nonexistent/herobids/staging/terraform.tfstate` that way.
- Cost: the first call per env installs providers into its data dir (~24 MB each). Each call
  takes ~4–5 s (init + select + output).
- `setup-control-plane.sh` shows up to 12 lines of the Terraform error instead of 5.
- README: the workspace section and the "Operator init" steps now say the key is fixed at init,
  and use the per-env `TF_DATA_DIR` with `init -reconfigure` for manual sessions.

## Verification

- New case in `test-converge-control-plane.sh` covers a shared `.terraform/environment` of
  `production` plus inherited `TF_WORKSPACE=production`. The Terraform stub now models init's
  workspace check. The case asserts:
  - the staging read succeeds
  - only `.terraform-envs/staging` is used
  - the shared dir is left untouched
- Against the HEAD `_ssh_opts.sh` the new case fails (5 failures, same error as the deploy). With
  the fix it passes. `infra/hetzner/scripts/tests/run-all.sh` passes.
- Live, read-only, with the shared dir selecting `production` and `TF_WORKSPACE=production`
  exported:
  - staging → `nomad_enabled=true`, `138.199.172.202`, `10.0.0.0/24`, `environment=staging`
  - production → `true`, `167.233.213.107`, `10.0.0.0/24`, `environment=production`
  - staging again → same as the first staging read
- A diff of S3 object versions before and after shows no new objects or versions. The shared
  `.terraform/` checksums are unchanged.
- Not verified: a full `deploy.sh --env staging` run (operator to re-run).

## Follow-up (not done; needs operator approval)

- Delete the stray `env:/nonexistent/herobids/staging/terraform.tfstate` (181 B, empty state)
  created by the probe above.
Done 2026-10-08 (not committed):
- `provision.sh`, `destroy.sh` and the `scale-common.sh` autoscaler helpers: fixed in
  `006-provision-destroy-autoscaler-share-terraform-data-dir.md`.
- traderton `terraform_output` and `plan-apply.sh`: fixed in traderton
  `docs/bug-reports/2026/10/08/001-terraform-output-shares-data-dir-across-envs.md`.
- `docs/features/2026/09/24/002-staging-recovery-diagnostic-plan.md`: annotated.
- `terraform_output` now also unsets inherited `TF_CLI_ARGS*`, which an operator's shell could
  use to inject arguments into init/workspace/output.
