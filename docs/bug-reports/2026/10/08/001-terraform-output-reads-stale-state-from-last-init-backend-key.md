# Bug: `terraform_output` reads whichever env's backend key was last init'ed (staging deploy aborts at step 3)

**Date:** 2026-10-08
**Severity:** HIGH. Every herobids helper that reads Terraform outputs (`deploy.sh`,
`setup-control-plane.sh`, `push.sh`/`seed-admin.sh`/`reset.sh`/`smoke-test.sh` IP auto-detect,
the autoscale smoke/trigger tests) silently read the **wrong environment's state**. Today it
aborted the staging deploy; with no explicit IP it would have targeted a stale server
(`78.46.192.37`) from a legacy state file.
**Status:** FIXED in `96c4d440`, but the fix was incomplete. Once the legacy objects below were deleted, it aborted the next staging deploy at the same step. Completed by `docs/bug-reports/2026/10/08/005-terraform-output-init-aborts-on-stale-shared-workspace-selection.md`.
**Fix location:** herobids `infra/hetzner/scripts/_ssh_opts.sh` (`terraform_output`),
`infra/hetzner/deploy.sh` (source backend env before the first Terraform read),
`infra/hetzner/scripts/tests/test-converge-control-plane.sh`.

## Symptom

```
$ infra/hetzner/deploy.sh --env staging 138.199.172.202 --env-file infra/hetzner/.env.staging
── Step 3/6: Converge control plane ──
ERROR: Could not determine the private subnet CIDR from terraform output private_subnet_ip_range (workspace staging) (got '').
```

`nomad_enabled` resolved to `true`, but `private_subnet_ip_range` was empty.

## Root cause

The S3 backend key (`herobids/<env>/terraform.tfstate`) is fixed at `terraform init` time;
`terraform workspace select` only picks the `env:/<workspace>/` prefix. `terraform_output` in
`_ssh_opts.sh` only ran `workspace select`, never `init`. The local
`infra/hetzner/.terraform/terraform.tfstate` was last init'ed for production on 2026-10-07
(during the bug 002/003 rollout), so `--env staging` read:

| S3 object | Last written | Server | `private_subnet_ip_range` |
|---|---|---|---|
| `env:/staging/herobids/production/terraform.tfstate` (read) | 2026-08-28 | `78.46.192.37` | absent (predates the output) |
| `env:/staging/herobids/staging/terraform.tfstate` (correct) | 2026-10-07 | `138.199.172.202` | `10.0.0.0/24` |

The 2026-10-07 deploys worked only because the local backend happened to point at the right
key at the time. `docs/features/2026/09/24/002-staging-recovery-diagnostic-plan.md` already
warned about this; traderton's `_ssh_opts.sh` was fixed the same way.

## Fix

- `terraform_output` runs `terraform init -reconfigure` with
  `key=herobids/${HEROBIDS_ENV}/terraform.tfstate` before `workspace select` + `output`
  (~2 s per call). This mirrors `tf_init_backend` and `provision.sh`.
- When `TF_BACKEND_BUCKET` is unset it sources `${TF_DIR}/.env.backend` inside its subshell.
  Without creds it fails loudly and never queries a stale backend.
- `deploy.sh` sources `--backend-env-file` before the IP auto-detect and the private-IP guard,
  so those reads use the same creds.

## Verification

- `test-converge-control-plane.sh` asserts the staging key is init'ed before any output read,
  and that missing creds fail without running Terraform. The new cases fail against the old
  `_ssh_opts.sh` (6 failures) and pass with the fix. `infra/hetzner/scripts/tests/run-all.sh`
  passes.
- Live, read-only: `terraform_output` resolves staging → `138.199.172.202` / `10.0.0.0/24`,
  production → `167.233.213.107` / `10.0.0.0/24`. This only passed because the legacy
  `env:/production/herobids/staging/...` object still existed, so the leftover local
  `production` selection was valid under the staging key. See 005.

## Follow-up (not done; needs operator approval)

Two legacy cross-keyed state objects remain in the bucket and are what the bug read:
`env:/staging/herobids/production/terraform.tfstate` and
`env:/production/herobids/staging/terraform.tfstate` (both from 2026-08-28). Archive or delete
them once you're sure nothing references them.

**Done 2026-10-08 ~15:57.** Both objects were copied to `archive/2026-10-08/env:/...` in the
same bucket and then deleted (S3 delete markers, so earlier versions are still recoverable).
That deletion exposed bug 005.
