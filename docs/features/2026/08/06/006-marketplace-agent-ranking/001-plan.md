# Marketplace Agent Ranking (Sort by Performance Score)

## Objective

Add a "Ranking" sort option to the blueprint marketplace that orders agents by
trading performance. The ranking is based on the existing `performanceScore`
formula from `apps/worker/src/runtime-composition.ts` (lines 777–789), computed
from persisted trading data rather than live runtime state.

## Decision Summary

We are reusing the existing 4-component weighted performance score. Three of the
four inputs are computable from the database. The fourth (drawdown) requires
either peak-equity tracking or is skipped in Phase 1.

| Phase | Change | Status | Why |
|---|---|---|---|
| **Phase 1** | Compute & persist `performanceScore` on blueprints from winRate + PnL + time-adjusted return. Skip drawdown (neutral 0.5). Add `ranking` sort to browse API + frontend. | **DO** | Delivers ranking with 80% score fidelity. winRate is the user's preferred metric and carries the most interpretable signal. |
| **Phase 2** | Add peak-equity tracking to enable drawdown component. Recompute scores with full 4-component formula. | **DEFER** | Requires a new column + update logic. The incremental benefit (20% weight) is modest; validate Phase 1 adoption first. |

## Background: The Existing Performance Score

`computePerformanceSummary()` in `runtime-composition.ts` computes a 1–10 score:

```
pnlScore        = clamp((pnlReturnPct + 5) / 10, 0, 1)     // weight 0.4
winRateScore    = clamp(winRate / 100, 0, 1)                // weight 0.2
riskAdjustedScore = clamp((riskAdjReturn + 1) / 3, 0, 1)   // weight 0.2
drawdownScore   = clamp(1 - |drawdownPct| / 10, 0, 1)      // weight 0.2

weightedScore   = pnlScore*0.4 + winRateScore*0.2 + riskAdjusted*0.2 + drawdown*0.2
performanceScore = round(weightedScore * 10)  → 1..10
```

**Important caveat:** This score is currently computed at runtime from live
session state. It is NOT persisted anywhere. The runtime draws winRate from the
`get_analytics` tool result and derives everything else from session-scoped
metrics (portfolio snapshots, elapsed time, peak-equity memory). For blueprint
ranking, we must compute equivalent values from the database.

## Data Availability Analysis

Each component of the formula was traced to its origin to determine whether it
can be computed offline (from the DB) or only at runtime.

### 1. winRate (weight 0.2) — ✅ Easy

**Runtime source:** `get_analytics` tool → `botRepo.getAnalyticsByCreator()` →
counts closed positions where `realizedPnl > 0` divided by total closed
positions in `positions` table.

**Blueprint computation:** Identical query against the `positions` table for the
agent (and its bots) linked to the blueprint.

```sql
-- pseudocode
closedPositions = SELECT * FROM positions
  WHERE (actorType='agent' AND actorId=$agentId)
     OR (actorType='bot' AND actorId IN ($botIds))
  AND closedAt IS NOT NULL

winRate = COUNT(closedPositions WHERE realizedPnl > 0) / COUNT(closedPositions) * 100
-- null if < 2 closed positions
```

**Verdict:** Trivially computable. Fully independent of runtime state.

### 2. pnlReturnPct (weight 0.4 via pnlScore) — ✅ Doable

**Runtime source:** `netPnlUsd / startingCapitalUsd * 100`, where:
- `netPnlUsd` = realizedPnl + unrealizedPnl (runtime mark prices)
- `startingCapitalUsd` = derived as `currentEquity - netPnlUsd` on first observation

**Blueprint computation:**
- `realizedPnlUsd` = SUM(realizedPnl) from closed positions in `positions` table
- `unrealizedPnlUsd` is NOT available offline (depends on live mark prices) →
  **use realizedPnl only** for blueprint scoring
- `startingCapitalUsd` → use `agents.capital` (user-configured trading capital).
  This is a deliberate simplification: the runtime derives starting capital from
  equity observations, but for ranking we use the explicit capital the user set.
  Agents with `capital = NULL` get a neutral `pnlScore = 0.5`.

