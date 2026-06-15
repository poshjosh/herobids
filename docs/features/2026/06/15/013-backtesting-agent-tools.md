# 024 — Backtesting Agent Tools

Let agents run backtests against historical market data to evaluate strategies
before committing capital. Exposes `run_backtest`, `get_backtest_result`, and
`cancel_backtest` tools, backed by the existing `@herobids/backtesting` package
and a new DB table for run persistence.

**Depends on:** 022 (tool result pattern), 023 (OHLCV / candle infrastructure).
Without 023, there is no historical data source for the backtest runner.

---

## Background

The `@herobids/backtesting` package already exists (`packages/backtesting/`) with:

- `runBacktest(config: BacktestConfig): Promise<BacktestReport>` — linear frame
  replay, strategy evaluation, paper execution, fill accounting.
- `ArrayHistoricalDataFeed` — takes pre-loaded `HistoricalFrame[]`.
- `MarketDataRecorder` — records live market events to disk.
- `parseCsvToFrames()` — imports OHLCV from CSV.

What the package lacks is a market data pipeline for agent-initiated requests: an
agent cannot say "backtest BTC over the last 30 days" because there is no
mechanism to fetch historical OHLCV and convert it to `HistoricalFrame[]` on demand.
Plan 023 builds this infrastructure; this plan consumes it.

Additionally, backtests can take seconds to minutes. They must run asynchronously
so the agent tick loop is not blocked. Results must persist so the agent can
retrieve them on later ticks.

---

## Scope

### What is in scope

- `run_backtest` tool — agent submits a backtest request and gets a job ID immediately.
- `get_backtest_result` tool — agent polls for a completed result.
- `cancel_backtest` tool — agent cancels a running backtest.
- DB table `backtest_runs` for persistent job tracking.
- Async execution inside the worker (BullMQ job queue).
- Mechanical strategy support only (no LLM strategy — see constraints below).
- Instruments: Hyperliquid perpetuals (BTC, SOL, ETH, etc.) using Binance OHLCV
  as the underlying data source (from plan 023 infrastructure).

### What is out of scope

- LLM-strategy backtests (prohibitively expensive — 1 LLM call per candle frame).
- Custom CSV data upload by agents.
- Visualisation / chart output.
- Comparison / A/B testing across multiple runs.
- Cross-venue or multi-symbol backtests.

---

## Constraints

### LLM strategy backtests are disabled

`LlmStrategy.evaluate()` makes a real LLM call for every frame. A 30-day hourly
backtest = 720 LLM calls = ~$0.50–$5.00 per run. This is unacceptable for a
background job. The `run_backtest` tool MUST reject `strategyType: 'llm'` with a
clear error: `"LLM strategy backtests are not supported. Use strategyType: 'momentum' instead."`.

### Async only — no blocking the agent tick

`runBacktest()` is synchronous per-frame but can take seconds to minutes for large
date ranges. It MUST run in a BullMQ job, not in-process during an agent tick.

### Concurrent backtest limit

Cap at 1 concurrent backtest per agent (hard limit in tool dispatch), and 3
concurrent backtests per worker process (to avoid saturating CPU). Reject with a
clear error if at capacity.

---

## Data pipeline

```
Agent calls run_backtest(symbol, from, to, strategyConfig)
  ↓
Tool dispatch:
  1. Validate params
  2. Fetch OHLCV from Binance (via @herobids/market-data, plan 023)
     GET /api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=...&endTime=...
  3. Convert klines → HistoricalFrame[]
  4. Create backtest_runs row (status: 'running')
  5. Enqueue BullMQ job: { runId, frames, config }
  6. Return { ok: true, runId, note: "backtest started" }
```

**Why fetch in the tool dispatch rather than in the job?**
The BullMQ job worker may run in a separate process (or the same — depends on
worker config). Fetching data in the tool dispatch keeps the job payload
self-contained (`HistoricalFrame[]`) and avoids the job needing network access
or market data configuration. For large date ranges (>720 frames), the frames
array will be large — profile memory impact. If it exceeds 10MB serialized, the
job should instead store frames to a temp Redis key and the job reads from there.

---

## DB schema: `backtest_runs`

