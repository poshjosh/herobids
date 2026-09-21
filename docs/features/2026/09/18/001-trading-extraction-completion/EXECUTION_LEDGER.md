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
| C1 | verified | ADRs 010/013; C1a verified; authorization recorded 2026-09-19; starting SHAs `herobids=81f5c0d9bde93bf613c2409eacfef55af3df2881`, `traderton=f4d8be1c0aaa5f476c9fae22dd79836755057384`; recovery contract authorized 2026-09-19 | herobids=`91fcd7a7`; traderton=`927e2b8`, `294cdb1` | Focused suites passed; typecheck/lint passed; final independent code review accepted. DB-backed outbox + profile-repository suites pass (herobids 3/3, traderton 3/3). Live cross-stack certification passed 2026-09-20 (see batch record). | C1 ships additive outbox migration `0071` only; retired `agents` columns stay physically inert and their destructive removal is a separately staged cleanup after old application instances are gone. 12 functional tests remain red and are deferred, not defects: 10 are the dropped-column read-path (`executionMode`/`capital`/`risk` null) owned by C3b; 2 are `/connect`/`/disconnect` in the telegram harness which builds its own app and will be re-wired by a later plan. |
| C2.3 | verified | ADR 011; exact mirror manifest and mandatory dual-checkout CI design | herobids=`416dd58add0b4b4841b27275da58d3200db7e81f`; traderton=`d60c56e56514b3ed0d262871d6febc75e18cc0b3` | Local checker + 4/4 checker tests pass; both protected remote slow workflows green on GitHub (2026-09-21) after publishing both SHAs. Protected pairs: Herobids source `${{ github.sha }}` with Traderton `d60c56e56514b3ed0d262871d6febc75e18cc0b3`; Traderton source `${{ github.sha }}` with Herobids `416dd58add0b4b4841b27275da58d3200db7e81f`. Assertion-only; no runtime authority. | — |
| C2.1/C2.2 | implemented | C1 verified; C2.3 verified | herobids=`973084c7`, `416dd58a`; traderton=`d60c56e` | traderton: `get_operator_defaults` read + `set_agent_trading_profile` ceiling enforcement (7 focused tests). herobids: `/agents/risk-defaults` re-pointed to cached boundary read; local `validateAgentRiskBounds` removed; `validation.risk_ceiling` → 400; `agent-risk-limits*.ts` + parity/unit tests deleted. Typechecks clean both repos; focused suites green (agents 139, go-live 30, saga 34, interactivity 43, operator-defaults 5). | Live cross-stack verification of the boundary-sourced auto-fill + out-of-ceiling create rejection still pending (see batch record). `blueprints.ts` local ceiling clamp+reject deferred to B4 (blueprint payload ownership). |
| C3a | implemented | ADR 014; C3 UAT rows updated before run | herobids=`a506d95ae428af902e9913bf0b9343ed0be53c0c` | 2026-09-19: focused generic capability tests passed (3/3); `pnpm --filter @herobids/web run typecheck`, `pnpm lint`, and `git diff --check` passed. AG-C05 passed. Dedicated visual-UAT attempt found no running web/API listener on ports 5173, 8080, or 3000. | Desktop/mobile AG-C01, AG-C03, and AG-C06 require a running stack and existing authenticated trading-capable/unavailable fixtures. Mark verified only after those UAT rows pass. |
| C3b | planned | C1 verified; C3a verified; presentation API contract | — | — | Profile-backed response and updated UAT rows |
| C4 | implemented / blocked | ADR 012; A3 read path | herobids=`59b9fc5a5f3ea718d34be3f7b4f3be61c87b6e0c` | 2026-09-19: focused domain/descriptor/prompt/boundary tests passed (230/230); creation/edit/assignment/fork tests passed (288/288); `pnpm lint` and `git diff --check` passed. The database-backed skill-reseed functional suite loaded but skipped all 6 tests because its database prerequisites are unavailable locally. | Blocked from verification until the database-backed skill-reseed functional suite runs. |
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

## Outstanding Issues

