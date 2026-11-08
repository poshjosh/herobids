# 002 — no staging or production check covers the browser pool

- **Status:** FIX IMPLEMENTED in the repo. The gate runs as check 7 of `smoke-test.sh`. Not committed. First run against staging (before bug 001 was deployed) failed as expected. Two consecutive runs after the staging deploy passed 10/10.
- **Severity:** MEDIUM. The pool was unreachable on staging from 2026-10-31 to 2026-11-08 with no failing check. Users found it through agent failures and an empty admin panel.
- **Date:** 2026-11-08
- **Related:** [2026/11/08/001](./001-browser-pool-registered-on-public-address-blocked-by-ufw.md) (the outage this gap let through).

## Symptoms

- No automated check reported the outage. The staging deploy gate passed.
- The only signal was the admin dashboard's empty Browser Pool panel, which nobody alerts on.
- Agents failed with `browser_pool.timeout`.

## Root cause

The only pool test does not cover the path that broke.

- [browser-pool-agent-browser-smoke-test.sh](../../../../../scripts/shell/tests/browser-pool-agent-browser-smoke-test.sh) is **local only**. It starts the dev Compose pool on `localhost:3001` and runs an `agent-browser` container on the Compose network. It never touches staging or production, never resolves the pool through Nomad, never uses the worker's `BrowserlessAdapter`, and never crosses a firewall.
- It runs only from tier 4 of the local [run-extra-tests.sh](../../../../../scripts/shell/tests/run-extra-tests.sh). It is not in CI. The only workflow is `build-push-agent.yml`.
- The staging gate, [smoke-test.sh](../../../../../infra/hetzner/scripts/smoke-test.sh), has no browser-pool checks. Its README says it runs after every staging deploy. The staging smoke-test runbook has no browser section.
- The admin panel's empty state (`No servers reporting`) is not monitored.

**Would the existing smoke test have caught it?** No. Locally there is no firewall, no Nomad address, and no public NIC, so the test passes.

## Staging test (implemented)

The gate is [smoke-test-browser-pool.sh](../../../../../infra/hetzner/scripts/smoke-test-browser-pool.sh). `smoke-test.sh` runs it as check 7 after every deploy, for both `--env staging` and `--env production`. It can also run alone: `infra/hetzner/scripts/smoke-test-browser-pool.sh --env staging <control-plane-ip>`.

1. **Nomad registration.** `GET /v1/service/browser-pool` on the control plane. Fail if there are no entries, or if an address is outside `BROWSER_POOL_PRIVATE_PREFIX` (default `10.0.0.`).
2. **Control plane reachability.** `GET /json/version` from the control plane. Fail on timeout or non-200. This is the class of outage from bug 001.
3. **Session round trip.** `PUT /json/new` returns an `id`, and `PUT /json/close/<id>` returns 200 or 404. Browserless drops a session that has no client attached, so 404 means it was already released. This is the path that agents see as `browser_pool.timeout`.
4. **Admin health.** A `herobids:server-health:browser-pool:*` snapshot exists, and `metadata.isAvailable` is `true`. Fail if the key is missing, which is what leaves the admin panel empty.
5. **Every ready agent node, host network.** The Nomad node list gives the public address for each `ready`, `eligible` agent node, and the gate runs `GET /json/version` there over SSH.
6. **Every ready agent node, Docker bridge.** The gate first reads the network of a running agent container. It fails if that is not `bridge`, because the UFW rules allow only `docker0`. It then runs a `busybox` container on the default bridge and fetches `/json/version`. This is the path agent containers use. It is the check that failed in the first run.

**First run (2026-11-08, staging, before bug 001 is deployed).** 2 passed, 7 failed:

- Registered at the public address `178.105.68.146:20454`, not the private prefix.
- Control plane could not reach the pool. No session could be acquired. No health snapshot exists.
- `herobids-staging-agent-3`: host check passed (local delivery to its own public address), Docker bridge check timed out.
- `herobids-staging-agent-2`: SSH refused because its host key differs from `known_hosts`. The gate fails closed on this. It needs an operator decision before the node can be checked.

Note on the host check. Local delivery to a node's own public address can succeed while remote traffic is blocked. The host check is only conclusive once the pool is on the private address.

### Follow-ups

- Agent-2's host key was accepted on first use without the console check (operator decision, staging only).
- Add the browser-pool step to [smoke-test-staging.md](../../../../runbooks/smoke-test-staging.md). The gate already runs inside `smoke-test.sh`.
- Consider an alert when the admin Browser Pool panel is empty for more than two publish cycles.
- Production uses the same gate. It is pre-launch and can be rebuilt, so run it there once after the fix.
