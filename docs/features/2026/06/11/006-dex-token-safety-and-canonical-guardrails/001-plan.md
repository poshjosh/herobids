# 006 - DEX Token Safety and Canonical Asset Guardrails

Rebuild the old repo's token-safety behavior in HeroBids without collapsing
search, discovery, and execution policy into one thin helper. The result should
be one shared token-policy surface for discovery and agent context, plus one
hard pre-execution guard for swap venues, both wired through HeroBids' existing
ports-and-adapters architecture.

**Depends on:** 023 token search and market regime.
**Blocks:** future agent-selected token-address swap flow for Jupiter and 1inch.
**Task list:** [tasks/001-dex-token-safety-and-canonical-guardrails-tasks.md](./tasks/001-dex-token-safety-and-canonical-guardrails-tasks.md)

---

## Background

The old repo had four behaviors that materially reduced bad DEX selections:

- explicit token-safety gates
- canonical token promotion for well-known symbols
- age, liquidity, and volume checks
- a one-time force-override flow

HeroBids currently has the primitives for most of this, but not the policy
layer:

- raw DexScreener search in `packages/market-data/src/dexscreener.ts`
- thin filtering in `packages/market-data/src/token-search.ts`
- richer discovery and enrichment data in `packages/market-data/src/discovery.ts`
- duplicated ad hoc search filtering in `apps/worker/src/tools/market-data.ts`
  and `apps/worker/src/agent.ts`
- brokered trade intent submission in `apps/worker/src/tools/trading.ts`
  and `apps/worker/src/agents/agent-decision-handler.ts`
- shared execution pipeline in `packages/engine/src/decision-intake.ts`
  and `packages/engine/src/trading-cycle.ts`

There is also one current correctness issue that should be fixed in this slice:
DEX discovery metadata is attached to the selected token by `network:symbol`
matching in `apps/worker/src/venue-intelligence.ts` and `apps/worker/src/agent.ts`.
That is not strong enough for same-symbol fakes on the same chain. The join key
must be `network:address`.

---

## Goal

Add a concrete, reusable token-policy system with these properties:

1. `search_tokens` and DEX venue intelligence use one shared ranking and
   filtering policy.
2. Well-known canonical assets are promoted consistently.
3. Search results carry structured safety metadata, not only silent filtering.
4. Swap execution is blocked by a hard token-safety guard before any order can
   execute.
5. Overrides are explicit, one-time, time-bound, persisted, and auditable.
6. Operator defaults and per-instance overrides stay in the correct config
   layers.

---

## Non-Goals

- This slice does **not** add fully dynamic agent-selected token-address trading
  across arbitrary mints. Bots still trade the assets configured in
  `swapAssets`.
- This slice does **not** redesign the whole agent tool model away from
  `submit_decision`.
- This slice does **not** add holder-analysis, contract-audit, or honeypot APIs.
  The safety gate is based on liquidity, volume, age, canonical identity, and
  existing enrichment fields.
- This slice does **not** move operator policy into environment variables.

---

## Design Principles

### One policy owner

Search ranking and search-time safety evaluation should live in one shared
market-data module. Worker call sites should stop reimplementing filtering.

### Hard gate separate from read-only search

Search may explain or suppress candidates, but swap execution must re-check the
selected asset using fresh policy evaluation. Search is advisory. Execution is
authoritative.

### Ports and adapters only

`packages/engine` must not import `@herobids/market-data` directly. The hard
gate must be exposed as a domain port and injected into the shared execution
pipeline by the worker.

### Address identity beats symbol identity

Any enrichment or canonical decision that can collide on symbol must key by
`network:address`, not by symbol.

### Operator minima, instance tightening

Operator config defines defaults and hard floors. Instance config may tighten
them, but must not silently relax below operator minima.

---

## Proposed Architecture

### 1. Shared market-data token policy module

Add a new module in `packages/market-data/src/token-safety.ts` that owns:

- canonical token registry lookup
- search candidate normalization
- safety scoring and blocked-reason generation
- canonical promotion and result ordering
- dead-pool detection
- search-time suppression vs explicit blocked-result return

`token-search.ts` becomes a thin orchestration wrapper around this policy
module instead of owning its own duplicate filtering rules.

### 2. Domain port for swap token safety

Add a new domain port in `packages/domain/src/ports/token-safety.ts`.

The engine consumes only the port interface and result types. The worker wires a
market-data-backed adapter into the port.

### 3. Persisted override store

Replace the old in-memory force code with a persisted one-time override record.

Overrides should be:

- scoped to actor, bot, venue account, network, and token address
- issued only when a safety rejection occurs and operator policy allows it
- time-bound
- one-time use
- auditable after consumption or expiry

### 4. Decision-pipeline guard

Add a new pre-execution guard step in `packages/engine/src/decision-intake.ts`.

For `venueType !== 'swap'`, it is a no-op.

For `venueType === 'swap'`, it evaluates the selected swap target before risk
check and execution. That keeps the guard on the single path shared by agent
submissions and strategy-driven trading cycles.

---

## Proposed Types

### Market-data types

Add to `packages/market-data/src/types.ts`:

```ts
export type TokenSafetyReasonCode =
  | 'token.low_liquidity'
  | 'token.low_volume'
  | 'token.too_new'
  | 'token.dead_pool'
  | 'token.non_canonical'
  | 'token.high_risk'
  | 'token.network_mismatch'
  | 'token.identity_ambiguous';

export interface TokenSafetyReason {
  code: TokenSafetyReasonCode;
  message: string;
  actual?: number | string;
  threshold?: number | string;
}

export interface CanonicalTokenDefinition {
  symbol: string;
  network: string;
  address: string;
  name: string;
  aliases?: string[];
}

export interface TokenSafetySummary {
  eligible: boolean;
  score: number;
  canonical: boolean;
  canonicalSymbol?: string;
  ageHours?: number;
  blockedReasons: TokenSafetyReason[];
  warnings: TokenSafetyReason[];
}

export interface TokenSearchCandidate extends TokenInfo {
  poolCreatedAt?: string;
  marketCapUsd?: number;
  fullyDilutedValuationUsd?: number;
  holderCount?: number;
  cexListings?: number;
  riskLevel?: 'low' | 'medium' | 'high';
  discoveryVectors?: string[];
  safety: TokenSafetySummary;
}

export interface TokenSearchPolicyOptions {
  network?: string;
  limit?: number;
  includeBlocked?: boolean;
  minLiquidityUsd?: number;
  minVolume24hUsd?: number;
  minTokenAgeHours?: number;
  preferCanonical?: boolean;
}
```

