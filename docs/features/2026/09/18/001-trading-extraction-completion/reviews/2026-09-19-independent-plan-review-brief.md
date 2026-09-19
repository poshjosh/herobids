# Independent Plan Review Brief

- **Date:** 2026-09-19
- **Status:** Ready for review
- **Scope:** ADRs 010–014 and plans C1a, C1–C5.
- **Purpose:** independent architecture review before implementation; it is not an implementation authorization.

## Reviewer Entry Point

Start with this brief, then read in this order:

1. `../000-roadmap.md` for current status and dependency order.
2. ADRs 010–014 under `docs/tech/architecture/adrs/2026/09/` for ratified constraints.
3. `../plans/C1a-profile-write-path-consolidation.md`, then
   `../plans/C1-trading-profile-slice.md`, C2, C3, C4, and C5.
4. `../decisions/B1-trading-profile-contract-draft.md` for C1's exact store and
   boundary-tool contract.
5. From the workspace root, inspect source evidence in
   `traderton/packages/boundary/src/agent-direct-actor-ensure.ts`,
   `traderton/packages/worker/src/composition/decision-intake.ts`, and
   `traderton/packages/db/src/repositories.ts` before questioning the selected
   triple key.

## Review questions

1. Does C1 enforce only from traderton-owned, verifiable state and delete every
   payload-echo path in the clean-slate cut-over?
2. Is C1's `(ownerId, actorId, venueAccountId)` key justified by the existing
   actor cache and durable fills/positions/risk reads, and do its tests prevent
   two agents sharing one venue account from reading or clearing each other's
   profile?
3. Does C2 leave one authority for defaults and risk math while preserving only
   intentional, parity-checked wire mirrors?
4. Does C3 prevent domain-specific formatting, semantic inference, and visual
   rules from leaking into generic herobids UI components?
5. Does C4 limit trading-account tools to trading-capable agents without
   breaking generic skill assignment?
6. Do the plans preserve the legal boundary confirmed by ADR 012: herobids may
   reason over a capability but does not execute, enforce, or own risk-gate
   authority?
7. Are the dependency order, test coverage, profile-write compensation, and
   failure handling adequate for a
   clean cut-over?
8. Does C5 preserve A8 as the baseline while requiring all five repository
   suites and two final clean A8 runs, with actionable evidence recording?

## Required output

Return prioritized findings with the affected ADR/plan section and a concrete
correction. Classify each finding as blocking, significant, or advisory. No C1a,
C1, C2.1/C2.2, C3, C4, or C5 implementation starts until blocking findings are
dispositioned. C2.3 may start only if the reviewer confirms it does not obscure
the authority boundaries.

## Disposition (2026-09-19)

The independent review identified and the user accepted corrections for: one
selected direct-execution binding per running agent; a revisioned full-snapshot
profile contract; signed-agent isolation; durable profile-change compensation;
an explicit C3 presentation contract and UAT execution; complete C4 prompt
surface removal; and mandatory assertion-only parity CI. The corrected plans and
governing documents are the implementation source of truth. C2.3 is confirmed
authority-neutral only as the specified assertion-only check. Implementation
still requires separate authorization and execution-ledger evidence.