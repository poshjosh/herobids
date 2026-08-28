# Externalize Autoscale Secrets from Cloud-Init

## Status

`draft`

## Problem

The autoscale systemd services on the control plane receive sensitive credentials via inline `Environment=` directives baked into `cloud-init.yaml` at provision time. This creates two issues:

1. **Operator duplication.** The same AWS credentials and Nomad ACL token must be set in two places: environment variables for `provision.sh` (local machine) and Terraform variables in the tfvars file (for cloud-init injection). They hold identical values but serve different consumption paths.

2. **Security exposure.** The credentials appear in Hetzner's `user_data` API field (visible to anyone with Hetzner API access) and are stored verbatim in Terraform state. Moving them to a deployed environment file reduces the exposure surface.

### Affected credentials

| Credential | Current source | Consumers |
|---|---|---|
| `AWS_ACCESS_KEY_ID` | `var.aws_access_key_id` → cloud-init `Environment=` | 3 systemd units, cloud-init `terraform init` |
| `AWS_SECRET_ACCESS_KEY` | `var.aws_secret_access_key` → cloud-init `Environment=` | Same |
| `TF_BACKEND_BUCKET` | `var.tf_backend_bucket` → cloud-init `Environment=` | Same |
| `TF_BACKEND_REGION` | `var.tf_backend_region` → cloud-init `Environment=` | Same |
| `TF_BACKEND_DYNAMODB_TABLE` | `var.tf_backend_dynamodb_table` → cloud-init `Environment=` | Same |
| `NOMAD_TOKEN` | `var.nomad_acl_token` → cloud-init `Environment=` | 3 systemd units, `/etc/nomad.d/acl-token` |

### Current flow

```
Operator sets values in two places:
  1. Shell env vars    → provision.sh → terraform init -backend-config=...
  2. tfvars file       → terraform apply → cloud-init templatefile → systemd Environment=
```

### Proposed flow

```
Operator sets values in one place:
  Shell env vars → provision.sh → terraform init -backend-config=...
                 → deploy.sh uploads env file → systemd EnvironmentFile=
```

## Design

### Core idea

Replace the inline `Environment=` directives for secrets with a single `EnvironmentFile=` directive pointing to a file deployed post-provision by `deploy.sh` or a new `setup-autoscale-env.sh` script.

### Environment file

Path: `/etc/herobids/autoscale.env`  
Permissions: `0600` (root only)  
Format: `KEY=VALUE` (systemd `EnvironmentFile` format, no quoting needed for simple values)

Contents:
```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
TF_BACKEND_BUCKET=herobids-terraform-state
TF_BACKEND_REGION=us-east-1
TF_BACKEND_DYNAMODB_TABLE=herobids-terraform-lock
NOMAD_TOKEN=...
```

### Operator workflow

1. Set env vars in shell (or `.envrc`):
   ```bash
   export TF_BACKEND_BUCKET=herobids-terraform-state
   export TF_BACKEND_REGION=us-east-1
   export AWS_ACCESS_KEY_ID=AKIA...
   export AWS_SECRET_ACCESS_KEY=...
   export NOMAD_ACL_TOKEN=...
   ```

2. Run `provision.sh` — uses env vars for `terraform init` backend config. The tfvars file no longer contains backend or ACL credentials.

3. Run `deploy.sh` (or `setup-autoscale-env.sh`) — generates and uploads `/etc/herobids/autoscale.env` from the same env vars, then runs `systemctl daemon-reload`.

One source of truth. No duplication.

## Task Breakdown

### T1. Create the autoscale environment file upload script

Create `infra/hetzner/scripts/setup-autoscale-env.sh`:
- Reads `TF_BACKEND_BUCKET`, `TF_BACKEND_REGION`, `TF_BACKEND_DYNAMODB_TABLE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `NOMAD_ACL_TOKEN` from the operator's environment.
- Validates required vars are present.
- Generates the `/etc/herobids/autoscale.env` content.
- Uploads it to the server via `scp` (same pattern as `setup-env.sh`).
- Sets `chmod 600`.
- Runs `systemctl daemon-reload` on the server.

Alternatively, integrate this into `deploy.sh` as an additional step alongside the existing `setup-env.sh` call.

### T2. Update systemd service units in cloud-init.yaml

For each of the three service units (`nomad-autoscale.service`, `nomad-scale-in.service`, `nomad-placement-failure-watcher.service`):

1. Remove the inline `Environment=` lines for:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `TF_BACKEND_BUCKET`
   - `TF_BACKEND_REGION`
   - `TF_BACKEND_DYNAMODB_TABLE`
   - `NOMAD_TOKEN`

2. Add:
   ```ini
   EnvironmentFile=-/etc/herobids/autoscale.env
   ```
   The `-` prefix makes the file optional — if it doesn't exist yet, the service starts without those vars (and `tf_backend_configured()` will catch the missing vars gracefully).

3. Keep all non-secret `Environment=` directives (thresholds, paths, `HEROBIDS_ENV`, etc.) inline — they're infrastructure config, not secrets.

### T3. Update cloud-init runcmd terraform init

The `terraform init` step in the runcmd block currently uses the baked-in credentials. Options:

**Option A (recommended):** Make the boot-time `terraform init` conditional on the env file existing. If `/etc/herobids/autoscale.env` doesn't exist at first boot, skip `terraform init` and log a warning. The first autoscale run (via `tf_ensure_ready()`) will handle init when the env file is deployed.

```bash
if [ -f /etc/herobids/autoscale.env ]; then
  . /etc/herobids/autoscale.env
  # ... terraform init with the sourced vars
