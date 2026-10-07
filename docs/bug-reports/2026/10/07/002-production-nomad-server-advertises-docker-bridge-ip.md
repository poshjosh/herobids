# Bug: production Nomad server advertises `172.17.0.1` (docker0), so agent nodes stay `down`

**Date:** 2026-10-07
**Severity:** HIGH. The production Nomad server advertises the Docker bridge IP instead of its private IP, so agent (Nomad client) nodes on the private network are handed an unreachable RPC/Serf address and never become `ready`. No agent can be scheduled in production. Impact is contained only because production is pre-launch.
**Status:** OPEN. Not yet fixed. Discovered while implementing WP1 of the private-agent-nodes plan; out of scope of that work.
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

- [ ] Production `nomad server members` shows `10.0.0.2`, not `172.17.0.1`.
- [ ] `/etc/nomad.d/nomad.hcl` on production has no unrendered `{{ GetPrivateIP }}` and advertises `10.0.0.2`.
- [ ] The production agent node reaches `ready` (`nomad node status`).
- [ ] The fix survives a control-plane reboot (re-resolves automatically).
- [ ] Staging's control-plane advertise is confirmed correct and uses the same mechanism (no hand-patch drift).

## Related

- `infra/hetzner/docs/auto-scaling/lessons-learnt.md` #1 and #11 (the `{{ GetPrivateIP }}` → docker-bridge problem and the agent-side fix).
- `docs/bug-reports/2026/10/07/001-...` (the worker's `NOMAD_ADDR`; a different layer — that was the worker container's env var, this is the server's advertise address).
- `docs/bug-reports/2026/10/07/003-...` (missing control-plane UFW bridge→Nomad rules; same production provision).
