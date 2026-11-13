# Staging autoscale blocked by `ownership_mismatch`

**Date:** 2026-11-12
**Environment:** staging (`herobids-staging`, control plane `138.199.172.202`)
**Status:** fixed by the Phase 1 cleanup of the
[Hetzner scale path plan](../../../features/2026/11/12/001-hetzner-scale-path/plan.md).
**Related:** ADR / plan task 0.5, 1.1–1.8.

## Symptom

Scale-out is refused on every autoscale tick. `/var/log/nomad-autoscale.log` on the
staging control plane repeats, roughly every 60 s:

```
[demand] Capacity guard BLOCKED scale-out: ["ownership_mismatch"]
Alert: failure count incremented to 4553/3.
```

The failure counter had reached 4553 by the time this report was written, so the pool
has been unable to scale out for a long time. Demand mode is on
(`NOMAD_AUTOSCALE_DEMAND_ENABLED=true`).

## Evidence (read-only, 2026-11-13)

Live Hetzner inventory for `app=herobids,environment=staging` (via
`capacity_fetch_cloud_servers staging`, GET-only):

| Cloud server | role | node_pool label | status | private IP | id |
|---|---|---|---|---|---|
| herobids-staging | control-plane | – | running | 10.0.0.2 | 167421976 |
| herobids-staging-agent-1 | agent | herobids-staging | running | 10.0.0.5 | 173731633 |
| herobids-staging-agent-2 | agent | herobids-staging | running | 10.0.0.3 | 173858368 |
| herobids-staging-agent-caps-1 | agent | herobids-staging | running | 10.0.0.4 | 175258516 |
| herobids-staging-agent-caps-2 | agent | herobids-staging | running | 10.0.0.6 | 175258517 |

Live Nomad nodes (`capacity_fetch_nomad_nodes`):

| Nomad node name | class | status | eligibility | address | id (short) |
|---|---|---|---|---|---|
| herobids-staging-agent-caps-2 | agent | ready | eligible | 10.0.0.6 | 690b36fc |
| herobids-staging-agent-3 | agent | ready | ineligible | 10.0.0.5 | 714f26cc |
| herobids-staging-agent-2 | agent | ready | ineligible | 10.0.0.3 | 9fed1a12 |
| herobids-staging-agent-caps-1 | agent | ready | eligible | 10.0.0.4 | ae9393db |

Reconcile with the real pool (`capacity_reconcile … herobids-staging`), read-only:

```
blockers:        ["ownership_mismatch"]
managed servers: ["herobids-staging-agent-1","herobids-staging-agent-2"]
```

So the reconcile treats only `agent-1` and `agent-2` as managed (shaped) servers; the
two `herobids-staging-agent-caps-*` servers fall into `$foreign` and raise
`ownership_mismatch`.

Two name-drift facts, recorded because they confirm "the live inventory is the truth"
(plan §1, task 0.2), but neither causes the block:
- The Nomad node named `herobids-staging-agent-3` sits at `10.0.0.5`, which is the
  private IP of the cloud server `herobids-staging-agent-1`. The Nomad node name and
  the Hetzner server name for that machine disagree.
- There is no Nomad node literally named `herobids-staging-agent-1`.

## Cause

The capacity guard (`infra/hetzner/scripts/capacity-inventory.sh`, program
`_CAPACITY_RECONCILE_JQ`) classifies any live `role=agent` server whose name is not
`^<pool>-agent-[0-9]+$` as foreign:

```jq
def shaped:
  .labels.role == "agent" and .labels.node_pool == $pool
  and ((.name // "") | test("^" + $pool + "-agent-[0-9]+$"));
...
| ($live | map(select((shaped | not) and (.labels.role != "control-plane")))) as $foreign
...
if ($foreign | length) > 0 then "ownership_mismatch" else empty end,
```

The two servers `herobids-staging-agent-caps-1` / `-caps-2` are a temporary second
pool (`infra/hetzner/main.tf`, resource `hcloud_server.agent_caps`, commit `e1717e37`
"Add agent-caps node pool to Terraform (sandbox replacement pool)"). Their names carry
the extra `-caps-` segment, so they fail the `shaped` test and land in `$foreign`. The
guard then refuses every scale action for the pool. The sandbox work that motivated the
caps pool is now deferred, so the pool only serves to block autoscaling.

## Fix

Remove the caps pool and converge staging on one clean `herobids-staging-agent-<N>`
pool, as laid out in Phase 1 of the
[Hetzner scale path plan](../../../features/2026/11/12/001-hetzner-scale-path/plan.md)
(tasks 1.2–1.8): pause the autoscaler, drain the old nodes, rebuild the main pool on
`cx53`, drain and destroy the caps nodes, remove the `agent_caps` Terraform resources,
purge any Nomad node outside Terraform state (including the drifted `agent-3` node),
then resume the autoscaler and confirm 10 consecutive clean runs.

## Fixed (live, 2026-11-13)

Phase 1 of the scale-path plan was executed on staging:
- Rebuilt the main agent pool as one clean `herobids-staging-agent-1` (on `cx23`, per the
  owner's node-type decision), removed the `agent_caps` pool (both servers destroyed via a
  targeted Terraform plan), and purged the stale `down` Nomad nodes (the two caps nodes and
  the drifted `agent-3`/`agent-2`).
- Reconciled the benign `hcloud_firewall.agent[0]` attachment drift with
  `terraform apply -refresh-only` (0 resource changes), which the scale-out allowlist requires.
- Resumed `nomad-autoscale.timer`.

Evidence after the fix:
- A full untargeted `terraform plan` reports **No changes**.
- The capacity guard reconciles cleanly: `[demand] Managed=1 active=1 … ready=1`, no
  `ownership_mismatch`.
- A real demand-driven scale-out succeeded: `[demand] === Scale-out successful: 1 -> 2 agent
  nodes (backlog, headroom) ===`; `agent_node_count=2` written to `staging.tfvars`.
- Steady state: two clean nodes `herobids-staging-agent-1`/`-2` (ready, eligible, names match
  the Hetzner servers), all agent jobs `running`, 0 blocked evaluations.
- The autoscale log shows consecutive clean ticks (no_demand/cooldown no-ops), no blockers.

Root cause (the deferred `agent_caps` pool tripping the ownership check) is resolved by removing
the caps pool. Status: **fixed**.
