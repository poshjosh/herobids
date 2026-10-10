# Epic: Eliminate the Parity-Drift Check

> **Objective.** Delete `scripts/parity-drift-manifest.json`,
> `scripts/check-parity-drift.mjs` (and its test) and the `parity-drift` CI job from
> **both** herobids and traderton, by resolving the duplication behind every manifest
> entry (delete dead copies, replace logic mirrors with boundary calls, move wire shapes
> into a traderton-published `@traderton/contracts` package, or retire the obligation),
> **not** by weakening, narrowing-to-nothing, or hiding the check.
>
> **The epic is done when** the manifest has **zero entries because nothing is mirrored
> anymore**, and then the checker, manifest, test and CI job are removed (milestone **C6**).

- **Date:** 2026-10-10
- **Status:** ACTIVE. Decision Brief B is ratified for everything except the items
  marked blocked below. Execution framework set up 2026-10-10: this file is the
  **entrypoint**; milestones, gates, invariants and the decision process are defined
  here and in the documents linked under "If you are an executing agent".
- **Scope:** both repositories. Herobids is where the manifest and checker live;
  traderton-side work is tracked here and authored in traderton.
- **Precedent for this structure:**
  [the trading-extraction epic's roadmap](../../../09/18/001-trading-extraction-completion/000-roadmap.md)
  (extended, not replaced: tracks, tasks, plans, decision briefs, an execution ledger).

## If you are an executing agent: start here

1. **Read, in this order** (about 15 minutes): this file;
   [invariants-and-quality-gates.md](invariants-and-quality-gates.md);
   [decision-framework.md](decision-framework.md);
   [decisions/B-parity-ownership.md](decisions/B-parity-ownership.md), sections "Mechanical
   rules for executing agents" and "Clarifications and open items";
   [EXECUTION_LEDGER.md](EXECUTION_LEDGER.md).
2. **Run `git status` and `git log` in both repos** (`herobids` and its sibling
   `traderton`). The human commits and pushes between sessions; the ledger may be behind.
3. **Pick your milestone:** the one you were assigned; otherwise the first row of
   "Ready now" whose prerequisites are `verified` in the ledger. Mark it `in progress` in
   the ledger with both starting SHAs before touching code. **If no row is ready, do not
   idle or guess:** report which rows are blocked and exactly what each is waiting for,
   and ask the human (Track D's checkpoint row D0 is the planned instance of this).
4. **Read the milestone block** (done-state, prerequisites, plan, governing decisions,
   gates) and **only** the decision rows it cites. You do not need the whole decision
   history.
5. **Implement.** Make lightweight decisions yourself; stop and write a brief only if the
   [heavyweight checklist](decision-framework.md#2-the-exception-the-heavyweight-path)
   fires.
6. **Verify against the gates** named in the block (floor plus profile). If you find a gap
   the roadmap did not account for, you may **not** mark the milestone done: record it,
   resolve it if small, otherwise split it into a new row
   ([section 3.3](invariants-and-quality-gates.md#33-when-a-milestone-is-not-done)).
7. **Leave the trail:** CHANGELOG, ledger batch record, any findings added to this file.
   Then state the next allowed milestone.
8. **STOP.** Report what you did and what is next, and wait. **Do not start the next
   milestone** until the human says to. You work autonomously *inside* a milestone;
   the human is the gate *between* milestones.

## Status at a glance (2026-10-10)

- Manifest today: **28 entries** (35 at epic start; A1, A2 done). Track A takes it to **17** (the 14 below plus the three
  `strategy-preset-*` entries, which stay `mirror-only` until H5); Tracks B, C, D take the
  rest to 0; C6 deletes the checker.
- **Ready now (autonomous):** Z1, A1, A3, A4, A6, B1.0, B3.1, B4.1, C1.0. A2 and A5-A7
  follow in order, because only one manifest-touching milestone runs at a time (I15).
- **Needs a human:** only what the agent cannot do itself: the B1.2 brief (a decision),
  and, when Tracks A-C are done, your answer at checkpoint D0 about the Wave E herobids
  halves. Tagging, releasing and publishing are done by the agent (invariant I12); it
  asks you only if a credential or permission fails. After **every** milestone the agent
  stops and waits for you (step 8).
- **Blocked:** Track D (waits on Wave E's herobids halves and the preset-assessment plan pair).
- **Recommended first milestone: A1.** It is self-contained and unblocks G1.

### Summary

| ID | Repo | Milestone | State |
|---|---|---|---|
| Z1 | herobids docs | Mirror the ratified decisions as ADR 018 | ready |
| A1 | herobids | Drop 4 manifest entries (`tick-gates-session-hours`, `domain-cost-profile`, `domain-result`, `domain-values-money`) | verified 2026-10-10 |
| A2 | herobids | Delete `values/instrument` and `pagination`; drop 3 entries | verified 2026-10-10 |
| A3 | herobids | Delete 7 dead ports; trim and narrow `candle-fetcher` | ready |
| A4 | herobids | Delete `venue-capability` and its orphaned fixture | ready |
| A5 | herobids | Delete `models/decision`; retarget `ActorType` | ready (after A3) |
| A6 | herobids | Delete mirrored `economic-calendar` port; local view type | ready |
| A7 | herobids | Delete `values/ids` | planned (after A2, A3, A5) |
| A8 | - | (withdrawn, merged into A1) | - |
| **G1** | herobids | Tag herobids containing A1 and A2 | planned |
| A9 | traderton | Delete `cost-profile`, `instrument`, `pagination`; bump pin | planned (after G1) |
| A10 | traderton | Delete the `tick-gates` cluster | planned (after A9) |
| B1.0 | herobids | Audit and plan: local capability and mode-rank pre-checks | ready |
| B1.1 | herobids | Drop verified-safe pre-checks; delete `mode-rank` | planned |
| B1.2 | herobids | **Brief:** agent-path capability check | planned, needs human |
| B1.3 | herobids | Implement B1.2's outcome; delete `execution-capability` | planned |
| B2.0 | - | Confirm no consumer of the health routes | **answered** (see block) |
| B2.1 | herobids | Remove actor-health | planned |
| B2.2 | traderton | Remove actor-health's dead copy | planned |
| B3.1 | herobids | Risk-contract retirement: tests first, record before-state | ready |
| B3.2 | herobids | Risk-contract retirement: implement | planned |
| B4.1 | herobids | Audit and plan `agent-risk-defaults` YAML removal | ready |
| B4.x | herobids | Rows defined by B4.1's plan | planned |
| C1.0 | traderton | Plan the `@traderton/contracts` carve-out | ready |
| C1.1-C1.6 | traderton | Build the package: skeleton + 5 shape groups (additive) | planned |
| C2.0-C2.1, **G2** | traderton | Publish workflow; first publish | planned |
| C3.0-C3.6, **G3** | herobids | Plan; wire dependency; migrate 5 shape groups; tag | planned |
| C4 | traderton | Traderton consumes the package; delete originals | planned |
| C5 | herobids | Automate the package version-pin bump | planned |
| D0 | herobids (report) | Checkpoint: report the remaining entries and ask the human about Track D | planned (after A, B, C) |
| D1, D2 | external, herobids | Preset-assessment H5; then drop the blocked entries | blocked |
| C6.1, C6.2 | herobids, traderton | **Delete the checker, manifest, tests and CI job** | blocked on all |

## What a "milestone" is in this epic

**Tracks are not milestones; each block below is.** A milestone is the unit of work one
agent finishes in one autonomous pass. A row qualifies only if all of these hold:

1. **One repo.** Cross-repo work is split into a herobids milestone and a traderton
   milestone with an explicit order, because the CI makes the order mandatory
   (invariant I3).
2. **One reviewable change set**, a few focused commits, with a done-state verifiable by
   commands (a count, a grep, a test, a CI recipe), not by judgment.
3. **One coherent reason for change** and, if it touches the manifest, at most 7 entries
   removed for the same reason.
4. **Sized to one session.** Rule of thumb: no more than about 15 files of real logic and
   no new design. Anything larger is split, or **preceded by a plan milestone** whose
   output is the written plan and revised rows.
5. **Stops only where it must.** Release, tag and publish steps are their own rows (`G*`)
   that the agent executes itself; a milestone never waits on a human unless the agent
   cannot proceed (invariant I12).
6. **Plan status stated:** either a written plan exists, the block says "none needed"
   (follow the block), or writing the plan is itself the milestone.

Track C was previously a handful of undefined multi-day rows; it is split here into plan
milestones and per-shape implementation milestones. Rows marked **provisional** may be
revised by their plan milestone; revise the row in this file when you do.

**ID scheme:** `Z` docs, `A` no-dependency deletes (herobids first), `B` decided
engineering, `C` contracts package, `D` blocked on other epics, `G` release row (tag or publish).
Mapping from the earlier numbering: old A1 (preset YAML deletion) was **retracted** and
no longer exists (see Brief B's correction); old A2 is A1 + A10, old A3 is A3, old A4 is
A2 + A9, old A5 is A4, old A6 is A5, old A7 is A1 + A9, old A8 is A7, old A9 is A1,
old A10 is A6, old B1-B4 are B1.x-B4.x, old C1-C3 are C1.x-C3.x, old C4 is C5, old C5 is
C6. New: Z1, the G rows, C4 (traderton dedupe), D2.

**Conventions introduced by this framework (for human review):** the milestone sizing
rule and ID scheme above; the herobids-first split with release rows (from invariant
I3); one manifest-touching milestone at a time (I15); this epic's own ledger; the
decision framework; the "Mechanical rules" and "Clarifications" sections in Brief B.

## Governing documents

| Document | Governs |
|---|---|
| [decisions/B-parity-ownership.md](decisions/B-parity-ownership.md) | Every per-entry disposition (R1-R11 are its mechanical form); clarifications O1-O8 |
| [decisions/agent-risk-contract-retirement.md](decisions/agent-risk-contract-retirement.md) | B3.1 and B3.2 test-first gate |
| [decisions/wire-dto-package-mechanics.md](decisions/wire-dto-package-mechanics.md) | Track C registry, version pin, CI dual-checkout |
| [investigation-findings.md](investigation-findings.md) | Evidence (call sites) behind each entry; re-verify at execution time (I6) |
| [ADR 011](../../../../../tech/architecture/adrs/2026/09/011-split-trading-authority-by-responsibility.md) | Original split-authority decision; Decisions 2-3 superseded in part by Brief B (Z1 records it) |
| [AGENTS.md](../../../../../../AGENTS.md) | Standing repo rules; this epic only adds checks |

---

## Track Z — Decision records

### Z1. Mirror Brief B and the mechanics doc as ADR 018
- **Repo:** herobids (docs only).
- **Done-state:** `docs/tech/architecture/adrs/2026/10/018-<slug>.md` exists in the ADR
  format used by ADR 011 (Date, Status `Accepted`, Context, Decision, Consequences,
  References). It states: the per-entry dispositions (summary plus link to Brief B), the
  sixth disposition, the wire-DTO package decision with its mechanics, and the end state
  (no mirrored files, no parity check). ADR 011 gets a single added status line
  "Decisions 2 and 3 superseded in part by ADR 018" and no other edit. This roadmap links
  ADR 018.
- **Prerequisites:** none. **Plan:** none needed.
- **Governing:** the extraction roadmap's convention ("Decisions reached in chat land as
  ADRs"); Brief B; mechanics doc. **Gates:** floor + GP-D (CHANGELOG not required for
  docs-only).

---

## Track A — Dead copies and retired obligations

Goal: shrink the manifest wherever a side is simply dead, or the obligation is retired.
**Herobids first.** The parts herobids can do alone come first; the traderton deletions
follow behind one herobids tag (G1), per
[invariant I3](invariants-and-quality-gates.md#2-the-two-ci-directions-and-the-cross-repo-ordering-protocol).
Common to every A block: re-run the I6 grep at execution time; remove the entry and its
`REQUIRED_*` ids (I1); retarget the checker test if it names the entry (I2); prune
barrels (I7); GP-H; CHANGELOG `### Removed`.

### A1. Drop four manifest entries (herobids, manifest only)
- **Done-state:** entries `tick-gates-session-hours`, `domain-cost-profile`,
  `domain-result`, `domain-values-money` are removed from the manifest, from
  `REQUIRED_ENTRY_IDS` and from `REQUIRED_ENTRY_AUTHORITIES`;
  `check-parity-drift.test.mjs` still passes (it names `agent-risk-defaults`,
  `strategy-preset-economy` and `domain-agent-risk-contract`, none of which A1 removes, so
  no test change is needed). Entry count decreases by 4. **No file is deleted or changed:** herobids
  keeps `tick-gates.ts`, `cost-profile.ts`, `result.ts`, `values/money.ts`.
- **Human decision (2026-10-10):** herobids keeps its `values/money.ts` wrapper (Brief B
  O2). It is generic code with no wire exposure, so keeping it creates no drift problem.
- **Do NOT touch** the three `strategy-preset-*` entries or the preset YAML files: they
  are live `mirror-only` contracts until H5 (Brief B correction; R5).
- **Prerequisites:** none. **Plan:** none needed.
- **Governing:** Brief B R3, R4, R5; resolved entries for tick-gates (traderton copy) and
  cost-profile (traderton copy); ratified decision 1. Dead-copy claims were re-verified by
  trial deletion on 2026-10-10 (see "Verification of the dead-copy claims").
- **Gates:** floor, GP-H.
- **Why first:** it is a precondition for G1, which unblocks every traderton-side deletion.

### A2. Delete herobids `values/instrument` and `pagination`; drop three entries
- **Done-state:** herobids `packages/domain/src/values/instrument.ts` and `pagination.ts`
  deleted; `values/index.ts` and `packages/domain/src/index.ts` pruned; entries
  `domain-values-instrument`, `domain-pagination`, `domain-values-index` removed (the
  barrel changes here, so its entry cannot survive); the one test referencing
  `PaginatedResponse` (`packages/domain/src/__tests__/skill-catalog-types.test.ts`)
  updated. Entry count decreases by 3. Traderton's copies stay until A9.
- **Prerequisites:** none (I15: do not overlap with another manifest-touching
  milestone). **Plan:** none needed.
- **Governing:** Brief B R1, R2, R4; resolved entries for instrument, pagination and
  values-index. **Gates:** floor, GP-H.

### A3. Delete 7 dead herobids ports; trim and narrow `candle-fetcher`
- **Done-state:** herobids `ports/{mark-source,sentiment,strategy,subscription,
  swap-venue,token-safety,venue}.ts` deleted; `ports/index.ts` pruned;
  `ports/candle-fetcher.ts` keeps only `PriceCandle` (the `CandleFetcher` interface
  removed); the `domain-ports-candle-fetcher` entry is **kept** and narrowed on both sides
  to a region (`start: "export interface PriceCandle"`, `end: "export interface
  CandleFetcher"`) so traderton's full file still matches the shared part; I6 grep shows
  zero herobids references to the removed names. Seven entries removed.
- **Prerequisites:** none. **Plan:** none needed.
- **Governing:** Brief B R1, R2, R10 (the `PriceCandle` residue waits for H5); findings
  Group 2. **Gates:** floor, GP-H (both recipes; the narrowed region must pass against
  traderton's pin).

### A4. Delete herobids `venue-capability` and the orphaned fixture
- **Done-state:** `packages/domain/src/trading/venue-capability.ts` and
  `tests/fixtures/venue-capabilities.ts` deleted; the export removed from
  `packages/domain/src/index.ts`; entry `domain-trading-venue-capability` removed (-1).
- **Prerequisites:** none. **Plan:** none needed. **Governing:** Brief B R1, R2; resolved
  entries (venue-capability). **Gates:** floor, GP-H.

### A5. Delete herobids `models/decision`; retarget `ActorType`
- **Done-state:** `packages/domain/src/models/decision.ts` deleted and unexported;
  `apps/worker/src/services/approval-service.ts` uses an existing equivalent union
  (`ActorTypeSchema` in `agent-protocol.ts`, or `ExternalBackendActorType` in
  `external-backend/contract.ts`), chosen by the lightweight path; entry
  `domain-models-decision` removed (-1); I6 grep: no remaining `Decision` / `ActorType`
  imports from the deleted file.
- **Prerequisites:** A3 `verified` (the dead `ports/strategy.ts` is the only other
  importer of `Decision`). **Plan:** none needed.
- **Governing:** Brief B R1, R2; resolved entries (models/decision). **Gates:** floor,
  GP-H.

### A6. Delete the mirrored `economic-calendar` port; keep a local view type
- **Done-state:** herobids `ports/economic-calendar.ts` deleted and unexported; a local
  type for the 7 fields the renderer reads (`time`, `currency`, `event`, `impact`,
  `forecast`, `previous`, `sources`) lives next to the renderer in `runtime-composition.ts`;
  `venue-intelligence.ts` (`parseEconomicCalendarBoundaryPayload`) and the `macroEvents`
  field use it; entry `domain-ports-economic-calendar` removed (-1). Behavior unchanged
  (the boundary payload is still read tolerantly).
- **Prerequisites:** none. **Plan:** none needed. **Governing:** Brief B R4
  (economic-calendar bullet). **Gates:** floor, GP-H.

### A7. Delete herobids `values/ids`
- **Done-state:** `packages/domain/src/values/ids.ts` deleted; barrels pruned; entry
  `domain-values-ids` removed (-1); I6 grep shows no herobids import of its symbols.
- **Prerequisites:** A2, A3, A5 `verified` (its only consumers are `values/instrument`,
  `ports/venue`, `models/decision`). **Plan:** none needed.
- **Governing:** Brief B R2; resolved entries (ids). **Gates:** floor, GP-H.

### A8. (withdrawn: merged into A1)
Decided 2026-10-10: herobids keeps the `values/money.ts` wrapper instead of replacing it
with a direct `decimal.js` import. Its manifest entry is dropped in A1. There is no A8
milestone; the ID is left unused so other references stay stable.

### G1. Release row: herobids tag containing A1 and A2
- **Who:** the agent (invariant I12). **Done-state:** a herobids tag exists whose
  `scripts/parity-drift-manifest.json` no longer lists the A1 and A2 entries, created with
  the repo's documented release flow (read `scripts/shell/ops/release.sh` first); the exact
  commands and the tag are in the ledger and the tag is recorded in Pin pairs as the pin
  target for A9 and A10. Ask the human only if a credential or permission fails.

### A9. Traderton: delete `cost-profile`, `instrument`, `pagination`; bump the pin
- **Repo:** traderton.
- **Done-state:** deleted: `packages/domain/src/cost-profile.ts`; `values/instrument.ts`;
  `pagination.ts`; barrels pruned; **`config/strategy-presets/*.yaml` are NOT deleted
  (live; Brief B correction)**; traderton's pin in `.github/workflows/slow-tests.yml` bumped with
  `release.sh --bump-parity-pin <G1 tag>`; the traderton recipe passes against that tag;
  traderton CHANGELOG `### Removed`; the pin pair recorded in the ledger.
- **Prerequisites:** G1. **Plan:** none needed.
- **Governing:** Brief B R1, R3, O5; resolved entries (cost-profile, instrument,
  pagination). **Gates:** floor, GP-T.

### A10. Traderton: delete the `tick-gates` cluster
- **Done-state:** deleted: `packages/worker/src/tick-gates.ts`, `tick-gate-state.ts`,
  `tick-gate-state.test.ts`, `tick-message-types.test.ts`,
  `_deferred-config/tick-gates.test.ts`; the `_deferred-config/README.md` bullet naming
  `tick-gates.test.ts` updated; I6 grep shows no remaining importers; traderton CHANGELOG
  `### Removed`. Trial-verified: build, lint and the full suite pass with these deleted.
  Also check `docs/features/initial/001-parity-ledger.md` for rows that assert these files.
- **Prerequisites:** A9 `verified` (pin already past G1). **Plan:** none needed.
- **Governing:** Brief B R3; resolved entries (tick-gates, traderton copy only; herobids
  is the sole executor of the gating). **Gates:** floor, GP-T.

---

## Track B — Decided engineering work

### B1.0. Audit and plan the removal of local capability and mode-rank pre-checks
- **Repo:** herobids. **Done-state:** `plans/B1-herobids-drops-local-capability-
  prechecks.md` lists **every** herobids call site of `validateExecutionCapability`,
  `checkModeEscalation`, `MODE_RANK` (known: `routes/bots.ts:339`, `routes/agents.ts:1276`,
  `routes/capabilities/trading.ts:1286`, `tools/bots.ts:260`, the broker re-check) and for
  each records: what it checks, the **verified** traderton-side equivalent with file:line
  (or "none"), and the boundary error code to map. Sites with a verified equivalent go to
  B1.1; any site with none goes to B1.2.
- **Known at setup time:** traderton covers the bot paths (`drive-target.ts:300,330,606`,
  `tools/bots.ts:965,1185,1217`); the agent path `routes/agents.ts:1276` has **no**
  equivalent; `capabilities/trading.ts:1286` is dead code. See Brief B O1.
- **Prerequisites:** none. **Plan:** this milestone writes it.
- **Governing:** Brief B ratified decision 2, R6, O1; findings Group 4. **Gates:** floor
  (docs only), GP-D.

### B1.1. Drop the verified-safe pre-checks; delete `mode-rank`
- **Done-state:** the sites B1.0 marked safe are removed (including the dead
  `capabilities/trading.ts` block); herobids maps traderton's typed boundary errors
  (`execution_capability.<code>`, the mode-escalation message) to the same response shape
  the local check used; tests prove the mapping; herobids `trading/mode-rank.ts` deleted
  and unexported; entry `domain-trading-mode-rank` removed (-1).
- **Prerequisites:** B1.0 `verified`. **Plan:** `plans/B1-...` (from B1.0).
- **Governing:** Brief B decision 2, R6. Accepted tradeoff: a rejected request now costs
  one round-trip. **Gates:** floor, GP-H.

### B1.2. Brief: the agent-path capability check (human decision)
- **Done-state:** `decisions/B1.2-agent-path-capability-check.md` in Brief B's format,
  status PROPOSED, with evidence (what traderton does today when an agent with `paper` on
  a swap venue starts), options with reversibility (for example: add a traderton-side
  check for the agent path, then drop herobids's; keep herobids's check as a documented
  exception and treat the `execution-capability` entry as a contract-package item; or
  drop it and accept the behavior), and a recommendation. **The agent stops here and
  flags it.** Heavyweight triggers H1 and H4.
- **Prerequisites:** B1.0. **Gates:** GP-D.

### B1.3. Implement B1.2's outcome; delete `execution-capability`
- **Done-state:** per the ratified outcome; herobids `trading/execution-capability.ts`
  deleted (relocating `venueTypeFromProvider`, which herobids still uses for venue-type
  stamping, next to `SWAP_VENUES` / `ORDERBOOK_VENUES` in its config module); entry
  `domain-trading-execution-capability` removed (-1), or retained per the decision. If
  the outcome adds a traderton check, that is a separate traderton milestone added to
  this file first.
- **Prerequisites:** B1.2 ratified. **Gates:** floor, GP-H (GP-T if traderton changes).

### B2.0. Confirm no consumer of the health routes (answered)
- **External:** answered by the human on 2026-10-10: nothing outside herobids and traderton
  calls `GET /agents/:id/health` or `GET /bots/:id/health`.
- **Inside the codebase (checked by the framework setup, 2026-10-10):** the only caller of
  either route is the route's own test (`apps/api/src/routes/actor-health.test.ts`). No
  match in `apps/web`, `scripts/`, `tests/`, `docker/`, `infra/`, Caddyfiles, or traderton.
  `packages/domain/src/infra/server-health.ts` mentions the type in a comment only;
  `agents/agent-ephemeral-redis-cleanup.ts` deletes the (never written) Redis key by
  literal string. **B2.1 must repeat this search and the I6 trial deletion** before it
  deletes anything.

### B2.1. Remove actor-health from herobids
- **Done-state:** deleted: `apps/api/src/routes/actor-health.ts` (and its registration and
  tests), `apps/worker/src/actor-health-publisher.ts` (+ test),
  `packages/domain/src/trading/actor-health.ts` (+ test) and its export; the actor-health
  Redis key cleanup in `agents/agent-ephemeral-redis-cleanup.ts` and the comment in
  `infra/server-health.ts` updated; entry `domain-trading-actor-health` removed (-1); a
  grep for `ActorHealth|actorHealthKey|actor-health` in `apps/` and `packages/` is clean.
- **Prerequisites:** none (B2.0 answered). **Plan:** none needed. **Governing:** Brief B ratified
  decision 3, R7. **Gates:** floor, GP-H; web typecheck (confirm no frontend reference).

### B2.2. Remove actor-health's dead copy from traderton
- **Done-state:** deleted: `packages/domain/src/trading/actor-health.ts` (+ test), its
  export, `packages/worker/src/actor-health-publisher.ts` (+ test),
  `packages/worker/src/_deferred-authoring/api-routes/actor-health.ts`; pin bumped to a
  herobids tag containing B2.1.
- **Prerequisites:** B2.1 merged and tagged (add a `G` row for that tag, or fold into the
  next one). **Gates:** floor, GP-T.

### B3.1. Risk-contract retirement: tests first, record the before-state
- **Done-state:** exactly [agent-risk-contract-retirement.md](decisions/agent-risk-contract-retirement.md):
  open items 1-3 checked (answers written in the ledger); tests 1-5 written and **run once
  before any production change**, with pass/fail per test recorded in the ledger.
  Gap-revealing and regression-guard tests that fail today are committed as vitest
  `it.fails(...)` with a pointer to B3.2 (so `pnpm test` stays green) and the real failure
  output recorded. Test 4 must pass; if it does not, stop (a more serious finding;
  heavyweight path).
- **Prerequisites:** none. **Plan:** the retirement doc is the plan. **Gates:** floor,
  **GP-X**.

### B3.2. Risk-contract retirement: implement
- **Done-state:** `resolveAgentRiskContractForResponse` is retired; the four `agents.ts`
  call sites (`929, 1061, 1997, 2768`) source `riskContract` from the boundary read for the
  agent's real profile (or, if open item 2 shows the intent was to wire the real profile
  through, that wiring, which is a **change of disposition: heavyweight H1/H3**);
  `it.fails` tests flipped to `it`; no herobids production caller of
  `resolveAgentRiskContract` remains; the mirrored `agent-risk-contract.ts` file is **not
  edited** (I5). The `domain-agent-risk-contract` entry stays until C3.6.
- **Prerequisites:** B3.1 `verified`. **Gates:** floor, GP-H, **GP-X**.

### B4.1. Audit and plan removal of herobids's `agentRiskDefaults` YAML block
- **Done-state:** `plans/B4-agent-risk-defaults-boundary-cache.md` lists every consumer
  (known: `apps/api` blueprint-risk-resolver, go-live service (parameter already unused),
  agent-create-normalization, telegram, chat, `agent-config-helpers`; **worker**
  `index.ts:589-590` reads `agentDecisionNoContextThreshold` and
  `agentDecisionSwapInstrumentFormatThreshold` locally; `agent.ts:294`), classifies each
  (boundary-read-able at startup vs. herobids-local), decides where herobids-local fields
  live (lightweight, matching `docs/best-practices/configuration.md`), lists `.env*.example`
  changes (I9), and **appends implementation rows B4.2... to this file and the ledger**.
- **Prerequisites:** none. **Plan:** this milestone writes it. **Governing:** Brief B
  resolved entries (`agent-risk-defaults`); `get_operator_defaults`
  (`apps/api/src/traderton-operator-defaults.ts`). Sequence the implementation rows after
  B3.2. **Gates:** GP-D. The final implementation row removes the manifest entry
  `agent-risk-defaults` (-1) and updates the checker test (I2: it names this id).

---

## Track C — Wire-DTO contract package (`@traderton/contracts`)

Mechanics are decided (registry, pin, CI) in
[wire-dto-package-mechanics.md](decisions/wire-dto-package-mechanics.md). **Agents work
autonomously inside each row and stop after it** (step 8); only a failed credential or
permission, and heavyweight decisions, need you. **Approach: additive first.** The package is built as a copy;
traderton's mirrored originals stay untouched and pinned until herobids has switched (C3),
a herobids tag exists (G3), and only then does traderton dedupe (C4). Editing a mirrored
traderton file earlier would turn traderton CI red (invariant I3).

### C1.0. Plan the carve-out
- **Repo:** traderton. **Done-state:** `plans/C1-contracts-package-carveout.md`: exact
  export list per shape group with transitive dependencies (for example `WatchPurposeEnum`
  with watch; `RegimeResult` lives in a file that is mostly staged assessment code),
  package layout and build graph, test strategy (round-trip contract fixtures for each Zod
  schema), starting version, the narrowed wake envelope (`ScannerWakeContext` and base
  fields; herobids owns the other wake contexts; Brief B O4), whether runtime helpers
  (`parseWatch`) ship or only schemas and types, and a revised C1.1-C4 row list written
  back into this file.
- **Prerequisites:** none. **Governing:** Brief B ratified decision 5, O4, O6; findings
  "Proposed wire-DTO contract set"; mechanics doc "Scope". **Gates:** GP-D.

### C1.1. Package skeleton (provisional)
- **Done-state:** `packages/contracts` in traderton (name `@traderton/contracts`), empty
  barrel, build, lint and test wiring in the workspace; no content yet. No manifest-listed
  file changed, so no pin bump. **Prerequisites:** C1.0. **Gates:** floor, GP-C.

### C1.2 - C1.6. Shape groups, additive copies (provisional; C1.0 may revise)
Each: add the shapes to the package with tests; originals untouched.
- **C1.2 Watch:** `WatchEntry`, `WatchEntrySchema`, instrument identity and coverage link,
  `WatchPurpose` enum and values.
- **C1.3 Scan state:** `CandleFetchStatus`, `SymbolFetchOutcome`, `PositionIndicatorUpdate`,
  `TechnicalScanState` field types, `HybridPricingIdentity`.
- **C1.4 Wake envelope:** `AgentWakePayload` envelope, `WakePriority`, `ScannerWakeContext`
  (and `ContextSnapshotPayload` if the plan includes it).
- **C1.5 Regime and volatility:** `RegimeResult`, `VolatilityEvidence`, `EvidenceValue`.
- **C1.6 Risk overrides:** `AgentRiskOverrides`, `AgentRiskOverridesSchema`.
- **Prerequisites:** C1.1. **Gates:** floor, GP-C.

### C2.0. Plan publishing
- **Done-state:** `plans/C2-publish-contracts.md`: publish workflow on traderton release
  tags, version mapping, `publishConfig` for GitHub Packages, required token permissions,
  dry-run procedure, rollback policy, how `release.sh` and `release-xstack.sh` integrate.
  **Prerequisites:** C1.0. **Gates:** GP-D.

### C2.1. Implement the publish workflow and dry run
- **Done-state:** workflow and `publishConfig` merged; `pnpm publish --dry-run` (or the
  plan's equivalent) succeeds. **No real publish.** **Prerequisites:** C1.1, C2.0.
  **Gates:** floor, GP-C.

### G2. Release row: first publish of `@traderton/contracts`
- **Who:** the agent (invariant I12), using the plan from C2.0 and the local credentials.
  **Done-state:** the package is published at its first version, and the version and
  publish time are in the ledger. This is the one step that cannot be redone with the same
  version, so run the plan's dry run again immediately before publishing. Ask the human
  only if a credential or permission fails. **Prerequisites:** C2.1; every C1.x shape the
  first C3 row needs.

### C3.0. Plan herobids's migration
- **Repo:** herobids. **Done-state:** `plans/C3-herobids-consumes-contracts.md`: **install
  authentication for local `pnpm install`, CI, and Docker builds** (open item O6; a new
  secret or credential is heavyweight), `.npmrc` without committed secrets, where the
  dependency lives, the exact herobids files to change per shape group, which herobids
  tests move into package contract tests, and how the checker stays green per shape (drop
  the entry in the same change as the swap, I1). **Prerequisites:** C2.0. **Gates:** GP-D.

### C3.1. Wire the dependency
- **Done-state:** `.npmrc` scope config, an exact-version pin of `@traderton/contracts`
  (no `^` or `~`), CI and Docker install authentication per the plan, `.env*.example`
  updated if a variable is introduced (I9); a clean-environment `pnpm install` and the
  Docker build both succeed; nothing uses the package yet. **Prerequisites:** G2, C3.0.
  **Gates:** floor, GP-C, `docs/best-practices/docker.md`.

### C3.2 - C3.6. Migrate one shape group each (provisional)
Each: swap herobids imports to the package, delete herobids's mirrored copy, drop the
manifest entry (I1, I2), GP-H.
- **C3.2 Watch:** delete `apps/worker/src/watch-types.ts` (keep herobids's own conversion
  to `RuntimeActiveWatch` in `agent-watch-view.ts`); drop `watch-types`.
- **C3.3 Scan state:** delete `apps/worker/src/scan-types.ts`; drop `scan-types`.
  (`domain-scanner-types` remains until D2.)
- **C3.4 Wake envelope:** `domain-trading-trading-protocol`: herobids keeps its own
  watch-threshold, discovery-delta, regime-change and reminder contexts and composes the
  full union from the package's envelope and `ScannerWakeContext`; drop the entry.
- **C3.5 Regime and volatility:** herobids's production imports of `RegimeResult`,
  `VolatilityEvidence`, `EvidenceValue` (`venue-intelligence.ts`, `tick-gates.ts`,
  `runtime-composition.ts`) come from the package. **Do not edit the still-mirrored
  `market-assessment.ts`** (I5, I10); its entry waits for D2.
- **C3.6 Risk overrides:** `AgentRiskOverridesSchema` from the package in the saga and
  `agent-config-helpers`; delete herobids's `agent-risk-contract.ts`; drop
  `domain-agent-risk-contract`. **Also requires B3.2.**
- **Prerequisites (all):** C3.1 and the matching C1.x `verified`. **Gates:** floor, GP-H,
  GP-C.

### G3. Release row: herobids tag containing the C3 entry removals
- **Who:** the agent (invariant I12). **Done-state:** the tag exists and is recorded as the
  pin target for C4.

### C4. Traderton consumes the package; delete the originals
- **Repo:** traderton. **Done-state:** traderton imports the shapes from
  `@traderton/contracts` (workspace dependency); the in-domain and in-worker originals are
  deleted (including the unused wake-context schemas, Brief B O4); pin bumped to the G3
  tag; the GP-T recipe passes. **Prerequisites:** G3, per shape. **Gates:** floor, GP-T,
  GP-C.

### C5. Automate the package version-pin bump
- **Repo:** herobids. **Done-state:** `scripts/shell/ops/release-xstack.sh` publishes
  `@traderton/contracts`, then bumps herobids's pinned dependency, right after the
  existing parity-pin steps (`bash -n` passes; the script is **edited, not run**: running it is G-row work).
  **Prerequisites:** G2. **Governing:** mechanics doc section 2. **Gates:** floor.

---

## Track D — Blocked on other epics

### D0. Checkpoint: report and ask
- **Repo:** herobids (report only). **Prerequisites:** every A, B and C milestone
  `verified`. **Done-state:** the agent lists the manifest entries that remain (expected:
  the 9 Track D entries `strategy-preset-economy`, `-premium`, `-standard`,
  `domain-config-presets-loader`, `domain-config-presets`,
  `domain-config-strategy-parameters`, `domain-market-assessment`, `domain-scanner-types`,
  `domain-ports-candle-fetcher`), states the chain that unblocks them (human "go" for
  E1-H and E3-H, then traderton preset plan S1-S9, then herobids H1-H6, then D2), and
  **asks the human whether to start it or stop here**. It does not start Track D on its
  own. **Gates:** none (report).

| Item | Blocked on | State |
|---|---|---|
| **D1** | The 2026-10-04 plan pair (traderton `docs/features/2026/10/04/004-preset-assessment-data-only/001-plan.md`; herobids [001-plan.md](../../04/002-preset-assessment-on-traderton/001-plan.md)) step **H5**, which depends on Wave E's herobids halves (E1-H, E3-H; traderton halves done) and the traderton preset plan S1-S9 | Owned elsewhere. The planning gaps found by this epic's investigation were fixed in H5's text (2026-10-10; uncommitted at setup time). |
| **D2** (herobids) | D1 executed | Drop and delete: `strategy-preset-economy`, `-premium`, `-standard`, `domain-config-presets-loader`, `domain-config-presets`, `domain-config-strategy-parameters`, `domain-market-assessment`, `domain-scanner-types`, and finish `domain-ports-candle-fetcher` (delete the residual `PriceCandle`). Herobids's preset YAML files go with H5 itself. **Traderton's own copies are live** (`presets-loader` is called from `tools/trading-profiles.ts` and guarded by `agent-strategy.parity.test.ts`); D1/H5 execution must first confirm what replaces traderton's `loadPresets` / `getPreset` / `listPresets` call sites, and only then may the three `strategy-preset-*` entries be dropped. Each drop follows R10: only after H5 has executed. Gates: floor, GP-H, GP-T if traderton changes. |

**Where Wave E actually stands** (from traderton's `docs/features/2026/10/04/
001-wave-e-actor-events-and-lifecycle/000-overview.md`, 2026-10-04): the traderton halves
(E0, E2, E3-T, E1-T) are **done**; the herobids halves (E1-H, E3-H) are **gated on the
human's go**; E4 and E5 are separate and not started. The chain behind D1 is therefore:
human "go" for E1-H and E3-H, then the traderton preset plan (S1-S9), then herobids H1-H6.
Tracks A, B, C do not depend on any of it; pulling it forward is optional and only shortens
the very last part of the epic.

---

## C6 — The finish line

Both rows are blocked until the manifest has **zero entries**. Either order works (each
repo's CI uses pinned refs); do C6.1 then C6.2 so the ledger records one pin-free end
state.

### C6.1. Herobids
- **Done-state:** deleted: `scripts/parity-drift-manifest.json`,
  `scripts/check-parity-drift.mjs`, `scripts/check-parity-drift.test.mjs`; the
  `parity-drift` job removed from `.github/workflows/slow-tests.yml` (and the file, if it
  has no other job; it had one on 2026-10-10); `package.json` `test:slow` updated;
  `release.sh`'s `--bump-parity-pin` and parity gate (around lines 235-246) and
  `release-xstack.sh`'s parity steps removed; the parity-drift rule removed from
  `AGENTS.md` (human-approved wording); ADR 018 and ADR 011 status consistent; CHANGELOG.
- **Gates:** floor, **GP-F**.

### C6.2. Traderton
- **Done-state:** deleted: `scripts/check-parity-drift.mjs` (the wrapper); the
  `parity-drift` job removed from `.github/workflows/slow-tests.yml`; `package.json`
  `test:slow` no longer references herobids's checker or test; any docs naming the check
  updated; CHANGELOG. **Gates:** floor, GP-F.

---

## Coverage: every manifest entry and the milestone that removes it

| Entry | Removed by | Entry | Removed by |
|---|---|---|---|
| `agent-risk-defaults` | B4.x | `domain-ports-venue` | A3 |
| `strategy-preset-economy` | D2 (stays `mirror-only` until H5) | `domain-result` | A1 |
| `strategy-preset-premium` | D2 (stays `mirror-only` until H5) | `domain-scanner-types` | D2 (type part moves in C3.3) |
| `strategy-preset-standard` | D2 (stays `mirror-only` until H5) | `domain-trading-actor-health` | B2.1 (B2.2) |
| `watch-types` | C3.2 | `domain-trading-execution-capability` | B1.3 |
| `scan-types` | C3.3 | `domain-trading-mode-rank` | B1.1 |
| `tick-gates-session-hours` | A1 (copy deleted A10) | `domain-trading-trading-protocol` | C3.4 |
| `domain-agent-risk-contract` | C3.6 (after B3.2) | `domain-trading-venue-capability` | A4 |
| `domain-config-presets-loader` | D2 | `domain-values-ids` | A7 |
| `domain-config-presets` | D2 | `domain-values-index` | A2 |
| `domain-config-strategy-parameters` | D2 | `domain-values-instrument` | A2 (copy deleted A9) |
| `domain-cost-profile` | A1 (copy deleted A9) | `domain-values-money` | A1 |
| `domain-market-assessment` | D2 | `domain-pagination` | A2 (copy deleted A9) |
| `domain-models-decision` | A5 | `domain-ports-candle-fetcher` | A3 narrows; D2 removes |
| `domain-ports-economic-calendar` | A6 | `domain-ports-mark-source`, `-sentiment`, `-strategy`, `-subscription`, `-swap-venue`, `-token-safety` | A3 |

## Verification of the dead-copy claims (trial deletion, 2026-10-10)

The preset-YAML claim was retracted because "zero references" came from grep alone (Brief
B correction). Every other dead-copy claim was therefore re-checked by **trial deletion in
APFS clones** of both repos under `/tmp` (the real working trees were not touched), with
the owning repo's own build, type checks and test suite as the judge.

- **Baselines (green):** herobids domain build, `pnpm lint`, `tsc` for domain/worker/api,
  web typecheck, `vitest run` (351 files, 6985 tests); traderton `pnpm -r run build`,
  `pnpm lint`, `vitest run` (170 files, 2976 tests).

| Claim tested | Result |
|---|---|
| **Traderton:** `cost-profile`, `values/instrument`, `pagination`, `tick-gates.ts` + `tick-gate-state.ts` + their 3 test files, actor-health (domain file + test, worker publisher + test, quarantined route copy), barrels pruned | **Confirmed.** Build, lint green; vitest 166 files / 2926 tests pass (the 50 fewer tests belong to the deleted code). Remaining references are docs only: `_deferred-config/README.md` (lines 37, 41, 54), `_deferred-authoring/README.md:66`, historical docs under `docs/features/initial/` and `archive/` (including `001-parity-ledger.md`; the milestone checks whether it asserts these files). |
| **Herobids:** the 7 ports, `CandleFetcher`, `venue-capability` + fixture, `models/decision` (with `ActorType` retargeted), `values/instrument`, `pagination`, `values/ids`, actor-health (domain file + test, worker publisher + test, API route + test + registration in `apps/api/src/index.ts`), barrels pruned | **Confirmed.** Domain build, lint, `tsc` for domain/worker/api, web typecheck green; vitest 348 files / 6964 tests pass. A scan of `scripts/`, `tests/`, `apps/web`, `docker`, `infra` found only the orphaned `tests/fixtures/venue-capabilities.ts`. |
| **Herobids, expected NOT dead:** `economic-calendar`, `values/money`, `mode-rank`, `execution-capability` | **Break set matches the roadmap exactly.** Worker: `hybrid-decision-sizing.ts`, `runtime-composition.ts`, `venue-intelligence.ts`, `tools/bots.ts`. API: `agent-create-normalization.ts`, `agent-config-helpers.ts`, `routes/bots.ts`, `routes/capabilities/trading-ledger.ts`, `routes/capabilities/trading.ts`, `routes/agents.ts` (plus cascade errors in `agent-interactivity.ts` and `chat.ts` from one collapsed type). Matches A6 and B1.x; `values/money` is kept by herobids (decision 2026-10-10). |
| **Preset YAMLs (traderton)** | **Retracted, live.** Not re-tested; Brief B's correction stands. |

**Not executed:** the DB-backed tiers (`pnpm test:functional`, `pnpm test:integration`,
traderton's `scripts/shell/tests/run-integration.sh`) need Postgres and Redis. Scans found
no references there, but they were not run; a milestone runs them if the environment
allows and records it if not.

**Gotchas the trials exposed** (apply in the milestones):
1. Rebuild the herobids domain package (`pnpm --filter @herobids/domain run build`) before
   the per-app `tsc` runs. The apps consume it through its build output, and the
   extraction handoff brief records the same build-cache blind spot for root `pnpm lint`.
2. Deleting the last export of a barrel leaves an empty `values/index.ts`, which fails the
   build ("is not a module"). Applies if a barrel is ever emptied: remove it and its
   `export *`, or leave `export {};`.
3. A single root cause can produce hundreds of `tsc` errors (one collapsed type in
   `agent-config-helpers.ts` produced ~160 in `agents.ts`, `chat.ts`, `agent-interactivity.ts`).
   Fix the first error file, rebuild, and re-run before counting.

---

## When the agent reaches out to you

Only these, and only when it cannot proceed:

| Situation | What you do |
|---|---|
| A heavyweight decision (B1.2 is the known one) | Read the brief the agent wrote and decide |
| A credential, permission, registry or branch rule blocks a tag, push or publish | Fix or grant it, then say "next" |
| Checkpoint D0 (Tracks A, B, C all verified) | Tell the agent whether to start the Wave E herobids halves (E1-H, E3-H) and the preset-assessment chain, or to stop here |
| Optional | Pull the `trading-protocol` trim forward (Brief B O4) |

## Findings log

Add a dated line here whenever a milestone uncovers a gap: the row it affected and what you
did (resolved in place, or split into a new row).

- 2026-10-10 (framework setup): see Brief B O1 (agent-path capability check has no
  traderton equivalent), O2 (money wording), O4 (trim timing), O6 (package install auth),
  O8 (AGENTS.md pin-recording step; fixed the same day). The ledger's Outstanding issues also notes
  that traderton's current pin fails against its own tree.
- 2026-10-10 (correction): the preset-YAML deletion was retracted: the traderton copies
  are live (`presets-loader` is called from `tools/trading-profiles.ts`; 14 traderton tests
  failed without them). The three `strategy-preset-*` entries stay `mirror-only` until H5.
  Root cause: "dead" was concluded from grep alone. The method now requires a trial
  deletion judged by the owning repo's own suite (invariant I6). All other dead-copy claims
  were re-verified that way (previous section).
