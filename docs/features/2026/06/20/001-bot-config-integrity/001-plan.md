# Bot Config Integrity

Completes the remaining work from the `001-automation-agents` feature and fixes
the cascading runtime failures revealed by the first agent evaluation.

**Backward compatibility is not a constraint.** Break existing field names, API shapes,
or DB columns freely if the new design is correct.

Phases 1–6 of `001-automation-agents` are complete (indicators, scan engine,
technical runtime, executor extraction, LLM enrichment, self-config tool). What
remains is the config layer between agent tools and the bot runtime: the schema is
poorly defined, the tools never validate it, and agents receive misleading feedback
that leads them to submit bots with config that explodes on start.

---

## Background

Agent `fcd90dea` created 15 bots that all crashed immediately with:

```
"strategy: Expected object, received string; venue: Required"   (first pass)
"strategy: Required; venue: Required"                            (second pass)
```

Four compounding causes:
1. `create_bot` accepts `config: z.object({}).passthrough()` — anything goes, nothing validated
2. `list_bots` / `get_bot_status` return `strategyPreset` read from raw JSONB — agent learns wrong field
3. `venue` is required in `BotConfigSchema` but no tool injects or explains it
4. `BotConfigSchema.strategy.type` conflates trading style (`momentum`) with decision engine (`llm`, `hybrid`, `mechanical`)

Additionally, `IntelligenceConfigSchema` in `UnifiedAgentConfig` is still typed as
`z.record(z.unknown())` (Phase 5 placeholder) — blocking future intelligence config
reads. And the analytics `decisionModes` filter is misnamed — it actually filters
by `execution.mode` (`paper|shadow|live`), not by decision framework type.

---

## Scope

### In Scope

1. **`BotConfigSchema` redesign** — split `strategy.type` (trading style) from
   `strategy.decisionMode` (decision engine); `type` becomes the trading style
   (`momentum|range|contrarian|swing|scalper|dca`), `decisionMode` becomes the engine
   (`mechanical|llm|hybrid`)
2. **`blueprints.strategyPreset` removal** — drop the redundant DB column; derive the
   display label from `configData.strategy.type` at read time
3. **`IntelligenceConfigSchema` typing** — replace `z.record(z.unknown())` with proper
   typed schema
4. **`create_bot` / `adjust_bot_config` validation** — validate against `BotConfigSchema`
   at tool call time; return detailed field-level errors; never pass invalid config to DB
5. **`strategyPreset` normalization in bot tools** — derive from `strategy.type`, not
   read from raw JSONB; remove all writes of `strategyPreset` into bot config JSONB
6. **Venue stamping** — `venue` and `venueType` are never supplied by the agent;
   always resolved from the trading binding and stamped unconditionally before
   validation; removed from the agent-facing tool schema
7. **Analytics fix** — `decisionModes` name was correct (filter by `strategy.decisionMode`);
   fix the implementation which currently filters by `execution.mode` instead;
   add a separate `executionModes` param for paper/shadow/live filtering

### Out of Scope

- `check_regime` 400 bug (HYPE not on Binance)
- `submit_decision` circuit breaker fix
- `MomentumStrategy` class deletion / subsumption into `MechanicalStrategy` (separate refactor)
- Bot management skill description update (follow-on once field names are stable)

---

## Step 1 — `BotConfigSchema` redesign: `strategy.type` + `strategy.decisionMode`
**File:** `packages/domain/src/config/schema.ts`

The current `StrategyConfigSchema` is a discriminated union on `type` with values
`momentum|llm|mechanical|hybrid`. This conflates two orthogonal concepts:

- **Trading style** (`type`): *what market logic* — momentum, range, contrarian, swing, scalper, dca
- **Decision engine** (`decisionMode`): *how decisions are made* — mechanical (indicators only), llm, hybrid

Split them. The new `strategy` object:

```typescript
export const StrategySchema = z.object({
  type: z.enum(['momentum', 'range', 'contrarian', 'swing', 'scalper', 'dca']),
  decisionMode: z.enum(['mechanical', 'llm', 'hybrid']).optional(),
  params: z.record(z.unknown()).optional(),
}).refine(
  (s) => s.type === 'dca' || s.decisionMode !== undefined,
  { message: 'decisionMode is required for non-DCA strategies', path: ['decisionMode'] },
);

export const BotConfigSchema = z.object({
  strategy: StrategySchema,
  // ... rest unchanged
});
```

