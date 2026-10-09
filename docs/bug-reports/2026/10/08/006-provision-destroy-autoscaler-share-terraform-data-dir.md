# Bug: `provision.sh`, `destroy.sh` and the autoscaler share one Terraform data dir across envs (cross-keyed workspaces, aborted destroys)

**Date:** 2026-10-08
**Severity:** HIGH.
- `provision.sh` could select or create a workspace under the *other* env's state key. That is
  the likely origin of the legacy cross-keyed objects behind bug 001.
- After switching envs, `destroy.sh` aborted at init. It failed safe, but blocked the teardown.
- Inherited `TF_WORKSPACE` / `TF_CLI_ARGS` could redirect or alter `plan`/`apply`/`destroy`.

**Status:** FIXED. Not committed yet.
**Fix location:** herobids `infra/hetzner/scripts/provision.sh`, `infra/hetzner/scripts/destroy.sh`,
`infra/hetzner/scripts/scale-common.sh`, `infra/hetzner/cloud-init.yaml`,
`scripts/shell/tests/autoscale-smoke-test.sh`, new `infra/hetzner/scripts/tests/test-provision-destroy.sh`,
`infra/hetzner/scripts/tests/test-tf-runtime-helpers.sh`, operator docs.
**Related:** `001-terraform-output-reads-stale-state-from-last-init-backend-key.md`,
`005-terraform-output-init-aborts-on-stale-shared-workspace-selection.md` (same root cause; 005 fixed
`terraform_output` and listed these as follow-ups).

## Root cause

All of these scripts used the one shared `infra/hetzner/.terraform/`. It holds both the backend key
and the selected workspace. The key is fixed at `init`, and `init` checks the selected workspace
against the new key.

- **`provision.sh`** ran `workspace show` and `workspace select || workspace new` *before*
  `init -reconfigure`. Those commands acted on whatever key was last init'ed.
  - Example: `--env staging` after a production session selected or *created* `staging` under the
    production key, i.e. `env:/staging/herobids/production/terraform.tfstate`.
  - Then init with the staging key passed only if that workspace also existed there.
  - This matches the two cross-keyed objects found and archived under bug 001.
