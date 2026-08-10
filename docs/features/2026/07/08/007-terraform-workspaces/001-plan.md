# Terraform Workspaces for Multi-Environment State Isolation

## Status

`implemented`

## Problem

The current Terraform setup in `infra/hetzner/` uses a single `terraform.tfstate` file shared across staging and production. This creates several problems:

1. **Terraform cannot manage two independent servers from one state.** When staging was provisioned via `--var-file staging.tfvars`, Terraform wrote that server into `terraform.tfstate`. If an operator later provisions production against the same state file, Terraform will see the staging server and attempt to reconfigure it — not create a new production server.

2. **`terraform output` returns the wrong server IP.** Both `deploy.sh` and manual operators rely on `terraform output -raw server_ipv4` to discover the target server. Without environment-specific state, that command returns whichever server was last applied — potentially the wrong one for the intended deploy target.

3. **SSH key auto-detection only reads `terraform.tfvars`.** The `_ssh_opts.sh` script parses `ssh_public_key_path` from `terraform.tfvars` to build `SSH_OPTS`. But when operators use `--var-file staging.tfvars` (bypassing the symlink convention), the key path is left unresolved, causing SSH connection failures during deploys.

4. **No operator guard against cross-environment mistakes.** Running `terraform destroy` without a workspace check could destroy the wrong environment. Running `deploy.sh --env staging` could deploy to the production server if the operator forgot to reconfigure.

5. **The README acknowledges this gap.** The environment table in `infra/hetzner/README.md` says `Terraform state: Separate terraform.tfvars per environment (future: workspaces)`. This plan implements that future.

## Goals

1. Give staging and production independent Terraform state via workspaces so each can be provisioned, planned, applied, and destroyed without affecting the other.
2. Make all deploy scripts (`provision.sh`, `deploy.sh`, `push.sh`, `setup-env.sh`, `logs.sh`) workspace-aware so they always target the correct environment.
3. Make SSH key auto-detection work reliably for both `terraform.tfvars` (symlinked) and `{environment}.tfvars` (standalone) conventions.
4. Eliminate the need for manual state-file symlinking or `-state` flags on every command.
5. Keep the operator experience simple: `--env staging` is the only switch needed.

## Non-Goals

1. Do not change the infrastructure topology (Hetzner, Docker Compose, Nomad) — this is purely a state-management change.
2. Do not introduce Terraform Cloud, remote backends, or state locking — keep the existing local-backend model.
3. Do not change the tfvars file structure — `staging.tfvars` and `production.tfvars` remain separate files.
4. Do not migrate existing state — current staging state remains as-is; this plan ensures future operations are safe.
5. Do not add CI/CD integration beyond what the scripts already support.

## Current State Summary

The following gaps exist in the current setup:

1. `provision.sh` runs `terraform init/plan/apply` against the default workspace with the default `terraform.tfstate`. It accepts `--var-file` but does not select a workspace.
2. `deploy.sh` auto-detects the server IP via `terraform output -raw server_ipv4`, which reads from the active workspace (always `default`). No workspace selection occurs.
3. `_ssh_opts.sh` reads `ssh_public_key_path` only from `terraform.tfvars` — it does not fall back to `{HEROBIDS_ENV}.tfvars`.
4. The `terraform.tfstate` file currently contains the staging server (`herobids-staging`, IP `128.140.55.192`).
5. No `.gitignore` entry exists for `terraform.tfstate.d/` (the workspace state directory).
6. The README marks workspaces as `(future: workspaces)`.

## Design Principles

