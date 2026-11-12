# Autoscaling Program: Entry Point

**Start here.** Hand this file to an agent and it can start or continue the work.
**Created:** 2026-11-11. **Owner:** the project owner. **State lives in:** [milestones.md](./milestones.md), the active milestone folder, and [journal.md](./journal.md).

## Goal (does not change without the owner)

> Capacity for all three tiers, **agent nodes, the browser pool and Traderton**, follows demand automatically, within hard bounds, without losing or duplicating work, at the 100k-user envelope (about 10,000 resident agents, up to 200 browser sessions, about 5,000 trading agents), with unit cost measured.

This is strategic objective SO-3 in [01-strategy.md](../../../../../decisions/01-strategy.md), made concrete.

**Program is done when** every tier has: (1) a demand signal that is recorded; (2) an autoscaler with hard bounds, a cooldown, and fail-closed behaviour; (3) safe scale-in; (4) proof on staging under synthetic load; (5) cost per unit measured; (6) a production rollout through the gates. Each milestone turns these into checks it can fail.

## Resume protocol (an agent follows these steps, in order)

1. Read this file.
2. Read [conventions.md](./conventions.md) once per session. It holds the rules of work, statuses, and stop conditions.
3. Read [milestones.md](./milestones.md). Find the milestone whose status is `in_progress`. If none, take the first `ready` one.
4. Read that milestone's `README.md`. Find the feature plan that is `in_progress`, else the first `ready` one.
5. Read the **last five entries** of [journal.md](./journal.md) and everything in [owner-inbox.md](./owner-inbox.md) that changed since your last entry (approvals and answers).
6. Open the feature plan. Continue at the **first task that is not `done`**. If it is `blocked`, take the next unblocked task. Never stall.
7. Before you stop: update statuses bottom-up, append a journal entry, and add anything the owner must approve to the inbox. See conventions section 7.

If everything in the active milestone is `done` or `blocked`, follow conventions section 3 (draft the next plan) and keep going.

## Copy-paste prompt for a new agent

```text
You are continuing the OpenAIdom autoscaling program. Open
docs/features/2026/11/11/001-autoscaling-program/README.md and follow its resume protocol.
Make decisions with docs/decisions/ (README.md "Which path does a decision take?"). Do not wait for
the owner: record approvals you need in owner-inbox.md and move to the next unblocked task.
Stop only for the conditions in conventions.md section 8.
```

## Map

| File or folder | Purpose | Changes |
|---|---|---|
| [milestones.md](./milestones.md) | The single list of milestones, status, and links | When a milestone changes status |
| [conventions.md](./conventions.md) | Rules of work: statuses, update order, just-in-time planning, decisions, approvals, stop conditions | Rarely |
| [journal.md](./journal.md) | Append-only log, one short entry per session | Every session |
| [owner-inbox.md](./owner-inbox.md) | What the owner must approve or answer, and the replies | Whenever needed |
| `m<N>-<slug>/` | One folder per milestone, created when the milestone starts | Per milestone |
| `m<N>-<slug>/README.md` | Goal, frozen exit checks, feature plan table with statuses, risks | Per feature |
| `m<N>-<slug>/f<N>-<M>-<slug>/plan.md` | One feature plan with a task table and statuses | Per task |
| `m<N>-<slug>/reference/` | Analysis notes that plans rely on | As discovered |
| [templates/](./templates) | Milestone and feature-plan templates | Rarely |

Only the active milestone has a folder and detailed plans. Later milestones are one line in `milestones.md`. This is deliberate (conventions section 3).

## How this relates to earlier plans

Nothing is moved or deleted yet, so existing links keep working. Each older document gets a pointer to its milestone, and its role is stated here.

| Earlier document | Role now | Milestone |
|---|---|---|
| [pending/000-staged-agent-node-rollout](../../../../pending/000-staged-agent-node-rollout/001-plan.md) (plan and learnings) | Source for the agent-node rollout work and lessons. Stays as a reference. Its remaining work becomes feature plans in M2 | M2 |
| [pending/000-sandbox-uid-egress](../../../../pending/000-sandbox-uid-egress/001-plan.md) | The sandbox rollout and retirement of the old nodes. Same treatment | M2 |
| [pending/005-browser-pool-dedicated-tier](../../../../pending/005-browser-pool-dedicated-tier/001-plan.md) | The design and phase list for the browser tier. Phases become feature plans in M3, drafted when needed. Once adopted, its checkboxes stop being the progress record | M3 |
| [pending/002-browser-pool-autoscale](../../../../pending/002-browser-pool-autoscale/001-plan.md), [003](../../../../pending/003-browser-pool-scale-foundations/001-plan.md), [004](../../../../pending/004-browser-pool-scale-to-thousands/001-plan.md) | Already marked partly superseded by 005. History only | M3, M5 |
| [docs/decisions/](../../../../../decisions/README.md) | The decision framework this program uses | all |

**Proposed clean-up (needs the owner):** when M3 starts, delete `002`, `003` and `004` after their still-valid parts are copied into M3 plans; keep `005` as the design reference. Recorded in the inbox.
