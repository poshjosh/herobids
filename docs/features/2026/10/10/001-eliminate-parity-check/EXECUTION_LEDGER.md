# Eliminate the Parity-Drift Check — Execution Ledger

**Purpose:** the executing agent updates this ledger after every bounded batch. It is the
operational record; [000-roadmap.md](000-roadmap.md) remains the authority for scope and
ordering. Format follows the trading-extraction epic's ledger
(`docs/features/2026/09/18/001-trading-extraction-completion/EXECUTION_LEDGER.md`).

## Rules

1. Work only on a milestone (track) whose prerequisites are evidenced here (status
   `verified` on every prerequisite) and whose **Authorization** column says `autonomous`.
   **Stop after every track** and wait for the human; never chain into the next track.
   Inside a track, work through its sub-steps in order without stopping, except at the
   track's named human stop (B1.2, C3.0/O6 if it needs a secret, D0).
2. One manifest-touching change `in progress` per repo. Sub-steps that edit
   `scripts/parity-drift-manifest.json` or the `REQUIRED_*` lists run sequentially, never
   interleaved (invariant I15).
3. Before the first change in a batch, record the **starting SHAs of both repos**
   (`git rev-parse HEAD` in each) and the output of `git status --short` in each; run
   `git status` / `git log` before making any claim about repo state, because the human
   commits and pushes between sessions.
4. Stop and record a blocker when a milestone cannot be followed without a new product or
   architecture decision (decision framework, heavyweight path). Do not silently widen
   scope.
5. Release rows (`G*`) are done by the agent like any other row (invariant I12): it runs the
   documented release/tag/publish steps, records the exact commands and results here, and
   asks the human only if it cannot (missing credential or permission, a script failure it
   cannot diagnose).
6. Every parity-pin bump is recorded in **Pin pairs** below (AGENTS.md's parity-drift rule
   points here since 2026-10-10).

## Status legend

- `planned`: defined in the roadmap, prerequisites not yet met
- `ready`: prerequisites met; authorized (`autonomous` in the Authorization column)
- `needs human`: the human must act (a heavyweight decision, a failed credential or permission, a checkpoint answer) before it can proceed
- `in progress`: active track (or sub-step)
- `blocked`: record blocker, owning decision or gate
- `implemented`: code committed; broader verification remains
- `verified`: every gate in the row's profile passed, evidence recorded

## Work items

Initial state recorded 2026-10-10. Update the row (and add a batch record) as you work.
A milestone is a **track** (M-*); the A/B/C/D/C6 rows are its sub-steps.