else
  logger -t cloud-init "INFO: /etc/herobids/autoscale.env not found — terraform init deferred to first autoscale run."
fi
```

**Option B:** Skip the boot-time `terraform init` entirely. Rely on `tf_ensure_ready()` to do it on the first autoscale timer invocation. Simpler, but means the first autoscale run takes longer (init + workspace select + capacity check + possible apply).

### T4. Update cloud-init NOMAD_TOKEN file write

The current runcmd writes `${nomad_acl_token}` to `/etc/nomad.d/acl-token`. This should also come from the environment file instead:

1. Remove the `nomad_acl_token` template variable from the runcmd block.
2. Add a step to `setup-autoscale-env.sh` (or `deploy.sh`) that writes `/etc/nomad.d/acl-token` from `NOMAD_ACL_TOKEN` if it's set.

### T5. Remove unused Terraform variables

Remove from `variables.tf`:
- `tf_backend_bucket`
- `tf_backend_region`
- `tf_backend_dynamodb_table`
- `aws_access_key_id`
- `aws_secret_access_key`
- `nomad_acl_token`

Remove the corresponding entries from:
- `main.tf` templatefile call
- `remote.tfvars.example`
- `production.tfvars` (commented entries)

### T6. Update provision.sh

`provision.sh` already reads `TF_BACKEND_BUCKET` etc. from environment variables — no change needed there. But remove any documentation that tells operators to put these values in tfvars.

### T7. Update deploy.sh

Add the autoscale env file upload step to `deploy.sh`'s sequence:
1. `setup-env.sh` — upload `.env` (app secrets)
2. **`setup-autoscale-env.sh`** — upload `autoscale.env` (infra secrets) *(new)*
3. `push.sh` — git pull, build, compose up
4. `seed-admin.sh` — seed admin user
5. verify — health check

### T8. Update scale-common.sh tf_ensure_ready

`tf_ensure_ready()` already handles backend init. Verify it works correctly when called for the first time after deploy (no prior `terraform init` from cloud-init). The `-reconfigure` flag in `tf_init_backend()` should handle this — confirm with a test.

### T9. Update documentation

- `infra/hetzner/README.md` — Update the "Terraform Remote Backend (S3)" and "Nomad ACL Authentication" sections to describe the new single-source workflow.
- `infra/hetzner/docs/auto-scaling/setup-auto-scaling.md` — Remove tfvars-based credential setup, add `setup-autoscale-env.sh` step.
- `infra/hetzner/docs/auto-scaling/useful.md` — Update recovery guidance.

### T10. Update tests

- Add a test to verify `tf_ensure_ready()` works when no prior `terraform init` has run (simulating the deferred-init path).
- Verify the systemd `EnvironmentFile=-` pattern works with the existing test harness (source the env file before running the test functions).

## Caveats

1. **First-boot gap.** After `provision.sh` completes and before `deploy.sh` runs, the autoscale timer will fire but `tf_backend_configured()` will fail (missing env vars). This is a graceful failure — the timer logs the error and retries on the next cycle. The gap closes when `deploy.sh` uploads the env file. This is acceptable: the app itself also doesn't work until `deploy.sh` uploads `.env`.

2. **Server recreation.** If Terraform recreates the control-plane server (new `user_data`), the uploaded env file is lost. The operator must re-run `deploy.sh` — same as they already do for `.env`. Not a new operational burden.

3. **Reboot recovery.** The env file is on persistent disk (`/etc/herobids/autoscale.env`). Reboots don't lose it. Only full server replacement does.

## Non-Goals

- Do not change how non-secret `Environment=` directives work (thresholds, paths, etc.). Those remain inline in cloud-init and change only at provision time.
- Do not redesign `deploy.sh` beyond adding one upload step.
- Do not change how the worker container receives `NOMAD_TOKEN` — it reads from `.env.prod`, which is a separate concern.

## Acceptance Criteria

1. Operators set AWS/backend credentials and Nomad ACL token in one place (shell environment).
2. `provision.sh` and `deploy.sh` both consume from that single source.
3. No sensitive credentials appear in `user_data` or Terraform state.
4. Autoscale services work after `deploy.sh` without requiring a re-provision.
5. The first-boot gap is documented and degrades gracefully (no crash, just a logged warning).
