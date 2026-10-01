# Phase 2 Program — DECISIONS

**Status:** living. **Read before making any judgment call. Do not relitigate
settled decisions.** Append new decisions here as you make them.

The decision *process* (Contemplator handoff + trigger test) is defined in the
staging program's `../../09/24/000-program/DECISIONS.md` and is reused verbatim.
This file records Phase-2-specific decisions and is the append target for new ones.

## Decisions already made (settled — treat as governing)

| # | Decision | Status | Where |
|---|---|---|---|
| P2-1 | herobids must not be a trading application; trading product/identity is Traderton-owned. | Settled | ENTRYPOINT §1; staging ENTRYPOINT §1; [ADR 015](../../../../tech/architecture/adrs/2026/09/015-external-backend-skill-registration.md) |
| P2-2 | **No persisted agent "type".** Agent identity is derived from its skills → `capabilityFamilies`. Do not add a `type` column. `skillPresetId` (in `unifiedConfig.metadata`) is a creation-time convenience, not identity. `capabilityMode` (`intelligence`/`hybrid`) stays — it is runtime wake/exec mechanics, domain-neutral. | Settled | `../002-…/000-analysis.md`; frontend audit `../003-…` |
| P2-3 | Capability UI must be **generic/derived from skills**, not trading-hardcoded. The agent detail page lists one readiness card per family the agent actually has; Advanced settings exposes a generic **Capabilities** tab (trading config renders only when the trading family is present). | Settled | `../002-…`; audit bucket B |
| P2-4 | The frontend trading-coupling audit is complete and authoritative for the web surface. Whole trading *features* (bots, exposure, instance detail, portfolios — audit buckets A/E) are NOT part of the 002 slice; they belong to the full Step 8 classification. | Settled | `../003-…` |
| P2-5 | **Two hard stops only:** (a) infrastructure mutation (Terraform/deploy/DNS/TLS/secrets/live traffic), (b) legal/payment-provider product-boundary calls. Everything else the agent decides via the §5 rubric. | Settled | ENTRYPOINT §5.2 |
| P2-6 | Legal questions are **batched** into `ESCALATIONS.md`, never raised one-by-one mid-flight. The agent keeps working on all other surfaces and the operator resolves the batch at Step 8 wrap-up. | Settled | ENTRYPOINT §5.3; TASKS T5.2 |
| P2-7 | Do not break the deployed herobids↔Traderton boundary contract. Any route/field change (e.g. `/capabilities/trading/*`, `skillPresetId`) must land in lockstep on both sides, or keep a thin alias and defer removal to the backend audit. | Settled | invariant §3.3; `../002-…/001-plan.md` Stage 3/4 |
| P2-8 | Greenfield: prefer clean removal over compatibility shims (no users/data), EXCEPT where it would break the live boundary contract (P2-7). | Settled | invariant §3.3 |
| P2-9 | No push / no merge to `main`; commit locally, atomic per change. Cross-repo doc moves commit in each repo under the same rule. | Settled | invariant §4.4 |

## Decision framework for NEW decisions

1. Apply the §5.1 classification rubric (GENERIC / MOVE / REMOVE-SAFE /
   ESCALATE-LEGAL). If GENERIC/MOVE/REMOVE-SAFE → act, record here.
2. If ESCALATE-LEGAL → append to `ESCALATIONS.md`, continue other work. Do not stop.
3. If it is a HARD STOP (infra) → prepare + document + request approval; mark the
   task 🚫; continue other non-blocked tasks.
4. If it is an architecturally significant engineering judgment call (ownership
   boundary, contract/route/public-copy change, or contradicts a decision here)
   → route to Contemplator via the staging `DECISIONS.md` protocol; record the
   ruling below.
5. Low-stakes mechanical choice → just decide; no record needed.

## New decisions (append as you go)

- **P2-10 | The agent capability-readiness endpoint `GET /agents/:id/capabilities/readiness` must emit one readiness entry per capability family the agent's skills declare (data-driven), not a hardcoded `knownFamilies = ['trading']`. This GENERIC fix is in scope for T1.1 (not deferred to the backend audit). | 2026-10-01 | Contemplator ruling.** The route is herobids-internal web↔api, NOT the deployed herobids↔Traderton boundary (that contract is exactly `/internal/v1/tools:invoke` + `/internal/v1/invocations/` per `packages/domain/src/traderton/contract.ts`; `TradertonClient` is outbound-only; grep `readiness` under `**/traderton/**` = 0 hits). So P2-7 (boundary lockstep) does NOT apply, and the change is additive to the response schema anyway. Classified GENERIC per §5.1 (removing a trading-hardcoded literal) → act now. Completes P2-3 end-to-end (frontend already derives families from skills; backend was silently dropping non-trading families). `deriveReadiness` already handles connectionless/non-trading families generically.

## Open questions requiring operator / legal input

These are the batched items that cannot be decided within the framework. The
live list lives in `ESCALATIONS.md`; summarize resolved ones here once decided.

- *(empty until Step 8 surfaces legal/product-boundary questions.)*