| ID | Repo | Status | Authorization | Prerequisites | Commits | Verification evidence | Blockers / notes |
|---|---|---|---|---|---|---|---|
| M-A | both | verified | autonomous | none | `f07d87ce` | A5, A6, A7 done; manifest 20 -> 17 | Track A: dead copies + retired obligations |
| M-B | both | verified | autonomous | M-A | `666d4a17`, `c4e87221`, `53857b7e` (hb); `5726fb3`, `b419f79` (tt); tag `v0.6.9` | Track B complete: B1.x-B4.x all verified | Track B: stops at B1.2 (human brief) |
| M-C | both | ready | autonomous | M-B | | | Track C: may stop at C3.0/O6 (secret) |
| M-D | both | blocked | autonomous | M-A, M-B, M-C | | | Track D: D0 checkpoint (human) |
| M-C6 | both | blocked | autonomous | manifest has zero entries | | | Finish line |
| Z1 | herobids (docs) | ready | autonomous | none | | | |
| A1 | herobids | verified | autonomous | none | `7af3f0d7` | Manifest 35 -> 31; checker test 4/4; both herobids recipes PASSED; `pnpm lint` clean; `git diff --check` clean | Drops 4 entries (`tick-gates-session-hours`, `domain-cost-profile`, `domain-result`, `domain-values-money`; money wrapper kept, human decision 2026-10-10). The `strategy-preset-*` entries are NOT touched (retracted claim) |
| A2 | herobids | verified | autonomous | none (I15 applies) | see batch record | Manifest 31 -> 28; domain build, `pnpm build`, `pnpm lint`, tsc worker/api/domain, web typecheck all clean; full `pnpm vitest run` (clean env) 351 files / 6982 tests passed; checker test 4/4; both herobids recipes PASSED | |
| A3 | herobids | verified | autonomous | none | `7c1e0eff` | Deleted 7 dead ports; `ports/index.ts` pruned; `candle-fetcher.ts` narrowed to `PriceCandle`; manifest 28 -> 21; checker test 4/4; both herobids recipes PASSED; `pnpm build` + `pnpm lint` clean; full `pnpm vitest run` (clean env) 351 files / 6982 tests passed | `domain-ports-candle-fetcher` narrowed (asymmetric region: hb `PriceCandle`→EOF, tt `PriceCandle`→`CandleFetcher`) |
| A4 | herobids | verified | autonomous | none | `a77d80e5` | Deleted `trading/venue-capability.ts` + orphaned `tests/fixtures/venue-capabilities.ts`; export removed from `domain/index.ts`; manifest 21 -> 20; checker test 4/4; both herobids recipes PASSED; `pnpm build` + `pnpm lint` clean; full `pnpm vitest run` (clean env) 351 files / 6982 tests passed | I6 grep: zero non-test, non-dist references |
| A5 | herobids | verified | autonomous | A3 (the dead `ports/strategy.ts` is the only other `Decision` importer) | `f07d87ce` | Deleted `models/decision.ts`; `approval-service.ts` casts to `ExternalBackendActorType`; `models/index.ts` pruned; manifest 20 -> 19 | |
| A6 | herobids | verified | autonomous | none | `f07d87ce` | Deleted `ports/economic-calendar.ts`; local `EconomicEventView` next to renderer; `venue-intelligence.ts` + `macroEvents` use it; manifest 19 -> 18 | |
| A7 | herobids | verified | autonomous | A2, A3, A5 | `f07d87ce` | Deleted `values/ids.ts`; `values/index.ts` pruned; manifest 18 -> 17 | `ids` consumers (`ports/venue`, `values/instrument`, `models/decision`) all deleted first |
| A8 | - | withdrawn | - | merged into A1 | | | Human decision 2026-10-10: keep `values/money.ts` |
| G1 | herobids | verified | autonomous | A1, A2 `verified` and merged | `c48c2757` (Bump to v0.6.7), tag `v0.6.7` | `v0.6.7` manifest has 28 entries and none of the 7 dropped ids; traderton `main` tree vs `v0.6.7` recipe PASSED; tag on origin = `c48c2757`; `release.sh 0.6.7` core tests all PASS (run 3) | Pin target for A9/A10 = `v0.6.7` |
| A9 | traderton | verified | autonomous | G1 | `733b71fa` | Deleted `cost-profile.ts`, `values/instrument.ts`, `pagination.ts`; barrels pruned; `pnpm build` + `pnpm lint` clean; full `pnpm test` (clean env) 170 files / 2976 tests passed; pin bumped to `v0.6.7`; traderton recipe vs `v0.6.7` PASSED | `config/strategy-presets/*.yaml` NOT deleted (live) |
| A10 | traderton | verified | autonomous | A9 | `29a88725` | Deleted `tick-gates.ts`, `tick-gate-state.ts`, `tick-gate-state.test.ts`, `tick-message-types.test.ts`, `_deferred-config/tick-gates.test.ts`; `_deferred-config/README.md` bullet removed; `pnpm build` + `pnpm lint` clean; full `pnpm test` (clean env) 168 files / 2943 tests passed | I6 grep: no remaining non-test importers |
| B1.0 | herobids | verified | autonomous | none | `655c141a` | `plans/B1-herobids-drops-local-capability-prechecks.md` written: 4 call sites audited, traderton equivalents verified | |
| B1.1 | herobids | verified | autonomous | B1.0 | `655c141a` | Dropped local capability/mode-rank pre-checks; deleted `mode-rank.ts` + test; manifest 17 -> 16; checker test 4/4; both recipes PASSED; full suite 350 files / 6969 tests | |
| B1.2 | herobids (brief) | verified | human (ratify the brief) | B1.0 | traderton `425a838` | Option 2 ratified: traderton `set_agent_trading_profile` enforces paper+swap for the agent path | Heavyweight brief: agent-path capability check |
| B1.3 | herobids | verified | autonomous | B1.2 ratified | `5c6b744` | Dropped agent-path pre-check; deleted `execution-capability.ts` + test; `venueTypeFromProvider` relocated to `config/schema.ts`; manifest 16 -> 15; checker test 4/4; both recipes PASSED; full suite 349 files / 6953 tests | |
| B2.0 | human | verified | human | none | | Human 2026-10-10: nothing outside herobids and traderton calls the health routes. Framework setup searched both repos: only the route's own test calls them | Satisfied. B2.1 repeats the search and the I6 trial deletion |
| B2.1 | herobids | verified | autonomous | B2.0 | `c755e1d1` | Deleted actor-health routes + publisher + domain type; manifest 15 -> 14; checker test 4/4; both recipes PASSED; full suite 346 files / 6932 tests | |
| B2.2 | traderton | verified | autonomous | B2.1 + herobids tag (G) | `3b1e863` + `8df8657` | Deleted actor-health dead copy; released herobids `v0.6.8`; pin bumped to `v0.6.8`; traderton recipe PASSED | |
| B3.1 | herobids | verified | autonomous | none | `43ec0a9e` | Open items 1-3 checked; tests 1-4 written and run (before-state recorded): test 1 (characterization) PASS, test 4 (no-enforcement) PASS, tests 2-3 (gap-revealing) FAIL as expected via `it.fails` | Open item 1: no `apps/web` consumer of `riskContract`. Open item 2: no other producer wires real profile data. Open item 3: `ResolvedAgentRiskContract` shape confirmed |
| B3.2 | herobids | verified | autonomous | B3.1 | `4345c55c` | Retired `resolveAgentRiskContractForResponse`; dropped `riskContract` display field from 4 agent responses; helper + tests removed; full suite 346 files / 6932 tests | Human decision 2026-10-10: Option A (delete). No `apps/web` or external consumer |
| B4.1 | herobids | verified | autonomous | none | `plans/B4-agent-risk-defaults-boundary-cache.md` | 9 consumers audited: 2 boundary-read-able, 1 herobids-local (worker thresholds), 6 dead params | Appends B4.2-B4.4 |
| B4.2 | herobids | verified | autonomous | B4.1 | `666d4a17` (hb) + `5726fb3` (tt) | Moved 2 worker thresholds to `agentDecisionHandler`; removed from both `AgentRiskDefaultsSchema`; both recipes + full suites green | |
| B4.3 | herobids | verified | autonomous | B4.2 | `c4e87221` | API readers (`blueprints.ts`, `agents.ts`) source `loadOperatorRiskDefaults`; 6 dead params removed; worker `agent.ts` field removed; full suite 346 files / 6932 tests | |
| B4.4 | herobids | verified | autonomous | B4.3 | `c4e87221` | `agentRiskDefaults` YAML block + `AppConfigSchema` key + `agent-risk-defaults` entry removed (manifest 14 -> 13); checker test retargeted (I2); `v0.6.9` released; traderton pin bumped to `v0.6.9` | |
| C1.0 | traderton | verified | autonomous | none | `plans/C1-contracts-package-carveout.md` | Carve-out plan written: 6 shape groups with export lists + transitive deps, package layout (`packages/contracts`, `@poshjosh/contracts`), zod-only build graph, round-trip fixture test strategy, v0.1.0, narrowed wake envelope (scanner + base only), schemas-only (`parseWatch` stays out), `RegimeResult` dual-home traced, revised C1.1–C5/G2/G3 row list | GP-D: plan only |
| C1.1-C1.6 | traderton | verified | autonomous | C1.0 | `e1cc1c2` | `packages/contracts` built: 6 shape groups (watch, scan-state, wake, regime/volatility, risk-overrides) + `MarketAssessmentIdentity` dep + 8 round-trip fixtures; `pnpm --filter @poshjosh/contracts run build` + `test` green; full traderton build (11 pkgs) + suite 167 files / 2936 tests green | |
| C2.0 | traderton | verified | autonomous | C1.0 | `plans/C2-publish-contracts.md` | Publish plan: GitHub Packages `poshjosh` org, `@poshjosh/contracts@0.1.0`, path-triggered workflow, `pnpm pack`/`--dry-run` procedure, rollback policy | GP-D: plan only |
| C2.1 | traderton | verified | autonomous | C1.1, C2.0 | `bff260c` | `publish-package.yml` + `files: ["dist"]`; `pnpm pack` + `pnpm publish --dry-run` green (12 kB tarball, dist-only) | |
| G2 | traderton | verified | autonomous | C2.1 | `799b802` (rename) + CI run `38068175023` | **Published `@poshjosh/contracts@0.1.0`** to GitHub Packages (Option A rename; scope matches repo owner `poshjosh`). Publish workflow `completed success`; log shows `+ @poshjosh/contracts@0.1.0` | Heavyweight (H3/H6) resolved: package scope vs repo owner |
| C3.0 | herobids | verified | autonomous | C2.0 | `plans/C3-herobids-consumes-contracts.md` | Install-auth plan: CI `GITHUB_TOKEN` (same-owner, no new cred); local+Docker need a `read:packages` PAT (O6 fires — verified `npm view @poshjosh/contracts` → `403 permission_denied: token does not match expected scopes`); `.npmrc` with `${NPM_TOKEN}` placeholder + `.env.example` twin; dep lives in `@herobids/domain`; per-shape file map + entry-drop order | GP-D: plan only |
| C3.1 | herobids | verified | autonomous | G2, C3.0 | `e91e5efd` | `.npmrc` scope config + exact pin `@poshjosh/contracts@0.1.0` in `@herobids/domain`; Docker `RUN --mount=type=secret,id=NPM_TOKEN` + `build-push-agent.yml` `NPM_TOKEN=${{ secrets.GITHUB_TOKEN }}`; `.env.example` NPM_TOKEN twin; clean-env `pnpm install` + Docker build succeed | O6 resolved: human supplied `read:packages` PAT in `~/.npmrc` |
| C3.2 | herobids | verified | autonomous | C3.1 | `37e5e282` | `watch-types.ts` imports `WatchEntry`/`WatchEntrySchema`/`WatchPurposeEnum` from package; `parseWatch`/`toRuntimeActiveWatch` moved to `agent-watch-view.ts`; `watch-types.ts` deleted; `watch-types` entry dropped; worker build + 76 watch tests green | |
| C3.3 | herobids | verified | autonomous | C3.2 | `8d1c80e8` | `scan-types.ts` imports `CandleFetchStatus`/`SymbolFetchOutcome`/`PositionIndicatorUpdate` from package; `scan-types.ts` deleted; `scan-types` entry dropped; worker build + checker 4/4 + sibling-tree PASSED | |
| C3.4 | herobids | verified | autonomous | C3.3 | `e8e82da2` | `trading-protocol.ts` imports `ScannerWakeContextSchema`/`WakePrioritySchema`/`AgentWakePayloadBaseSchema` from package; keeps 4 herobids-owned wake contexts + `ContextSnapshotPayloadSchema`; re-composes `AgentWakePayloadSchema`; `domain-trading-trading-protocol` entry dropped; domain+worker build + 101 wake tests green | |
| C3.5 | herobids | verified | autonomous | C3.4 | `15d034ab` | `RegimeResult`/`VolatilityEvidence`/`EvidenceValue` re-pointed to package in `venue-intelligence`, `tick-gates`, `runtime-composition`, `platform-assessor`, `assessment-ports`, `evidence-adapters`; `market-assessment.ts` untouched (I5/I10); no entry drop (waits D2); `NPM_TOKEN` added to env-example drift guard ignored set; full worker suite 3094 tests green | |
| C3.6 | herobids | verified | autonomous | C3.5 | `2b136560` | Saga imports `AgentRiskOverridesSchema` from package (dep added to `apps/api`); `agent-risk-contract.ts` + test deleted (resolution math + dead `riskContractOps` field have no production consumers); barrel pruned; `domain-agent-risk-contract` entry dropped; checker test retargeted (I2); domain+worker+api build + 5895 tests green + `pnpm lint` clean | |
| G3 | herobids | in-progress | autonomous | C3.x | | Planned commands: `printf 'o\n' \| scripts/shell/ops/release.sh 0.6.10` (commit only package.json + CHANGELOG.md, not the human's uncommitted docs). Release script runs `run-all-tests.sh --e2e` (unit + integration + functional + E2E), then bumps package.json → 0.6.10, inserts `## v0.6.10` CHANGELOG header, commits, pushes origin/main, tags `v0.6.10`, pushes tags. | Tag herobids with the C3 entry removals |
| C4 | traderton | planned | autonomous | G3 | | | |
| C5 | herobids | planned | autonomous | G2 | | | |
| D0 | herobids (report) | planned | autonomous | Tracks A, B, C all `verified` | | | **Checkpoint:** stop, list the remaining manifest entries (expected: the 9 Track D entries) and ask the human whether to start the Wave E herobids halves and the preset-assessment chain |
| D1 | external | blocked | n/a | Preset-assessment plan pair H5 | | | Not owned by this epic |
| D2 | herobids | blocked | autonomous | D1 | | | |
| C6 | both | blocked | autonomous | manifest has zero entries | | | The epic's finish line |

## Pin pairs

Record every parity-pin change (and the state at the start of the epic).

| Date | Repo whose pin changed | Pin | Paired with (other repo's ref) | Milestone |
|---|---|---|---|---|
| 2026-10-10 (start) | herobids `slow-tests.yml` | traderton `v0.1.2` | herobids `${{ github.sha }}` | baseline |
| 2026-10-10 (start) | traderton `slow-tests.yml` | herobids `v0.6.5` | traderton `${{ github.sha }}` | baseline (already red against current traderton tree; `v0.6.6` passes) |
| 2026-10-10 | (none yet) herobids `v0.6.7` created | herobids tag `v0.6.7` (`c48c2757`) | traderton `main` (`54a26c49`) passes against it | G1: pin target for A9 (traderton bump not applied yet) |
| 2026-10-10 | traderton `slow-tests.yml` | herobids `v0.6.7` | traderton `main` (`733b71fa`) | A9: pin bumped via `release.sh --bump-parity-pin v0.6.7`; traderton recipe vs `v0.6.7` PASSED |
| 2026-10-10 | traderton `slow-tests.yml` | herobids `v0.6.8` | traderton `main` (`8df8657`) | B2.2: pin bumped via `release.sh --bump-parity-pin v0.6.8`; traderton recipe vs `v0.6.8` PASSED |
| 2026-10-10 | traderton `slow-tests.yml` | herobids `v0.6.9` | traderton `main` (`b419f79`) | B4: pin bumped via `release.sh --bump-parity-pin v0.6.9`; traderton recipe vs `v0.6.9` PASSED |

## Per-batch record template

A batch is a **track** (M-*). Record one batch per track; list the sub-steps completed
inside it. (Historical A1/A2/G1/A9/A10/A3/A4 batches predate the track grouping and are
kept as-is below.)

```text
Date:
Milestone / batch (track):
Starting SHAs: herobids=<sha>, traderton=<sha>
Sub-steps completed (in order):
Commits:
Focused validation:
Broader validation (lint, per-package tsc, build/test):
Parity gates (both herobids recipes; traderton recipe if GP-T): manifest entry count before -> after
Decisions made (lightweight path, one line each):
Findings / new gaps (and where recorded in the roadmap):
Residual risks / blockers:
Next allowed milestone (track):
```

## Outstanding issues

- **Earlier A1 (traderton preset-YAML deletion) was retracted, not postponed.** The traderton
  copies of `config/strategy-presets/*.yaml` are live: `presets-loader` is called from
  `packages/worker/src/tools/trading-profiles.ts`, and 14 traderton tests failed without
  them. The three `strategy-preset-*` entries stay `mirror-only` until H5 (roadmap D2).
  The one-line leftover edit in `scripts/check-parity-drift.test.mjs` was reverted
  (2026-10-10); the tree carries no residue of it.
- **Dead-copy claims were re-verified on 2026-10-10 by trial deletion** in scratch clones
  (roadmap, "Verification of the dead-copy claims"): all remaining claims held. The
  DB-backed test tiers were not run.
- **Traderton's parity pin is already stale** (herobids `v0.6.5`): the traderton-side
  recipe fails on `tick-gates-session-hours` and `domain-trading-trading-protocol`
  against the current traderton tree; `v0.6.6` passes. The first traderton-side
  milestone bumps the pin past this.

## Batch records

```text
Date: 2026-10-10
Milestone / batch: A1 (drop four manifest entries)
Starting SHAs: herobids=af80644290bfd52a4a99505999e2540ffc8b14dc, traderton=54a26c491beaf2595cd68eaaa17963cf3c74e1e6
Starting git status: both clean
Scope completed: removed tick-gates-session-hours, domain-cost-profile, domain-result, domain-values-money from scripts/parity-drift-manifest.json, REQUIRED_ENTRY_IDS and REQUIRED_ENTRY_AUTHORITIES. No source file touched; no test change needed (test names agent-risk-defaults, strategy-preset-economy, domain-agent-risk-contract).
Commits: see below (herobids only)
Focused validation: node --test scripts/check-parity-drift.test.mjs -> 4 pass, 0 fail
Broader validation: pnpm lint clean; git diff --check clean. No build/full-suite run: no code, barrel or file changed (nothing deleted, so the I6 trial deletion does not apply).
Parity gates: sibling-tree recipe PASSED; pin recipe (traderton v0.1.2) PASSED; manifest entry count 35 -> 31
Decisions made: none beyond the roadmap (money wrapper kept per human decision 2026-10-10).
Findings / new gaps: roadmap's status-at-a-glance says Track A takes the manifest to 17; unaffected. Stray-reference grep outside docs/ for the 4 ids: none.
Residual risks / blockers: none. Traderton CI uses herobids pin v0.6.5 (unchanged), so it is unaffected until G1.
Next allowed milestone: first ready row after A1 in roadmap order: A2 (delete values/instrument and pagination; drop 3 entries). G1 needs A1 and A2 verified and merged.
```

```text
Date: 2026-10-10
Milestone / batch: A2 (delete herobids values/instrument and pagination)
Starting SHAs: herobids=366cf3919fa3601e6baf866cab4b2c3d553f500b (366cf391 "Fix type in default config" is a config/default.yaml-only commit made after A1), traderton=54a26c491beaf2595cd68eaaa17963cf3c74e1e6
Starting git status: both clean
Scope completed: deleted packages/domain/src/values/instrument.ts and pagination.ts; pruned values/index.ts and domain index.ts; removed the PaginatedResponse describe block and import from packages/domain/src/__tests__/skill-catalog-types.test.ts (it only tested the deleted type); removed entries domain-pagination, domain-values-index, domain-values-instrument and their required ids.
Commits: caef43fe (herobids only)
Focused validation: node --test scripts/check-parity-drift.test.mjs -> 4 pass
Broader validation (I6 trial deletion): domain build, pnpm build, pnpm lint, tsc worker/api/domain, web typecheck clean; env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm vitest run -> 351 files passed (26 skipped), 6982 tests passed (332 skipped). DB-backed integration tier not run.
Parity gates: sibling-tree recipe PASSED; pin recipe (traderton v0.1.2) PASSED; manifest entries 31 -> 28
Decisions made: removed the PaginatedResponse type tests together with the type (done-state said "updated"; the tests asserted nothing else).
Findings / new gaps: none. Grep of apps/packages/scripts/tests/.github for the deleted names is clean (only gitignored tsbuildinfo caches match).
Residual risks / blockers: none. Traderton unaffected until A9 (its pin is still v0.6.5).
Next allowed milestone: G1 (tag herobids containing A1 and A2); A3, A4, A6 also remain ready. One manifest-touching milestone at a time (I15).
```

```text
Date: 2026-10-10
Milestone / batch: G1 (herobids tag containing A1 and A2)
Starting SHAs: herobids=e2160f1c (origin/main), traderton=54a26c49
Commands: printf 'o\n' | scripts/shell/ops/release.sh 0.6.7 (3rd attempt, with DATABASE_URL, REDIS_URL, CREDENTIAL_ENCRYPTION_KEY unset)
Result: commit c48c2757 "Bump to v0.6.7" pushed to origin/main; tag v0.6.7 pushed; core tests (unit, agent-bot LLM inheritance, integration, functional, transport parity, 4 API smokes, Playwright E2E) all PASS.
Attempts: (1) functional tier failed on a flake in telegram-slash-commands.functional.test.ts (stale async /restart output read by the next test, then TRUNCATE failures; file passes 31/31 in isolation; unrelated to A1/A2). (2) unit tier failed because the agent's own repro exported DATABASE_URL/REDIS_URL/CREDENTIAL_ENCRYPTION_KEY into the persistent shell (invariant I13); unset and rerun. No code changed between attempts.
Parity gates: v0.6.7 manifest = 28 entries; traderton main tree vs v0.6.7 recipe PASSED.
Findings / new gaps: (a) flaky Telegram functional test (stale /restart background work); candidate follow-up row, not blocking. (b) release.sh teardown stopped the previously running local herobids-web-1/herobids-worker-1 containers. (c) release.sh committed only package.json + CHANGELOG ("only" mode); an unrelated human edit to docs/features/pending/000-dynamic-connections/001-plan.md was left uncommitted.
Residual risks / blockers: none for the epic.
Next allowed milestone: A9 (traderton: delete cost-profile, instrument, pagination; bump pin to v0.6.7). Herobids-only rows A3, A4, A6 remain ready.
```

```text
Date: 2026-10-10
Milestone / batch: A9 (traderton: delete cost-profile, instrument, pagination; bump pin)
Starting SHAs: herobids=bcb759b2 (origin/main), traderton=54a26c49
Starting git status: both clean
Scope completed: deleted packages/domain/src/cost-profile.ts, values/instrument.ts, pagination.ts; pruned packages/domain/src/index.ts and values/index.ts; bumped .github/workflows/slow-tests.yml pin v0.6.5 -> v0.6.7 via release.sh --bump-parity-pin; CHANGELOG ### Removed. config/strategy-presets/*.yaml NOT touched (live).
Commits: 733b71fa (traderton only)
Focused validation: grep confirms no non-test importer of Instrument (domain type), PaginatedResponse, AgentCostProfile*/resolveAgentCostProfile/TickThinkingLevel/CostPreset in traderton.
Broader validation (I6 trial deletion): pnpm build clean; pnpm lint clean; env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm test -> 170 files passed (21 skipped), 2976 tests passed (102 skipped).
Parity gates: traderton recipe vs herobids v0.6.7 PASSED (parity-drift: PASSED).
Decisions made: none beyond the roadmap (R3 dead-copy deletes; pin bump to G1 tag).
Findings / new gaps: none.
Residual risks / blockers: none. Traderton CI now pins herobids v0.6.7 (past the stale v0.6.5).
Next allowed milestone: A10 (traderton: delete the tick-gates cluster). Herobids-only rows A3, A4, A6 remain ready.
```

```text
Date: 2026-10-10
Milestone / batch: A10 (traderton: delete the tick-gates cluster)
Starting SHAs: herobids=078039a9 (origin/main), traderton=733b71fa
Starting git status: both clean
Scope completed: deleted packages/worker/src/tick-gates.ts, tick-gate-state.ts, tick-gate-state.test.ts, tick-message-types.test.ts, _deferred-config/tick-gates.test.ts; removed the _deferred-config/README.md bullet naming tick-gates.test.ts (and adjusted the "two remaining files" -> "one remaining file" wording); CHANGELOG ### Removed.
Commits: 29a88725 (traderton only)
Focused validation: I6 grep — no non-test importer of any tick-gates/tick-gate-state symbol or module (calculateAtrPercent/computeDecisionContextHash matches are unrelated: market-data indicators and engine decision-context-hash). No worker barrel exports the deleted modules.
Broader validation (I6 trial deletion): pnpm build clean; pnpm lint clean; env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm test -> 168 files passed (21 skipped), 2943 tests passed (102 skipped). The 2-file / 33-test drop vs A9 is exactly the deleted test files.
Parity gates: none required (no manifest entry touched; traderton-only dead-copy delete, pin already past G1).
Decisions made: none beyond the roadmap (R3 dead-copy deletes).
Findings / new gaps: docs/features/initial/001-parity-ledger.md line 42 mentions "tick-gates" only as a historical Phase-8 extraction note (not an assertion of a live file); left as-is per done-state ("check ... for rows that assert these files" — none assert a live file).
Residual risks / blockers: none.
Next allowed milestone: A3 (herobids: delete 7 dead ports; trim and narrow candle-fetcher). A4, A6 also remain ready. One manifest-touching milestone at a time (I15).
```

```text
Date: 2026-10-10
Milestone / batch: A3 (herobids: delete 7 dead ports; trim and narrow candle-fetcher)
Starting SHAs: herobids=62b91df7 (origin/main), traderton=29a88725
Starting git status: both clean
Scope completed: deleted packages/domain/src/ports/{mark-source,sentiment,strategy,subscription,swap-venue,token-safety,venue}.ts; pruned ports/index.ts; narrowed ports/candle-fetcher.ts to PriceCandle only (removed CandleFetcher interface); removed 7 manifest entries + their required ids; narrowed domain-ports-candle-fetcher region on both sides; CHANGELOG ### Removed.
Commits: 7c1e0eff (herobids only)
Focused validation: I6 grep — zero non-test, non-dist references to any of the 7 ports' exported symbols (MarkSource/SentimentProvider/MarketSnapshot/Subscription*/SwapVenuePort/SwapTokenSafetyPort/OrderbookVenuePort/VenueError/VenueProfile/OrderCommand/BalanceSnapshot/VenueOrder/VenueFill/MarketMetadata) or CandleFetcher. The only matches were in packages/venues/dist/*.d.ts, which is entirely gitignored (packages/venues has no tracked files — the adapters moved to traderton). PriceCandle remains live (market-assessment.ts, platform-assessor.ts, preset-scorecard-runner.ts, tick-gates.ts).
Broader validation (I6 trial deletion): pnpm build clean; pnpm lint clean; env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm vitest run -> 351 files passed (26 skipped), 6982 tests passed (332 skipped).
Parity gates: checker test 4/4; sibling-tree recipe PASSED; herobids-side pin recipe (traderton v0.1.2) PASSED; manifest entries 28 -> 21.
Decisions made: the roadmap's suggested candle-fetcher region markers (start "export interface PriceCandle", end "export interface CandleFetcher") cannot be applied symmetrically because herobids's trimmed file no longer contains the end marker (the checker's extractRegion requires `end` to be present). Resolved with an asymmetric region: herobids extracts PriceCandle -> EOF (no end), traderton extracts PriceCandle -> "\nexport interface CandleFetcher". Both normalize to the identical PriceCandle block.
Findings / new gaps: none.
Residual risks / blockers: none.
Next allowed milestone: A4 (herobids: delete venue-capability and the orphaned fixture). A6 also remains ready. One manifest-touching milestone at a time (I15).
```

```text
Date: 2026-10-10
Milestone / batch: A4 (herobids: delete venue-capability and the orphaned fixture)
Starting SHAs: herobids=44e04ff9 (origin/main), traderton=29a88725
Starting git status: both clean
Scope completed: deleted packages/domain/src/trading/venue-capability.ts and tests/fixtures/venue-capabilities.ts; removed the export from packages/domain/src/index.ts; removed manifest entry domain-trading-venue-capability + its required id; CHANGELOG ### Removed.
Commits: a77d80e5 (herobids only)
Focused validation: I6 grep — zero non-test, non-dist references to VenueCapabilities/TimeInForce/validate*/OrderAttributeFlags/FULL_CAPABILITIES. The only matches were in gitignored dist/*.d.ts (packages/engine has 0 tracked files; packages/venues has 0 tracked files — both moved to traderton). The fixture has no importer.
Broader validation (I6 trial deletion): pnpm build clean; pnpm lint clean; env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm vitest run -> 351 files passed (26 skipped), 6982 tests passed (332 skipped).
Parity gates: checker test 4/4; sibling-tree recipe PASSED; herobids-side pin recipe (traderton v0.1.2) PASSED; manifest entries 21 -> 20.
Decisions made: none beyond the roadmap (R1/R2 dead-copy deletes).
Findings / new gaps: none.
Residual risks / blockers: none.
Next allowed milestone: A6 (herobids: delete the mirrored economic-calendar port; keep a local 7-field view type). One manifest-touching milestone at a time (I15).
```

```text
Date: 2026-10-10
Milestone / batch (track): M-A (Track A — dead copies and retired obligations)
Starting SHAs: herobids=2c9e6632 (origin/main), traderton=29a88725
Starting git status: both clean
Sub-steps completed (in order): A5 (delete models/decision; retarget ActorType), A6 (delete economic-calendar port; local EconomicEventView), A7 (delete values/ids). G1 (v0.6.7) and A1-A4/A9/A10 were already verified.
Commits: f07d87ce (herobids only)
Focused validation: I6 grep — A5: zero non-test references to Decision/ActorType (only importer was the already-deleted ports/strategy.ts); A6: zero non-test references to EconomicEvent/EconomicCalendarProvider; A7: zero references (source or test) to any branded id type (OrderId/BotId/VenueAccountId/InstrumentId/DecisionId/FillId/AgentId/SkillId).
Broader validation (I6 trial deletion): pnpm --filter @herobids/domain run build clean; pnpm build clean; pnpm lint clean; env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm vitest run -> 351 files passed (26 skipped), 6982 tests passed (332 skipped).
Parity gates: checker test 4/4; sibling-tree recipe PASSED; herobids-side pin recipe (traderton v0.1.2) PASSED; manifest entries 20 -> 17.
Decisions made (lightweight): A5 — retargeted ActorType to ExternalBackendActorType (the exact type of ExternalBackendSubject.actor.type, imported from @herobids/domain/external-backend) rather than ActorTypeSchema, since the value is cast into the boundary subject, not validated. A6 — named the local view type EconomicEventView and placed it next to the renderer in runtime-composition.ts (venue-intelligence.ts already imports from runtime-composition.ts, so no new import cycle).
Findings / new gaps: none.
Residual risks / blockers: none.
Next allowed milestone (track): M-B (Track B — decided engineering), which stops at B1.2 for the human brief.
```

```text
Date: 2026-10-10
Milestone / batch (track): M-B (Track B — decided engineering) — B4.2-B4.4 completion
Starting SHAs: herobids=d4e6ed16 (origin/main), traderton=8df8657 (origin/main)
Sub-steps completed (in order): B4.2 (move worker thresholds to agentDecisionHandler; symmetric 15-field agentRiskDefaults in both repos), B4.3 (re-point blueprint + risk-defaults readers to loadOperatorRiskDefaults; remove 6 dead params + worker agent.ts field), B4.4 (remove herobids agentRiskDefaults YAML block + AppConfigSchema key + agent-risk-defaults manifest entry; retarget checker test I2), release v0.6.9, traderton pin bump to v0.6.9. (B1.0-B3.2 were already verified earlier in the track.)
Commits: herobids 666d4a17 (B4.2), c4e87221 (B4.3-B4.4), 53857b7e (functional test positional fix), f839e355 (Bump to v0.6.9); traderton 5726fb3 (B4.2), b419f79 (pin bump)
Focused validation: checker test 4/4 (node --test scripts/check-parity-drift.test.mjs); focused api tests 463/463 (blueprints, chat, agent-interactivity, handle-go-live, execution-mode-immutability, agents*); traderton affected tests 86/86.
Broader validation: herobids pnpm lint clean; pnpm build + domain/worker/api builds clean; env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm vitest run -> 346 files passed (26 skipped), 6932 tests passed (332 skipped); release.sh core+extra+e2e all PASS. traderton pnpm lint clean; pnpm -r run build clean; env -u DATABASE_URL -u REDIS_URL -u CREDENTIAL_ENCRYPTION_KEY pnpm vitest run -> 166 files passed (21 skipped), 2928 tests passed (102 skipped).
Parity gates: checker test 4/4; sibling-tree recipe PASSED; herobids-side pin recipe (traderton v0.1.2) PASSED; traderton-side pin recipe (herobids v0.6.9) PASSED; manifest entry count 14 -> 13 (agent-risk-defaults removed).
Decisions made (lightweight path, one line each):
  - B4.2: moved the 2 thresholds to herobids-local `agentDecisionHandler` block (option 1 from the plan); removed them from BOTH repos' `AgentRiskDefaultsSchema` (symmetric change, authority traderton).
  - B4.3: boundary-read helper `readOperatorRiskDefaults` uses `AgentRiskDefaultsSchema.parse({})` as the fail-open fallback (blueprint instantiation is enforcement-adjacent; the boundary's own `set_agent_trading_profile` is the hard gate).
  - B4.4: retargeted checker test I2. The test flips three authority classifications: the removed `agent-risk-defaults` (traderton) was replaced by `domain-agent-risk-contract` (the surviving traderton id), kept `strategy-preset-economy` (mirror-only), and the now-free third slot uses `domain-config-presets` (mirror-only).
Findings / new gaps: the functional tier of release.sh 0.6.9 initially failed on 4 telegram-slash-commands functional tests because `telegramWebhookHandler`'s positional args shifted after the `agentRiskDefaults` param removal; fixed in `53857b7e` (no code-behaviour change, test wiring only), then release passed end-to-end.
Residual risks / blockers: none. Traderton keeps its `agentRiskDefaults` block (it is the sole authority; exposed over `get_operator_defaults`).
Next allowed milestone (track): M-C (Track C — @poshjosh/contracts package), starting at C1.0 (plan).
```