### Domain port types

Add new file `packages/domain/src/ports/token-safety.ts`:

```ts
import type { Result } from '../result.js';

export interface SwapTokenSafetyCheckRequest {
  actorType: string;
  actorId: string;
  botId?: string;
  venue: string;
  venueAccountId: string;
  network: string;
  tokenAddress: string;
  tokenSymbol?: string;
  swapSide: 'buy' | 'sell';
  estimatedOrderNotionalUsd?: string;
  overrideId?: string;
}

export interface SwapTokenSafetyApproval {
  tokenAddress: string;
  tokenSymbol?: string;
  overridden: boolean;
  liquidityUsd?: number;
  volume24hUsd?: number;
  ageHours?: number;
}

export interface SwapTokenSafetyOverrideTicket {
  id: string;
  expiresAt: string;
  tokenAddress: string;
  network: string;
  reasonCodes: string[];
}

export interface SwapTokenSafetyRejection {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  overrideTicket?: SwapTokenSafetyOverrideTicket;
}

export interface SwapTokenSafetyPort {
  checkSwapTarget(
    request: SwapTokenSafetyCheckRequest,
  ): Promise<Result<SwapTokenSafetyApproval, SwapTokenSafetyRejection>>;
}
```

Export it from:

- `packages/domain/src/ports/index.ts`
- `packages/domain/src/index.ts`

### Engine result type changes

Extend `packages/engine/src/decision-intake.ts` result shape so pre-execution
guard failures are first-class:

```ts
export interface PreExecutionRejection {
  scope: 'risk_gate' | 'swap_token_safety';
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface DecisionIntakeResult {
  decision: Decision;
  plan?: ExecutionPlan;
  riskRejected: boolean;
  executionResult?: ExecutionResult;
  position: PositionState;
  executionFailed: boolean;
  preExecutionRejection?: PreExecutionRejection;
}
```

Do not model token-safety rejection as `executionFailed`. It is a guardrail
rejection before execution starts.

---

## Config Schema

### Operator config

Add a new nested section under `marketData` in `packages/domain/src/config/schema.ts`.

```ts
export const CanonicalTokenEntrySchema = z.object({
  address: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
});

export const TokenSafetyDefaultsSchema = z.object({
  minLiquidityUsd: z.number().min(0).default(10_000),
  minVolume24hUsd: z.number().min(0).default(25_000),
  minTokenAgeHours: z.number().min(0).default(24),
  deadPoolMinAgeHours: z.number().min(1).default(24 * 30),
  deadPoolMaxVolume24hUsd: z.number().min(0).default(1_000),
  preferCanonical: z.boolean().default(true),
  requireCanonicalForKnownSymbols: z.boolean().default(true),
  includeBlockedSearchResults: z.boolean().default(false),
});

export const TokenSafetyTradeGuardSchema = z.object({
  enabled: z.boolean().default(true),
  liquidityMultiplier: z.number().min(1).default(200),
  allowOverrides: z.boolean().default(true),
  overrideTtlMs: z.number().int().min(60_000).default(300_000),
});

export const TokenSafetyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaults: TokenSafetyDefaultsSchema.default({}),
  tradeGuard: TokenSafetyTradeGuardSchema.default({}),
  canonicalTokens: z.record(
    z.string(),
    z.record(z.string(), CanonicalTokenEntrySchema),
  ).default({}),
});
```

Insert it into `MarketDataConfigSchema` as:

```ts
tokenSafety: TokenSafetyConfigSchema.default({}),
```

Add matching defaults to `config/default.yaml`:

```yaml
marketData:
  tokenSafety:
    enabled: true
    defaults:
      minLiquidityUsd: 10000
      minVolume24hUsd: 25000
      minTokenAgeHours: 24
      deadPoolMinAgeHours: 720
      deadPoolMaxVolume24hUsd: 1000
      preferCanonical: true
      requireCanonicalForKnownSymbols: true
      includeBlockedSearchResults: false
    tradeGuard:
      enabled: true
      liquidityMultiplier: 200
      allowOverrides: true
      overrideTtlMs: 300000
    canonicalTokens:
      solana:
        SOL:
          address: So11111111111111111111111111111111111111112
          name: Wrapped SOL
          aliases: [WSOL]
        USDC:
          address: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
          name: USD Coin
      base:
        WETH:
          address: 0x4200000000000000000000000000000000000006
          name: Wrapped Ether
          aliases: [ETH]
```

### Instance config

Extend `RiskConfigSchema` in `packages/domain/src/config/schema.ts` with swap-
specific overrides:

```ts
minSwapTokenLiquidityUsd: z.number().min(0).optional(),
minSwapTokenVolume24hUsd: z.number().min(0).optional(),
minSwapTokenAgeHours: z.number().min(0).optional(),
allowSwapTokenSafetyOverride: z.boolean().optional(),
```

Semantics:

- instance values may tighten operator defaults
- instance values must not relax below operator minima
- `allowSwapTokenSafetyOverride: false` disables override issuance for that bot
  even if operator policy allows it globally

This keeps deploy-time defaults in operator config and per-bot appetite in
instance config.

---

## Search and Ranking Rules

### Search pipeline

`packages/market-data/src/token-search.ts` should become:

1. fetch raw DexScreener search results
2. dedupe by `network:address`
3. fetch discovery context for the same networks when available
4. join enrichment by `network:address`
5. evaluate token safety and canonical identity
6. rank candidates
7. return eligible results by default, blocked results when explicitly requested

### Ranking order

Sort order should be deterministic:

1. canonical exact match for known symbols
2. eligible over blocked
3. exact symbol match over fuzzy name match
4. higher liquidity
5. higher volume
6. older pool age when otherwise tied

### Canonical behavior

If query matches a known canonical symbol on a specific network:

- promote the canonical address to the top when present
- mark non-canonical same-symbol candidates with `token.non_canonical`
- when `requireCanonicalForKnownSymbols` is true, treat same-symbol non-canonical
  candidates as blocked by default

Do not inject a synthetic canonical token when the upstream search did not
return it. Ranking only reorders actual returned candidates.

---