```ts
export const backtestRuns = pgTable('backtest_runs', {
  id: text('id').primaryKey(),                          // UUID v4
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id),
  status: text('status').notNull().default('pending'),  // 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  symbol: text('symbol').notNull(),                     // e.g. 'BTC'
  venue: text('venue').notNull().default('hyperliquid'),
  fromTimestamp: timestamp('from_timestamp', { withTimezone: true }).notNull(),
  toTimestamp: timestamp('to_timestamp', { withTimezone: true }).notNull(),
  strategyType: text('strategy_type').notNull(),        // 'momentum' (llm rejected at tool layer)
  strategyConfig: jsonb('strategy_config').notNull(),   // strategy params
  totalFrames: integer('total_frames'),                 // set when job starts
  result: jsonb('result').$type<BacktestReport>(),      // set on completion
  errorMessage: text('error_message'),                  // set on failure
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
// Indexes: agent_id, user_id, status, created_at
```

Migration: standard Drizzle `drizzle-kit generate` flow.

---

## BullMQ job: `backtest-run`

```ts
interface BacktestJobData {
  runId: string;
  agentId: string;
  userId: string;
  frames: HistoricalFrame[];       // pre-fetched in tool dispatch
  backtestConfig: BacktestConfig;  // fully resolved config
}

async function processBacktestJob(job: Job<BacktestJobData>): Promise<void> {
  const { runId, frames, backtestConfig } = job.data;
  await db.update(backtestRuns).set({ status: 'running', startedAt: new Date() })
    .where(eq(backtestRuns.id, runId));
  try {
    const feed = new ArrayHistoricalDataFeed(frames);
    const report = await runBacktest({ ...backtestConfig, dataFeed: feed });
    await db.update(backtestRuns).set({
      status: 'completed',
      result: report,
      totalFrames: report.totalFrames,
      completedAt: new Date(),
    }).where(eq(backtestRuns.id, runId));
  } catch (err) {
    await db.update(backtestRuns).set({
      status: 'failed',
      errorMessage: String(err),
      completedAt: new Date(),
    }).where(eq(backtestRuns.id, runId));
  }
}
```

**Cancellation:** Set `status = 'cancelled'` in DB. The job checks status once at
start; if cancelled before it begins, it exits early. Mid-run cancellation is not
supported (BullMQ jobs run to completion). Document this limitation in tool
description.

---

## Agent tools

All three are **direct in-process tools** (no broker round-trip for read/cancel;
`run_backtest` enqueues to BullMQ but returns immediately).

### `run_backtest`

```ts
tool name:  run_backtest
args: {
  symbol: string            // e.g. "BTC", "SOL", "ETH"
  fromIso: string           // ISO 8601 date, e.g. "2025-01-01"
  toIso: string             // ISO 8601 date, e.g. "2025-02-01"
  strategyType: string      // "momentum" only; "llm" → rejected
  strategyConfig: {
    lookbackPeriod?: number   // MomentumStrategy: bars to look back (default 10)
    threshold?: number        // % change to trigger signal (default 2)
    riskLimits?: { maxPositionSize?: string, maxDrawdown?: string }
  }
  interval?: string         // candle interval: "1h" (default) | "4h" | "1d"
}
returns: {
  ok: boolean
  runId?: string
  note: string
  error?: string            // if rejected (llm strategy, concurrency limit, etc.)
}
```

Validation in tool dispatch:
- `strategyType === 'llm'` → reject
- Agent already has a running backtest → reject
- `fromIso` before 1 year ago → reject (data too old / unreliable)
- `toIso` after today → reject
- Date range > 90 days → reject (too many frames, protect against memory/CPU abuse)

### `get_backtest_result`

```ts
tool name:  get_backtest_result
args:       { runId?: string }    // if omitted, returns most recent run for this agent
returns: {
  ok: boolean
  runId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  result?: BacktestReportSummary  // only when status='completed'
  errorMessage?: string           // only when status='failed'
  note: string
}

interface BacktestReportSummary {
  symbol: string
  fromIso: string
  toIso: string
  totalFrames: number
  totalDecisions: number
  totalFills: number
  realizedPnl: string      // e.g. "+$142.50" or "-$38.20"
  riskRejections: number
  strategyErrors: number
}
```

Full `BacktestReport` is not returned to the agent — the summary is sufficient for
LLM reasoning and avoids flooding context with large JSON.

### `cancel_backtest`