```
pnlReturnPct = realizedPnlUsd / agents.capital * 100
pnlScore = clamp((pnlReturnPct + 5) / 10, 0, 1)
```

**Verdict:** Computable with the simplification of using `agents.capital` instead
of derived starting capital, and using realized PnL only (no unrealized). This
is conservative — agents with large open profitable positions won't get credit
until they close, which is actually desirable for ranking (realized performance
only).

### 3. riskAdjustedReturn (weight 0.2) — ✅ Doable

**Runtime source:** `pnlReturnPct / sqrt(elapsedHours)` where `elapsedHours` is
session duration.

**Blueprint computation:** Use agent lifetime instead of session duration.

```
hoursSinceCreation = (NOW() - agents.createdAt) / 3600000
riskAdjustedReturn = pnlReturnPct / sqrt(MAX(hoursSinceCreation, 1/60))
riskAdjustedScore = clamp((riskAdjustedReturn + 1) / 3, 0, 1)
```

**Verdict:** Computable using `agents.createdAt`. Different semantics from
runtime (lifetime vs. session) but directionally correct — an agent that made
50% in 1 week scores higher than one that made 50% in 1 year.

### 4. drawdownPct (weight 0.2) — ❌ Hard (deferred to Phase 2)

**Runtime source:** `(currentEquity - peakEquity) / peakEquity * 100`, where
`peakEquity` is tracked in-memory during the session.

**Blueprint computation:** Requires knowing the highest equity point in the
agent's history. This is NOT stored anywhere today. To compute it:

- **Option A (complex):** Replay all positions chronologically, computing
  cumulative realizedPnl at each close, tracking the peak. Does not capture
  unrealized drawdowns between closes.
- **Option B (simple):** Add a `peakEquityUsd` column to `blueprints` (or
  `agents`), updated whenever a new performance score is computed.
  `equity = capital + cumulativeRealizedPnl`. Peak equity = the max observed.
- **Option C (simplest):** Skip drawdown entirely, use neutral `drawdownScore =
  0.5`.

**Phase 1 decision:** Use Option C (neutral 0.5). This means the drawdown
component neither rewards nor penalizes any agent. The remaining 80% of the
formula (PnL 40% + winRate 20% + risk-adjusted 20%) still produces a meaningful
discriminative score.

**Phase 2:** Implement Option B — add `peakEquityUsd` to `blueprints`, update it
on each score recomputation.

## Phase 1 Implementation Plan

### Step 1: Add `performanceScore` column to `blueprints` table — **DONE**

**File:** `packages/db/src/schema/blueprints.ts`
- Add `performanceScore: doublePrecision('performance_score').notNull().default(0)`
- Add index: `index('idx_blueprints_performance').on(t.performanceScore)`

**File:** New migration (e.g., `0032_add_blueprint_performance_score`)

### Step 2: Create a scoring function — **DONE**

**New file or location:** `apps/api/src/services/blueprint-performance-scorer.ts`
(or in `agent-blueprint-sync-service.ts`)

The function:
1. Resolves the agent linked to the blueprint (`agents.blueprintId`)
2. Queries closed positions for the agent + its bots (same query pattern as
   `getAnalyticsByCreator` in `packages/db/src/repositories.ts`)
3. Computes:
   - `winRate` = winningPositions / closedPositions * 100 (null if < 2 closed)
   - `realizedPnlUsd` = SUM(realizedPnl) from closed positions
   - `pnlReturnPct` = realizedPnlUsd / agents.capital * 100 (null if no capital)
   - `riskAdjustedReturn` = pnlReturnPct / sqrt(hoursSinceCreation)
4. Computes the 4-component weighted score with drawdown = 0.5
5. Returns `performanceScore` (1–10)

Edge cases:
- Agent has no closed positions → `performanceScore = 0` (sorts to bottom)
- Agent has no capital set → `pnlScore = 0.5` (neutral)
- Agent has < 2 closed positions → `winRateScore = 0.5` (neutral)

### Step 3: Trigger score computation — **DONE**

All triggers only compute scores for the **original author's agent** (the agent
owned by `blueprints.authorId` whose `blueprintId` matches this blueprint).
Forked blueprint instances belonging to other users do NOT affect the
blueprint's marketplace ranking.

