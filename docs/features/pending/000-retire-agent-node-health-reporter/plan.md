# Retire the on-node agent-node-health reporter (worker owns agent-server health)

## Why

Two writers now publish the `agent-server` `ServerHealthSnapshot` to Redis under
`herobids:server-health:agent-server:<id>`:

1. **On each agent node** — `infra/hetzner/scripts/agent-node-health.sh`, run by a
   systemd oneshot (`agent-node-health.service`) on a ~15s timer
   (`agent-node-health.timer`), installed inline by
   `infra/hetzner/cloud-init-nomad-client.yaml`.
2. **In the worker (control plane)** — `apps/worker/src/agent-server-health-publisher.ts`
   (`AgentServerHealthPublisher`), added in the agent-fleet-visibility feature.

Both write the same key space with a 60s TTL, so it is last-writer-wins — a latent
inconsistency bug, and now a correctness gap: the worker publisher computes real free
memory (total − reserved − occupying allocations) and uses the same node/pool filter and
occupancy predicate as the cluster-capacity publisher, so its numbers agree with the
capacity section and the autoscaler. The on-node script derives memory from `free`/`df`
on the host and does not share that logic.

Decision (owner, 2026-11-14): **the worker is the single owner.** It is where the code,
tests, pool filter, and capacity math already live, and it keeps the agent nodes dumb.
The on-node reporter is to be retired.

This plan is the infra decommissioning step, kept separate from the application change on
purpose: it mutates shared infrastructure (cloud-init, systemd units on live nodes), which
must be an explicit, owner-approved step, not folded into the app rework.

## Scope / touchpoints

Remove the on-node reporter and its scheduling:

- `infra/hetzner/cloud-init-nomad-client.yaml`:
  - the inline `agent-node-health.sh` file block,
  - the `agent-node-health.service` unit,
  - the `agent-node-health.timer` unit,
  - the `systemctl enable/start agent-node-health.timer` runcmd lines,
  - the `AGENT_NODE_HEALTH_ENABLED` / `REDIS_URL` env wired for that service.
- `infra/hetzner/scripts/agent-node-health.sh` — the standalone reference copy.
- Any docs/runbooks that reference `agent-node-health` or `AGENT_NODE_HEALTH_ENABLED`.

Leave untouched: the Redis key space and TTL (the worker keeps writing them), the
`ServerHealthSnapshot` contract, and the admin dashboard.

## Rollout (reviewed infra change — owner approval required)

Ordering matters: the worker publisher must be live and verified **before** the on-node
reporter is removed, so the `agent-server` group never goes dark.

1. Confirm the worker `AgentServerHealthPublisher` is deployed and the dashboard's
   Agent Servers group is populated from it (check snapshot `version` / timing, or
   temporarily stop the timer on one node and confirm its card persists via the worker).
2. Flip the on-node reporter off first (reversible): set
   `AGENT_NODE_HEALTH_ENABLED=false` (the script already exits 2 when not `true`) on the
   nodes, or stop/disable `agent-node-health.timer`, and confirm cards still report.
3. Remove the units and script from `cloud-init-nomad-client.yaml` and delete the
   standalone script. New nodes come up without the reporter.
4. For existing nodes: either let them roll (staged node rollout) or run a one-off
   `systemctl disable --now agent-node-health.timer` via the approved maintenance path.
   Do not hand-edit shared state outside that path.

## Verification

- Dashboard Agent Servers group stays populated across step 2 and after step 3.
- No writer other than the worker touches `herobids:server-health:agent-server:*`
  (grep infra for `agent-node-health` returns nothing after removal).
- A non-Nomad / worker-down case still degrades to "No servers reporting." (worker
  publisher no-ops off-Nomad; that is expected and unchanged).

## Links

- Owner: `apps/worker/src/agent-server-health-publisher.ts` (the replacement writer).
- Shared node reads / filter: `apps/worker/src/agents/nomad-client.ts` (`readAgentNodes`).
- Capacity sibling that shares the same reads: `apps/worker/src/cluster-capacity-publisher.ts`.

## Status

Pending owner approval for the infra change. The application side (worker as owner) has
shipped; only the on-node decommission remains.