`decisionMode` is **optional for `dca`** (timer-driven, no signal evaluation) and
**required for all other types**. The refinement enforces this. The `createStrategy()`
factory checks `type === 'dca'` first and routes to the DCA executor without ever
reading `decisionMode`. For all other types, `decisionMode` selects the engine.

`params` carries the trading style tuning (indicator thresholds, candle interval,
position size, etc.) as well as LLM config when `decisionMode` is `llm` or `hybrid`.
Full per-style params typing can be added incrementally — start with
`z.record(z.unknown())` to unblock the rename, harden later.

### Checklist

- [ ] Replace `StrategyConfigSchema` (discriminated union) with flat `StrategySchema`
  (`type` + `decisionMode` + `params`)
- [ ] Export `StrategyConfig` type from the new schema
- [ ] Remove `LlmParamsSchema`, `HybridParamsSchema` from `BotConfigSchema` (they are
  now folded into `params` — LLM config lives in `params` when `decisionMode = 'llm'`)
- [ ] Keep `MomentumParamsSchema` and `MechanicalParamsSchema` — they remain valid
  `params` shapes for `type = 'momentum'` and `type = 'mechanical'` respectively
- [ ] Update `createStrategy()` in `apps/worker/src/index.ts` — check `type === 'dca'`
  first and route to DCA executor (no `decisionMode` read); for all other types, key on
  `config.strategy.decisionMode` to select engine: `mechanical` → `MechanicalStrategy`,
  `llm` → `LlmStrategy`, `hybrid` → `HybridStrategy`.
  **Exception:** when `type = 'momentum'` AND `decisionMode = 'mechanical'`, continue
  routing to `MomentumStrategy` for now (see deprecation step below).
- [ ] Update `apps/worker/src/backtest-runtime.ts` — use `decisionMode` not `strategyType`
- [ ] Update `packages/backtesting/src/replay-runner.ts` — same
- [ ] Update `apps/api/src/routes/blueprints.ts` PRESETS — add `decisionMode: 'mechanical'`
  to each preset's `configData.strategy`; `type` values (`dca`, `range`, etc.) are now valid
- [ ] Update `apps/api/src/routes/bots.ts` — reads `config['execution']?.['mode']` for live
  gate; also update any `strategy.type` reads to use new shape
- [ ] Update `apps/api/src/routes/bots.test.ts` fixtures
- [ ] Update `apps/api/src/routes/backtests.test.ts` fixtures
- [ ] `pnpm lint` passes

---

## Step 1b — Deprecate `MomentumStrategy`
**File:** `packages/strategy/src/momentum.ts`

`MomentumStrategy` compares the current price to a simple moving average. This is a
subset of what `MechanicalStrategy` already does with richer, higher-confidence signals
(RSI, MACD, volume). The two overlap enough that `MomentumStrategy` should not exist
long-term as a separate engine.

This step marks it as deprecated without changing any runtime behaviour. Removal is
tracked in `docs/features/2026/06/20/002-mechanical-strategy-unification/001-plan.md`.

### Checklist

- [ ] Add a deprecation comment block to `packages/strategy/src/momentum.ts`:
  ```
  /**
   * @deprecated Use MechanicalStrategy with signalBias='trend-following' instead.
   * MomentumStrategy is retained temporarily while MechanicalStrategy is verified
   * to fully cover momentum trading use cases.
   * Removal tracked in docs/features/2026/06/20/002-mechanical-strategy-unification/001-plan.md
   */
  ```
- [ ] No code changes — runtime behaviour unchanged
- [ ] `pnpm lint` passes

---

## Step 1c — Remove `blueprints.strategyPreset` column
**Files:** `packages/db/src/schema/blueprints.ts`, `apps/api/src/routes/blueprints.ts`,
migration

`blueprints.strategyPreset` is a text column storing the preset name (e.g. `'momentum'`).
This is a redundant copy of `configData.strategy.type` and will drift if the configData
is updated independently. Drop the column and derive the label at read time.

### Checklist

- [ ] Remove `strategyPreset` column from `blueprints` table schema (`blueprints.ts`)
- [ ] Generate migration: `pnpm --filter @herobids/db run generate`
- [ ] Update blueprint API routes: replace `b.strategyPreset` reads with
  `(b.configData?.strategy as any)?.type ?? null`
