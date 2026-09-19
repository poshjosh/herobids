# Trading Extraction Execution Ledger

**Purpose:** the implementing agent updates this ledger after every bounded batch.
It is the operational record for Track C; the roadmap remains the authority for
scope and ordering.

## Rules

1. Work only on an item whose prerequisites are evidenced below and whose plan is
   authorized for implementation.
2. Keep one item `in progress` at a time. C3a and C4 may be independent only
   after their recorded prerequisites are met.
3. Before a cross-repository change, record both starting SHAs. After each batch,
   record the commit(s), focused tests, full-gate status, and unresolved defects.
4. Stop and record a blocker when a plan cannot be followed without a new product
   or architecture decision. Do not silently widen scope.
5. C5 starts only when every decided item is `verified`. Its report and final
   independent review close the ledger.

## Status Legend

- `planned` — reviewed plan, no implementation authorization
- `in progress` — active bounded batch
- `blocked` — record blocker and owning decision
- `implemented` — code committed; broader verification remains
- `verified` — all plan acceptance evidence recorded

## Work Items

| Item | Status | Prerequisites / required evidence | Implementation commits | Verification evidence | Blockers / notes |
|---|---|---|---|---|---|
| C1a | verified | ADR 013; plan-review corrections incorporated; authorization recorded 2026-09-19; starting SHAs `herobids=f3e9f672e9fb4b217c50f282935636d4cff5ae1d`, `traderton=2f2dda4f9999ba34a4f2b7e7c9464f77d093387e` | `491c6952` | 367 focused tests; API TypeScript check; final independent review accepted | Snapshot, selected-binding, and reconciliation planner only |
| C1 | planned | ADRs 010/013; C1a verified; both repo start SHAs | — | — | Full snapshot, selected-binding, signed-agent tools, durable saga, echo cut-over |
| C2.3 | planned | ADR 011; exact mirror manifest and mandatory dual-checkout CI design | — | — | Assertion-only; no runtime authority |
| C2.1/C2.2 | planned | C1 verified; C2.3 verified | — | — | Boundary defaults before local enforcement removal |
| C3a | planned | ADR 014; C3 UAT rows updated before run | — | — | Visual-only phase; run affected UAT rows desktop + mobile |
| C3b | planned | C1 verified; C3a verified; presentation API contract | — | — | Profile-backed response and updated UAT rows |
| C4 | planned | ADR 012; A3 read path | — | — | Remove tool advertising from base prompt and registry |
| C5 | planned | Every decided item verified | — | — | Five suites, two A8 runs, C3 UAT, final report |

## Per-Batch Record Template

```text
Date:
Item / batch:
Starting SHAs: herobids=<sha>, traderton=<sha>
Scope completed:
Commits:
Focused validation:
Broader validation:
UAT rows (when UI changes):
Residual risks / blockers:
Next allowed item:
```

## Batch Records

```text
Date: 2026-09-19
Item / batch: C1a — trading-profile write-path consolidation
Starting SHAs: herobids=f3e9f672e9fb4b217c50f282935636d4cff5ae1d, traderton=2f2dda4f9999ba34a4f2b7e7c9464f77d093387e
Scope completed: Shared pure snapshot, selected-binding, and reconciliation helpers; all C1a mutation paths delegate through the adapter. No boundary writer or profile store enabled.
Commits: herobids `491c6952` — Consolidate trading profile reconciliation paths
Focused validation: `env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm vitest run apps/api/src/agents/trading-profile-reconciliation.test.ts apps/api/src/agents/trading-profile-workflow-delegation.test.ts apps/api/src/routes/agents.test.ts apps/api/src/routes/agent-interactivity.test.ts apps/api/src/routes/chat.test.ts apps/api/src/routes/connections.test.ts apps/api/src/services/agent-instantiation-service.test.ts apps/api/src/services/agent-go-live-service.test.ts apps/api/src/services/agent-config-service.test.ts` — 9 files, 367 tests passed.
Broader validation: `pnpm exec tsc --noEmit -p apps/api/tsconfig.json` passed; `git diff --check` passed; final independent review accepted with no findings.
UAT rows (when UI changes): Not applicable.
Residual risks / blockers: None. C1a intentionally creates no Traderton boundary writer or durable profile store; C1 owns that cut-over.
Next allowed item: C1, after its prerequisites are re-evidenced.
```
