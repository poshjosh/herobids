# Plan: Converge Autoscale systemd Unit Environment on Every Deploy

**Status:** pending (not implemented)
**Date:** 2026-10-13
**Environment:** production (staging has the same latent defect)

## Problem

The Nomad autoscale systemd units (`nomad-autoscale.service`,
`nomad-scale-in.service`, `nomad-placement-failure-watcher.service`) carry
their autoscale configuration as hard-coded `Environment=` directives in the
unit file. Those directives are baked at **first boot** by `cloud-init.yaml`
(from the `${...}` template variables), and are never updated afterwards.

`hcloud_server.default` has `lifecycle { ignore_changes = [user_data] }`, so an
existing control plane never receives newer cloud-init. `deploy.sh` runs
`setup-control-plane.sh` → `converge-control-plane.sh` on every deploy, but that
script only adds the `EnvironmentFile=-/etc/herobids/autoscale.env` drop-in
(step 3c) — it does **not** reconcile the `Environment=` block.

Result: production's units were frozen at staging-era values (baked 2026-08-08):

| Setting | Unit file (stale) | `production.tfvars` (correct) |
|---|---|---|
| `TF_VAR_max_agent_nodes` | 5 | 9 |
| `TF_VAR_min_agent_nodes` | 0 | 1 |
| `TF_VAR_agent_memory_reservation_mb` | 256 | 512 |
| `TF_VAR_agent_node_server_type` | cpx21 (discontinued) | cx23 |
| `scale_out_memory_threshold_pct` | 20 | 40 |
| `ENABLE_SCALE_IN` | false | true |
| `scale_in_drain_deadline_seconds` | 600 | 900 |
| placement-failure threshold/cooldown | 5 / 600 | 3 / 900 |

The shell scripts read their limits from these env vars (`tf_var()` in
`scale-common.sh`), **not** from `production.tfvars`, so the stale values
directly drive the autoscaler's decisions (wrong ceiling, wrong floor, wrong
free-slot math, scale-in effectively disabled).

## Immediate mitigation (already applied — Option A)

Systemd drop-in overrides written on the production control plane
(`/etc/systemd/system/{nomad-autoscale,nomad-scale-in,nomad-placement-failure-watcher}.service.d/20-production-overrides.conf`)
with the correct production values, then `systemctl daemon-reload`. Verified via
`systemctl show <unit> -p Environment` and dry-runs. This is a **one-time,
hand-applied** fix — it does not survive a re-provision and is not in the repo.

## Durable fix (this plan)

Extend `converge-control-plane.sh` to regenerate the autoscale units'
`Environment=` block from the current environment's values on every run, so a
deploy converges them the same way it already converges `nomad.hcl` and UFW.

### Approach

`converge-control-plane.sh` runs **on the control plane** as root and does not
have the `${...}` template variables (those are only available to
`cloud-init.yaml`'s `templatefile`). The values must therefore come from a
source available on the box. Options:

1. **Read from the deployed `<env>.tfvars`** (`/opt/herobids/infra/hetzner/<env>.tfvars`,
   uploaded by `setup-autoscale-env.sh`). This is the authoritative per-env
   source already on the box. Parse the relevant keys
   (`min_agent_nodes`, `max_agent_nodes`, `agent_node_server_type`,
   `agent_memory_reservation_mb`, `scale_out_*`, `scale_in_*`,
   `placement_failure_*`, `enable_scale_in`, `location`) and rewrite the
   `Environment=` lines. **Preferred** — single source of truth, no new inputs.
2. Pass the values as env vars from `setup-control-plane.sh` (which has local
   Terraform access) into the remote script. More plumbing; only needed if the
   tfvars parse proves fragile.

### Steps

1. Add a `reconcile_autoscale_units` function to `converge-control-plane.sh`
   that, for each of the three units:
   - reads the current values from `/opt/herobids/infra/hetzner/${HEROBIDS_ENV}.tfvars`
     (fall back to `variables.tf` defaults if a key is absent);
   - builds the correct `Environment=` block (mirroring `cloud-init.yaml`);
   - rewrites the unit file only if it differs (`write_if_changed`), preserving
     the `EnvironmentFile=` line and the security-hardening directives.
2. Keep the existing step 3c (EnvironmentFile drop-in) for older boxes.
3. `systemctl daemon-reload` when any unit changed. No Nomad restart needed
   (these are timer-driven oneshots).
4. Extend `scripts/tests/test-converge-control-plane.sh`:
   - a fixture with a stale unit (staging-era values) + a `<env>.tfvars` with
     production values → assert the unit is rewritten to match;
   - assert a converged unit is a no-op on re-run;
   - assert the `EnvironmentFile=` line and hardening directives survive.
5. Add a sync test (like the existing cloud-init sync test) asserting the
   generated `Environment=` block matches `cloud-init.yaml`'s template output
   for the same variable values.

### Node-count file reconcile (folded in — do NOT seed to `agent_node_count`)

`/var/run/nomad-autoscale-node-count` is seeded to `0` at first boot and only
updated after a scale operation, so it drifts from the real node count (on
production it read `0` while 1 node was `ready`, blocking scale-in and making
the next scale-out apply a redundant count).

**Do not "fix" this by seeding the file to `${agent_node_count}`.** That would
embed `agent_node_count` in `user_data`, which forces a control-plane
replacement on every node-count change (lesson #5 in
`auto-scaling/lessons-learnt.md`). The `0` seed is deliberate.

Instead, reconcile at runtime:

1. Add a `reconcile_node_count` step (in `converge-control-plane.sh`, or as a
   small guard in `check-nomad-capacity.sh` / `scale-common.sh`) that:
   - counts `ready` agent nodes via the Nomad API (reuse
     `list_eligible_agent_nodes` / the `NodeClass == "agent"` filter so the
     control-plane client, if any, is excluded);
   - writes the count to `NOMAD_AUTOSCALE_NODE_COUNT_FILE` when it disagrees
     with the cached value (or when the file is missing/`0`).
2. This makes the cached count self-heal from any cause (first boot, manual
   node changes, re-provision), not just the initial seed.
3. Extend `test-converge-control-plane.sh` (or the scale-common tests) to cover:
   - stale `0` + 1 ready node → file rewritten to `1`;
   - matching count → no write;
   - no ready nodes → file left alone (or written to `0`), no error.

### Out of scope / follow-ups

- **`005-production-runbook.md` is stale** (see the STALE banner added there).
- **SMTP alerting** is configured by the operator; not part of this plan.

## Verification

- `bash infra/hetzner/scripts/tests/test-converge-control-plane.sh` passes.
- On a staging box (safe target), run `deploy.sh` and confirm the units are
  rewritten to staging's values and a second run is a no-op.
- On production, after the next `deploy.sh`, confirm
  `systemctl show nomad-autoscale.service -p Environment` still shows the
  production values (the drop-in from Option A can then be removed, since the
  main unit will be correct).