- [ ] Update `CreateBlueprintSchema` and `UpdateBlueprintSchema` — remove `strategyPreset`
  input field
- [ ] Update blueprint list/get responses — derive `strategyType` display field from
  `configData.strategy.type` instead
- [ ] `pnpm lint` passes

---

## Step 2 — `IntelligenceConfigSchema` typing
**File:** `packages/domain/src/config/schema.ts`

Replace the Phase 5 placeholder with the schema originally specified in
`docs/features/2026/06/16/001-automation-agents/001-automation-agents.md`.

```typescript
export const IntelligenceConfigSchema = z.object({
  provider: z.string().optional(),
  lightModel: z.string().optional(),
  heavyModel: z.string().optional(),
  maxTokens: z.number().int().min(1).optional(),
  wakeIntervalMs: z.number().int().min(10_000).optional(),
});
```

Note: `goal` / `prompt` is stored on the top-level `agents.prompt` column, not
inside `unifiedConfig.intelligence`. The schema here captures the LLM model config
that an agent might self-update via `update_own_config`.

### Checklist

- [ ] Define `IntelligenceConfigSchema` (typed, not `z.record(z.unknown())`)
- [ ] Replace placeholder in `UnifiedAgentConfigSchema.intelligence`
- [ ] Export `IntelligenceConfig` type
- [ ] Update `update_own_config` tool to accept `intelligence` updates (currently only
  `technical`, `execution`, `risk` are accepted — add `intelligence` section for
  model config changes if needed)
- [ ] `pnpm lint` passes

---

## Step 3 — Venue stamping from binding (agent never provides venue)
**Files:** `apps/worker/src/agents/agent-message-broker.ts`,
`packages/domain/src/config/schema.ts`, `apps/worker/src/tools/bots.ts`

`venue` and `venueType` are not creator-supplied fields — they are always resolved
from the agent's trading binding. An agent does not have the information to choose
a venue independently; its binding already fixes the venue account. Allowing the
agent to supply `venue` in config creates a mismatch risk: the agent could specify
a venue it has no access to.

### Design

- `venue` and `venueType` are **optional** in `BotConfigSchema` (creators do not
  supply them).
- The broker **always stamps** them from the resolved binding before validation,
  unconditionally overwriting any value the agent may have included.
- If the binding's venue account cannot be resolved, the broker returns a clear
  error and does not write to the DB.
- The `venueAccountId` parameter on `create_bot` is the correct lever for an agent
  with multiple bindings — it selects which binding to use; `venue` is then derived
  from that binding.
- `venue` and `venueType` must be **absent** from the agent-facing `BotConfigInputSchema`
  in `bots.ts` so the LLM is never prompted to fill them.

```typescript
// In agent-message-broker.ts create_and_start handler:
const venueAccount = await resolveVenueAccount(binding.sourceVenueAccountId);
if (!venueAccount) {
  return toolError('Cannot resolve venue account from trading binding');
}
// Stamp unconditionally — agent-provided values are discarded
rawConfig.venue = venueAccount.venue;
rawConfig.venueType = venueAccount.venueType;
// Now run BotConfigSchema.safeParse(rawConfig)
```

### Checklist

- [ ] Make `venue` and `venueType` optional in `BotConfigSchema`
  (`packages/domain/src/config/schema.ts`)
- [ ] In `agent-message-broker.ts` `create_and_start` handler, load the venue
  account for `binding.sourceVenueAccountId` and stamp `venue`/`venueType`
  unconditionally before validation
- [ ] Fail with a clear error if the venue account cannot be resolved
- [ ] Remove `venue` and `venueType` from the agent-facing `BotConfigInputSchema`
  in `bots.ts` (Step 4a) so the LLM is not prompted to fill them
- [ ] Add a unit test: `venue` absent from input → stamped from binding
- [ ] Add a unit test: `venue` present in agent input → replaced by binding value

---

## Step 4 — Bot config validation at tool call time
**Files:** `apps/worker/src/tools/bots.ts`, `apps/worker/src/agents/agent-message-broker.ts`

**Rule:** A tool must not return `success: true` when the config is invalid.
**Rule:** If the agent enters wrong fields, do not silently correct — return useful
errors that name both unknown fields and missing required fields.