| Trigger | When | Priority |
|---------|------|----------|
| Agent stop | `agent-lifecycle-service.ts` — after stopping, recompute blueprint score for the author's agent | **Phase 1** |
| Agent start | `agent-blueprint-sync-service.ts` — after syncing blueprint, recompute for the author's agent | **Phase 1** |
| Periodic job | Nightly cron rescans all published blueprints whose linked author-agent has had position activity (fills or closes) since the last score update | **Phase 1** |

Stop/start catches the common case (positions close, agent stops). The nightly
job catches agents that have bot-closed positions without being restarted.

### Step 4: Add `ranking` sort to browse API — **DONE**

**File:** `packages/domain/src/blueprint.ts`
- Add `'ranking'` to `BlueprintBrowseQuerySchema.sort` enum

**File:** `apps/api/src/routes/blueprints.ts` (GET `/blueprints`)
- Add `else if (query.sort === 'ranking')` branch:
  - `ORDER BY performance_score DESC, id ASC`
- Handle cursor pagination for `ranking` sort (same pattern as `popular`):
  - Cursor key: `{ score: performanceScore, id: blueprintId }`
  - WHERE clause: score < cursor OR (score = cursor AND id > cursor)

### Step 5: Add `performanceScore` to response schema — **DONE**

**File:** `packages/domain/src/blueprint.ts`
- Add `performanceScore: z.number()` to `BlueprintSummarySchema`

### Step 6: Update frontend — **DONE**

**File:** `apps/web/src/features/blueprints/BlueprintBrowse.tsx`
- Add `{ value: 'ranking', label: 'Ranking' }` to `SORT_OPTIONS`
- The "Ranking" sort option is only shown when the active context is
  trading-relevant. This is determined by a new **skills-based filter** (see
  Step 6a). When the skills filter includes a trading skill (or when
  `kind = 'agent'` with a trading `strategyType`), the Ranking sort appears.
  For non-trading contexts (e.g., personal assistant skills only), it is
  hidden.

**Marketplace cards:**
- Trading agent cards: display the rank number only (e.g., a "#3" badge).
  Clean, competitive, and easy to understand at a glance.
- Non-trading agent cards: display nothing — no score, no rank.

**File:** `apps/web/src/lib/blueprint-types.ts`
- Add `performanceScore: number` to `BlueprintSummary`

**File:** `apps/web/src/lib/api-client.ts`
- Add `performanceScore: number` to the `BlueprintSummary` type

### Step 6a: Skills-based filter (new work) — **DONE**

To gate the Ranking sort on trading context, add a skills-based filter to the
marketplace browse UI. This is **new work** — the current `BlueprintBrowse`
component has `kind`, `sort`, and kind-tabs but no skills filter.

**API:** `GET /blueprints` already accepts a `tags` query parameter (comma-
separated). Blueprint tags include skill names. Add a `skillIds` or extend
`tags` filtering to support skill-based filtering.

**Frontend:** Add a skill multi-select dropdown or chip filter to the
`BlueprintBrowse` filter row. When the user selects a trading skill, the
"Ranking" sort option appears. The filter should be populated from the same
skill list used in agent creation.

**Simpler alternative for Phase 1:** Instead of a full skills filter, gate the
"Ranking" sort on `kind = 'agent' AND strategyType IS NOT NULL`. This is a
reasonable proxy: any agent blueprint with a strategy type is a trading agent.
A proper skills filter can be added later as separate work.

### Step 7: Lint, test, verify — **DONE**

- `pnpm lint`
- Run existing blueprint browse tests
- Add test: `GET /blueprints?sort=ranking` returns blueprints ordered by
  performance score
- Manual UAT: browse marketplace, switch to "Ranking" sort, verify agents appear
  in sensible order

## Phase 2 (Deferred)

- Add `peakEquityUsd` column to `blueprints` table
- Update it on each score recomputation: `peakEquityUsd = MAX(peakEquityUsd, capital + cumulativeRealizedPnl)`
- Compute `drawdownPct = (currentEquity - peakEquityUsd) / peakEquityUsd * 100`
- Replace neutral 0.5 with actual `drawdownScore` in the formula

## Resolved Design Decisions

