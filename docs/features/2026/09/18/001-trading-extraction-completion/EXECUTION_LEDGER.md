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
- `pending` — authorized and queued for implementation
- `in progress` — active bounded batch
- `blocked` — record blocker and owning decision
- `implemented` — code committed; broader verification remains
- `verified` — all plan acceptance evidence recorded

## Work Items

| Item | Status | Prerequisites / required evidence | Implementation commits | Verification evidence | Blockers / notes |
|---|---|---|---|---|---|
| C1a | verified | ADR 013; plan-review corrections incorporated; authorization recorded 2026-09-19; starting SHAs `herobids=f3e9f672e9fb4b217c50f282935636d4cff5ae1d`, `traderton=2f2dda4f9999ba34a4f2b7e7c9464f77d093387e` | `491c6952`, `c7fcdad8`, `5d4e5222` | 372 focused tests; API typecheck/build/lint; final independent reviews accepted | Snapshot, selected-binding, and reconciliation planner only |
| C1 | planned | ADRs 010/013; C1a verified; both repo start SHAs | — | — | Full snapshot, selected-binding, signed-agent tools, durable saga, echo cut-over |
| C2.3 | blocked | ADR 011; exact mirror manifest and mandatory dual-checkout CI design | herobids=`01bbb35046f6a391e7c59143ab42f9a0df450242`, `250dd60b37603105b2028b93972ec54fa5c06d33`; traderton=`485c31c16180d30cf77fe330bf84e4a1c26b06da` | 2026-09-19, Node 22 container: Herobids `01bbb35046f6a391e7c59143ab42f9a0df450242` with its final staged checker/test expansion versus clean Traderton `485c31c16180d30cf77fe330bf84e4a1c26b06da` passed 4/4 checker tests and the protected-mode manifest comparison. Traderton `485c31c16180d30cf77fe330bf84e4a1c26b06da` versus a temporary Herobids `01bbb35046f6a391e7c59143ab42f9a0df450242` worktree with only that expansion overlaid also passed 4/4 and the protected-mode comparison. | Blocked pending publication of both commits: GitHub Actions cannot fetch local-only SHAs. After publication, rerun both remote slow workflows and record the results. Intended protected pairs: Herobids source `${{ github.sha }}` with Traderton `485c31c16180d30cf77fe330bf84e4a1c26b06da`; Traderton source `${{ github.sha }}` at `485c31c16180d30cf77fe330bf84e4a1c26b06da` with Herobids `250dd60b37603105b2028b93972ec54fa5c06d33`. Assertion-only; no runtime authority. |
| C2.1/C2.2 | planned | C1 verified; C2.3 verified | — | — | Boundary defaults before local enforcement removal |
| C3a | implemented | ADR 014; C3 UAT rows updated before run | herobids=`a506d95ae428af902e9913bf0b9343ed0be53c0c` | 2026-09-19: focused generic capability tests passed (3/3); `pnpm --filter @herobids/web run typecheck`, `pnpm lint`, and `git diff --check` passed. AG-C05 passed. Dedicated visual-UAT attempt found no running web/API listener on ports 5173, 8080, or 3000. | Desktop/mobile AG-C01, AG-C03, and AG-C06 require a running stack and existing authenticated trading-capable/unavailable fixtures. Mark verified only after those UAT rows pass. |
| C3b | planned | C1 verified; C3a verified; presentation API contract | — | — | Profile-backed response and updated UAT rows |
| C4 | pending | ADR 012; A3 read path | — | — | Authorized 2026-09-19. Remove tool advertising from base prompt and registry. |
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
Commits: herobids `491c6952` — Consolidate trading profile reconciliation paths; `c7fcdad8` — Validate agent connections before profile reconciliation; `5d4e5222` — Align profile binding selection with runtime
Focused validation: `env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm vitest run apps/api/src/agents/trading-profile-reconciliation.test.ts apps/api/src/agents/trading-profile-workflow-delegation.test.ts apps/api/src/routes/agents.test.ts apps/api/src/routes/agent-interactivity.test.ts apps/api/src/routes/chat.test.ts apps/api/src/routes/connections.test.ts apps/api/src/services/agent-instantiation-service.test.ts apps/api/src/services/agent-go-live-service.test.ts apps/api/src/services/agent-config-service.test.ts` — 9 files, 372 tests passed.
Broader validation: `pnpm exec tsc --noEmit -p apps/api/tsconfig.json` passed; `pnpm --filter @herobids/api run build` passed; `pnpm lint` passed; `git diff --check` passed. Closure-audit findings for PATCH validation and runtime default-ready/first-ready binding selection were corrected and independently accepted.
UAT rows (when UI changes): Not applicable.
Residual risks / blockers: None. C1a intentionally creates no Traderton boundary writer or durable profile store; C1 owns that cut-over.
Next allowed item: C1, after its prerequisites are re-evidenced.

Date: 2026-09-19
Item / batch: C3a — visual de-specialization
Starting SHAs: herobids=01bbb350, traderton=485c31c
Scope completed: Added generic capability attribute/feed renderers; removed trading presentation from agent list, summary, and detail-header surfaces; moved existing trading data through a capability-scoped transitional adapter; kept approval actions platform-owned while rendering proposal details through the trading capability adapter.
Commits: None (intentionally uncommitted)
Focused validation: `pnpm exec vitest run apps/web/src/features/agents/CapabilityPresentation.test.tsx --config vitest.config.ts` passed (2/2).
Broader validation: `pnpm --filter @herobids/web run typecheck` passed; `pnpm lint` passed; static formatter sweep passed. Local Vite served `/` and `/agents` with HTTP 200, then was stopped.
UAT rows (when UI changes): AG-C01, AG-C03, and AG-C06 updated before run and recorded blocked because no authenticated fixture/browser automation was available; AG-C05 passed via the second-capability focused UI fixture. All entries use date 2026-09-19 and commit placeholder `uncommitted C3a`.
Residual risks / blockers: Visual desktop/mobile and unavailable-connection UAT need an authenticated trading-capable fixture plus browser automation. C3a continues to use existing transitional sources until C3b supplies the profile-backed presentation API.
Next allowed item: Commit and rerun the blocked visual UATs, then mark C3a implemented/verified as appropriate; C3b remains gated on C1.
```
