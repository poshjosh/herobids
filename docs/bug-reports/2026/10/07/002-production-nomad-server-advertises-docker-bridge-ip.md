# Bug: production Nomad server advertises `172.17.0.1` (docker0), so agent nodes stay `down`

**Date:** 2026-10-07
**Severity:** HIGH. The production Nomad server advertises the Docker bridge IP instead of its private IP, so agent (Nomad client) nodes on the private network are handed an unreachable RPC/Serf address and never become `ready`. No agent can be scheduled in production. Impact is contained only because production is pre-launch.
**Status:** FIX IMPLEMENTED. Deploy-time control-plane convergence (Option B) added and rolled out to staging and production on 2026-10-07 (see "Fix implemented" at the end). Not committed yet.
**Fix location:** herobids `infra/hetzner/` control-plane Nomad config / cloud-init. No application code.

## How to use this report

Self-contained. Work from the herobids repo root; follow `AGENTS.md`. Production control
plane: `167.233.213.107`, SSH key `~/.ssh/herobids_deploy_key_prod`. Staging CP:
`138.199.172.202`, key `~/.ssh/herobids_deploy_key`. Both are pre-launch (operator test
accounts only). Do not commit/push unless asked.

## Summary

On the production control plane, `nomad server members` reports:

```
Name                        Address      Port
herobids-production.global  172.17.0.1   4648
```

`172.17.0.1` is the Docker `docker0` bridge, not the Hetzner private IP `10.0.0.2`. Staging
is correct (`10.0.0.2`). An agent node's `nomad.hcl` points at `servers = ["10.0.0.2:4647"]`
and the node reaches the server there, but the server then tells it to use `172.17.0.1` for
RPC/Serf, which the agent cannot route to. The agent stays `down`.

## Evidence (2026-10-07)

```sh
ssh -i ~/.ssh/herobids_deploy_key_prod root@167.233.213.107 \
  'export NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token); nomad server members; grep -A2 advertise /etc/nomad.d/nomad.hcl'
```

- `nomad server members` → `herobids-production.global 172.17.0.1 ...`
- `/etc/nomad.d/nomad.hcl` on production still contains the **unrendered template literal**:
  ```hcl
  advertise {
    http = "{{ GetPrivateIP }}"
    rpc  = "{{ GetPrivateIP }}"
  ```

Staging, for comparison:
```sh
ssh -i ~/.ssh/herobids_deploy_key root@138.199.172.202 \
  'export NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token); nomad server members'
# herobids-staging.global 10.0.0.2 ...
```

(Note: the agent-node config uses a different mechanism — a `__PRIVATE_IP__` placeholder
patched by `nomad-private-ip.service` — and that side is fine. This bug is specifically the
**control-plane server** config.)

## Root cause (to confirm during the fix)

The production control-plane `nomad.hcl` advertise block uses Nomad's `{{ GetPrivateIP }}`
Go template. Two things are wrong on this box:

1. The literal `{{ GetPrivateIP }}` is still present in the file (not rendered to an IP). So
   either the control plane uses raw `{{ GetPrivateIP }}` and relies on Nomad to resolve it
   at runtime, or a substitution step (as on the agent side) was expected and didn't run.
2. `{{ GetPrivateIP }}` resolves to the first RFC1918 address, which is Docker's
   `172.17.0.1` — exactly lessons-learnt #1 (`infra/hetzner/docs/auto-scaling/lessons-learnt.md`),
   which was fixed for the **agent** cloud-init (`__PRIVATE_IP__` + `nomad-private-ip.service`,
   driven by the subnet prefix) but the **control-plane** `cloud-init.yaml` server config may
   still rely on `{{ GetPrivateIP }}`.

Check `infra/hetzner/cloud-init.yaml` for how the control-plane `nomad.hcl` advertise block
is written, and compare with the agent fix in `cloud-init-nomad-client.yaml`. The durable
fix is to apply the same `__PRIVATE_IP__`/subnet-prefix substitution to the control-plane
server config so it advertises `10.0.0.2`, and to make it re-resolve on every boot.

Staging appears correct today, so either staging was patched by hand, or a timing/interface
difference let it resolve correctly there — determine which before assuming the template is
fine on staging.

## Immediate unblock (manual, until the durable fix ships)

