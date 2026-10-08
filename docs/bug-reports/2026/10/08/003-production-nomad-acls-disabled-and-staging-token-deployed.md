# Bug: production Nomad ran without ACLs, carried the staging token, and could not autoscale or launch agents

**Date:** 2026-10-08
**Severity:** HIGH (security). The production Nomad API accepted anonymous requests: any
process able to reach `:4646` on the control plane, the private network or the Docker bridge
could submit or stop jobs.
**Status:** FIXED on production 2026-10-08. Code changes are not committed yet.
**Fix location:** `infra/hetzner/deploy.sh`, `scripts/setup-nomad.sh`,
`scripts/converge-control-plane.sh`, `.env.backend(.example)`, `infra/hetzner/README.md`,
autoscale docs.

## Findings (all production; staging was correct)

| # | Finding | Cause |
|---|---|---|
| 1 | `/etc/nomad.d/nomad.hcl` had no `acl { enabled = true }`; anonymous `/v1/jobs` → 200 | Control plane created from older cloud-init (`ignore_changes = [user_data]`, same class as 2026-10-07/002) |
| 2 | `/etc/nomad.d/acl-token` and `autoscale.env` held the **staging** management token | `NOMAD_ACL_TOKEN` lives in the shared `.env.backend`, and `deploy.sh` deploys it to every env |
| 3 | Worker `NOMAD_TOKEN` empty | `.env.production` never got one |
| 4 | No `herobids-agents` namespace, so every agent launch would fail ("nonexistent namespace") | `setup-nomad.sh` (which creates it) never ran for production |
| 5 | `nomad-autoscale`, `nomad-scale-in`, `nomad-placement-failure-watcher` failing: "Missing backend environment variables" | Units lacked `EnvironmentFile=-/etc/herobids/autoscale.env` (older cloud-init) |

## Fix

Code:
- `deploy.sh`: the Nomad token is per environment. It now comes from `NOMAD_TOKEN` in
  `--env-file`, and any `NOMAD_ACL_TOKEN` from `.env.backend` is ignored with a note. If no
  env file is passed, `deploy.sh` prompts for one up front (instead of `setup-env.sh`).
- `setup-nomad.sh`: reads and writes the token in the env file only.
- `.env.backend` / `.env.backend.example`: the `NOMAD_ACL_TOKEN` line is replaced by a note.
- `converge-control-plane.sh` (runs on every deploy): adds an `EnvironmentFile=` drop-in to
  autoscale units that lack it, and warns when `nomad.hcl` does not enable ACLs. ACLs are not
  auto-enabled, because that needs a coordinated bootstrap and token rollout.

Production operations (in this order, so nothing was locked out):
1. Generated a production-only token and set it as `NOMAD_TOKEN` in `.env.production`.
   Deployed `.env`, `autoscale.env` and `acl-token`, then recreated the worker while ACLs were
   still off, so the token was ignored and nothing broke.
2. Ran converge, which installed the three autoscale drop-ins.
3. Backed up `nomad.hcl` to `nomad.hcl.bak-2026-10-08-pre-acl`, added `acl { enabled = true }`,
   ran `nomad config validate`, restarted Nomad, and confirmed the leader at `10.0.0.2:4647`.
4. `nomad acl bootstrap /etc/nomad.d/acl-token` (operator-supplied secret = step 1 token).
5. `nomad namespace apply herobids-agents`.

## Verification (production, 2026-10-08)

- Anonymous `/v1/jobs` → 403; production token → 200; staging token → 403.
- Worker container with its own token → 200 on `/v1/jobs?namespace=herobids-agents` and on
  `/v1/service/browser-pool`.
- `nomad-autoscale` run: "Capacity sufficient", unit exits cleanly.
- Dry-run `nomad job plan` of a 256 MB job in `herobids-agents`: all tasks allocated.
  browser-pool allocation unaffected by the restart.
- Converge re-run: "already converged", no ACL warning.
- NOT verified: a real agent launch on production.

## Still open

- Raft peer still recorded as `172.17.0.1:4647` (warning from converge, see 2026-10-07/002).
  This needs `peers.json` recovery in a maintenance window.
- No mTLS on Nomad (Nomad warns about this). It is a separate hardening item.