### 4a — `create_bot` tool schema

Replace `config: z.object({}).passthrough()` with a typed schema that matches what
`BotConfigSchema` expects, so the LLM gets structured guidance and errors are caught
before the message hits the broker.

Use a **discriminated union** on `strategy.type` so the agent sees two unambiguous
shapes — one for DCA (no `decisionMode`), one for all signal-based types (`decisionMode`
required). This avoids the agent needing to reason about when to omit a field.

```typescript
// Agent-facing schema — discriminated union on strategy type:
const StrategyInputSchema = z.discriminatedUnion('type', [
  // DCA: timer-driven, no decision mode
  z.object({
    type: z.literal('dca'),
    params: z.record(z.unknown()).optional(),
  }).describe('Dollar-cost averaging — buys on a fixed schedule, no signal required'),

  // Signal-based: decisionMode selects the engine
  z.object({
    type: z.enum(['momentum', 'range', 'contrarian', 'swing', 'scalper']),
    decisionMode: z.enum(['mechanical', 'llm', 'hybrid'])
      .default('mechanical')
      .describe('mechanical = indicator rules; llm = LLM decides; hybrid = indicators pre-filter then LLM'),
    params: z.record(z.unknown()).optional(),
  }),
]);

const BotConfigInputSchema = z.object({
  symbol: z.string().describe('Trading symbol, e.g. "HYPE-USDT"'),
  strategy: StrategyInputSchema,
  execution: z.object({
    mode: z.enum(['paper', 'shadow', 'live']).optional(),
    slippageBps: z.number().optional(),
  }).optional(),
  risk: z.record(z.unknown()).optional(),
  venueType: z.enum(['orderbook', 'swap']).optional(),
  // venue is omitted — injected from the binding (Step 3)
});
```

The internal `BotConfigSchema` (`packages/domain`) keeps the refined flat object (single
source of truth for validation). `BotConfigInputSchema` is only the agent-facing surface
in `bots.ts` — it converts to the internal shape before broker validation.

### 4b — Full validation in the broker before DB write

In `agent-message-broker.ts`, after venue injection (Step 3), validate the full
config against `BotConfigSchema`:

```typescript
const validation = BotConfigSchema.safeParse(effectiveConfig);
if (!validation.success) {
  // Build a useful error listing:
  // - Fields that are required but missing
  // - Fields that don't match any known field (potential typos)
  const issues = validation.error.issues.map(i =>
    `${i.path.join('.') || 'root'}: ${i.message}`
  ).join('; ');
  throw new Error(`Bot config is invalid: ${issues}`);
}
// Only store validated config
const botId = await this.botRepo.createBot({
  ...
  config: validation.data,
});
```

The error propagates back through the broker → tool call → agent sees a `fault: false`
tool failure with the validation message.

### 4c — `adjust_bot_config` tool schema

Same treatment: `config: z.object({}).passthrough()` → typed partial input.
Validate merged result against `BotConfigSchema` before persisting.

### Checklist

- [ ] `create_bot` tool: replace `passthrough()` schema with typed `BotConfigInputSchema`
- [ ] `create_bot` tool: update `description` to reflect actual required/optional fields
- [ ] Broker `create_and_start`: after venue injection, run `BotConfigSchema.safeParse()`
- [ ] Broker `create_and_start`: on failure, throw with field-level error message
- [ ] `adjust_bot_config` tool: replace `passthrough()` schema with typed partial input
- [ ] Broker `update` handler: validate merged config before persisting
- [ ] Tests: invalid `strategy` type → error names the field
- [ ] Tests: missing `symbol` → error names the field
- [ ] Tests: unrecognized field (e.g. `strategyPreset` at root) → error notes unknown field
- [ ] Tests: valid config → creates bot
- [ ] `pnpm lint` passes

---

## Step 5 — `strategyPreset` normalization
**Files:** `apps/worker/src/tools/bots.ts`, `apps/worker/src/agents/agent-message-broker.ts`,
`apps/worker/src/runtime-composition.ts`

`strategyPreset` is a **display/UI concept** only. It must never be stored in bot
config JSONB, and must never be read from bot config JSONB as if it is a real field.

The display value shown to the agent should be **derived from `strategy.type`** using
a deterministic mapping:

```typescript
function deriveStrategyPreset(strategyType: string | undefined): string | null {
  if (!strategyType) return null;
  // Direct 1:1 for now; later presets will map to mechanical with specific params
  const PRESET_MAP: Record<string, string> = {
    momentum: 'momentum',
    mechanical: 'mechanical',
  };
  return PRESET_MAP[strategyType] ?? strategyType;
}
```

### Checklist

- [ ] `list_bots` tool (`bots.ts` line 69): replace `b.config['strategyPreset'] ?? null`
  with `deriveStrategyPreset((b.config['strategy'] as any)?.type ?? undefined)`
- [ ] `get_bot_status` tool (`bots.ts` line 108): same replacement
- [ ] `agent-message-broker.ts` line 624: replace `config?.['strategyPreset']` with
  `(config?.['strategy'] as any)?.type`
- [ ] `agent-message-broker.ts` line 684: same
- [ ] `agent-message-broker.ts` line 779: same
- [ ] `runtime-composition.ts` line 1446: reads `bot['strategyPreset']` from the broker
  payload — fix the upstream source (lines 624/684/779 above); this line then reads a
  value that is now correctly derived, not a JSONB raw field
- [ ] `runtime-composition.ts` line 987: `bot.strategyPreset` in the managed-bots prompt
  block — continues to work once source is fixed upstream
- [ ] `packages/domain/src/agent-protocol.ts` line 258: `strategyPreset: z.string().optional()`
  in `InstanceStatusPayloadSchema` — keep the field (agents see it as display info) but
  add a JSDoc noting it is derived from `strategy.type`, not stored in JSONB
- [ ] If the agent sends `strategyPreset` as a root field in bot config, the broker
  should log a warning and strip it (not silently store it) — the validation in Step 4
  will reject it; ensure the error message is informative
- [ ] Tests: `list_bots` returns `strategyPreset` derived from `strategy.type`
- [ ] Tests: bot with no `strategy.type` returns `strategyPreset: null`
- [ ] `pnpm lint` passes

---

## Step 6 — Analytics `decisionModes` fix + add `executionModes`
**Files:** `apps/api/src/routes/analytics.ts`, `apps/api/src/routes/analytics.test.ts`,
`apps/web/src/lib/api-client.ts` (if the filter is exposed in the web client)

`decisionModes` was the **correct name** — in aitradingbot (the reference implementation),
`decisionModes` filters by `strategyKind` which is equivalent to `strategy.decisionMode`
(`mechanical|llm|hybrid`). The herobids implementation has a bug: the param is named
`decisionModes` but the code filters by `b.executionMode` (paper/shadow/live) instead.

Fix:
1. Keep `decisionModes` — fix the filter to use `strategy.decisionMode` from the bot's stored config
2. Add a new `executionModes` param for paper/shadow/live filtering (what the current broken code was attempting)

```typescript
// Fix decisionModes — filter by strategy.decisionMode (mechanical|llm|hybrid)
if (query.decisionModes && query.decisionModes.length > 0) {
  const modeSet = new Set(query.decisionModes);
  targetMeta = targetMeta.filter((b) =>
    modeSet.has((b.config?.strategy as any)?.decisionMode ?? null)
  );
}

// New executionModes — filter by execution.mode (paper|shadow|live)
if (query.executionModes && query.executionModes.length > 0) {
  const modeSet = new Set(query.executionModes);
  targetMeta = targetMeta.filter((b) => b.executionMode !== null && modeSet.has(b.executionMode));
}
```

### Checklist

- [ ] Fix `decisionModes` filter in `computeAnalytics()` to read `strategy.decisionMode`
  from bot config JSONB instead of `b.executionMode`
- [ ] Add `executionModes` param to `AnalyticsQuerySchema` and `AnalyticsBodySchema`
- [ ] Add `executionModes` filter block in `computeAnalytics()` (paper/shadow/live)
- [ ] Update `analytics.test.ts` — add tests for both filters
- [ ] Check web client (`api-client.ts`) for any analytics query usage
- [ ] `pnpm lint` passes

---

## Order of Execution

Steps have some dependencies:

```
Step 1 (schema redesign: type + decisionMode)
  └── Step 1b (drop blueprints.strategyPreset) — depends on type being the source of truth
        └── Step 4 (validation) — depends on schema being stable
              └── Step 3 (venue injection) — feeds into validation
                    └── Step 5 (strategyPreset in bot tools) — depends on strategy.type being valid
Step 2 (intelligence schema) — independent, can be done any time
Step 6 (analytics fix) — independent, can be done any time
```

Recommended order: **1 → 1b → 3 → 4 → 5 → 2 → 6**

---

## Definition of Done

- [ ] An agent that sends `strategy: "momentum"` (string) gets a clear error:
  `"strategy: Expected object with type and params, received string"`
- [ ] An agent that sends `strategyPreset: "momentum"` (root field) gets:
  `"strategyPreset: Unrecognized key; strategy: Required"`
- [ ] An agent that sends `strategy: { type: 'momentum', decisionMode: 'mechanical', params: {...} }`
  (no `venue`) gets the bot created successfully with `venue` injected from binding
- [ ] An agent that sends `strategy: { type: 'momentum', decisionMode: 'llm', params: {...} }`
  creates a bot that uses `LlmStrategy`
- [ ] `list_bots` returns `strategyType: 'momentum'` derived from `strategy.type`, not
  from raw JSONB
- [ ] `blueprints.strategyPreset` column no longer exists in the DB schema
- [ ] Blueprint list/get API returns `strategyType` derived from `configData.strategy.type`
- [ ] All 6 blueprint presets have `strategy.decisionMode: 'mechanical'` in their `configData`
- [ ] `UnifiedAgentConfigSchema.intelligence` has a typed schema (not `z.record(z.unknown())`)
- [ ] `GET /analytics?executionModes=shadow` works; `GET /analytics?decisionModes=shadow` returns 400
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

---

## Verification

Two layers are required: unit/integration tests (fast, in CI) and an E2E update to
the agent trade test (proves the agent's actual experience is correct).

### Unit / integration tests (in vitest)

Already covered by checklists in each step. Key cases:

- Schema rejects `strategy: "momentum"` (string) with field-level error
- Schema rejects `strategyPreset` at root with "unrecognized key" error
- Venue stamping: agent-provided `venue` is replaced by binding value
- `deriveStrategyPreset()` returns correct value for each `strategy.type`
- `decisionModes` analytics filter reads `strategy.decisionMode`, not `executionMode`
- `executionModes` analytics filter reads `execution.mode`

### E2E — update `scripts/ts/agent-trade-test.ts`

The current test explicitly tells the agent **not** to create bots (line 334). That
must change: bot creation is the primary failure mode this plan fixes, so E2E
coverage is non-negotiable.

**Changes to `agent-trade-test.ts`:**

1. **Remove the "do not create a bot" instruction** from the agent goal/prompt.

2. **Allow and expect bot creation** — update the goal to include a bot creation task,
   e.g. create a paper-mode momentum bot on the test instrument.

3. **Add assertion: bot appears in `list_bots` with correct fields**
   After the agent has had sufficient ticks to act, call `GET /bots` (or use the
   existing `checkBotActivity` helper) and assert:
   - At least one bot exists with `strategy.type` set (not `strategyPreset` at root)
   - `strategy.decisionMode` is present and valid (or absent for `type: 'dca'`)
   - `execution.mode` matches the test's `EXECUTION_MODE`
   - No bot in `status: 'crashed'` with a config-related error

4. **Add negative assertion (optional but recommended):**
   Before the agent run, attempt a direct `POST /bots` API call with a deliberately
   bad config (e.g. `strategy: "momentum"` as a string). Assert the API returns a
   400 with a field-level error message containing `"strategy"`.

**Update `scripts/shell/tests/agent-trade-test.sh`** — no structural changes needed;
the shell wrapper just drives the TS script. Add a note in the header that bot
creation is now part of the test scenario.

### Checklist

- [ ] Remove "do not create a bot" instruction from agent goal in `agent-trade-test.ts`
- [ ] Add bot creation to the agent's goal/prompt
- [ ] Add post-run assertion: bot exists with valid `strategy.type` + `decisionMode`
- [ ] Add post-run assertion: no bot in `status: 'crashed'`
- [ ] (Optional) Add pre-run negative assertion: bad config → 400 with field-level error
- [ ] Run `agent-trade-test.sh` and confirm clean pass
