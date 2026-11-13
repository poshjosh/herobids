# Owner Inbox

Things only the owner can approve or answer. Agents add items; the owner replies in the **Reply** line or in chat, and the agent records it. Agents never wait on this file: they move to the next unblocked task. Rules: [conventions.md](./conventions.md) sections 5 and 11.

**Every item stands alone.** Its title says what is being asked. The body says what, why it matters, the exact question, a recommendation, and what happens under each answer. The ID (`I-nnn`) is only a label.

## Open

### I-001: Approve where this program lives and how it is organised

**What it is.** The autoscaling work now has its own folder, `docs/features/2026/11/11/001-autoscaling-program/`. It is organised like this:

- `README.md` is the entry point you hand to an agent.
- `milestones.md` is the single list of milestones, with their status.
- Each milestone gets its own folder (`m1-shared-core/`, and later `m2-...`) only when it starts. Each feature plan lives inside its milestone folder.
- `journal.md` is the session log. `owner-inbox.md` (this file) is what needs you.
- The older plans (staged agent-node rollout, sandbox egress, browser-pool plans 002 to 005) stay where they are, each with a pointer to this program.

**Question.** Do you approve this location and organisation?

**Recommendation.** Yes. It follows the repo's existing feature-folder pattern and breaks no links.

**If yes:** the exit checks of the first milestone (M1) become frozen, so agents cannot reword them to fit their results.
**If no:** tell me what to change (a different folder, a different file layout). Nothing else is waiting on this.
**Status:** open · **Reply:**

### I-002: Two facts I need from you (for the decision on a shared autoscaling kit)

The decision on how to share autoscaling code across the three tiers needs two facts only you hold. I propose an answer for each, so you can just confirm or correct.

1. **Do herobids and Traderton use the same Hetzner project or API token?**
   - What I found: Traderton's README says it owns its own server, firewall and data volume and shares no Terraform state with herobids. The herobids drift note says herobids staging and production share one project and token. I did not read any token.
   - **Answered by the owner on 2026-11-11: they use the same Hetzner project today.** My proposed answer ("Traderton is separate") was a wrong guess. I had read Traderton's README, which says it has its own Terraform state, and wrongly took that to mean its own cloud project.
   - Consequence recorded in limitation L-14 of the decision registers: the two systems' resources are told apart by labels (`app=herobids` and `app=traderton`), so the herobids autoscaler's ownership guard does not see Traderton's servers. Whether a shared cloud project is acceptable for legal separation is the owner's call, not assumed.
2. **How much engineering capacity will there be over the next quarter** (people and agents working in parallel)?
   - What I found: not recorded anywhere.
   - My proposed answer: one owner plus agents, so favour small, identical-behaviour steps over a rewrite.
   - Why it matters: it decides how ambitious the sharing approach can be.

**Blocks:** the decision on the shared kit (plans F1.2 and F1.3 in milestone M1). It does not block the first plan.
**Status:** fact 1 answered (same project); fact 2 (engineering capacity) still open · **Reply:**

### I-003 (deferred): Delete the superseded browser-pool plans 002, 003 and 004

**What it is.** These three plans were already marked partly superseded by plan 005. When the browser-tier milestone (M3) starts, their still-valid parts get copied into M3 plans.
**Question (later):** may I then delete the three folders, keeping 005 as the design reference?
**Why:** two sources of truth for the same work drift apart.
**Not actionable yet.** Listed so it is not forgotten.
**Status:** deferred to the start of M3

## Answered and closed

(none yet)
