# Eliminate the Parity-Drift Check — Execution Ledger

**Purpose:** the executing agent updates this ledger after every bounded batch. It is the
operational record; [000-roadmap.md](000-roadmap.md) remains the authority for scope and
ordering. Format follows the trading-extraction epic's ledger
(`docs/features/2026/09/18/001-trading-extraction-completion/EXECUTION_LEDGER.md`).

## Rules

1. Work only on a milestone whose prerequisites are evidenced here (status `verified` on
   every prerequisite) and whose **Authorization** column says `autonomous`.
   **Stop after every milestone** and wait for the human; never chain into the next one.
2. One milestone `in progress` per repo. Milestones that edit
   `scripts/parity-drift-manifest.json` or the `REQUIRED_*` lists must not overlap
   (invariant I15).
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
- `in progress`: active bounded batch
- `blocked`: record blocker, owning decision or gate
- `implemented`: code committed; broader verification remains
- `verified`: every gate in the row's profile passed, evidence recorded

## Work items

Initial state recorded 2026-10-10. Update the row (and add a batch record) as you work.

| ID | Repo | Status | Authorization | Prerequisites | Commits | Verification evidence | Blockers / notes |
|---|---|---|---|---|---|---|---|
| Z1 | herobids (docs) | ready | autonomous | none | | | |
| A1 | herobids | verified | autonomous | none | `7af3f0d7` | Manifest 35 -> 31; checker test 4/4; both herobids recipes PASSED; `pnpm lint` clean; `git diff --check` clean | Drops 4 entries (`tick-gates-session-hours`, `domain-cost-profile`, `domain-result`, `domain-values-money`; money wrapper kept, human decision 2026-10-10). The `strategy-preset-*` entries are NOT touched (retracted claim) |
| A2 | herobids | verified | autonomous | none (I15 applies) | see batch record | Manifest 31 -> 28; domain build, `pnpm build`, `pnpm lint`, tsc worker/api/domain, web typecheck all clean; full `pnpm vitest run` (clean env) 351 files / 6982 tests passed; checker test 4/4; both herobids recipes PASSED | |
| A3 | herobids | in progress | autonomous | none | start: herobids=`62b91df7`, traderton=`29a88725` | | |
| A4 | herobids | ready | autonomous | none | | | |
| A5 | herobids | ready | autonomous | A3 (the dead `ports/strategy.ts` is the only other `Decision` importer) | | | |
| A6 | herobids | ready | autonomous | none | | | |
| A7 | herobids | planned | autonomous | A2, A3, A5 | | | `ids` consumers: `ports/venue`, `values/instrument`, `models/decision` |
| A8 | - | withdrawn | - | merged into A1 | | | Human decision 2026-10-10: keep `values/money.ts` |
| G1 | herobids | verified | autonomous | A1, A2 `verified` and merged | `c48c2757` (Bump to v0.6.7), tag `v0.6.7` | `v0.6.7` manifest has 28 entries and none of the 7 dropped ids; traderton `main` tree vs `v0.6.7` recipe PASSED; tag on origin = `c48c2757`; `release.sh 0.6.7` core tests all PASS (run 3) | Pin target for A9/A10 = `v0.6.7` |
| A9 | traderton | verified | autonomous | G1 | `733b71fa` | Deleted `cost-profile.ts`, `values/instrument.ts`, `pagination.ts`; barrels pruned; `pnpm build` + `pnpm lint` clean; full `pnpm test` (clean env) 170 files / 2976 tests passed; pin bumped to `v0.6.7`; traderton recipe vs `v0.6.7` PASSED | `config/strategy-presets/*.yaml` NOT deleted (live) |
| A10 | traderton | verified | autonomous | A9 | `29a88725` | Deleted `tick-gates.ts`, `tick-gate-state.ts`, `tick-gate-state.test.ts`, `tick-message-types.test.ts`, `_deferred-config/tick-gates.test.ts`; `_deferred-config/README.md` bullet removed; `pnpm build` + `pnpm lint` clean; full `pnpm test` (clean env) 168 files / 2943 tests passed | I6 grep: no remaining non-test importers |
| B1.0 | herobids | ready | autonomous | none | | | Audit + short plan |
| B1.1 | herobids | planned | autonomous | B1.0 | | | |
| B1.2 | herobids (brief) | planned | human (ratify the brief) | B1.0 | | | Heavyweight brief: agent-path capability check |
| B1.3 | herobids | planned | autonomous | B1.2 ratified | | | |
| B2.0 | human | verified | human | none | | Human 2026-10-10: nothing outside herobids and traderton calls the health routes. Framework setup searched both repos: only the route's own test calls them | Satisfied. B2.1 repeats the search and the I6 trial deletion |
| B2.1 | herobids | planned | autonomous | B2.0 | | | |
| B2.2 | traderton | planned | autonomous | B2.1 + herobids tag (G) | | | |
| B3.1 | herobids | ready | autonomous | none | | | GP-X: tests first, record before-state |
| B3.2 | herobids | planned | autonomous | B3.1 | | | |
| B4.1 | herobids | ready | autonomous | none | | | Audit + plan; adds rows B4.x |
| C1.0 | traderton | ready | autonomous | none | | | Plan only |
| C1.1-C1.6 | traderton | planned | autonomous | C1.0 | | | Provisional split; C1.0 may revise |
| C2.0 | traderton | planned | autonomous | C1.0 | | | Plan only |
| C2.1 | traderton | planned | autonomous | C1.1, C2.0 | | | |
| G2 | traderton | planned | autonomous | C2.1 | | | First publish of `@traderton/contracts`; record version |
| C3.0 | herobids | planned | autonomous | C2.0 | | | Plan only; must settle install auth (open item O6) |
| C3.1-C3.6 | herobids | planned | autonomous | G2, C3.0, shapes in C1.x | | | |
| G3 | herobids | planned | autonomous | C3.x | | | Tag herobids with the C3 entry removals |
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

## Per-batch record template

```text
Date:
Milestone / batch:
Starting SHAs: herobids=<sha>, traderton=<sha>
Scope completed:
Commits:
Focused validation:
Broader validation (lint, per-package tsc, build/test):
Parity gates (both herobids recipes; traderton recipe if GP-T): manifest entry count before -> after
Decisions made (lightweight path, one line each):
Findings / new gaps (and where recorded in the roadmap):
Residual risks / blockers:
Next allowed milestone:
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