On the production control plane, set the advertise addresses to the real private IP and
restart Nomad, then re-bootstrap/verify agents:

```sh
ssh -i ~/.ssh/herobids_deploy_key_prod root@167.233.213.107 '
  sed -i "s/{{ GetPrivateIP }}/10.0.0.2/g" /etc/nomad.d/nomad.hcl
  systemctl restart nomad'
# then confirm:
ssh -i ~/.ssh/herobids_deploy_key_prod root@167.233.213.107 \
  'export NOMAD_TOKEN=$(cat /etc/nomad.d/acl-token); nomad server members; nomad node status'
```

Expect the server to advertise `10.0.0.2` and the agent node to reach `ready`. This is a
stopgap; a control-plane reboot would revert it unless the cloud-init/template fix lands.

## Acceptance checklist

- [x] Production `nomad server members` shows `10.0.0.2`, not `172.17.0.1`.
- [x] `/etc/nomad.d/nomad.hcl` on production has no unrendered `{{ GetPrivateIP }}` and advertises `10.0.0.2`.
- [x] The production agent node reaches `ready` (`nomad node status`). Needed a `systemctl restart nomad` on the agent node; see below.
- [ ] The fix survives a control-plane reboot (re-resolves automatically). Not verified: no reboot was done. `nomad-private-ip.service` is enabled and `nomad.service` now `Requires=` it, and `deploy.sh` re-converges on every deploy.
- [x] Staging's control-plane advertise is confirmed correct and uses the same mechanism (no hand-patch drift). Staging had been hand-patched (literal `10.0.0.2`, no unit); convergence installed the unit and drop-in.

## Related

