# Bug: production control plane was missing the UFW `172.18.0.0/16 → 4646/4647/4648` rules

**Date:** 2026-10-07
**Severity:** MEDIUM. On the first production provision, the Docker-bridge→Nomad UFW allow
rules were absent, so the worker/API containers (on the Docker bridge) could not reach the
Nomad API. Applied manually to unblock, but it will recur on any production rebuild until the
provisioning path is confirmed to apply them. Downgraded from HIGH because a manual rule
application is a reliable stopgap and production is pre-launch.
**Status:** OPEN (manually worked around on the live box; root cause in provisioning not
yet confirmed/fixed). Discovered while fixing bug 001; out of scope of that fix.
**Fix location:** herobids `infra/hetzner/cloud-init.yaml` (control-plane) / provisioning
verification. No application code.

## How to use this report

Self-contained. herobids repo; follow `AGENTS.md`. Production CP `167.233.213.107`, key
`~/.ssh/herobids_deploy_key_prod`. Pre-launch. Don't commit/push unless asked.

## Summary

`infra/hetzner/cloud-init.yaml` defines, inside the `enable_nomad` block, three UFW rules so
the worker/API containers (which live on the Docker bridge `172.18.0.0/16`, NOT the Hetzner
private network) can reach the Nomad server:

```sh
ufw allow from 172.18.0.0/16 to any port 4646 proto tcp
ufw allow from 172.18.0.0/16 to any port 4647 proto tcp
ufw allow from 172.18.0.0/16 to any port 4648 proto tcp
```

On the freshly provisioned production control plane these rules were **absent** — only the
`10.0.0.0/24` (agent private-network) rules were present. With UFW's routed default-deny, the
worker's Nomad calls were dropped. Combined with bug 001 (wrong `NOMAD_ADDR`) this fully
blocked worker→Nomad.

## Evidence (2026-10-07)

While fixing bug 001, the worker→Nomad `wget` kept timing out even after `NOMAD_ADDR` was
corrected. `ufw status` on production showed the `10.0.0.0/24` Nomad rules but not the
`172.18.0.0/16` ones. After applying the three rules above by hand, the worker reached Nomad.
They are present now:

```sh
ssh -i ~/.ssh/herobids_deploy_key_prod root@167.233.213.107 'ufw status | grep 172.18'
# 4646/tcp ALLOW 172.18.0.0/16
# 4647/tcp ALLOW 172.18.0.0/16
# 4648/tcp ALLOW 172.18.0.0/16
```

## Root cause (to confirm)

Why cloud-init's rules didn't land on this box is unconfirmed. Candidates:
- The `enable_nomad` runcmd block partially failed or didn't run on first boot (check
  `/var/log/cloud-init-output.log` and `journalctl` on production).
- Ordering: the rules are added in the same runcmd block that installs Nomad; if an earlier
  command in that block failed under `set -e`-like behavior, later lines (including these
  rules) would be skipped. cloud-init `runcmd` does not stop on first error by default, but
  individual multi-line `|` steps can.
- The box was provisioned from a commit/cloud-init version that predated these rules, then
  not re-provisioned.

The durable fix is likely: make the bridge→Nomad rules idempotent and reassert them on every
boot (like a small oneshot unit), rather than only in first-boot `runcmd`, and/or add a
provisioning post-check that fails loudly if the rules are missing. Confirm the root cause
before choosing.

Note the Docker bridge subnet (`172.18.0.0/16`) is pinned in `docker-compose.yaml`
(`networks.default.ipam`) and the rules must stay in sync with it — but on this production box
the running Nomad server actually advertised `172.17.0.1` (see bug 002), i.e. the default
bridge, which hints the compose network / bridge assumptions on production may not match the
pinned `172.18.0.0/16`. Verify the actual bridge subnet in use on production
(`docker network inspect herobids_default`) as part of this fix; the UFW rule subnet must
match whatever the worker/API containers actually use.

## Acceptance checklist

- [ ] Root cause of the missing rules on first provision is identified (logs on production).
- [ ] A fresh production (or staging) provision ends with the three `172.18.0.0/16 → 4646/4647/4648` rules present, verified automatically or by a documented post-check.
- [ ] The worker container can reach the Nomad API on a fresh provision with no manual UFW step.
- [ ] The UFW rule subnet matches the actual Docker bridge subnet the worker/API use on production (cross-check with bug 002's `172.17.0.1` finding).

## Related

- `docs/bug-reports/2026/10/07/001-...` (wrong `NOMAD_ADDR`; the other half of the worker→Nomad blockage).
- `docs/bug-reports/2026/10/07/002-...` (control-plane advertises `172.17.0.1`; related bridge-subnet question).
- `infra/hetzner/docs/runbooks/reprovision-runbook.md` step 6a documents these rules as "the firewall trap".