1. **One switch to rule them all.** `--env staging|production` (or `HEROBIDS_ENV`) must be the single source of truth — no separate `--workspace` flag.
2. **Workspace names match environment names.** `staging` and `production` are the workspace names. The `default` workspace is deprecated and should not be used.
3. **Scripts are idempotent.** Running `provision.sh --env staging` twice in a row should `terraform plan` and show no changes, not fail or create a duplicate workspace.
4. **Backward compatible with existing state.** The current `terraform.tfstate` (containing staging) will be migrated into the `staging` workspace. No resources are destroyed.
5. **SSH key detection is environment-aware.** If `${HEROBIDS_ENV}.tfvars` exists and contains `ssh_public_key_path`, use it. Fall back to `terraform.tfvars`. Allow `HEROBIDS_SSH_KEY` env var override as a final escape hatch.

## Proposed End State

After this feature lands:

1. Two Terraform workspaces exist: `staging` and `production` (the `default` workspace is empty or absent).
2. `provision.sh --env staging` selects the `staging` workspace before any Terraform command. Same for `production`.
3. `deploy.sh`, `push.sh`, `setup-env.sh`, and `logs.sh` all select the correct workspace before calling `terraform output`.
4. SSH key auto-detection reads from the correct tfvars file per environment.
5. `terraform.tfstate.d/` is gitignored.
6. The README no longer says `(future: workspaces)`.
7. An operator can switch between staging and production by changing only the `--env` flag.

## Implementation Plan

### Phase 1 — Add workspace support to `provision.sh`

#### Goal

Make `terraform init/plan/apply` environment-aware via workspace selection.

#### Files

- `infra/hetzner/scripts/provision.sh`

#### Tasks

1. After `HEROBIDS_ENV` is determined and before `terraform init`, select or create the workspace:
   ```bash
   terraform workspace select "${HEROBIDS_ENV}" 2>/dev/null || \
     terraform workspace new "${HEROBIDS_ENV}"
   ```
2. If `--var-file` is provided, resolve its path relative to `TF_DIR` (already done). The var-file is still passed as `TF_CLI_ARGS="-var-file=..."` to all terraform commands — this behavior is unchanged.
3. Add a warning if the operator is on the `default` workspace (deprecated).
4. Update the `--help` output to mention workspaces.
5. If the workspace is `production`, print a bright confirmation prompt before `apply` (in addition to the existing plan-review prompt).

#### Expected Result

`provision.sh --env staging` operates on the `staging` workspace. `provision.sh --env production` operates on the `production` workspace. Resources from different environments never appear in the same plan.

#### Validation

1. Run `provision.sh --env staging` → plan shows staging resources only.
2. Run `provision.sh --env production --var-file production.tfvars` → plan shows a new production server (no staging resources).
3. Run `provision.sh --env staging` a second time → plan shows no changes (idempotent).

---

### Phase 2 — Make deploy scripts workspace-aware

#### Goal

Ensure all scripts that call `terraform output` select the correct workspace first.

#### Files

- `infra/hetzner/deploy.sh`
- `infra/hetzner/scripts/push.sh`
- `infra/hetzner/scripts/setup-env.sh`
- `infra/hetzner/scripts/logs.sh`
- `infra/hetzner/scripts/seed-admin.sh`
- `infra/hetzner/scripts/reset.sh`
- `infra/hetzner/scripts/reset-and-run.sh`
- `infra/hetzner/scripts/maintenance-restart-from-local.sh`

#### Tasks

1. Audit every script that calls `terraform output` via a repo-wide search (for example, `rg "terraform output" infra/hetzner`). Include wrappers outside the main deploy path, not just the scripts already expected to change.
2. Add a shared helper function `terraform_output()` to `_ssh_opts.sh` that:
   - Executes in a subshell from `TF_DIR`
   - Selects the correct workspace before reading outputs
   - Returns a clear, user-facing error when the workspace does not exist yet
   - Avoids mutating the caller's current shell state outside the helper
3. Replace all inline Terraform output lookups with the helper, including `server_ipv4`, `frontend_url`, and `api_url`.
4. Ensure both `deploy.sh` and `maintenance-restart-from-local.sh` call the helper instead of invoking `terraform output` directly.

#### Expected Result