## Hard Swap Guard

### Guard location

The hard gate belongs in `packages/engine/src/decision-intake.ts`, but only via
the injected `SwapTokenSafetyPort`.

Guard sequence:

1. persist decision
2. persist decision context
3. create and persist plan
4. if `venueType === 'swap'`, call `swapTokenSafety.checkSwapTarget(...)`
5. on failure, mark plan failed and return `preExecutionRejection`
6. on success, continue to risk gate and execution

This preserves one shared path for:

- strategy-driven trading cycles in `packages/engine/src/trading-cycle.ts`
- agent-submitted decisions in `apps/worker/src/agents/agent-decision-handler.ts`

### Estimated notional rule

Use the old dynamic liquidity-floor idea in HeroBids-compatible form:

- start with configured `minLiquidityUsd`
- when `tradeGuard.liquidityMultiplier` is set and an order notional estimate is
  available, require at least:

$$
\text{requiredLiquidityUsd} = \max(\text{configuredMinLiquidityUsd}, \text{estimatedOrderNotionalUsd} \times \text{liquidityMultiplier})
$$

Order notional estimate should be computed as follows:

- swap buy with quote asset in stable units: use order quantity directly
- swap sell or non-stable quote: use `referenceMark.price * quantity`

If no reliable notional estimate is available, fall back to the configured floor.

### Rejection payload

A swap safety rejection should carry:

- reason codes
- rendered message
- measured liquidity, volume, age when available
- override ticket when issuance is allowed

This rejection should flow back to the agent as a `DecisionRejected` event, not
as a generic execution failure.

---

## Override Flow

### Data model

Add new DB table `token_safety_overrides` in
`packages/db/src/schema/token-safety-overrides.ts`:

```ts
export const tokenSafetyOverrides = pgTable('token_safety_overrides', {
  id: text('id').primaryKey(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  botId: text('bot_id'),
  venueAccountId: text('venue_account_id').notNull(),
  network: text('network').notNull(),
  tokenAddress: text('token_address').notNull(),
  reasonCodes: jsonb('reason_codes').$type<string[]>().notNull(),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  decisionId: text('decision_id'),
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Export it from `packages/db/src/schema/index.ts` and add a repository for:

- issue override
- fetch active override
- consume override atomically
- expire override lazily on read

### Message contract

Extend `DecisionSubmitPayloadSchema` in `packages/domain/src/agent-protocol.ts`
with:

```ts
safetyOverrideId: z.string().min(1).optional(),
```

Extend the tool schema in `apps/worker/src/tools/trading.ts` with the same
field, and forward it through `publishToInbound`.

### Consumption rules

An override is valid only when all of the following match:

- same actor
- same bot or same venue account
- same network
- same token address
- not expired
- not consumed before

Consumption must be atomic in the repository layer.

---

## Exact Insertion Points

### Market-data package

- `packages/market-data/src/types.ts`
  - add token safety reason, summary, canonical definition, and search candidate types
- `packages/market-data/src/token-safety.ts`
  - new shared evaluation and ranking module
- `packages/market-data/src/token-search.ts`
  - replace local thin filtering with shared policy orchestration
- `packages/market-data/src/provider-registry.ts`
  - add `tokens.search(...)` facade returning `TokenSearchCandidate[]`
  - optionally add `tokens.resolveSwapTarget(...)` or equivalent helper used by the worker adapter
- `packages/market-data/src/index.ts`
  - export new types and policy helpers
- `packages/market-data/src/token-search.test.ts`
  - expand tests for canonical promotion, blocked reasons, and includeBlocked behavior
- `packages/market-data/src/provider-registry.test.ts`
  - add coverage for the new `tokens.search` facade

### Domain package

- `packages/domain/src/ports/token-safety.ts`
  - new port interface and shared result types
- `packages/domain/src/ports/index.ts`
  - export the new port
- `packages/domain/src/index.ts`
  - re-export port types
- `packages/domain/src/config/schema.ts`
  - add `TokenSafetyConfigSchema` under `MarketDataConfigSchema`
  - extend `RiskConfigSchema` with swap-token safety overrides
- `packages/domain/src/agent-protocol.ts`
  - add `safetyOverrideId` to `DecisionSubmitPayloadSchema`
  - extend any rejection payload details tests as needed

### Engine package

- `packages/engine/src/decision-intake.ts`
  - add injected `swapTokenSafety?: SwapTokenSafetyPort`
  - add pre-execution guard result handling
- `packages/engine/src/trading-cycle.ts`
  - thread `swapTokenSafety` through `TradingCycleDeps`
- `packages/engine/src/journal.ts`
  - add a generic pre-execution guardrail event helper if current risk-only helper is too narrow
- `packages/engine/src/decision-intake.test.ts`
  - add swap-token rejection and override-accepted cases
- `packages/engine/src/trading-cycle.test.ts`
  - add shared-path coverage for strategy-produced swap decisions

### Worker package

- `apps/worker/src/index.ts`
  - construct the market-data-backed adapter for `SwapTokenSafetyPort`
  - construct and inject the override repository
  - pass the port into `TradingActor` deps
- `apps/worker/src/trading-actor.ts`
  - accept `swapTokenSafety` in actor deps
  - include it in `getIntakeDeps()`
  - include it when calling `runTradingCycle(...)`
- `apps/worker/src/tools/market-data.ts`
  - replace duplicated `filterSearchResults` with shared market-data policy
  - return safety metadata from `search_tokens`
- `apps/worker/src/tools/trading.ts`
  - accept `safetyOverrideId` on `submit_decision`
- `apps/worker/src/agents/agent-decision-handler.ts`
  - map `preExecutionRejection.scope === 'swap_token_safety'` to `DecisionRejected`
  - include override ticket details in rejection payload
- `apps/worker/src/venue-intelligence.ts`
  - replace symbol-key discovery map helper with address-key helper
- `apps/worker/src/agent.ts`
  - stop using local `filterSearchResults`
  - join discovery metadata to selected DEX candidates by `network:address`

### DB package

- `packages/db/src/schema/token-safety-overrides.ts`
  - new table
- `packages/db/src/schema/index.ts`
  - export new table
- `packages/db/src/token-safety-override-repository.ts`
  - new repository for issue/consume/expire
- `packages/db/src/index.ts`
  - export repository if needed
- `packages/db/drizzle/*`
  - generate migration and journal entry with `drizzle-kit generate`

### Config and docs

- `config/default.yaml`
  - add `marketData.tokenSafety`
- `docs/best-practices/configuration.md`
  - optional short note only if token-safety config introduces a non-obvious layering rule

---

## Worker Adapter Shape

Implement the concrete adapter in the worker, not in engine.

Suggested file: `apps/worker/src/token-safety-adapter.ts`

Responsibilities:

- resolve network and token identity from the bot's `swapAssets`
- fetch candidate data through the shared market-data token policy
- evaluate dynamic liquidity floor and other hard checks
- issue or consume override tickets through the repository
- return `Result<SwapTokenSafetyApproval, SwapTokenSafetyRejection>`

This keeps market-data and persistence concerns out of the engine package.

---

## Search Tool Contract

### Request

Extend `search_tokens` to support:

```ts
{
  query: string;
  network?: string;
  limit?: number;
  includeBlocked?: boolean;
  minLiquidityUsd?: number;
  minVolume24hUsd?: number;
  minTokenAgeHours?: number;
}
```

### Response

Return candidates with structured safety:

```json
{
  "ok": true,
  "tokens": [
    {
      "address": "So111...",
      "symbol": "SOL",
      "network": "solana",
      "liquidityUsd": 12000000,
      "volume24hUsd": 8300000,
      "safety": {
        "eligible": true,
        "score": 12000001,
        "canonical": true,
        "canonicalSymbol": "SOL",
        "ageHours": 5000,
        "blockedReasons": [],
        "warnings": []
      }
    }
  ]
}
```

Default behavior:

- only eligible results returned
- blocked results included only when `includeBlocked === true`

---

## Address-Join Fix

Replace this current behavior:

- build DEX discovery maps by `network:symbol`
- attach discovery context to the top token by symbol

With this behavior:

- build maps by `network:address`
- attach discovery context only when the search result address matches exactly

Exact insertion points:

- `apps/worker/src/venue-intelligence.ts`
- `apps/worker/src/agent.ts`

This fix is part of the same feature, not optional follow-up work.

---

## Implementation Plan

1. Add config and type scaffolding.
   Files: `packages/domain/src/config/schema.ts`, domain port files,
   `packages/market-data/src/types.ts`.
   Outcome: shared types and policy config exist without behavior changes.

2. Build shared token-policy evaluation in market-data.
   Files: `packages/market-data/src/token-safety.ts`,
   `packages/market-data/src/token-search.ts`,
   `packages/market-data/src/provider-registry.ts`.
   Outcome: one canonical ranking and safety-evaluation surface exists.

3. Remove duplicated worker-side search filtering and fix address joins.
   Files: `apps/worker/src/tools/market-data.ts`,
   `apps/worker/src/agent.ts`,
   `apps/worker/src/venue-intelligence.ts`.
   Outcome: all search consumers use the shared policy and attach metadata by address.

4. Add persisted override storage and worker adapter.
   Files: DB schema, repository, worker adapter, migration.
   Outcome: override issuance and consumption are durable and auditable.

5. Inject swap-token safety into the shared execution pipeline.
   Files: `apps/worker/src/index.ts`, `apps/worker/src/trading-actor.ts`,
   `packages/engine/src/decision-intake.ts`, `packages/engine/src/trading-cycle.ts`.
   Outcome: both strategy and agent swap decisions are guarded before execution.

6. Extend agent decision payloads and rejection handling.
   Files: `packages/domain/src/agent-protocol.ts`,
   `apps/worker/src/tools/trading.ts`,
   `apps/worker/src/agents/agent-decision-handler.ts`.
   Outcome: an agent can resubmit with a one-time override ticket when policy allows it.

7. Add focused tests and run validation.
   Outcome: behavior is covered and compile/type checks remain clean.

---

## Test Strategy

### Market-data tests

- canonical token promoted above non-canonical same-symbol tokens
- non-canonical same-symbol results blocked when operator policy requires canonical
- low liquidity, low volume, too-new, and dead-pool cases produce structured reasons
- `includeBlocked: true` returns blocked candidates with reasons instead of dropping them
- search results remain deduped by `network:address`

### Worker tests

- `search_tokens` returns safety metadata and no longer uses duplicated local filtering
- DEX venue intelligence attaches pool age and discovery vectors only on exact
  `network:address` match
- `submit_decision` forwards `safetyOverrideId`

### Engine tests

- swap decisions reject before execution when token safety fails
- swap decisions proceed when safety passes
- override ticket allows one retry and is consumed atomically
- orderbook venues bypass swap-token safety entirely

### DB tests

- override rows expire correctly
- consumed override cannot be reused
- override with mismatched actor or token is rejected

### Validation command

`pnpm lint`

Targeted test commands may be used during implementation, but `pnpm lint` is the
required completion gate per repo policy.

---

## Rollout Notes

1. Ship shared search policy and address-key fix first. This improves discovery
   without affecting execution decisions.
2. Ship DB-backed override storage next.
3. Ship the injected swap hard gate after override storage exists.
4. Only after that should any direct token-address trading surface be added.

---

## Exit Criteria

- `search_tokens` and DEX venue intelligence use one shared policy layer.
- Canonical assets are promoted consistently for configured symbols.
- Search results expose structured safety metadata.
- Swap decisions are blocked before execution when token safety fails.
- Override tickets are persisted, one-time, time-bound, and auditable.
- DEX discovery metadata is joined by `network:address`, not `network:symbol`.
- Focused tests and `pnpm lint` pass.# 006 - DEX Token Safety and Canonical Asset Guardrails

Rebuild the old repo's DEX token-safety behavior in HeroBids without collapsing
read-only search, market-data enrichment, and execution-time guardrails into one
ad hoc module.

This plan introduces a shared token policy layer, canonical-token promotion,
age/liquidity/volume/dead-pool gates, and a persisted one-time override flow.
It keeps HeroBids' current architecture intact by routing execution-time checks
through a domain port injected into the shared decision intake path.

**Depends on:** existing `marketData`, `search_tokens`, swap venue support, and
the shared `submitDecisionForExecution()` pipeline.

**Blocks:** future agent-selected arbitrary token-address swap trading from
`search_tokens` results.

---

## Background

The old repo had two distinct behaviors that HeroBids currently lacks:

1. Search-time token hygiene.
   It promoted canonical tokens for well-known symbols and filtered out obvious
   low-quality candidates before presenting them to agents.

2. Execution-time token safety.
   It revalidated the token before trading, rejected low-liquidity / low-volume /
   too-new / dead-pool assets, and issued a short-lived force override when the
   caller explicitly wanted to bypass the rejection.

HeroBids currently has stronger market-data primitives than the old repo,
including aggregated discovery, pool age, and CMC enrichment, but the search
policy is still thin:

- `packages/market-data/src/token-search.ts` only applies liquidity, network,
  sort, and dedupe.
- `apps/worker/src/tools/market-data.ts` duplicates that same filtering logic.
- `apps/worker/src/agent.ts` duplicates it again for DEX intelligence.
- DEX discovery enrichment is attached by `network:symbol`, which is too weak for
  same-symbol fakes on the same chain.

HeroBids also differs from the old repo operationally:

- Decisions are brokered through `submit_decision`, not a direct `buy_token`
  tool.
- The shared execution path is `submitDecisionForExecution()` in the engine.
- Engine package boundaries should not import market-data directly.
- Force overrides should be persisted and auditable, not stored only in worker
  memory.

---

## Goal

Add a HeroBids-native token safety system with three layers:

1. A single shared search/discovery policy used by all read-only token lookup
   paths.
2. A hard pre-execution guard for swap trades routed through the shared decision
   pipeline.
3. A persisted, one-time override flow for explicit bypasses.

---

## Non-Goals

- Do not add a new direct `buy_token` or `sell_token` tool in this slice.
- Do not redesign the whole agent decision contract to support arbitrary token
  address trading from `search_tokens` results.
- Do not move raw provider fetching out of `ProviderRegistry`.
- Do not introduce cross-process shared override state outside Postgres.
- Do not weaken existing operator-vs-instance config boundaries.

---

## Design Principles

### One policy surface

All search-time filtering, ranking, canonical promotion, and safety reasoning
must live in one shared policy module under `packages/market-data/src/`.
Worker code should stop duplicating thin local filters.

### Address is identity

Discovery enrichment and safety evaluation must join on `network:address`, not
`network:symbol` and not bare symbol.

### Search is advisory, execution is authoritative

`search_tokens` should surface safety metadata and default to safe results, but
swap execution must still re-check the target before any order plan is allowed
to run.

### Engine stays on ports

The engine should not import `@herobids/market-data`. Execution-time token
safety must be injected through a domain port owned by `@herobids/domain`.

### Overrides are explicit and auditable

The old repo's in-memory force code is not sufficient for HeroBids. Override
tokens must be persisted with TTL, status transitions, and actor/bot/token
scope.

### Fail loud on missing data

If token safety is enabled for a swap path and market data required for the
guard is unavailable, the system should reject the trade rather than silently
degrade.

---

## Proposed Architecture

### 1. Shared token policy module in `@herobids/market-data`

Add a new policy module:

```text
packages/market-data/src/
  token-safety.ts        # shared policy evaluation + canonical promotion
```

This module owns:

- canonical token lookup and promotion
- network/address identity matching
- search-time filtering and ranking
- computation of blocked reasons and warnings
- dynamic execution-time gates for swap trades

It does not own DB persistence and it does not own agent message handling.

### 2. Address-based enrichment map

Replace symbol-based enrichment joins with address-based joins in worker DEX
intelligence code.

Current weak behavior:

- `apps/worker/src/venue-intelligence.ts` builds `network:symbol` maps
- `apps/worker/src/agent.ts` attaches discovery metadata to the top search hit
  using `network:symbol`

Required behavior:

- build `network:address` maps for discovered tokens
- only attach discovery metadata to the exact token address returned by search

### 3. Execution-time guard via domain port

Introduce a new domain port:

```text
packages/domain/src/ports/token-safety.ts
```

The engine will call this port from `submitDecisionForExecution()` when:

- `venueType === 'swap'`, and
- the plan contains an order that increases exposure to the base asset
  (practically: swap `buy` orders)

This keeps the check on the shared path used by both strategy-driven and
agent-driven decisions without violating package boundaries.

### 4. Persisted override flow

Add a DB-backed one-time override table and repository so rejected swap-token
decisions can be retried with an explicit override ID.

The override should be:

- scoped to `network + tokenAddress`
- optionally scoped to `botId` and `venueAccountId`
- short-lived
- one-time use
- auditable after consumption / expiry

---

## Proposed Types

### Market-data search policy types

Add to `packages/market-data/src/types.ts`:

```ts
export type TokenSafetyReasonCode =
  | 'token.low_liquidity'
  | 'token.low_volume'
  | 'token.too_new'
  | 'token.dead_pool'
  | 'token.high_risk'
  | 'token.identity_ambiguous'
  | 'token.non_canonical_symbol'
  | 'token.data_unavailable';

export interface TokenSafetyReason {
  code: TokenSafetyReasonCode;
  message: string;
  actual?: number | string;
  threshold?: number | string;
}

export interface CanonicalTokenDefinition {
  address: string;
  name: string;
  aliases?: string[];
}

export interface TokenSafetySummary {
  eligible: boolean;
  canonical: boolean;
  canonicalSymbol?: string;
  score: number;
  ageHours?: number;
  blockedReasons: TokenSafetyReason[];
  warnings: TokenSafetyReason[];
}

export interface TokenSearchCandidate extends TokenInfo {
  poolCreatedAt?: string;
  marketCapUsd?: number;
  fullyDilutedValuationUsd?: number;
  holderCount?: number;
  cexListings?: number;
  riskLevel?: 'low' | 'medium' | 'high';
  discoveryVectors?: string[];
  safety: TokenSafetySummary;
}

export interface TokenSearchPolicyOptions {
  network?: string;
  limit?: number;
  includeBlocked?: boolean;
  minLiquidityUsd?: number;
  minVolume24hUsd?: number;
  minTokenAgeHours?: number;
}

export interface SwapTokenSafetyInput {
  network: string;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenName?: string;
  side: 'buy' | 'sell';
  estimatedNotionalUsd?: number;
  minLiquidityUsd?: number;
  minVolume24hUsd?: number;
  minTokenAgeHours?: number;
  requireCanonical?: boolean;
}

export interface SwapTokenSafetyResult {
  ok: boolean;
  symbol?: string;
  name?: string;
  canonical: boolean;
  overridden: boolean;
  blockedReasons: TokenSafetyReason[];
  liquidityUsd?: number;
  volume24hUsd?: number;
  ageHours?: number;
  riskLevel?: 'low' | 'medium' | 'high';
}
```

### Domain port types

Add to `packages/domain/src/ports/token-safety.ts`:

```ts
import type { Result, DomainError } from '../result.js';

export interface SwapTokenSafetyCheckRequest {
  botId?: string;
  decisionId?: string;
  venue: string;
  venueAccountId: string;
  network: string;
  tokenAddress: string;
  side: 'buy' | 'sell';
  estimatedNotionalUsd?: string;
  safetyOverrideId?: string;
  instanceRiskOverrides?: {
    minSwapTokenLiquidityUsd?: number;
    minSwapTokenVolume24hUsd?: number;
    minSwapTokenAgeHours?: number;
    allowSwapTokenSafetyOverride?: boolean;
  };
}

export interface SwapTokenSafetyApproval {
  tokenAddress: string;
  canonical: boolean;
  overridden: boolean;
  liquidityUsd?: string;
  volume24hUsd?: string;
  ageHours?: string;
}

export interface SwapTokenSafetyOverrideRequest {
  overrideId: string;
  expiresAt: string;
  tokenAddress: string;
  reasonCodes: string[];
}

export interface SwapTokenSafetyError extends DomainError {
  code:
    | 'token_safety.rejected'
    | 'token_safety.override_invalid'
    | 'token_safety.override_expired'
    | 'token_safety.data_unavailable';
  context?: {
    tokenAddress?: string;
    reasonCodes?: string[];
    overrideRequest?: SwapTokenSafetyOverrideRequest;
  };
}

export interface SwapTokenSafetyPort {
  checkSwapTarget(
    request: SwapTokenSafetyCheckRequest,
  ): Promise<Result<SwapTokenSafetyApproval, SwapTokenSafetyError>>;
}
```

### Instance config additions

Extend `RiskConfigSchema` in `packages/domain/src/config/schema.ts`:

```ts
export const RiskConfigSchema = z.object({
  maxPositionSizePct: z.number().min(0).max(100).optional(),
  maxPositionSize: z.string().optional(),
  maxOpenPositions: z.number().min(1).optional(),
  maxDrawdown: z.string().optional(),
  dailyMaxLossPct: z.number().min(0).max(100).optional(),
  stopLossCooldownMs: z.number().min(0).optional(),
  maxOrderNotional: z.string().optional(),
  minSwapTokenLiquidityUsd: z.number().min(0).optional(),
  minSwapTokenVolume24hUsd: z.number().min(0).optional(),
  minSwapTokenAgeHours: z.number().min(0).optional(),
  allowSwapTokenSafetyOverride: z.boolean().optional(),
});
```

These values are only read when `venueType === 'swap'`.

Instance values should only tighten operator defaults unless the operator later
adds an explicit relaxation flag.

---

## Proposed Operator Config Schema

Extend `MarketDataConfigSchema` in `packages/domain/src/config/schema.ts` with a
new `tokenSafety` block:

```ts
export const TokenSafetyThresholdsSchema = z.object({
  minLiquidityUsd: z.number().min(0).default(10_000),
  minVolume24hUsd: z.number().min(0).default(25_000),
  minTokenAgeHours: z.number().min(0).default(24),
  deadPoolMinAgeHours: z.number().min(0).default(24 * 30),
  deadPoolMaxVolume24hUsd: z.number().min(0).default(1_000),
});

export const CanonicalTokenRegistrySchema = z.record(
  z.string(),
  z.record(
    z.string(),
    z.object({
      address: z.string().min(1),
      name: z.string().min(1),
      aliases: z.array(z.string().min(1)).default([]),
    }),
  ),
);

export const TokenSafetyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  preferCanonicalTokens: z.boolean().default(true),
  requireCanonicalForConfiguredSymbols: z.boolean().default(true),
  includeBlockedSearchResults: z.boolean().default(false),
  searchDefaults: TokenSafetyThresholdsSchema.default({}),
  tradeGuard: TokenSafetyThresholdsSchema.extend({
    liquidityMultiplier: z.number().min(1).default(200),
    overrideTtlMs: z.number().int().min(1_000).default(300_000),
    allowOverrides: z.boolean().default(true),
  }).default({}),
  canonicalTokens: CanonicalTokenRegistrySchema.default({}),
});

export const MarketDataConfigSchema = z.object({
  // existing providers...
  tokenSafety: TokenSafetyConfigSchema.default({}),
  timeoutMs: z.number().min(1000).default(5000),
});
```

### Default YAML shape

Add to `config/default.yaml` under `marketData:`:

```yaml
marketData:
  # existing provider config ...
  tokenSafety:
    enabled: true
    preferCanonicalTokens: true
    requireCanonicalForConfiguredSymbols: true
    includeBlockedSearchResults: false
    searchDefaults:
      minLiquidityUsd: 10000
      minVolume24hUsd: 25000
      minTokenAgeHours: 24
      deadPoolMinAgeHours: 720
      deadPoolMaxVolume24hUsd: 1000
    tradeGuard:
      minLiquidityUsd: 10000
      minVolume24hUsd: 25000
      minTokenAgeHours: 24
      deadPoolMinAgeHours: 720
      deadPoolMaxVolume24hUsd: 1000
      liquidityMultiplier: 200
      overrideTtlMs: 300000
      allowOverrides: true
    canonicalTokens:
      solana:
        SOL:
          address: So11111111111111111111111111111111111111112
          name: Wrapped SOL
          aliases: [WSOL]
        USDC:
          address: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
          name: USD Coin
      base:
        WETH:
          address: 0x4200000000000000000000000000000000000006
          name: Wrapped Ether
          aliases: [ETH]
        USDC:
          address: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
          name: USD Coin
```

### Config precedence

Threshold precedence for swap execution should be:

1. operator minimums from `marketData.tokenSafety.tradeGuard`
2. stricter instance overrides from `risk.minSwapToken*`
3. dynamic liquidity floor from `estimatedNotionalUsd * liquidityMultiplier`

The effective liquidity floor is:

```text
max(
  operator minLiquidityUsd,
  instance minSwapTokenLiquidityUsd if present,
  estimatedNotionalUsd * liquidityMultiplier if estimatedNotionalUsd is known,
)
```

---

## Exact Insertion Points

### Domain

1. `packages/domain/src/ports/token-safety.ts`
   Add the new `SwapTokenSafetyPort` and related request/result/error types.

2. `packages/domain/src/ports/index.ts`
   Export the new port.

3. `packages/domain/src/index.ts`
   Re-export the new port types if the package root currently exports ports.

4. `packages/domain/src/config/schema.ts`
   Add `TokenSafetyConfigSchema` under `MarketDataConfigSchema`.
   Extend `RiskConfigSchema` with swap-token overrides.

### Market data

5. `packages/market-data/src/types.ts`
   Add `TokenSearchCandidate`, `TokenSafetySummary`, reason codes, and canonical
   registry types.

6. `packages/market-data/src/token-safety.ts` (new)
   Implement:
   - `buildCanonicalLookup()`
   - `evaluateTokenCandidate()`
   - `rankTokenCandidates()`
   - `evaluateSwapTokenSafety()`
   - `tokenAddressKey(network, address)`

7. `packages/market-data/src/token-search.ts`
   Replace the local liquidity-only filter with orchestration that:
   - fetches raw DexScreener search results
   - optionally joins discovery enrichment by `network:address`
   - evaluates safety policy for each candidate
   - promotes canonical matches
   - returns `TokenSearchCandidate[]`

8. `packages/market-data/src/provider-registry.ts`
   Add a high-level namespace:

   ```ts
   tokens: {
     search(query: string, options?: TokenSearchPolicyOptions)
     validateSwapTarget(input: SwapTokenSafetyInput)
   }
   ```

   Keep raw provider methods (`dexscreener.search`, `discovery.discover`) for
   lower-level callers and tests.

9. `packages/market-data/src/index.ts`
   Export the new policy functions and types.

### Engine

10. `packages/engine/src/decision-intake.ts`
    Extend `DecisionIntakeDeps` with:

    ```ts
    swapTokenSafety?: SwapTokenSafetyPort;
    instanceRiskOverrides?: {
      minSwapTokenLiquidityUsd?: number;
      minSwapTokenVolume24hUsd?: number;
      minSwapTokenAgeHours?: number;
      allowSwapTokenSafetyOverride?: boolean;
    };
    ```

    After plan creation and before risk check, run the guard when:
    - `venueType === 'swap'`
    - the plan contains at least one `buy` swap order

    On failure:
    - mark the plan failed if already persisted, or skip persistence if the guard
      runs before plan persistence
    - return a structured pre-execution rejection rather than falling through to
      generic execution failure

11. `packages/engine/src/trading-cycle.ts`
    Extend `TradingCycleDeps` with the same injected port / risk override fields
    and pass them through to `submitDecisionForExecution()`.

### Worker runtime

12. `apps/worker/src/index.ts`
    Build the concrete `SwapTokenSafetyPort` implementation when market data is
    configured. Fail closed for swap bots when token safety is enabled but the
    market-data registry cannot be constructed.

13. `apps/worker/src/trading-actor.ts`
    Add `swapTokenSafety` to actor deps, pass it into both:
    - `getIntakeDeps()` for agent-submitted decisions
    - `runTradingCycle()` for strategy-submitted decisions

14. `apps/worker/src/tools/market-data.ts`
    Remove the local `filterSearchResults()` duplication and call the shared
    `marketDataRegistry.tokens.search()` surface.

15. `apps/worker/src/agent.ts`
    Replace the local DEX filtering and symbol-based discovery join with:
    - shared token search policy
    - address-based enrichment lookup

16. `apps/worker/src/venue-intelligence.ts`
    Replace `buildDiscoveryNetworkMap()` with an address-keyed helper, for
    example `buildDiscoveryAddressMap<T extends { network: string; address: string }>()`.

### Brokered decision path

17. `packages/domain/src/agent-protocol.ts`
    Add `safetyOverrideId?: string` to `DecisionSubmitPayloadSchema`.

18. `apps/worker/src/tools/trading.ts`
    Add `safetyOverrideId` to `submit_decision` params so an agent can retry a
    rejected swap decision explicitly.

19. `apps/worker/src/agents/agent-decision-handler.ts`
    Pass `payload.safetyOverrideId` into the shared decision intake path through
    the new `DecisionIntakeDeps` / metadata plumbing.

20. `packages/domain/src/models/decision.ts`
    No schema change is required if the override stays in `metadata`, but if a
    first-class field is preferred, add it here and update persistence.

### Persistence

21. `packages/db/src/schema/token-safety-overrides.ts` (new)
    Add the override table.

22. `packages/db/src/schema/index.ts`
    Export the new table.

23. `packages/db/src/token-safety-override-repository.ts` (new)
    Add repository methods:
    - `createOverride()`
    - `consumeOverride()`
    - `expireOverrides()`
    - `findActiveOverride()`

24. `packages/db/src/index.ts` and/or `packages/db/src/repositories.ts`
    Export and wire the new repository.

25. `packages/db/drizzle/*`
    Generate a migration for the new override table.

---

## Override Table Shape

Suggested schema:

```ts
export const tokenSafetyOverrides = pgTable('token_safety_overrides', {
  id: text('id').primaryKey(),
  botId: text('bot_id'),
  venueAccountId: text('venue_account_id').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  network: text('network').notNull(),
  tokenAddress: text('token_address').notNull(),
  reasonCodes: jsonb('reason_codes').$type<string[]>().notNull(),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  consumedDecisionId: text('consumed_decision_id'),
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Status values:

- `active`
- `consumed`
- `expired`
- `revoked`

---

## Search Policy Behavior

### Candidate assembly

For `tokens.search(query, options)`:

1. Fetch raw DexScreener search results.
2. Filter by requested network when provided.
3. Deduplicate by `network:address`.
4. Join discovery enrichment by `network:address` when discovery data is
   available.
5. Compute `TokenSafetySummary` for every candidate.
6. If the query matches a configured canonical symbol or alias, promote the
   canonical address to the top when present.
7. Sort by:
   - eligible before blocked
   - canonical before non-canonical when query matches a canonical symbol
   - higher safety score
   - higher liquidity
   - higher volume
8. Return only eligible results unless `includeBlocked === true`.

### Safety score

Scoring does not replace hard filters. It only ranks eligible candidates.

Suggested score components:

- `+ canonical boost`
- `+ liquidity rank`
- `+ volume rank`
- `+ age rank`
- `+ lower provider risk level`

Blocked candidates always sort below eligible candidates even with higher raw
liquidity.

### Canonical promotion behavior

If query matches a canonical symbol or alias:

- exact canonical address result should rank first when present and eligible
- non-canonical same-symbol results should carry a warning or block reason
  (`token.non_canonical_symbol`) depending on config
- do not inject a synthetic token entry when the canonical address is absent
  from provider results; only annotate that no canonical result was found

---

## Execution Guard Behavior

### When the guard runs

Run the guard only for swap trades that increase base-token exposure.

Practical rule for this slice:

- if `venueType !== 'swap'`: skip
- if plan has no orders: skip
- if all planned swap orders are `sell`: skip
- if any planned swap order is `buy`: evaluate the configured base asset

### How target identity is resolved

Use the configured swap base asset from `BotConfig.swapAssets.baseAsset` as the
token address / mint being protected.

This slice assumes swap bots are still configured against explicit swap assets.
It does not add arbitrary agent-selected token addresses.

### Effective thresholds

For swap buys, compute the effective floors from:

- operator config
- instance risk overrides
- dynamic liquidity multiplier when notional can be estimated

`estimatedNotionalUsd` resolution order:

1. if quote asset is a canonical stable asset on the same network and the swap
   buy spends quote, treat input quantity as USD notional
2. otherwise use `referenceMark.price * quantity` when available
3. otherwise omit the dynamic multiplier and apply only static floors

### Rejection behavior

If the guard rejects:

- do not execute any order
- emit a structured rejection with code `token_safety.rejected`
- include `reasonCodes`, human-readable reasons, and a one-time
  `overrideRequest` when overrides are enabled

### Override behavior

If `safetyOverrideId` is present:

- validate it against token, bot / venue scope, expiry, and status
- consume it atomically
- return approval with `overridden: true`
- reject with `token_safety.override_invalid` or
  `token_safety.override_expired` on failure

---

## Decision Flow Changes

### Search path

```text
search_tokens tool
  -> marketDataRegistry.tokens.search(query, options)
  -> token-safety policy
  -> returns TokenSearchCandidate[] with safety metadata
```

### Strategy / agent execution path

```text
submit_decision
  -> broker payload includes optional safetyOverrideId
  -> AgentDecisionHandler / TradingActor build DecisionIntakeDeps
  -> submitDecisionForExecution()
  -> planDecision()
  -> swapTokenSafety.checkSwapTarget() when venueType=swap and buy order exists
  -> risk gate
  -> executor
```

This keeps one hard gate for both:

- agent-submitted decisions via broker
- strategy-submitted decisions via `runTradingCycle()`

---

## Logging and Events

Add structured logs for:

- canonical promotion decisions
- search candidates filtered as blocked
- execution-time swap token safety rejections
- override issuance
- override consumption

Suggested event / code vocabulary:

- `token_safety.rejected`
- `token_safety.override_issued`
- `token_safety.override_consumed`
- `token_safety.override_invalid`
- `token_safety.override_expired`

When an agent decision is rejected by token safety, the agent-facing rejection
payload should include:

- human-readable message
- machine-readable codes
- `overrideRequest.overrideId`
- `overrideRequest.expiresAt`

---

## Rollout Plan

1. Add config schema and defaults.
2. Add market-data token-safety module and shared search policy.
3. Switch read-only search and DEX intelligence code to the shared policy and
   address-based enrichment.
4. Add domain port, DB override persistence, and worker adapter.
5. Inject the guard into `submitDecisionForExecution()` and `runTradingCycle()`.
6. Extend `submit_decision` payload with `safetyOverrideId`.
7. Ship override retry flow and update tests.

---

## Test Strategy

### Market-data unit tests

Add or extend:

- `packages/market-data/src/token-safety.test.ts`
- `packages/market-data/src/token-search.test.ts`
- `packages/market-data/src/provider-registry.test.ts`

Cases:

- promotes canonical token for canonical symbol query
- does not bleed discovery enrichment between same-symbol different-address
  tokens on the same network
- blocks low-liquidity token
- blocks low-volume token
- blocks too-new token
- blocks dead pool
- keeps blocked results hidden by default
- includes blocked results when `includeBlocked=true`

### Worker tests

Add or extend:

- `apps/worker/src/venue-intelligence.test.ts`
- `apps/worker/src/tools/market-data.test.ts` or nearest existing test file
- `apps/worker/src/agents/agent-decision-handler.test.ts`
- `apps/worker/src/trading-actor.test.ts`

Cases:

- DEX intelligence attaches discovery metadata by address, not symbol
- `search_tokens` no longer duplicates filter logic
- rejected swap decision returns `token_safety.rejected` with override request
- retry with valid `safetyOverrideId` succeeds and marks override consumed
- invalid or expired override is rejected cleanly

### Engine tests

Add or extend:

- `packages/engine/src/decision-intake.test.ts`
- `packages/engine/src/trading-cycle.test.ts`

Cases:

- swap buy invokes the injected guard
- swap sell / flatten path skips the guard
- guard rejection prevents execution
- guard success allows risk gate and executor to run

### DB tests

Add or extend:

- `packages/db/src/token-safety-override-repository.integration.test.ts`

Cases:

- create override
- consume override once
- second consume fails
- expired override cannot be consumed

### Validation command

Run:

```bash
pnpm lint
pnpm test packages/market-data/src/token-search.test.ts packages/engine/src/decision-intake.test.ts apps/worker/src/trading-actor.test.ts
```

---

## Exit Criteria

- `search_tokens` and worker DEX intelligence use one shared token policy
  implementation.
- Discovery enrichment joins by `network:address`, not `network:symbol`.
- Canonical tokens are promoted for configured symbols.
- Swap buy decisions are blocked when token safety thresholds fail.
- Overrides are persisted, one-time, and auditable.
- Agent retry path supports `safetyOverrideId`.
- Focused tests and `pnpm lint` pass.

---

## Follow-on Slice

After this plan lands, the next logical plan is dynamic token-address execution:

- allow agent-selected token addresses to flow from `search_tokens` into a
  brokered trade request
- add explicit token identity fields to the decision contract for swap venues
- keep this token-safety layer as the authoritative guardrail for that future
  direct-swap flow