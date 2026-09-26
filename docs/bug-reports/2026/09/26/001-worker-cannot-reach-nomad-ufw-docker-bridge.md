# Bug Report 001 — Worker container cannot reach Nomad (UFW blocks Docker bridge → private IP)

- **Status:** FIXED (staging unblocked live; durable fix pending review)
- **Severity:** High (blocks all agent runtime launches on Nomad)
- **Date:** 2026-09-26
- **Environment:** staging (`herobids-staging`, control plane `138.199.172.202`, re-provisioned 2026-09-25); same latent gap present in production (identical shared `cloud-init.yaml`)

## Summary

After restoring the Nomad server (reboot → `__PRIVATE_IP__` substitution → ACL
re-bootstrap via `setup-nomad.sh`), agent runtime launches still fail with
`Critical execution failure`. The worker logs `runtime.launch_failed: This
operation was aborted` — the `NomadClient` 10s AbortController timeout
(`apps/worker/src/agents/nomad-client.ts`).

Nomad itself is healthy (server is raft leader, `nomad server members` shows
`alive`, the agent node `herobids-staging-agent-1` is `ready`, and the host can
`curl http://10.0.0.2:4646/v1/status/leader` successfully). The failure is
**network reachability from the worker container**, not Nomad or the ACL token.

## Root Cause

The worker container is on the Docker bridge network (`herobids_default`,
`172.18.0.0/16`, container IP `172.18.0.8`). Its `NOMAD_ADDR` is
`http://10.0.0.2:4646`, so Nomad traffic egresses the bridge, is routed to the
host's private NIC, and is then subject to UFW.

UFW is `Default: deny (routed)`, and the only Nomad-port rules on the control
plane allow only the private subnet:

```sh
ufw allow from ${private_subnet} to any port 4646 proto tcp   # 10.0.0.0/24
ufw allow from ${private_subnet} to any port 4647 proto tcp
ufw allow from ${private_subnet} to any port 4648 proto tcp
```

The Docker bridge subnet is not in the allow list, so the worker's traffic is
dropped. Kernel log confirms:

```
[UFW BLOCK] IN=br-0d23090f63f6 ... SRC=172.18.0.8 DST=10.0.0.2 ... DPT=4646
```

This rule set is unchanged since the Nomad cluster topology was introduced
(`git show 36796dfb`, 2026-07-08). The gap was **latent**: it only manifests now
because a chain of earlier, higher-layer failures (private NIC down →
`__PRIVATE_IP__` unsubstituted → stale ACL token) each masked this final layer.
Re-provisioning the control plane (2026-09-25) and completing those fixes
exposed it.

## Why the worker reaches Nomad via the bridge

Unlike agent nodes (which reach Nomad over the Hetzner private network from
their own hosts), the worker runs **on the control plane itself**, inside a
Docker container. Outbound traffic from that container leaves via the Docker
bridge and is then routed onto `enp7s0`, hitting UFW's routed-default-deny.

## Proposed fix (Option 1 — agreed by operator)

Add UFW allow rules for the Docker bridge subnet to the Nomad ports. Two scoping
options:

- **A (narrower, recommended):** allow only the specific bridge gateway/host,
  or a `/32` for the worker's observable egress.
- **B (matches existing convention):** allow `from 172.18.0.0/16` to ports
  4646/4647/4648, analogous to how `10.0.0.0/24` is already allowed.

The immediate unblock (staging only, persists until next re-prov):

```sh
ufw allow from 172.18.0.0/16 to any port 4646 proto tcp
ufw allow from 172.18.0.0/16 to any port 4647 proto tcp
ufw allow from 172.18.0.0/16 to any port 4648 proto tcp
```

The durable fix (code, **uncommitted, awaiting review**) is to add the same
rules to `infra/hetzner/cloud-init.yaml` alongside the existing
`ufw allow from ${private_subnet}` block so a re-provision does not reintroduce
this.

## Fix (implemented — uncommitted, for review)

1. **Staging unblocked live** — `ufw allow from 172.18.0.0/16` to 4646/4647/4648.
   Verified: worker reconcile now logs `Runtime reconcile complete via port`.
2. **`docker-compose.yaml`** — pinned `networks.default.ipam` to `172.18.0.0/16`
   (matches the current running bridge, so it is a no-op on a live stack) so the
   firewall rule keyed on that range stays deterministic.
3. **`infra/hetzner/cloud-init.yaml`** — added the three bridge→Nomad UFW allow
   rules next to the existing `${private_subnet}` block, with a comment pointing
   at the `docker-compose.yaml` pin.

## Risk assessment (why this is low-risk)

- **Additive only** — nothing existing is removed or weakened.
- The source CIDR `172.18.0.0/16` is Docker's internal bridge, routable only
  from containers on this host; **not** reachable from the public internet.
- The tighter `Option A` (specific IP instead of `/16`) is the safer default if
  preferred; both are acceptable for staging.

## Files

- `docker-compose.yaml` — new `networks.default.ipam` pin to `172.18.0.0/16`
- `infra/hetzner/cloud-init.yaml` — UFW allow rules for the Docker bridge subnet to 4646/4647/4648
- `infra/hetzner/.env.staging` (gitignored) — `RUNTIME_BACKEND=nomad`,
  `NOMAD_ADDR=http://10.0.0.2:4646`, `SHARED_REDIS_HOST=10.0.0.2`,
  `SHARED_POSTGRES_HOST=10.0.0.2`
- `apps/worker/src/agents/nomad-client.ts` — the 10s AbortController that turns
  a UFW drop into `runtime.launch_failed: This operation was aborted` (no change
  needed)

## Verification

- `docker exec herobids-worker-1 env` → `NOMAD_TOKEN=b8ad8fb4…` (valid),
  `RUNTIME_BACKEND=nomad`, `NOMAD_ADDR=http://10.0.0.2:4646`
- `docker exec herobids-worker-1 sh -c 'wget -qO- http://10.0.0.2:4646/v1/status/leader'`
  → `download timed out`
- Host `curl http://10.0.0.2:4646/v1/status/leader` → `"10.0.0.2:4647"` (works)
- `/var/log/ufw.log` → `[UFW BLOCK] SRC=172.18.0.8 DST=10.0.0.2 DPT=4646`

## Related

- Root-cause chain (preceding fixes, already applied): private NIC down →
  `__PRIVATE_IP__` placeholder → stale ACL token. See repo memory
  `herobids-staging-nomad-investigation.md`.
- `docs/features/2026/07/08/004-orchestration/003-cluster-safe-connectivity.md`
  (shared-service connectivity design — note it documents agent-node egress, not
  the worker's own control-plane egress).
- `infra/hetzner/docs/setup.md` (Phase 6/7 added 2026-09-26 for Nomad bootstrap
  + teardown/re-provision).