# Program Progress Tracker — External Backend / Staging

**Status:** live. **Read this immediately after ENTRYPOINT.md.**
**Updated:** 2026-09-25

## Current state (read first)

**Current phase:** Phase 1 — Restore And Prove Staging
**Current step:** 1 — Recover Herobids staging (read-only diagnosis complete; baseline not restored)
**Blocked on:** Explicit operator decision on whether to re-provision staging.
The staging backend/workspace were inspected, but state serial 76 has no
resources or outputs; the refresh-only plan failed during configuration
evaluation, and the Hetzner API returned no server named `herobids-staging`.
DNS still resolves staging addresses, but their ownership is unconfirmed.
HTTPS and SSH probes did not connect successfully. Do not provision, change
DNS, or otherwise remediate until the operator explicitly approves a path.
Before an approved Herobids apply, review the prepared Traderton infrastructure
plan and code against the shared-network handoff in
[the Step 2 plan](../003-traderton-staging-infrastructure-plan.md). This does
not authorize provisioning or change the step order.

## Step status

Legend: ✅ done · 🔄 in progress · ⏸ paused · ⬜ not started · 🚫 blocked

| # | Step | Status | Notes / handoff |
| --- | --- | --- | --- |
| 1 | Recover Herobids staging | 🚫 | Read-only diagnosis complete; baseline remains unrestored. See `../002-staging-recovery-diagnostic-plan.md`; remediation is blocked pending explicit operator decision on re-provisioning |
| 2 | Create Traderton staging infrastructure | 🔄 | Public/independent model adopted (2026-09-25): no Herobids network handoff; Traderton owns its VM + public HMAC boundary. Items 1-3,5 code-prepared and reviewed; item 4 apply blocked on explicit approval; production plan [004](../004-traderton-production-infrastructure-plan.md) |
| 3 | Deploy Traderton boundary | ⬜ | |
| 4 | Integrate Herobids with Traderton | ⬜ | |
| 5 | Operational readiness and rollback | ⬜ | |
| 6 | Move trading documentation | ⬜ | Phase 2 |
| 7 | Build minimal Traderton frontend | ⬜ | Phase 2 |
| 8 | Audit legal/product boundary | ⬜ | Phase 2 |
| 9 | External Backend Genericization Discovery | ⬜ | Phase 3; starts after Phase 1 operational proof; produces all six ADR 015 exit criteria |
| 10 | External Backend contract and trust plan | ⬜ | Phase 3 |
| 11 | Generic client migration | ⬜ | Phase 3 |
| 12 | External skill deep integration | ⬜ | Phase 3 |
| 13 | Traderton skill publication | ⬜ | Phase 3 |
| 14 | Remove Herobids first-party trading ownership | ⬜ | Phase 3 |
| 15 | Trading-domain module cleanup | ⬜ | Phase 3 |
| 16 | Final staging proof | ⬜ | Phase 3 |

## Continuity handoff (for a new agent resuming work)

1. Read [ENTRYPOINT.md](./ENTRYPOINT.md) for objective + invariants.
2. Read [DECISIONS.md](./DECISIONS.md) for decisions made so far — do not relitigate them.
3. Read the current step's plan and resume at the first incomplete sub-step.
4. Do not perform any infrastructure mutation without operator approval.

## Steps completed with evidence

- *None yet.* Step 1's read-only diagnosis is recorded in `../002-staging-recovery-diagnostic-plan.md`; the staging baseline is not restored, so the step remains blocked.