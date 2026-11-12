# Milestones

**The single list.** One row per milestone. Detail lives in the milestone folder. Statuses and rules: [conventions.md](./conventions.md) section 1. Entry point: [README.md](./README.md).
**Last updated:** 2026-11-11

| ID | Milestone | Why it exists (one line) | Status | Folder | Depends on |
|---|---|---|---|---|---|
| M1 | Shared autoscaling core, tier-aware | Make the existing autoscaler's safety logic reusable by a second tier, and unblock staging, whose scale-out is refused today | **in_progress** | [m1-shared-core](./m1-shared-core/README.md) | none |
| M2 | Agent tier ready for scale | Make the largest tier (about 10,000 resident agents) fit the control plane, node sizes and network; stop over-limit agents (C-13); finish the staged agent-node rollout | planned | created when started | M1 (guard fix) |
| M3 | Browser tier | Build the dedicated, auto-scaled browser pool: measure, move, front door, dedicated nodes, autoscaler, safe scale-in, security | planned | created when started | M1 |
| M4 | Traderton scaling | Measure, decide and build how Traderton scales for about 5,000 trading agents | planned | created when started | measurements from M2 |
| M5 | Scale proof and cost | Prove all tiers under synthetic load on staging; measure unit cost; alerts; runbooks | planned | created when started | M2, M3, M4 |
| M6 | Production rollout | Roll each tier to production through the gates, with owner approvals | planned | created when started | M5 |

**Order.** M1 first. M2 and M3 can then run in parallel. M4 needs measurements that M2 produces. M5 and M6 follow. This order may change; change it here and note why in the journal.

## Exit checks (summary; the frozen version is in each milestone README)

| ID | The milestone is done when |
|---|---|
| M1 | The autoscaler's ownership guard and plan checks are driven by a tier profile; agent behaviour is byte-identical; staging scale-out is no longer refused because of the caps pool; a for_each-style tier passes the same checks in fixtures |
| M2 | Per-resident control-plane limits are measured and fixed; node sizing and network are decided and applied on staging; over-limit agents are stopped; the old agent nodes are retired |
| M3 | Browser nodes scale out and in under load on staging with no cut session; the front door is private-only; cost per session is measured |
| M4 | A decision record exists for Traderton scaling; the chosen path scales under synthetic load on staging without duplicating a trading agent |
| M5 | Each tier holds its target under synthetic load; unit costs are measured; alerts and runbooks exist |
| M6 | Each tier runs on production with its bounds, alerts and rollback tested |

## Status rules in one line

A milestone is `done` only when every exit check passes as a behaviour of the running system. Deferring something needs a named home. See [conventions.md](./conventions.md).