1. **Score update frequency** — Both stop/start triggers AND a nightly periodic
   job. Stop/start catches the common case (positions close, agent stops). The
   nightly job catches agents with bot-closed positions that haven't been
   restarted.

2. **Non-trading agents** — They get `performanceScore = 0` (sorting to bottom
   when ranking is selected). However, the "Ranking" sort option is only
   surfaced in the UI when the active context is trading-relevant (gated by a
   skills-based filter or `strategyType IS NOT NULL`). A personal-assistant
   blueprint under "All" + "Ranking" would appear at the bottom, which is
   acceptable.

3. **Display on cards** — Trading agent cards show a rank number badge only
   (e.g., "#3"). Clean and competitive. Non-trading agent cards show nothing.

4. **Scope** — Only the **original author's agent** performance is used for the
   blueprint's ranking. Rationale:
   - The marketplace sells *strategies*, not execution luck. The author's own
     results are the honest signal of the strategy's quality.
   - Forked instances reflect other users' configuration and market timing, not
     the blueprint's inherent quality.
   - Simpler implementation: one agent → one score. No aggregation, no privacy
     concerns.
   - If the author never traded their own blueprint → score stays 0, which is
     correct: unproven strategies shouldn't outrank proven ones.

5. **Skills-based filter** — New work required. The Ranking sort is gated on
   trading context. Phase 1 uses the simpler proxy of `kind = 'agent' AND
   strategyType IS NOT NULL`. A full skills filter for the marketplace can be
   added later. See Step 6a for details.

---

## Outstanding Issues

### [Step 1] Add performanceScore column to blueprints

- **MEDIUM** — Missing migration snapshot file (`0063_snapshot.json`). Several other migrations in the codebase also lack snapshots (0012, 0013, 0014, 0018, 0025, 0029, 0040), so this is a pre-existing practice. Not blocking but worth addressing before merge.
- **MEDIUM** — Plan document references `"0032_add_blueprint_performance_score"` as example migration name; actual migration is 0063. Cosmetic discrepancy, the plan example was never meant to be literal.
- **LOW** — Missing trailing newlines in migration SQL and journal (fixed).

### [Step 2] Create scoring function

- **MEDIUM** — `Number(p.realizedPnl ?? 0)` has dead `?? 0` fallback (field is `NOT NULL DEFAULT '0'`). Pre-existing pattern from `repositories.ts`, harmless but misleading.
- **LOW** — `clamp` helper lacks JSDoc comment.
- **LOW** — No transaction wrapping read→write (acceptable for periodically-recomputed score).
- **LOW** — Full-table scan on positions for agents with many closed positions (acceptable for Phase 1, called on triggers + cron, not request path).

### [Step 3] Trigger score computation

- **MEDIUM** — Double recomputation on every agent start: `startAgent` fires recompute after `ensurePublishedBlueprintForAgent`, but the sync service already fires its own recompute in all 3 internal paths (create/unchanged/revised). Wasteful but idempotent.
- **MEDIUM** — Periodic cron rescans ALL published blueprints without the plan's "position activity since last update" filter. Acceptable for Phase 1.
- **LOW** — Plan says "nightly" but cron interval is every 6 hours.
- **LOW** — `console.error` used instead of structured logger in lifecycle/sync services.
- **LOW** — Dead `?? 0` fallback on `realizedPnl` (NOT NULL column).

### [Steps 4+5] Ranking sort + performanceScore schema

- **LOW** — Cross-sort cursor reuse: cursor `score` key is shared across all sort types. Switching sorts with a stale cursor produces silently wrong pagination (pre-existing pattern, not a regression).
- **LOW** — `performanceScore = 0` at cursor boundary produces valid but degenerate pagination (all 0-score agents sort by UUID within the group). Mitigated by frontend hiding ranking for non-trading contexts.
- **LOW** — Plan doc uses camelCase cursor key `{ score, id }` — implementation is consistent.

### [Step 6] Frontend + skills filter

- **MEDIUM** — Rank badge hidden for `performanceScore === 0`, which excludes agents with no positions even when sorted by ranking. Every item has a position in a ranked list regardless of score.
- **LOW** — `strategyType` gate may hide badge for non-trading agents. Phase 1 proxy is acceptable.
