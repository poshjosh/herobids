# Program Progress Tracker — External Backend / Staging

**Status:** live. **Read this immediately after ENTRYPOINT.md.**
**Updated:** 2026-09-24

## Current state (read first)

**Current phase:** Phase 1 — Restore And Prove Staging
**Current step:** 1 — Recover Herobids staging (diagnosis only; no mutation performed yet)
**Blocked on:** S3 backend credentials/access for Terraform state inspection
(`TF_BACKEND_BUCKET`, `TF_BACKEND_REGION`, `AWS_*`) and SSH access for later
passes. Read-only Pass 1 (Terraform state inspection) is authorized and may be
done now — it obtains the server IP from state; only mutation requires
operator approval. Optional last-known-change context speeds diagnosis but is
not required to begin.

## Step status

Legend: ✅ done · 🔄 in progress · ⏸ paused · ⬜ not started · 🚫 blocked

| # | Step | Status | Notes / handoff |
| --- | --- | --- | --- |
| 1 | Recover Herobids staging | 🔄 | Plan in `../002-staging-recovery-diagnostic-plan.md`; read-only Pass 1 authorized to run now; mutation gated on approval |
| 2 | Create Traderton staging infrastructure | ⬜ | |
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

- *None yet.* Step 1 is the first active step; document its diagnosis outcome here when done.