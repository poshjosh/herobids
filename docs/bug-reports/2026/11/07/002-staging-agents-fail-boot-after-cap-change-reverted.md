# 002 — Staging Agents Fail to Boot After Nomad Cap Change (Reverted)

- **Status:** Reverted on `main`; cap change not deployed. Staging agents need a redeploy after the revert.
- **Severity:** High (all staging agents stopped; boot fails)
- **Date:** 2026-11-07
- **Related:** [001 — Nomad agent tasks missing sandbox capabilities](./001-nomad-agent-tasks-missing-sandbox-caps.md)

## Summary

Commit `ffc77878` (fix for 001) added `cap_add: ['NET_ADMIN', 'SYS_ADMIN']` to Nomad agent job specs and `allow_caps` to the Nomad client cloud-init. It was deployed to staging in `3d8d74af` (v0.8.10). The maintenance restart at 14:09 CET then left agents unable to boot. Each agent was placed, did not connect within the 120 s boot window, and was purged by the worker.

## Timeline (CET)

| Time | Event |
|---|---|
| 13:42 | `ffc77878` committed to `main`: cap change, fault-text change, tests, bug report 001 |
| 14:08 | `3d8d74af` (v0.8.10) committed on `main` |
| 14:09 | Maintenance restart started (`--env staging`, deploy + restart). Six agents stopped |
| 14:13–14:15 | Six agents queued at 30 s intervals; Nomad jobs registered and marked placed |
| 14:15:12 | First job purged by the worker ("boot window expired"), no heartbeat |
| 14:17 | Alert for "Job searcher" (`bb11883d`): "placed on capacity but did not connect before the boot window expired" |

## Evidence

- The worker log shows `Nomad job registered`, then `first placement recorded`, then `Nomad job stopped and purged` 120 s later, with no heartbeat.
- No agent `nomad` allocations remained when checked (purged). Client logs could not be read.
- The Nomad client nodes' SSH host keys changed after Oct 31 (`herobids-staging-agent-2`, `herobids-staging-agent-3`). Their identity is not yet confirmed. Nodes were not re-verified before the revert.
- `herobids-staging-agent-2` was last updated 22 hours before the check, so it predates the cloud-init change. Its docker plugin very likely does not allow `NET_ADMIN` or `SYS_ADMIN`.
- The restart script's `Running agent containers: 0` check is Docker-only and says nothing about Nomad agents.

## Root Cause (probable, not confirmed)

The job spec requests `NET_ADMIN` and `SYS_ADMIN`. Existing Nomad clients do not allow them, so the task cannot start. Cloud-init changes apply only to new nodes. The alloc errors would confirm this, but they were not retrievable.

Also possible: the agent image on GHCR (`herobids-agent:latest`) lagged the `3d8d74af` build. The restart script rebuilds the image only on the control host, and Nomad pulls from GHCR.

## Decision: Revert

Sandbox fix left in place means no agent boots on staging. Revert the three cap-related files to their v0.8.9 state. The fault-text change, tests for it, and the docs stay.

- Reverted files: `apps/worker/src/agents/nomad-runtime-adapter.ts`, `apps/worker/src/agents/nomad-runtime-adapter.test.ts`, `infra/hetzner/cloud-init-nomad-client.yaml`.
- Restored from `60cc5ad1`. `ffc77878` is the only commit touching these files since v0.8.9, so the revert is exact.
- Sandbox errors (`execute_code` / `execute_shell`) return as before.

## Follow-up (before re-applying the cap change)

1. Confirm the identity of `herobids-staging-agent-2` and `-3` (Hetzner console, ED25519 host key).
2. Roll out `allow_caps` to existing Nomad clients: drain, edit the docker plugin, restart Nomad, undrain. Do not rely on cloud-init alone.
3. Re-apply `cap_add` only after step 2 is confirmed on every client.
4. Verify on staging: one agent boots, and `execute_shell` runs without `sandbox_infrastructure_error`.
5. Only then deploy to production. Production uses the same Nomad backend.

## Deploy

After the revert commit is on `main`:

1. Wait for the `build-push-agent` workflow to finish (it publishes `ghcr.io/poshjosh/herobids-agent:latest`).
2. Deploy to staging: `infra/hetzner/scripts/push.sh --env staging --yes`.
3. Restart stopped agents once the deploy is healthy.
