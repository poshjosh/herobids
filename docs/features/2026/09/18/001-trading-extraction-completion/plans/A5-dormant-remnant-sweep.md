# Plan A5: Dormant / remnant deletion sweep

- **Task:** A5 — delete the engine-era dormant modules and dead surface identified by the audit §6
- **Repo:** herobids
- **Status:** PLAN — **implementer-ready (2026-09-18).** Decision-gated: **No** (pure deletion of unimported code; every item re-verified import-free before each deletion).
- **Defect class:** Unnecessary duplication by forgetting (audit tier 3).

## For the implementer (no prior context needed)

- **Repo:** herobids only.
- Focused commits are allowed. Update the changelog when warranted; do not merge herobids into `main` yet.
- This is a **deletion sweep**: for every item, first `grep` for production importers (exclude tests). If a live importer exists that the row did not anticipate, STOP and flag — do not delete blind.
- The four **CHECK-FIRST** items (7, 8, 13, 14) have a stated default decision below; follow the default unless your grep contradicts it, and record the outcome in the PR.
- Verify per-package `tsc --noEmit` after each cluster (worker → domain/config → API), plus full lint + test suite. `grep` must prove zero repo-wide references to each deleted symbol.
- Do NOT touch the items in "Explicitly NOT deleted here."

## Context

The audit (§6) registered dormant remnants whose live counterparts exist in traderton and which have **no production importer** in herobids. They inflate the "trading residue" the ownership decision must reason about and mislead readers (e.g. `agent-risk-limits-contracts.ts` header cites a traderton path as if local). Deletion is safe under either Track-B outcome: if B ever wants any of this back, it comes back from traderton where it is live.

## Deletion list (re-verify each import-free at execution time; audit §6 is the evidence index)

| # | Item | Notes |
|---|---|---|
| 1 | `apps/worker/src/validate-trade-instrument.ts` (+ its test) | live counterpart in traderton actor; also drop the test's `SubmitDecisionParamsSchema` import use |
| 2 | `apps/worker/src/swap-instrument-id.ts` (+ test) | live in traderton |
| 3 | `apps/worker/src/resolve-swap-assets.ts` (+ test) | live in traderton |
| 4 | `apps/worker/src/swap-startup-validation.ts` (+ test) | live in traderton |
| 5 | `apps/worker/src/candle-fetch-breaker.ts` (+ test) | live in traderton actor scan loop |
| 6 | `apps/worker/src/candle-fetch-retry.ts` (+ test) | live in traderton |
| 7 | `venue-instrument-cache.ts` | **CHECK-FIRST — DEFAULT: attempt consumer switch, else KEEP.** One live consumer (market-intelligence/assessment-identity-resolver, fail-closed). Attempt to switch it to boundary-backed validation (small change); if that is not a small change, KEEP the whole file, drop only provably-dead exports, and strike the file from this sweep. Record which path you took in the PR |
| 8 | `buildAgentRiskLimits`/`buildRiskLimitsFromContract` + `RiskLimits` type seam (`agent-risk-limits-contracts.ts`) | **DECIDED (A3 = Option X):** A3/A6 keep the in-process risk math alive as the payload-bound `RiskSource` implementation until B1/Track C. So **do NOT delete the builders in this sweep** — delete only exports proven dead by grep, and keep every type/builder the A3 seam or the remaining parity tests still import. Re-confirm with grep; if genuinely unimported, delete. Err toward KEEP here |
| 9 | `riskContractOps.adjustOverrides` in `agent.ts` `buildRiskContractOps()` | **DECIDED:** adjust is boundary fail-closed (A3), so the in-process **write** path is dead at the tool layer — remove `adjustOverrides`'s in-process write. **KEEP the read path** (`getContract`/`getProfile`) — A3/A6 still use it as the payload-bound read fallback until B1 |
| 10 | `ctx.executionConfig` assembly in `agent.ts` + broker | constructed, never read — verify again, then remove from `toolContext` and the type if nothing consumes |
| 11 | Worker venue-URL env overrides (`HYPERLIQUID_*`, `BYBIT_*`, `ONEINCH_*`, `JUPITER_API_URL`, `SOLANA_RPC_URL`, `BASE_RPC_URL`) in `apps/worker/src/config.ts` + `.env.example` | no live consumer; **coordinate with `env-example-drift.test.ts`** (it enforces no-stale-entries — the deletion makes the guard happy, but update `IGNORED_ENV_VARS` lists if the vars remain for scripts) |
| 12 | `execution:` config block in `config/default.yaml` minus `defaultSlippageBps` | only live consumer is the venue-defaults route's `defaultSlippageBps`; delete the rest + their schema fields if the domain schema allows (else leave schema, delete yaml keys) |
| 13 | `GET /agents/:id/trades` route (agent-interactivity.ts) | **CHECK-FIRST — DEFAULT: DELETE.** No web consumer (AgentTradesTable uses capabilities/trading positions). Grep herobids' own web + docs for callers; if none (expected), delete the route. If a caller exists, strike from sweep and flag |
| 14 | Exports endpoints, `GET /trading/fills` (billing), bot-health routes | **CHECK-FIRST — DEFAULT: KEEP exports, DELETE `/trading/fills` + bot-health static fallback.** Exports may have plausible external consumers → keep. `/trading/fills` (billing) and the bot-health static fallback have no web consumer → delete. Record each keep/delete explicitly in the PR |
| 15 | `BotRepository.isConnectionOwnedBy` vestige | rename the check into connections-related helper or inline it; delete the "Bot"Repository file |
| 16 | `scout-gating.hasUncoveredTrackedPosition` deprecated export + its `venue-intelligence` import | superseded by position-coverage |
| 17 | Stale doc refs: `complete-technical-scan.ts` mention in `docs/tech/agents/wake-signal-and-technical-scan.md`; preset-scorecard TODO | doc fixes |

**Explicitly NOT deleted here** (deferred): `routes/exports-traderton.ts` row mirrors (serving exports until a traderton-native export exists), `blueprints.integration.test.ts` orphan (repo memory: deliberately untouched per Plan 005 §9), `resolve_watch`/`resolve_task` (A6 decides), `list_watches` fallback (A6 decides).

## Steps

1. Execute in table order; per item: grep importers (excluding tests) → delete file/exports → fix tests that referenced them (most tests delete with the module; parity tests may need import updates) → run per-package tsc.
2. Items 7/8/13/14 are the "check-first" items: resolve their micro-question at execution start, record the outcome in the PR, strike or proceed.
3. `env-example-drift` + full lint + test suite after each cluster (worker first, then domain/config, then API).
4. Update the audit doc §6 with `deleted` markers per row (the audit stays the evidence index; annotate, don't rewrite).

## Verification

- Both repos' per-package tsc + full suites green (herobids suite primarily).
- `grep` proves zero references to each deleted symbol repo-wide.
- Live cross-stack smoke (A8 gate) unaffected — deletions are import-free by construction.

## Risks

- Hidden dynamic imports or reflection — none known; the repo has no plugin machinery in worker.
- The "check-first" items are where a surprise consumer could exist; that's why they're gated on a re-verification grep, not deleted blind.
- Public-API removals (13/14) could break undocumented external consumers — default to keep unless we find none in our own docs.

## References

- Audit §6 (evidence index), §5.3 counts
- `docs/tech/trading/audits/2026/09/001-…-ownership-audit.md`
