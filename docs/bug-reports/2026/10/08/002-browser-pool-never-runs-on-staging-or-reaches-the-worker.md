# Bug: browser-pool never ran on staging, hung the production deploy, and is never used by the worker

**Date:** 2026-10-08
**Severity:** HIGH. `browse_interactive` has been unavailable on staging and production since
the Nomad migration. Production deploys hung indefinitely at the final step of `push.sh`.
**Status:** FIX IMPLEMENTED. The job is running on both clusters (submitted by hand). The
config change takes effect on the next deploy after commit + push. Not committed yet.
**Fix location:** `infra/nomad/browser-pool.nomad.hcl`, `infra/hetzner/scripts/push.sh`,
`config/staging.yaml`, `config/production.yaml`.

## Three independent defects

1. **Unplaceable job.** The `service` block had no `provider`, so it defaulted to Consul. That
   adds a `${attr.consul.version} semver >= 1.8.0` constraint, and no node runs Consul. On
   production `nomad job run` then monitored a deployment that could never place, and the
   deploy hung. The worker discovers services through Nomad's own catalog
   (`GET /v1/service/browser-pool`), so even a placed Consul-registered job would be invisible.
   Fix: `provider = "nomad"`. `nomad job run` in `push.sh` is now wrapped in `timeout 180`.
2. **Silently skipped on ACL clusters.** `push.sh` gated submission on an anonymous
   `nomad server members`. That returns 403 on staging (ACLs on), so the job was never
   submitted. It "worked" on production only because ACLs were off there (bug 003). Fix:
   export `NOMAD_TOKEN` from `/etc/nomad.d/acl-token` before the gate.
3. **Worker never asks Nomad.** `config/default.yaml` sets
   `browserPool.url: "http://browser-pool:3000"` (the Compose service name), and the worker
   uses the static URL whenever it is non-empty. Staging logged
   `getaddrinfo EAI_AGAIN browser-pool`. Fix: `browserPool.url: ""` in `staging.yaml` and
   `production.yaml`, so the worker resolves the URL via Nomad discovery.

## Verification

- `nomad job plan` on production: "All tasks successfully allocated". The job is running on
  both clusters, and `nomad service list` shows `browser-pool`.
- Staging gate with token: passes. `timeout 180 nomad job run`: deployment successful.
- The production worker (with its token) gets 200 from `/v1/service/browser-pool`.
- YAML merge: staging/production resolve `browserPool.url` to `""`; development keeps the
  Compose URL. `tests/staging-config-validation.test.ts` and `apps/worker/src/config.test.ts`
  pass.
- NOT verified: an agent completing a `browse_interactive` call end to end. This needs the
  config change deployed. The agent → `10.0.0.x:<dynamic port>` path across agent nodes is
  untested.

## Known limitation (not fixed)

The worker resolves the browser-pool address once at startup. If the allocation moves
(node replaced, reschedule), the worker keeps the stale address until it restarts.

## Cost note

The job reserves 2048 MB on the agent node (3.7 GiB on cpx21), which leaves about 6 agent
slots of 256 MB before autoscaling adds a node.
