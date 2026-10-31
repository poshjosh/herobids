# Manual recovery: fully empty agent pool

Plan reference: `001-safe-capacity-expansion-plan.md`, H3 (decided option A, fail closed).

## When this applies

The autoscaler does not scale from zero. When the pool has no managed agent servers, the capacity guard
refuses every scale action with the blocker `empty_inventory`. This happens even when the declared count
is 0, so it applies to both staging (`min_agent_nodes = 0`) and production (`min_agent_nodes = 1`).

Two ways to reach an empty pool:

- Staging: scale-in drains down to `min_agent_nodes = 0`, and the last agent is removed.
- Production: the floor is 1, so an empty pool means every agent was lost outside the autoscaler
  (for example, deleted or failed to join). Treat this as an incident.

Confirm the state before you act:

```bash
# Read-only. Prints the blockers (expect "empty_inventory").
scale-out.sh --dry-run
```

`--dry-run` makes no Terraform call and writes no state. The backend must already be initialised (see
[setup-auto-scaling.md](./setup-auto-scaling.md), Step 4).

Also check for work that needs capacity, so you know whether recovery is urgent:

```bash
nomad job status        # look for pending or blocked evaluations
nomad node status       # expect no ready nodes
```

## Approval

Staging: get explicit approval first, covering the node count (1), the duration, the owner who will
clean up, and the restoration step. This follows plan §12.3.

Production: get approval from the production owner. Do not run the steps below without it.

## Steps

The autoscaler and manual apply must not run at the same time. The autoscaler holds the lock
`/var/run/nomad-autoscale.lock` on the control plane, and a manual apply from your workstation does not take
that lock. So stop the timers first.

1. **Pause the autoscaler timers** on the control plane:

   ```bash
   sudo systemctl stop nomad-autoscale.timer
   sudo systemctl stop nomad-scale-in.timer    # only if it is enabled
   systemctl list-timers 'nomad-*'             # confirm they are inactive
   ```

2. **Plan one agent with the same backend and tfvars as the normal path:**

   ```bash
   cd infra/hetzner
   export TF_DATA_DIR=.terraform-envs/<env>
   terraform plan -var-file=<env>.tfvars -var="agent_node_count=1" -out="$PLANFILE"
   ```

   Use a private temporary path for `$PLANFILE` (`mktemp`, mode 600). Saved plans can contain secrets.

3. **Review the plan before applying.** The only allowed change is creating index 0 of the agent pool:

   ```bash
   terraform show -json "$PLANFILE" | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | "\(.address) \(.change.actions | join(","))"'
   ```

   Expected output is exactly these two lines, both `create`:

   ```
   hcloud_server.agent[0] create
   hcloud_server_network.agent[0] create
   ```

   If anything else appears (any update, delete, replacement, or a control-plane resource), stop. Do not
   apply. Get an owner decision.

4. **Apply the reviewed saved plan** (not a fresh plan):

   ```bash
   terraform apply "$PLANFILE"
   rm -f "$PLANFILE"
   ```

5. **Wait for the node to join.** It typically takes 3–5 minutes (cloud-init, then Nomad registration):

   ```bash
   nomad node status    # expect one node, status "ready", eligibility "eligible"
   ```

   Until it joins, `scale-out.sh --dry-run` reports `unjoined_without_record`. That is expected, because
   a manual apply writes no in-flight record. It clears by itself once the node is ready. Do not delete any
   record to clear it.

6. **Restart the timers and verify:**

   ```bash
   sudo systemctl start nomad-autoscale.timer
   sudo systemctl start nomad-scale-in.timer   # only if you stopped it in step 1
   scale-out.sh --dry-run                      # must not print "pool blocked"
   ```

7. **Record the recovery** in the incident notes: time, approver, node ID, and the cleanup owner.

## If the node does not become ready

- Do not leave a half-joined node running. Find it with `nomad node status` and the Hetzner console.
- Remove it through the same reviewed route, with `-var="agent_node_count=0"` and the same saved-plan check.
  The destroy plan must show only `hcloud_server.agent[0]` and `hcloud_server_network.agent[0]` deleted.
- If Terraform refuses because of `prevent_destroy`, stop and get an owner decision.
- Keep the timers stopped until the pool is back to a known state.

## Known limits

- Scale-from-zero is not automated (H3, option A). A bootstrap path with its own cap and approval is
  deferred.
- Staging was at `min_agent_nodes = 0`, so scale-in could empty the pool on its own. Decision: staging uses a
  floor of 1 (approved). The local `staging.tfvars` is set, but the live control plane reads the floor from its
  own environment (`TF_VAR_min_agent_nodes`, rendered from cloud-init, which has `ignore_changes = [user_data]`).
  Changing the live value is an approved P9 step, not done yet. Until then, this runbook is still the fallback.
- This runbook was rehearsed against the synthetic fixtures (see Verification). It has not been run against
  live staging or production.

## Verification

Rehearsal against the synthetic empty-pool fixtures (`cloud-empty.json`, `nomad-empty.json`), using the
real `capacity_reconcile` function, with no network or Terraform calls:

| Declared count | Exit | Status | Blockers |
|---|---|---|---|
| 0 | 2 | blocked | `empty_inventory` |
| 1 | 2 | blocked | `empty_inventory`, `partial_apply` |

The fixtures are synthetic and not captured from live Nomad (see `tests/fixtures/capacity/README.md`).
Live steps above are not executed. Mark them not executed until they are run under approval.

## Related

- [setup-auto-scaling.md](./setup-auto-scaling.md), "Clearing a blocked scale guard" (for blocked guards with
  an existing server).
- [lessons-learnt.md](./lessons-learnt.md), item 5 (`agent_node_count` in cloud-init).
