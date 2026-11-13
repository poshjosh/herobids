# Runbook: switch the agent or browser node type (e.g. cx23 ↔ cx53)

**When:** the agent pool is approaching the ~60-node / ~750-agent trigger (see the
[Hetzner scale-path plan](../../../../docs/features/2026/11/12/001-hetzner-scale-path/plan.md) §7),
or the browser pool's measured sessions-per-node is the constraint. Starting node type is
`cx23`; the usual switch is up to `cx53`.

**What it does:** rebuilds every node in one pool (`agent` or `browser`) on a new Hetzner
server type by `terraform -replace`, keeping everything else (control plane, network, the
other pool, the browser node's fixed IP) untouched. It is **hard to undo** (nodes are
destroyed and recreated; agents on a replaced node restart elsewhere), so every apply is
gated behind a plan review.

Helper: `infra/hetzner/scripts/switch-node-type.sh` does the mechanics. This runbook is the
authority on order, the manual judgement points, and rollback.

---

> **Status (2026-11-13):** the cx53 switch has NOT been run live yet — it is **deferred**
> pending the Hetzner shared-core limit raise (an earlier `cx53` apply failed with
> `shared core limit exceeded`). The script, runbook and tests are ready. Raise the limit
> (plan task 0.4), then follow this runbook. Owner todo.

## 0. Before you start (do not skip)

1. **Raise the Hetzner limit first if switching UP.** The Hetzner project is shared
   (herobids staging + production + Traderton). A `cx53` is 16 vCPU; a larger fleet can
   exceed the project's shared-vCPU / server limit, and the apply then fails with
   `shared core limit exceeded` **after** destroying the old node. The project quota is only
   visible in the Hetzner console — confirm it was raised (ask the owner) before you switch up.
   This is the single most common failure; it stranded a `cx53` apply on 2026-11-13.
2. Read `infra/hetzner/docs/auto-scaling/useful-commands.md` and, for production,
   `infra/hetzner/docs/runbooks/production-notes.md`.
3. Run **on the control plane** over SSH (the Terraform state + backend creds live there).
   `TF_DATA_DIR=.terraform-envs/<env>` is set by the helper.
4. Know the rollback phrase: switching back to the old type is the same command with the old
   `--to`. A `cx53`↔`cx23` replace works both ways; agents restart on the remaining nodes.

---

## 1. Agent pool switch

```sh
# on the control plane
infra/hetzner/scripts/switch-node-type.sh --env staging --pool agent --to cx53
```

The script will:
1. Pre-check the type and warn about the shared-core limit.
2. Stop `nomad-autoscale.timer` and `nomad-scale-in.timer`.
3. Set `agent_node_server_type = cx53` in `<env>.tfvars` (backup kept).
4. Produce a `-replace` plan for `hcloud_server.agent[*]` + `hcloud_server_network.agent[*]`,
   **refuse** if the plan touches anything else, show the plan, and require the confirmation
   phrase `switch agent <env> cx53`.
5. Apply. **Expected plan:** replace each `hcloud_server.agent[i]` and its network attachment.
   Nothing on `hcloud_server.default`, the network, or volumes. If you see any of those, the
   script already refused — stop and investigate.
6. `refresh-only` to clear the `hcloud_firewall.agent[0]` `apply_to` drift (otherwise the
   scale-out allowlist rejects on drift).

**Then, manually (the script prints these):**
7. **Re-measure the node template** on a new `cx53` node and update the demand-mode template,
   or demand-mode scale-out will mis-size:
   ```sh
   # token from /etc/nomad.d/acl-token; do not print it
   curl -s -H "X-Nomad-Token: $(cat /etc/nomad.d/acl-token)" \
     http://127.0.0.1:4646/v1/node/<new-node-id> \
     | jq '{mem:.NodeResources.Memory.MemoryMB, cpu:.NodeResources.Cpu.CpuShares, reserved:.ReservedResources}'
   ```
   Set `nomad_node_template_memory_mb` / `nomad_node_template_cpu_mhz` in `<env>.tfvars` to the
   usable (total − reserved) values, then re-upload settings:
   ```sh
   infra/hetzner/scripts/setup-autoscale-env.sh --env <env>
   ```
8. Confirm each new node is `ready` + `eligible`, class `agent`, in `nomad node status`, and
   that the Hetzner name equals the Nomad name.
9. The script restarts the timers. Read ~10 autoscale-log runs: no `ownership_mismatch`, no
   blockers.

---

## 2. Browser pool switch

```sh
infra/hetzner/scripts/switch-node-type.sh --env staging --pool browser --to cx53
```

Same flow, with two browser-specific points:
- The browser node keeps its **fixed private IP** (`10.0.0.240`). A replace destroys the old
  network attachment before creating the new one (both cannot hold the IP) — this is why the
  replace, not an in-place resize, is used.
- **Restart the worker after the new browser node is up**, because the worker resolves the
  browser pool address only at startup:
  ```sh
  docker compose -f docker-compose.yaml -f docker-compose.<env>.yaml up -d worker
  # confirm: docker logs ... | grep "Browser pool URL resolved"  -> http://10.0.0.240:3100
  ```
- Re-run the sandbox egress sanity on an agent afterwards (A1 public reachable, A2 private
  `10.0.0.2:5432` blocked for the agent user, A3 browser `10.0.0.240:3100` reachable) — the
  browser IP is the only allowlisted private host, so a changed IP would break browsing.
- Resize `browser-pool.nomad.hcl` `MAX_CONCURRENT_SESSIONS` / `memory` / `cpu` to the new node
  and redeploy the job, then re-measure the sessions-per-node ceiling
  (`scripts/loadtest/browser-sessions.sh`).

---

## 3. If the apply fails with `shared core limit exceeded`

The old node is likely already destroyed and the new one was not created. The pool is short
but the system keeps running on the remaining nodes (and the caps/other pool). Do not retry
blindly. Either:
- Get the Hetzner limit raised, then re-run the same command (it will create the missing node), or
- Switch back down: re-run with `--to <old-type>` (e.g. `cx23`), which fits the existing quota.

Never resolve it by deleting data or the control plane.

---

## 4. Rollback

Re-run the switch with the previous type:
```sh
infra/hetzner/scripts/switch-node-type.sh --env <env> --pool <agent|browser> --to cx23
```
For the agent pool, also restore the `nomad_node_template_*` values for `cx23`
(`3819` / `4000`) and re-upload settings. Agents restart on the remaining nodes during the roll.