- **C1 functional suite (2026-09-20):** 12 functional tests remain red and are intentionally deferred. 10 (`go-live`, `agents.functional`, `/info`, `/mode`) assert `executionMode`/`capital`/`risk` derived from the dropped `agents` columns — these are C3b's profile-backed presentation switch, not C1 defects. 2 (`/connect`, `/disconnect`) run in the telegram harness which constructs its own app without a profile saga and will be re-wired by a later plan. None block C1's code correctness; they block only full-functional green.
- **C2.1/C2.2:** Live cross-stack verification of the boundary-sourced `/agents/risk-defaults` auto-fill and the out-of-ceiling create rejection (boundary typed error, not a local pre-check) remains unrun. Requires the running stack (`scripts/shell/run/reset-and-run-xstack.sh`).
- **C3a:** Run AG-C01, AG-C03, and AG-C06 against a running authenticated stack with existing trading-capable and unavailable capability fixtures at desktop and mobile viewports.
- **C4:** Provision `DATABASE_URL` and `REDIS_URL`, then run the six database-backed skill-reseed functional tests before marking the item verified.

## Batch Records

```text
Date: 2026-09-19
Item / batch: C1 — Traderton-owned trading profile slice
Starting SHAs: herobids=81f5c0d9bde93bf613c2409eacfef55af3df2881, traderton=f4d8be1c0aaa5f476c9fae22dd79836755057384
Scope completed: Traderton-owned revisioned profile store, signed profile tools, and durable multi-action operation manifests; profile-only actor/risk enforcement; Herobids metadata-only reconciliation outbox and saga wired to C1a mutation paths; agent-row enforcement source and decision/session payload echo retired.
Commits: traderton `927e2b8` — Add durable agent trading profiles; herobids `91fcd7a7` — Move agent trading state to Traderton profiles.
Focused validation: Herobids C1 suite: 431 passed, 91 DB-gated blueprint tests skipped. Traderton C1 suite: 71 passed. Final independent code review accepted with no high/critical findings.
Broader validation: Herobids API and worker TypeScript checks, Traderton DB/worker/boundary TypeScript checks, and `pnpm lint` passed in both repos; `git diff --check` passed in both repos.
UAT rows (when UI changes): Not applicable.
Residual risks / blockers: Database-backed Herobids outbox and Traderton profile repository suites could not run because `DATABASE_URL`, `REDIS_URL`, and `CREDENTIAL_ENCRYPTION_KEY` are unavailable. The required live cross-stack migration, binding-switch, profile-backed decision, and injected saga-recovery certification remains unrun. Profile migrations must be applied Traderton-first; Herobids `0071` is additive, while legacy physical agent columns are intentionally inert until a separately staged drop.
Next allowed item: Provision integration infrastructure and complete C1 verification; C2.1/C2.2 and C3b remain gated on C1 verification.

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
Commits: herobids `a506d95ae428af902e9913bf0b9343ed0be53c0c` — `feat(web): render agent capabilities generically`; `9a781ce9` — `docs: record C3a validation evidence`.
Focused validation: focused generic capability tests passed (3/3).
Broader validation: `pnpm --filter @herobids/web run typecheck` passed; `pnpm lint` passed; static formatter sweep passed. Local Vite served `/` and `/agents` with HTTP 200, then was stopped.
UAT rows (when UI changes): AG-C01, AG-C03, and AG-C06 updated before run and recorded blocked because no authenticated fixture/browser automation was available; AG-C05 passed via the second-capability focused UI fixture. Entries are dated 2026-09-19 and reference implementation commit `a506d95a`.
Residual risks / blockers: Visual desktop/mobile and unavailable-connection UAT need an authenticated trading-capable fixture plus browser automation. C3a continues to use existing transitional sources until C3b supplies the profile-backed presentation API.
Next allowed item: Rerun the blocked visual UATs, then mark C3a verified as appropriate; C3b remains gated on C1.

Date: 2026-09-20
Item / batch: C1 — functional harness saga wiring (test-infra repair)
Starting SHAs: herobids=cd76a992, traderton=(unchanged)
Scope completed: Wired `makeFunctionalProfileSaga` into `agentRoutes` (11th arg) and `connectionRoutes` (7th arg) so the functional suite exercises the real C1a/C1 reconciliation saga instead of the `transport_error` fallback; made the stub persist `proposed.profiles` and added `finalize`/`compensate` no-ops.
Commits: (uncommitted)
Focused validation: `pnpm exec tsc --noEmit -p apps/api/tsconfig.json` passed; `pnpm test:functional` reduced from 19 to 12 failures (all 500-class cleared).
Broader validation: N/A.
UAT rows (when UI changes): N/A.
Residual risks / blockers: 12 functional tests remain red and are deferred (see Outstanding Issues) — 10 are the dropped-column read-path owned by C3b; 2 are the telegram harness's separate app wiring, re-wired by a later plan.
Next allowed item: Any authorized item whose prerequisites are met (C2.1/C2.2 and C3b remain gated on C1 verification).

Date: 2026-09-20
Item / batch: C1 — DB-backed verification + sameManifest fix
Starting SHAs: herobids=d5de37f7, traderton=(parent of fix)
Scope completed: Provisioned traderton DB (role `traderton`/db `traderton` inside the local postgres), applied herobids `0071` + traderton migrations; ran the DB-backed C1 suites. Fixed `AgentTradingProfileRepository.sameManifest` jsonb key-order false conflict.
Commits: traderton `(uncommitted)` — `agent-trading-profile-repository.ts` `sameManifest`/`canonicalJson` fix.
Focused validation: herobids `trading-profile-reconciliation-outbox-repository.integration.test.ts` 3/3 passed; traderton `agent-trading-profile-repository.integration.test.ts` 3/3 passed; `pnpm exec tsc --noEmit -p packages/db/tsconfig.json` passed.
Broader validation: N/A.
UAT rows (when UI changes): N/A.
Residual risks / blockers: Live cross-stack certification still pending (only local DB-backed suites covered). The `sameManifest` fix is uncommitted.
Next allowed item: Commit the traderton fix; then live cross-stack certification to close C1 → verified.

Date: 2026-09-20
Item / batch: C1 — live cross-stack certification
Starting SHAs: herobids=c45a9dff, traderton=294cdb1
Scope completed: Brought up the full cross-stack via `scripts/shell/run/reset-and-run-xstack.sh` (traderton boundary :8080 + herobids api :3000/worker/web). Drove the real herobids→boundary→traderton path: provider-link provisioning, agent create, connection grant (profile saga), agent start (actor ensure), decision execution, mid-session profile edit, and binding switch.
Commits: none (certification only).
Focused validation: (1) Profile store — grant wrote `agent_trading_profiles` (capital 777, mode paper→shadow, revision 1); PATCH capital round-tripped (2500, revision 2); create-with-connection persisted capital 777. (2) Actor ensure — boundary logged `agent-direct actor constructed + started` with `capital:"777"` sourced from the profile (not a payload echo). (3) Profile-backed decision — `submit_decision` produced a `decisions` row (`go_long`, target 0.0024, actor_type agent) and the agent's own message sized the position as `~25% of $777 capital`. (4) Mid-session edit — signed `set_agent_trading_profile` (revision 3, capital 1234.00) then `get_account_summary` returned `capital: "1234.00"`; a subsequent `submit_decision` logged `needs reconstruction — rebuilding` then `constructed + started` with `capital:"1234.00"`, and the decision was accepted (plan `completed`, position BTC long 0.01). (5) Binding switch — added a second connection; the new venue account received a profile (capital copied from the selected template); after restart the actor bound to the NEW selected account (`d4419311…`), with 4 reconstruction events total.
Broader validation: `curl http://localhost:8080/health/ready` → `{"status":"ready"}`; `curl http://localhost:3000/health` → ok; HMAC creds verified identical across both `.env` files.
UAT rows (when UI changes): N/A.
Residual risks / blockers: `quick-setup.sh` fails at custom-skill provisioning (`skills.trading_account_tools_require_trading_capability` — the AI4Trade skill doc lacks `capabilityFamilies`; rule landed 2026-09-19 in `ad94c9d3`, doc last touched 2026-08-28). Pre-existing drift, NOT C1; certification bypassed it by driving the API directly. The 12 deferred functional tests remain (10 C3b read-path, 2 telegram harness).
Next allowed item: C2.1/C2.2 and C3b (both gated on C1 verified — now satisfied).
```
