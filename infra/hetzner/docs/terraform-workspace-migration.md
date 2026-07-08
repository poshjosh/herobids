# Terraform Workspace Migration — One-Time Procedure

This document describes the one-time manual procedure to migrate the existing Terraform state (currently in the `default` workspace) into the `staging` workspace.

**Prerequisite:** All Terraform workspace code changes (Phases 1–3) must be deployed first. The scripts must support `--env` workspace selection.

> **⚠️ IMPORTANT — Read Before You Begin:**
>
> - **Do NOT run `provision.sh --env staging` before completing this migration.** `provision.sh --env staging` creates an empty workspace and will NOT migrate existing state. If you have already run it, see the recovery section below.
> - **Ensure no other terraform operations are in progress.** This project uses a local state backend with no state locking. Only one operator should run terraform commands at a time.

## Background

Before workspaces, `infra/hetzner/terraform.tfstate` contained the staging server resources in the `default` workspace. After workspaces are enabled, each environment gets its own workspace (`staging`, `production`). The `default` workspace is deprecated.

`terraform workspace new` creates an **empty** workspace by default (it does NOT copy the current state). The `-state` flag must be used to seed a new workspace from an existing state file.

## Migration Steps

Run these commands from `infra/hetzner/`:

```bash
cd infra/hetzner

# 1. Back up the current default workspace state file.
cp terraform.tfstate terraform.tfstate.pre-migration.backup

# 2. Create the staging workspace from that state file.
terraform workspace new -state=terraform.tfstate staging
```

> **Ignore this message:** Terraform prints *"You're now on a new, empty workspace"* after every `workspace new`, even when the `-state` flag populated it. Your staging workspace **does** contain the state — you'll verify this in step 3.

> ⚠️ **CRITICAL: Stop here until step 4 is complete.** Between steps 2 and 4, both the `default` and `staging` workspaces reference the same live Hetzner resources. Do NOT run `terraform apply`, `terraform destroy`, or `terraform plan` against the `default` workspace — you could modify or destroy live staging infrastructure.

```bash
# 3. Verify the staging workspace has the correct state.
terraform workspace select staging
terraform state list | sort
# Expected output includes:
#   hcloud_firewall.control_plane (if enabled)
#   hcloud_network.private (if Nomad enabled)
#   hcloud_primary_ip.default
#   hcloud_server.default
#   hcloud_ssh_key.default
#   ... (any agent node resources if Nomad enabled)
#
# If the list does not match expectations, STOP and restore from backup.

# 4. Archive the old default-workspace state so `default`
#    no longer points at the same live resources.
mv terraform.tfstate terraform.tfstate.default.archived.backup
# Also archive the backup file — if left in place, Terraform
# may use it as the default workspace state.
mv terraform.tfstate.backup terraform.tfstate.backup.archived 2>/dev/null || true

# 5. Confirm the default workspace is now empty.
terraform workspace select default
terraform state list   # "No state file was found!" is EXPECTED — default is empty ✓
```

## Verification

After migration, verify:

```bash
# Staging workspace has all resources
terraform workspace select staging
terraform state list | sort

# Default workspace is empty
terraform workspace select default
terraform state list   # should output nothing

# Workspace list shows both
terraform workspace list
# Output should show:
#   default
# * staging    (asterisk indicates active)
```

## What If Something Goes Wrong?

### Staging workspace already exists but is empty

If you previously ran `terraform workspace new staging` (without `-state`), the staging workspace exists but has no state. Fix:

```bash
terraform workspace select staging
terraform state push terraform.tfstate.pre-migration.backup
terraform state list   # verify resources are listed
```

### Staging workspace already exists and has the correct state

No action needed. `terraform workspace select staging` succeeds and `terraform state list` shows resources.

### You accidentally ran `provision.sh --env staging` before migration

**Case A — You reviewed the plan but did NOT apply:** No resources were created. Recovery:

1. Delete the empty staging workspace: `terraform workspace select default && terraform workspace delete staging`
2. Follow the migration steps above starting from step 1.

**Case B — You applied the plan (created duplicate resources in Hetzner):** The empty staging workspace now manages real orphaned resources that duplicate your live infrastructure. Recovery:

1. **Destroy the orphaned resources:** `terraform workspace select staging && terraform destroy` (this removes only the duplicate resources)
2. Delete the now-empty staging workspace: `terraform workspace select default && terraform workspace delete staging`
3. Follow the migration steps above starting from step 1.

### You need to roll back

```bash
# Restore the original state file from the golden backup
cp terraform.tfstate.pre-migration.backup terraform.tfstate
terraform workspace select default
terraform state list   # should show resources again
```

## After Migration

- The `staging` workspace contains all existing staging resources.
- `provision.sh --env staging` will now operate on the staging workspace (no changes expected).
- The `default` workspace is empty and deprecated. Do not use it.
- When ready to provision production: `provision.sh --env production --var-file production.tfvars` will create the `production` workspace fresh.