Every script that needs a server IP, SSH command, or any Terraform output always gets the value for the correct environment.

#### Validation

1. `deploy.sh --env staging` prints the staging server IP, not the production one.
2. `deploy.sh --env production` prints the production server IP (once provisioned).
3. `maintenance-restart-from-local.sh --env staging` resolves the staging IP, not the active/default workspace IP.
4. Scripts that run before provisioning (e.g., `setup-env.sh` before `provision.sh`) fail with a clear message rather than a cryptic Terraform error.

---

### Phase 3 — Fix SSH key auto-detection for per-environment tfvars

#### Goal

`_ssh_opts.sh` must find the SSH private key regardless of whether the operator uses `terraform.tfvars` (symlinked) or `{environment}.tfvars` (standalone).

#### Files

- `infra/hetzner/scripts/_ssh_opts.sh`

#### Tasks

1. Refactor SSH key discovery into a helper (for example, `resolve_ssh_key()`) instead of doing the lookup eagerly at file-load time.
2. Call that helper only after `HEROBIDS_ENV` is known:
    - once after defaulting `HEROBIDS_ENV`, and
    - again at the end of `parse_env_flag()` when `--env` overrides the default.
3. Keep the lookup precedence explicit and stable:
    - `HEROBIDS_SSH_KEY` env var override first
    - `terraform.tfvars` next
    - `${HEROBIDS_ENV}.tfvars` fallback last
4. Rebuild `SSH_OPTS` and re-export `HEROBIDS_SSH_KEY` whenever the helper reruns so child scripts always see the environment-correct key.

#### Expected Result

SSH connections work whether the operator uses `ln -sf staging.tfvars terraform.tfvars` or `provision.sh --var-file staging.tfvars`.

#### Validation

1. With `terraform.tfvars` symlinked to `staging.tfvars`: SSH key detected correctly.
2. Without `terraform.tfvars`, with only `staging.tfvars` present and `--env staging`: SSH key detected from `staging.tfvars`.
3. Without `terraform.tfvars`, with only `production.tfvars` present and `--env production`: SSH key detected from `production.tfvars`.
4. With `HEROBIDS_SSH_KEY=~/custom_key` set: custom key used regardless of tfvars.

---

### Phase 4 — Migrate existing state into the `staging` workspace

#### Goal

Move the current `terraform.tfstate` (which contains the staging server) into the `staging` workspace without destroying or recreating any resources.

#### Tasks

1. Document a one-time migration procedure:
   ```bash
   cd infra/hetzner

   # 1. Back up the current default workspace state file.
   cp terraform.tfstate terraform.tfstate.pre-workspaces.backup

   # 2. Create the staging workspace from that state file.
   terraform workspace new -state=terraform.tfstate staging

   # 3. Verify staging workspace has the correct state.
   terraform workspace select staging
   terraform state list   # should show all existing resources

   # 4. Archive the old default-workspace state file so `default`
   #    no longer points at the same live resources.
   mv terraform.tfstate terraform.tfstate.default.pre-workspaces.backup

   # 5. Confirm the default workspace is now empty.
   terraform workspace select default
   terraform state list   # should show no resources
   ```
2. Treat migration as an explicit one-time operator step, not something `provision.sh` does implicitly.
   - `provision.sh --env staging` may create a brand-new empty workspace for fresh environments.
   - It must not assume that `terraform workspace new staging` automatically migrates the current default state.
3. Document what to do if the operator has already created a workspace:
   - If `staging` already exists and contains the correct state, no migration is needed.
   - If `staging` exists but is empty, recreate it from a backup or manually `terraform state push` from the saved state file.

#### Expected Result

The `staging` workspace contains the existing `herobids-staging` server and all associated resources. The legacy `terraform.tfstate` file is archived so the `default` workspace is empty and no longer duplicates live staging resources. The `production` workspace is created fresh when first provisioned.

#### Validation