```ts
tool name:  cancel_backtest
args:       { runId: string }
returns:    { ok: boolean, runId, previousStatus, note: string }
```

Sets `status = 'cancelled'` in DB. If the job hasn't started yet, it will be
skipped. If already running, it will complete but the result will be marked
`cancelled` (update after job finishes — the job checks status before writing result).

---

## New `backtesting` skill

```ts
{
  id: 'backtesting',
  name: 'Backtesting',
  description: 'Run historical backtests on trading strategies before committing capital.',
  instructions: `You have access to backtesting tools.
- Use \`run_backtest\` to test a strategy on historical data (up to 90 days). Returns a runId immediately.
  Only mechanical (momentum) strategies are supported. LLM strategies are not supported.
- Use \`get_backtest_result\` to poll for results. Check on the next tick after submitting.
- Use \`cancel_backtest\` to cancel a pending or running backtest.

Backtest results show realized P&L, total fills, and risk rejections.
Use results to tune strategy parameters before deploying a live bot.`,
  requiredTools: ['run_backtest', 'get_backtest_result', 'cancel_backtest'],
  capabilityFamilies: [],
  bindingRequirements: {},
  contextRequirements: ['costs'],
  requiredContextBlocks: ['corePlatformContext'],
  promptRendererHints: ['core-system'],
  requiredGuardrails: ['token-budget'],
  suggestedTickIntervalMs: 900_000,
  visibility: 'public',
}
```

Note: `capabilityFamilies: []` — this skill does not require a trading binding.
An agent can run backtests without having a venue account.

---

## Files changed

| File | Change |
|---|---|
| `packages/db/src/schema/backtest-runs.ts` | New table definition |
| `packages/db/src/schema/index.ts` | Export `backtestRuns` |
| `packages/db/drizzle/` | New migration (drizzle-kit generate) |
| `packages/db/src/repositories.ts` | Add backtest run CRUD methods |
| `apps/worker/src/jobs/backtest-job.ts` | New BullMQ job processor |
| `apps/worker/src/jobs/index.ts` | Register `backtest-run` queue |
| `apps/worker/src/agent.ts` | Add `run_backtest`, `get_backtest_result`, `cancel_backtest` cases |
| `packages/domain/src/skills.ts` | Add `BACKTESTING_SKILL`, append to `SYSTEM_SKILLS` |
| `apps/worker/package.json` | Ensure `@herobids/backtesting` dependency present |

---

## Testing

- Unit: `processBacktestJob` with mock DB and `ArrayHistoricalDataFeed` — test
  success and failure paths, verify DB updates.
- Unit: `run_backtest` tool dispatch — test LLM strategy rejection, date range
  validation, concurrency limit.
- Unit: `get_backtest_result` — test pending/completed/failed status rendering.
- Integration: full flow — tool calls `run_backtest` → BullMQ job completes →
  `get_backtest_result` returns completed summary with non-zero fills.
- Regression: existing `@herobids/backtesting` unit tests unchanged and green.

---

## Operational notes

### Memory

A 90-day hourly backtest = ~2160 frames. Each `HistoricalFrame` ≈ 200 bytes.
2160 × 200 = ~430KB in memory per job. Well within acceptable limits.

### BullMQ concurrency

Set `concurrency: 3` on the `backtest-run` queue in the worker. Enforce at the
tool layer (1 per agent) independently of queue concurrency.

### Retention

Completed/failed backtest run rows are retained for 30 days (clean up via a
scheduled job or a Drizzle cron). The `result` JSONB column for large runs can be
significant — profile and consider storing only the summary if storage is a concern.

---

## Open questions

1. Should the `backtesting` skill be combinable with `bot-management`? E.g. an
   agent could run a backtest, see positive P&L, then use `create_bot` to deploy
   the strategy. This combo should work with no changes — skills compose.
2. 90-day cap on date range: is this sufficient for useful strategy evaluation?
   Consider: a 90-day window covers ~1 market cycle. For longer-term strategies
   (swing/position bots), a 180-day window might be more useful. Revisit after
   initial launch.
3. The `MomentumStrategy` in `packages/strategy/` has limited parameters. Are the
   `strategyConfig` fields (`lookbackPeriod`, `threshold`) sufficient for the agent
   to meaningfully explore strategy variants? Consider exposing more parameters once
   the initial tool is stable.