- **`destroy.sh`** ran init in the shared dir, then `select`. After a run for the other env, init
  aborted with `Currently selected workspace "<other>" does not exist` (bug 005's failure).
- **Both scripts** stored the var-file in a shell variable named `TF_CLI_ARGS`.
  - That is also a Terraform env var. If the operator's shell exported it, every command, including
    `init` and `workspace`, received `-var-file=...`, and the operator's value was silently replaced.
  - An inherited `TF_WORKSPACE`, from the shell or `.env.backend`, overrode the workspace. It also
    made `workspace select` fail with a misleading "does not exist".
- **`scale-common.sh`** (`tf_init_backend` → `tf_select_workspace` → `tf_apply_var`) has the same
  pattern on the control plane.
  - Each server serves one env, so this is not reachable in normal operation. A manual
    `workspace select` in `/opt/herobids/infra/hetzner` would have made it reachable.
  - Its comment claimed `-reconfigure` "ensures stale local .terraform state doesn't cause drift",
    but `-reconfigure` does not reset the selection.

## Fix

**`provision.sh` and `destroy.sh`:**
- Use the same per-env data dir as `terraform_output`: `TF_DATA_DIR=.terraform-envs/<env>`,
  relative to `infra/hetzner`, gitignored.
- Clear the dir's remembered selection before init, so init always starts from `default`, which
  exists under every key. This means:
  - a missing workspace reaches `provision.sh`'s `new`, or `destroy.sh`'s "Nothing to destroy"
  - instead of aborting init.
- After sourcing the backend file, unset `TF_WORKSPACE` and `TF_CLI_ARGS*`, as
  `provision-staging.sh` already does.
- The var-file is now an array, `VAR_FILE_ARGS`, passed only to plan/apply/destroy.

**`provision.sh` only:**
- Order is now init (env key) → `workspace select || new`, so a workspace is only ever created
  under its own key.
- Dropped the "deprecated default workspace" warning. In a per-env data dir it no longer means
  anything.

**`destroy.sh` only:**
- Unchanged otherwise: `select` only (never `new`), the hard `workspace show` guard, the
  prevent_destroy override and its second init. The second init uses the same data dir.

**`scale-common.sh` and the server side:**
- `tf_use_env_data_dir` exports `TF_DATA_DIR=${TERRAFORM_DIR}/.terraform-envs/<env>` and unsets
  `TF_WORKSPACE`.
- It is called from `tf_init_backend`, `tf_select_workspace` and `tf_apply_var`, so init, select
  and apply share one dir.
- That path is inside the systemd units' `ReadWritePaths` and survives `push.sh`'s `git reset`.
- The `workspace new` fallback and the `workspace show` short-circuit are kept.
- The cloud-init boot-time init uses the same dir. This only affects new servers, because of
  `ignore_changes = [user_data]`.
- `autoscale-smoke-test.sh` step 7 reads `workspace show` from it.

**Docs:**
- README "Terraform Workspaces" and "Debugging", `docs/setup.md`, the runbooks and the auto-scaling
  docs now use `TF_DATA_DIR=.terraform-envs/<env>` for manual `terraform` commands.

**Cost:**
- The first run per env (operator machine and each control plane) installs providers into the new
  dir, about 24 MB.
- Existing `.terraform/` dirs are now unused. They are harmless, and can be deleted.

## Verification

- New `test-provision-destroy.sh` (30 checks) uses a terraform stub that models the S3 backend:
  - workspaces are kept per key
  - init checks the selection against the key
  - workspace commands need a prior init in that data dir
- Its scenarios:
  - the shared dir still selects production, with `TF_WORKSPACE=production` and
    `TF_CLI_ARGS=-lock=false` inherited, and `TF_WORKSPACE` also set in `.env.backend`
  - a brand-new env (no workspace under its key)
  - a remembered selection whose workspace was deleted
  - destroy of a missing workspace
  - production destroy without acknowledgement
- Against the HEAD scripts, 22 of the 30 checks fail, including "no workspace created under the
  production key". With the fix, all pass.
- New suite in `test-tf-runtime-helpers.sh` (7 checks): stale shared selection plus inherited
  `TF_WORKSPACE`. `tf_ensure_ready` + `tf_apply_var` run only in `.terraform-envs/staging`. 6 of the
  7 checks fail against HEAD; all pass with the fix.
- `infra/hetzner/scripts/tests/run-all.sh` passes (370 checks). `bash -n` passes on all scripts.
  `pnpm lint` passes.
- Not verified live: no `provision.sh`/`destroy.sh` run (both mutate infrastructure), and no
  control-plane autoscaler run.
  - After the next deploy, the timer's first run creates `.terraform-envs/<env>` on each control
    plane.
  - Until then, smoke-test step 7 reports `default`.
  - **Regression, found 2026-10-09:** this note underestimated the gap. `release.sh 0.6.6 --all`
    runs the extra tests *before* deploying, against staging still on v0.6.4 (no
    `.terraform-envs/`). The v0.6.5 smoke test read `.terraform-envs/staging`, got `default`, and
    failed step 7 ("Terraform workspace is staging"), which blocked the release.
  - **Fix:** step 7 now reads `.terraform-envs/<env>` if it exists on the server. Otherwise it falls
    back to the shared `.terraform/`, with a warning. It also compares the workspace line exactly
    instead of grepping all output.
  - Verified against live staging (still v0.6.4), read-only: 18/18 pass, with the fallback warning.
    The new-layout branch was checked locally.

## Still open

- The `destroy.sh` prevent_destroy override (`zz_destroy_override.tf`) lives in the shared working
  dir. A concurrent Terraform run in `infra/hetzner` (another shell, a deploy's `terraform_output`)
  sees `prevent_destroy = false` while it exists. Per-env data dirs do not isolate config files.
- `scripts/migrate-backend-to-s3.sh` (one-off, hard-coded `production`) still uses the shared dir.
  This is intentional: `-migrate-state` needs the previous backend recorded there.