1. `terraform workspace select staging && terraform state list` shows all staging resources.
2. `terraform workspace select default && terraform state list` shows no resources.
3. No `terraform destroy` was needed at any point.

---

### Phase 5 — Update `.gitignore`

#### Goal

Prevent workspace state files from being committed.

#### Files

- `.gitignore`

#### Tasks

1. Add `infra/hetzner/terraform.tfstate.d/` to `.gitignore`.
2. Verify the entry is effective: `git status` should not show workspace state files after provisioning.

#### Expected Result

Workspace-specific state is local-only and never accidentally committed.

#### Validation

1. After provisioning staging, `git status` in `infra/hetzner/` shows no untracked files in `terraform.tfstate.d/`.
2. The existing `terraform.tfstate` and `terraform.tfstate.backup` continue to exist (for the `default` workspace) and remain gitignored (already in `.gitignore`).

---

### Phase 6 — Update documentation

#### Goal

Remove the `(future: workspaces)` note and document the new workspace-based workflow.

#### Files

- `infra/hetzner/README.md`
- `infra/hetzner/remote.tfvars.example` (if it references state conventions)
- `docs/runbooks/staging-smoke-test.md` (the prerequisite about `terraform output`)
- `docs/features/2026/07/08/003-staging-environment-setup/001-plan.md` (if it references state management)

#### Tasks

1. Update the environments table in `infra/hetzner/README.md`:
   - Change `Terraform state` row from `Separate terraform.tfvars per environment (future: workspaces)` to `Terraform workspaces (staging / production)`.
2. Add a "Workspaces" section to the README explaining:
   - How workspaces work (`terraform workspace list`, `terraform workspace select`)
   - That `provision.sh --env` handles workspace selection automatically
   - How to manually inspect state for a specific environment
3. Rewrite manual Terraform examples in the README that currently rely on raw active-workspace behavior (for example, `terraform output -var-file=staging.tfvars` and `ssh root@$(terraform output -raw server_ipv4)`) so they show the workspace-aware workflow.
4. Update the smoke test prerequisite in `docs/runbooks/staging-smoke-test.md`:
   - The existing prerequisite says `terraform output -raw server_ipv4` — replace it with a workspace-aware command sequence (or an explicit wrapper script command).
5. Remove any `(future: workspaces)` references from the codebase.

#### Expected Result

An operator reading the docs understands that environments are isolated by Terraform workspaces and knows how to target the correct one.

#### Validation

1. README accurately describes the workspace-based workflow.
2. README no longer contains raw `terraform output` examples that silently depend on whichever workspace happens to be active.
3. No stale `(future: workspaces)` references remain.
4. Smoke test doc provides the correct commands for getting the staging IP.

---

## Validation Plan

Run validation in this order:

1. **Static review** — read through the modified scripts, confirm no raw `terraform output` calls remain without workspace selection.
2. **State migration verification** — create `staging` from the saved default state using `terraform workspace new -state=...`, verify `terraform state list`, then archive the old `terraform.tfstate` and confirm `default` is empty.
3. **Dry-run `provision.sh`** — `--env staging` selects the staging workspace, plan shows no unexpected changes.
4. **Dry-run `provision.sh` for production** — `--env production --var-file production.tfvars` selects the production workspace, plan shows a new server (no staging resources).
5. **SSH key detection** — verify scripts find the key from `staging.tfvars` and `production.tfvars` independently.
6. **Deploy helper correctness** — `deploy.sh --env staging` and `maintenance-restart-from-local.sh --env staging` auto-detect the staging IP; the production variants resolve the production IP.
7. **Git hygiene** — `git status` shows no untracked workspace state files.

## Rollout Order

1. Implement Phase 1 (workspace support in `provision.sh`).
2. Implement Phase 2 (workspace-aware deploy scripts).
3. Implement Phase 3 (SSH key detection fix).
4. Perform the explicit one-time staging state migration (Phase 4).
5. Add `.gitignore` entry (Phase 5).
6. Update documentation (Phase 6).
7. Run the staging smoke test to confirm nothing is broken.
8. Provision production in its own workspace when ready.

