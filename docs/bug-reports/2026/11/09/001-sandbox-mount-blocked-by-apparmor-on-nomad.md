# 001 — Sandbox Fails on Nomad Even With NET_ADMIN and SYS_ADMIN (AppArmor Blocks mount)

- **Status:** Open. Fix in progress: [000-sandbox-uid-egress](../../../../features/pending/000-sandbox-uid-egress/001-plan.md).
- **Severity:** High (`execute_shell` and `execute_code` fail for all agents on Nomad)
- **Date:** 2026-11-09
- **Related:** [2026/11/07 001](../11/07/001-nomad-agent-tasks-missing-sandbox-caps.md), [2026/11/07 002](../11/07/002-staging-agents-fail-boot-after-cap-change-reverted.md), [2026/06/14 010](../../06/14/010-execute-code-sandbox-fails-missing-sys-admin-capability.md)

## Summary

Granting `NET_ADMIN` and `SYS_ADMIN` to an agent container does not make the sandbox work. Docker's default AppArmor profile (`docker-default`) denies `mount`, so `scripts/sandbox-exec.sh` still fails. The error changes from `Operation not permitted` (missing capability) to `Permission denied` (LSM denial).

## Symptoms

- Canary agent (Job searcher, `bb11883d`) on `herobids-staging-agent-caps-1`, running with `NET_ADMIN` and `SYS_ADMIN` in its job spec.
- Inside the container, `CapEff` includes bits 12 and 21.
- `sandbox-exec.sh true` prints `mount --make-shared /var/run/netns failed: Permission denied` and exits 1.
- `mount -t tmpfs none /mnt` inside the container fails with `Permission denied`.

## Reproduction

On `herobids-staging-agent-caps-1`, with the agent image:

```sh
# Fails: caps granted, docker-default AppArmor
docker run --rm --entrypoint /usr/local/bin/sandbox-exec.sh \
  --cap-add NET_ADMIN --cap-add SYS_ADMIN ghcr.io/poshjosh/herobids-agent:latest true

# Passes: same caps, AppArmor unconfined (test only, not a fix)
docker run --rm --entrypoint /usr/local/bin/sandbox-exec.sh \
  --cap-add NET_ADMIN --cap-add SYS_ADMIN --security-opt apparmor=unconfined \
  ghcr.io/poshjosh/herobids-agent:latest true
```

## Root Cause

`sandbox-exec.sh` creates a network namespace by mounting `/var/run/netns` (`ip netns add`). Docker's default AppArmor profile denies `mount` regardless of `CAP_SYS_ADMIN`. The capability is necessary but not sufficient.

## Impact

- No agent on Nomad can run `execute_shell` or `execute_code` in the sandbox.
- Workarounds that unconfine AppArmor or grant `SYS_ADMIN` add risk without fixing the design.

## Decision

Do not weaken AppArmor, and do not extend `SYS_ADMIN`. Replace the network namespace with iptables rules that match the agent user's UID. See the feature plan for the design.

## Lessons

See [agent-runtime-rollout-guide.md §2](../../../../tech/agents/agent-runtime-rollout-guide.md#2-sandbox-requirements). Granting a capability is not a test. Check the LSM profile and run the probe in a throwaway container first.


---

## Resolved — 2026-11-13 (Hetzner scale-path, Phase 4b)

Resolved by design change rather than by weakening AppArmor: the sandbox no longer
creates a network namespace (which needed `SYS_ADMIN` + a `mount` that `docker-default`
AppArmor denies). The current design installs iptables **owner rules** for the agent UID
using `NET_ADMIN` only — no namespace, no `mount`, no AppArmor change. Proven live on
staging (egress rules install cleanly; private ranges blocked for the agent user). See
[sandbox-shell-access.md](../../../features/2026/11/12/001-hetzner-scale-path/sandbox-shell-access.md).
