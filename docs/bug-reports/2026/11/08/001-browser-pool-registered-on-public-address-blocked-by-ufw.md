# 001 — browser-pool registers its public address, which agent-node UFW blocks

- **Status:** DEPLOYED TO STAGING (manual steps, 2026-11-08 approved). The job runs as version 1 without the `update` block. The `update` block and the gate's agent-network check are in the repo and await deployment and a redeploy test. Production not deployed. Not committed.
- **Severity:** HIGH. `browse_interactive` is unavailable on staging (`browser_pool.timeout`). The admin dashboard shows `No servers reporting` under Browser Pool. Production is affected by the same registration design once it runs the pool on an agent node.
- **Date:** 2026-11-08
- **Environment:** staging (`herobids-staging`). The same design applies to production.
- **Related:** [2026/10/08/002](../../10/08/002-browser-pool-never-runs-on-staging-or-reaches-the-worker.md) (worker discovery, which this report follows up), [2026/11/07/002](../07/002-staging-agents-fail-boot-after-cap-change-reverted.md) (staging agent boot).

## Symptoms

- Agent "Job searcher" `browse_interactive` returns `browser_pool.timeout` ("Session acquisition timed out after 10000ms").
- Admin dashboard: Browser Pool shows `No servers reporting`.
- Nomad `browser-pool` is `running` and its service is registered and healthy.

## Root cause

Three defects combine. Each one alone is survivable.

1. **Public registration.** Nomad registers the service on the node's default host network, which is the public NIC (`unique.network.ip-address = 178.105.68.146`). The agent cloud-init only patches `advertise` (control-plane traffic), not the service address. The pool was registered at `178.105.68.146:20454`.
2. **UFW blocks the public path.** Agent nodes run `ufw default deny incoming` and allow only port 22. The pool's dynamic port is dropped (`INPUT` policy `DROP`). The worker's `GET /v1/service/browser-pool` returns the public address, so the worker's health publisher times out after 5 s and writes no snapshot. That is the empty admin panel.
3. **Dynamic port.** The port changes on every reschedule (`20454` today). Any firewall rule keyed on it would go stale.

The pool moved onto a clean node on 2026-10-31. The drift note records the unplanned replacement at about 10:58 UTC, and the pool was re-placed on the survivor at 11:00 UTC ([012-agent-node-drift-note.md](../../../../features/2026/10/30/001-agent-continuity-and-safe-capacity/012-agent-node-drift-note.md)).

**Why it appeared to work before (inference).** The old pool host was a hand-built node after a cloud-init failure. The UFW steps live in `runcmd`, so that node probably never enabled its firewall. The recovery backup shows an external address (`2.31.100.47`) reaching the old pool's `/json/version`, so its port was reachable from the internet. Those logs show health checks only and no `/json/new` session requests, so `browse_interactive` was not shown to work end to end on staging.

**Secondary gap.** The control plane's UFW default is `deny (routed)`. The worker runs on the Docker bridge `172.18.0.0/16` and reaches agent nodes through FORWARD, so it needs a routed rule even after the port is open.

## Fix

Option 2 plus option 3 from the operator's plan. Option 1 (a manual rule on the current port) was not used. Option 4 (persistence) is covered by the cloud-init and converge changes below.

- **Static port and private host network** ([browser-pool.nomad.hcl](../../../../../infra/nomad/browser-pool.nomad.hcl)): `static = 3100`, `host_network = "private"`. The service inherits the private address. An explicit `update` block (`max_parallel = 1`, `auto_revert = true`) replaces one allocation at a time, so the old allocation releases port 3100 first. Confirm with a staging redeploy (`ss -ltnp | grep 3100`).
- **Private host network on agent nodes** ([cloud-init-nomad-client.yaml](../../../../../infra/hetzner/cloud-init-nomad-client.yaml)): `host_network "private" { cidr = "${private_subnet}" }` in the Nomad client block. The default host network stays the public NIC, so node registration and other tasks are unchanged.
- **Agent-node firewall** (same file, `runcmd`):
  - `ufw allow from 10.0.0.0/24 to any port 3100` (other nodes, control plane, this host).
  - `ufw allow from 172.17.0.0/16 to any port 3100` (agent containers on this node, which use `docker0`).
  - `ufw route allow from 172.17.0.0/16 to 10.0.0.0/24 port 3100` (agent containers reaching a pool on another node).
- **Control-plane routed rule** ([cloud-init.yaml](../../../../../infra/hetzner/cloud-init.yaml), and `ufw_route_allow` in [converge-control-plane.sh](../../../../../infra/hetzner/scripts/converge-control-plane.sh)): `ufw route allow from 172.18.0.0/16 to 10.0.0.0/24 port 3100`. Converge applies it to existing control planes on every deploy.
- **Tests:** [test-converge-control-plane.sh](../../../../../infra/hetzner/scripts/tests/test-converge-control-plane.sh) expects 9 UFW rules and asserts the new rules, `host_network`, and the static port. The suite exits 0. `cloud-init` YAML parses.

### Limits of this fix

- A static port allows one pool instance per node. Scaling out needs one port per instance (see the autoscale plan) before `count` is raised.
- The worker resolves the pool address once at startup. A reschedule needs a worker restart (known limitation from 2026/10/08 002).
- Running agents keep the `BROWSER_POOL_URL` they were launched with, so they need a restart after the address changes.

## Deploy order (staging)

Cloud-init runs only on first boot, and the staging agent node already exists. Converge covers only the control plane. So the existing node needs manual steps. Do these before resubmitting the job. The job fails to place if the client has no `private` host network.

1. Apply the control-plane route rule: run the normal staging deploy, which converges control planes, or `setup-control-plane.sh --env staging`.
2. On `herobids-staging-agent-3` (`178.105.68.146`), add the `host_network "private"` block to `/etc/nomad.d/nomad.hcl` and add the three `ufw` rules above. Then restart the Nomad client. **This restarts the Nomad client on a node running six agent containers. Get operator approval first.**
3. Resubmit the job with the Nomad token: `nomad job run infra/nomad/browser-pool.nomad.hcl`. The allocation moves to `10.0.0.5:3100`.
4. Restart the worker, so it resolves the new address.
5. Restart agents that were launched before this change, so they pick up the new `BROWSER_POOL_URL`.

## Verification

- `nomad service info browser-pool` shows `10.0.0.5:3100`, not the public address.
- On the agent node, `ss -ltnp | grep 3100` shows the port on the private address. Expect Docker to publish on that address. If it publishes on `0.0.0.0`, UFW still blocks the public interface, but record it.
- From the control plane: `curl -m 5 http://10.0.0.5:3100/json/version` returns 200.
- The admin Browser Pool panel shows one server.
- An agent's `browse_interactive` open, snapshot, and close succeed.
- Run the gate: `infra/hetzner/scripts/smoke-test-browser-pool.sh --env staging <control-plane-ip>`. All checks must pass. See [002](./002-no-staging-check-for-browser-pool.md).

## Staging test

The gate that proves this fix is [smoke-test-browser-pool.sh](../../../../../infra/hetzner/scripts/smoke-test-browser-pool.sh), run by `smoke-test.sh` as check 7. It is described in [002](./002-no-staging-check-for-browser-pool.md). It failed on staging before this fix, as expected.

## Follow-ups

- Confirm the Docker port-publish address on a staging node after deploy.
- Confirm whether the deleted old node's cloud-init failed before UFW ran. The node is gone, so check the cloud-init logs of any new node that hits the same failure.
- Production uses the same design. Run the same checks there before relying on the pool.
- Browserless has no token auth (per the autoscale plan). Do not open the port to the public internet.