## Post-Implementation Tasks

### One-time migration (operator action)

After the code changes land, the operator must:

1. Back up `terraform.tfstate`, then create `staging` from it with `terraform workspace new -state=terraform.tfstate staging`.
2. Verify `terraform workspace select staging && terraform state list` shows the existing staging resources.
3. Archive the old `terraform.tfstate` file so `default` no longer points at the same live resources.
4. Verify via `terraform workspace list` that both `default` and `staging` exist, and that `terraform workspace select default && terraform state list` shows no resources.

### Future production provisioning

When ready to provision production:

1. Copy `remote.tfvars.example` to `production.tfvars` and fill in values.
2. Run `provision.sh --env production --var-file production.tfvars`.
3. The script creates the `production` workspace and provisions a fresh server.

### Switching between environments for manual Terraform commands

Operators who run `terraform` commands directly must remember:

```bash
cd infra/hetzner
terraform workspace select staging    # or: production
terraform plan                        # now scoped to the correct environment
```

The scripts handle this automatically, but manual commands require the operator to switch.

## Risks And Mitigations

1. **Risk: Workspace state directory grows large and is accidentally deleted.**
   Mitigation: State is local-only, backed by the Hetzner server itself. If state is lost, resources still exist — `terraform import` can recover them. Future work could add remote state (S3, Terraform Cloud) but that's out of scope.

2. **Risk: Operator runs `terraform destroy` in the wrong workspace.**
   Mitigation: Workspace-aware wrappers reduce accidental cross-environment output mistakes, but they do not change Terraform lifecycle policy. Today the control-plane server already has `prevent_destroy = true`, while agent nodes do not. This feature should not rely on a `main.tf` lifecycle change that is out of scope; if stronger destroy protection is needed, track it separately.

3. **Risk: The one-time migration leaves both `default` and `staging` pointing at the same live resources.**
   Mitigation: Use `terraform workspace new -state=terraform.tfstate staging`, verify the new workspace, then archive the original `terraform.tfstate` immediately so the default workspace becomes empty.

4. **Risk: Scripts that don't source `_ssh_opts.sh` still call `terraform output` raw.**
   Mitigation: Phase 2 audits every caller, including secondary wrappers such as `maintenance-restart-from-local.sh`. Validation also checks the README and runbooks for stale raw `terraform output` examples. A final `rg "terraform output" infra/hetzner docs/runbooks` before merging catches stragglers.

## Open Questions

1. Should the `default` workspace be explicitly deleted after migration, or left as an empty shell?
   - **Recommendation:** Leave it. Deleting it requires `terraform workspace delete default` which can only be done when the workspace is empty and not selected. It's harmless and serves as a reminder that `default` is deprecated.

2. Should we add a `HEROBIDS_ENV` guard to `terraform destroy` as a safety measure?
   - **Recommendation:** Not in this feature. Workspace-awareness fixes targeting mistakes for normal operations, but destroy safeguards for agent nodes or manual Terraform use should be handled in a separate follow-up.

3. Should the scripts support `--var-file` + workspace seamlessly, or should we enforce the symlink convention (`terraform.tfvars` always points to the active env)?
   - **Recommendation:** Support both. The `--var-file` flag should work with workspaces (the var-file is environment-specific anyway). The SSH key fallback (Phase 3) handles the case where `terraform.tfvars` doesn't exist. The symlink convention is a convenience, not a requirement.

4. What happens if the operator runs `provision.sh` without `--var-file`? Should it read `${HEROBIDS_ENV}.tfvars` automatically?
   - **Recommendation:** Not in this feature. `--var-file` remains explicit for now. Auto-detection of `{env}.tfvars` could be a follow-up enhancement.
