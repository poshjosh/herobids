# 001 — Nomad Agent Tasks Missing Sandbox Capabilities (execute_code / execute_shell fail on staging)

- **Status:** Reverted (cap change) on `main`. Agents failed to boot with it; see [002](./002-staging-agents-fail-boot-after-cap-change-reverted.md). Re-apply after node rollout.
- **Severity:** High
- **Date:** 2026-11-07
- **Summary:** On staging, `execute_code` and `execute_shell` fail for agents with `sandbox_infrastructure_error`: `mount --make-shared /var/run/netns failed: Operation not permitted`. The Nomad runtime never granted `NET_ADMIN` or `SYS_ADMIN` to agent tasks. Bug report 010 fixed this for Docker mode only.

## Symptoms

- Platform fault alerts: `execute_code.sandbox_infrastructure_error` and `execute_shell.sandbox_infrastructure_error`, for agent "Job searcher".
- Stderr detail: `mount --make-shared /var/run/netns failed: Operation not permitted`.

## Root Cause

1. `scripts/sandbox-exec.sh` runs `ip netns add`, which makes `/var/run/netns` a shared mount. That needs `CAP_SYS_ADMIN`. Iptables rules need `CAP_NET_ADMIN`.
2. `DockerAgentManager` adds `NET_ADMIN` and `SYS_ADMIN` to `CapAdd` (fixed in 010).
3. `NomadRuntimeAdapter.buildNomadJobSpec` set no `cap_add`. The Nomad client's docker plugin did not set `allow_caps`. Nomad's default `allow_caps` excludes both caps, so the container started without them.

## Resolution

- `apps/worker/src/agents/nomad-runtime-adapter.ts`: the task `Config` now sets `cap_add: ['NET_ADMIN', 'SYS_ADMIN']`.
- `infra/hetzner/cloud-init-nomad-client.yaml`: plugin `"docker"` `allow_caps` extends Nomad's default list with `net_admin` and `sys_admin`. `allow_privileged` stays `false`. Existing Nomad clients need this config and a Nomad restart. New nodes pick it up from cloud-init.
- `apps/worker/src/tools/shell.ts` and `apps/worker/src/tools/code.ts`: the non-recoverable fault text now tells the agent to tell the user the tool is unavailable, and not to save the limitation to memory. A stale "sandbox is broken" memory outlives the fix.

## Accepted Risk

`allow_caps` is set per Nomad client, so any job on those nodes can request `NET_ADMIN` and `SYS_ADMIN`. This matches the Docker path (bug 010). Accepted on 2026-11-07. Restricting caps to a dedicated agent node pool is a possible follow-up.

## Deploy Order

1. Apply the `allow_caps` change to every Nomad client and restart Nomad. Do this first.
2. Deploy the worker. A task that requests `cap_add` on a client without the new `allow_caps` fails to start.
3. Restart affected agents so they get a new job spec.

## Verification

1. Unit test: `buildNomadJobSpec` includes `cap_add: ['NET_ADMIN', 'SYS_ADMIN']` and no `privileged` key.
2. Existing `shell.test.ts`, `code.test.ts`, `tool-errors.test.ts`, `agent-broker-platform-fault.test.ts` pass.
3. On a Nomad client after the change: `nomad job inspect agent-<id>` shows `cap_add`, and `grep CapEff /proc/self/status` inside the agent container includes the `NET_ADMIN` and `SYS_ADMIN` bits. `execute_shell` runs a command without the fault.