- `infra/hetzner/docs/auto-scaling/lessons-learnt.md` #1 and #11 (the `{{ GetPrivateIP }}` → docker-bridge problem and the agent-side fix).
- `docs/bug-reports/2026/10/07/001-...` (the worker's `NOMAD_ADDR`; a different layer — that was the worker container's env var, this is the server's advertise address).
- `docs/bug-reports/2026/10/07/003-...` (missing control-plane UFW bridge→Nomad rules; same production provision).

## Confirmed root cause (2026-10-07, supersedes the hypotheses above)

The current code is already correct. The live box is stale.

- The committed `infra/hetzner/cloud-init.yaml` already writes the control-plane advertise block as `__PRIVATE_IP__` and installs `nomad-private-ip.service`, which substitutes the private IP on every boot. `grep -n GetPrivateIP infra/hetzner/cloud-init*.yaml` returns nothing.
- The live production control plane (`herobids-production`, server id 160476851) still has `{{ GetPrivateIP }}` in `/etc/nomad.d/nomad.hcl`, and `nomad-private-ip.service` is **not installed** (`systemctl list-unit-files nomad-private-ip.service` lists 0 units).
- That server was created before those cloud-init fixes landed. Today's "first production Nomad provision" only added the agent node; the control plane already existed. Its Postgres logs go back days.
- `hcloud_server.default` has `lifecycle { ignore_changes = [user_data] }`, so Terraform never sends newer cloud-init to an existing control plane. cloud-init `user_data` is fixed at server creation; the git checkout on the box (`/opt/herobids`, now `f5edd19b`) being current doesn't change it.
- Staging advertises `10.0.0.2` correctly. Whether its config came from cloud-init or a hand patch has to be checked during the fix.

The same cause produced bug 003.

## Fix (Option B, agreed 2026-10-07): converge in place on every deploy

Don't rebuild the control plane. Add an idempotent control-plane convergence step that runs on every `deploy.sh`, so existing control planes match the committed cloud-init no matter which `user_data` they booted with:

1. Install `nomad-private-ip.service` with the same content as `cloud-init.yaml`, using this environment's `private_subnet`.
2. Make `nomad.service` depend on it (`After=`/`Requires=nomad-private-ip.service`, via a systemd drop-in so the stale unit file needn't be rewritten).
3. Normalise the `advertise` block: replace `{{ GetPrivateIP }}` with `__PRIVATE_IP__` and let the unit substitute the real private IP.
4. Restart Nomad **only if** the config changed. Verify a leader is elected and `nomad server members` shows the private IP.
5. Never touch `/opt/nomad/data`: the ACL bootstrap and tokens live in Raft state.

### Acceptance (in addition to the checklist above)
- [x] Running the convergence twice in a row changes nothing the second time and doesn't restart Nomad.
- [ ] After convergence on production: `nomad server members` shows `10.0.0.2`, the existing ACL token still works, and the agent node is `ready`. Members and agent verified. The token check is not meaningful: the production server's `nomad.hcl` has no `acl` block, so ACLs are disabled there (see below).
- [x] Running the convergence on staging is a no-op, or only adds the missing unit/drop-in. Staging stays healthy.

## Fix implemented (2026-10-07)

- `infra/hetzner/scripts/converge-control-plane.sh` runs on the control plane. It resolves the private IP first (dies before changing anything if there is none), re-asserts the UFW rules, installs `nomad-private-ip.service` and the `nomad.service.d/10-private-ip.conf` drop-in, and rewrites `{{ GetPrivateIP }}` / `__PRIVATE_IP__` in `nomad.hcl` to the private IP itself. It only `start`s the oneshot when inactive, never restarts it (`Requires=` would restart Nomad too). It then does one live check (leader `"<ip>:` and `nomad server members`), and restarts Nomad if `nomad.hcl` or the `nomad.service` dependency changed or the live check failed, so a re-run after a mid-way failure can't report `already converged` while Nomad runs stale config. Raft peer addresses that differ from the advertise IP print a non-fatal WARNING. It never touches `/opt/nomad/data`.
- The control-plane `nomad-private-ip.service` (cloud-init.yaml and the converge copy) exits 0 when `nomad.hcl` has no placeholder, so a late NIC no longer stops an already-patched Nomad from starting.
- `infra/hetzner/scripts/setup-control-plane.sh` uploads and runs it. It is wired in as `deploy.sh` step 3/6. It skips only on a literal `nomad_enabled = false`; a Terraform error fails loudly. Without Terraform state, use `HEROBIDS_NOMAD_ENABLED=true HEROBIDS_PRIVATE_SUBNET=<cidr>` plus the server IP.
- Tests: `infra/hetzner/scripts/tests/test-converge-control-plane.sh`.

Rollout evidence:
- Staging: `changed: installed nomad-private-ip.service; installed nomad.service drop-in; restarted nomad`. The leader stayed `10.0.0.2:4647` and agent `db4e22b4` stayed `ready`. The second run reported `already converged`.
- Production: `changed: installed nomad-private-ip.service; installed nomad.service drop-in; patched nomad.hcl advertise; restarted nomad`. Server members show `10.0.0.2`, the leader is `"10.0.0.2:4647"`, and the second run reported `already converged`. From the worker, `wget .../v1/status/leader` returns `"10.0.0.2:4647"`, and there was no `runtime.reconcile_failed` in the 70s check.

Follow-ups found during rollout (not fixed here):
1. **Agent client cached the old server address.** `herobids-production-agent-1` kept dialing `172.17.0.1:4647` and did not fall back to its configured `servers`. It became `ready` only after `systemctl restart nomad` on the agent node.
2. **Raft configuration still stores the old address.** `nomad operator raft list-peers` shows server ID `4730df44-...` at `172.17.0.1:4647`. Nomad logs `failed to reconcile member ... need at least one voter` about every 10s. The single voter still elects itself, so the cluster works. Fixing the stored address needs `peers.json` recovery under `/opt/nomad/data`, which is an operator decision.
3. **ACLs are disabled on the production server.** Its stale `nomad.hcl` has no `acl { enabled = true }` block, while cloud-init and the agent node have ACLs enabled. The agent logs `ACL support disabled` on `ACL.GetPolicies`. Enabling ACLs needs a bootstrap and token rollout, so it is out of scope for this fix.
4. **Agent-node `nomad-private-ip.service` still blocks Nomad on a late NIC.** In `infra/hetzner/cloud-init-nomad-client.yaml` the unit exits 1 whenever no private IP is visible, even if `nomad.hcl` is already patched, so `Requires=` fails `nomad.service` on such a boot. The control-plane copy (cloud-init.yaml + converge script) now exits 0 when there is no placeholder. The agent copy was left unchanged on purpose: changing agent `user_data` replaces agent nodes on the next apply. Fix it together with the next planned agent rollout.
