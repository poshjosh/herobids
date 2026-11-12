# Owner Inbox

Things only the owner can approve or answer. Agents add items; the owner replies in the **Reply** column or in chat and the agent records it. Agents never wait on this file: they move to the next unblocked task. Rules: [conventions.md](./conventions.md) section 5.

**Item form:** `I-nnn`, kind (approval or fact), what and why, exact commands or the question, expected effect, rollback, how it will be verified, a recommended answer, status (`open`, `approved`, `answered`, `rejected`, `withdrawn`).

## Open

### I-001 (fact): Confirm the program structure and location
- **Question:** Is `docs/features/2026/11/11/001-autoscaling-program/` the right home, with `README.md` as the entry point and one folder per milestone?
- **Recommended answer:** yes. It follows the repo's feature-folder convention and keeps older plans linked, not moved.
- **Blocks:** nothing. M1's exit checks freeze on your confirmation.
- **Status:** open · **Reply:**

### I-002 (fact): Two owner facts for the shared-kit decision (OD-01)
Asked once, with proposed answers. Confirm or correct.

| # | Question | What I found | My proposed answer | Reply |
|---|---|---|---|---|
| Q1 | Do herobids and Traderton use the same Hetzner project or API token? | Traderton's README says it owns its own VM, firewall and data volume and shares no Terraform state. The herobids drift note says herobids staging and production share one project and token. I did not read any token | Traderton is separate; herobids staging and production share one | |
| Q2 | How much engineering capacity is there over the next quarter (people and agents working in parallel)? | Not recorded anywhere | One owner plus agents, so favour small, byte-identical steps over a rewrite | |

- **Blocks:** the decision on OD-01 (F1.2, F1.3). Not F1.1.
- **Status:** open

### I-003 (approval, deferred): Clean up superseded browser-pool plans
- **Action:** when M3 starts, delete `pending/002-browser-pool-autoscale`, `003` and `004` after their still-valid parts are copied into M3 plans; keep `005` as the design reference.
- **Why:** reduce duplicate sources of truth (INV-P3).
- **Not yet actionable.** Listed so it is not forgotten.
- **Status:** deferred to M3 start

## Answered and closed

(none yet)
