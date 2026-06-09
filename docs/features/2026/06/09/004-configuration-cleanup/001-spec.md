# Config Hardening: Implementation Spec

Source notes: 000-note-0, 000-note-1, 000-note-2.

---

## Policy (Non-Negotiable)

Three distinct surfaces. Never mix them.

| Surface | Home | Lifecycle |
|---|---|---|
| Operator config | `config/default.yaml` + `packages/domain/src/config/schema.ts` | Deploy/restart |
| Env overrides | `apps/worker/src/config.ts` ENV_OVERRIDES map | Deploy/restart — secrets and infra wiring only |
| Agent container payload | `apps/worker/src/index.ts` + `docker-agent-manager.ts` | Runtime, derived from resolved operator config |

**Schema presence does not imply env override support.** The burden of proof for a new env override is operational need, not schema existence.

**Env overrides are justified for:** secrets, deployment-specific scalars infra injects (URLs, ports), and existing scalar LLM runtime values already in the ENV_OVERRIDES map.

**Env overrides are not justified for:** structured policy objects (trading hours, market-data budgets, context diff policy, sandbox limits). These go in YAML.

**Container payload fields** (`TRADING_HOURS_JSON`, `MARKET_DATA_CONFIG_JSON`, `AGENT_CONFIG`, `TOOL_POLICY`) are internal worker-to-agent transport contract. They are not operator env vars, must not appear in `docker-compose.yaml`, and must always be derived from resolved `appConfig` in `index.ts`.

**`docker-compose.yaml`** is infra wiring only: service URLs, Docker runtime wiring, and secret passthrough into worker. Not a second home for structured operator policy.

---

## Changes: New Config Surfaces (High Priority)

### 1. New `worker` block — `schema.ts` + `default.yaml`

Add `WorkerConfigSchema` with:

```yaml
worker:
  scanIntervalMs: 5000        # WorkerRuntime scan loop interval
  concurrency: 10             # WorkerRuntime max concurrent actors
  agents:
    healthCheckIntervalMs: 2000  # AgentSessionManager health poll cadence
```

Wire in `apps/worker/src/index.ts`:
- Replace literal `scanIntervalMs: 5000` → `appConfig.worker.scanIntervalMs`
- Replace literal `concurrency: 10` → `appConfig.worker.concurrency`
- Replace literal `healthCheckIntervalMs: 2000` → `appConfig.worker.agents.healthCheckIntervalMs`

### 2. Extend `backtesting` block — `schema.ts` + `default.yaml`

Add `backtesting.concurrency`:

```yaml
backtesting:
  concurrency: 2    # BacktestRuntime BullMQ consumer concurrency
```

Wire in `apps/worker/src/index.ts`: replace literal `concurrency: 2` in `BacktestRuntime` constructor.

### 3. Extend `execution` block — `schema.ts` + `default.yaml`

Add:
```yaml
execution:
  shadowPollIntervalMs: 2000   # swap-venue price polling when no stream
  shadowQuoteSlippageBps: 50   # slippage used for shadow swap price quotes
```

Note: `execution.defaultSlippageBps` already exists. `shadowQuoteSlippageBps` is semantically distinct (it is used only for price estimation, not order submission). Add separately.

Wire in `apps/worker/src/trading-actor.ts`:
- Replace `shadowPollIntervalMs ?? 2000` → source from injected config
- Replace `slippageBps: 50` quote fallback → source from injected config

### 4. New `agentRuntime` block — `schema.ts` + `default.yaml`

Add `AgentRuntimeConfigSchema` with sub-objects:

```yaml
agentRuntime:
  failureBackoff:
    backoffThreshold: 3        # consecutive failures before doubling interval
    maxFailures: 5             # consecutive failures before shutdown
    maxIntervalMs: 1800000     # cap on backed-off interval (30 min)
  toolCircuitBreaker:
    failureThreshold: 3        # failures before circuit opens
    reopenAfterTicks: 5        # ticks before auto-reset
  thinking:
    drawdownThresholdPct: -2   # drawdown % that triggers deep thinking
  contextDiff:
    fullContextEveryTicks: 10  # force full context every N ticks
    maxDiffTokens: 200         # fall back to full if diff exceeds this
    maxChangedLines: 12        # truncate diff at this many lines
  defaultBudgets:
    maxHistoryMessages: 20
    maxRecentToolMessages: 6
    maxToolResultChars: 4000
    maxVisibleToolSchemas: 16
    maxContextBlockChars: 4000
```

Wire ups:
- `apps/worker/src/agent.ts`: `new ToolCircuitBreaker()` and `new FailureBackoffController()` → inject from config
- `apps/worker/src/agent.ts`: initial descriptor `budgets` block → replace with `DEFAULT_RUNTIME_BUDGETS` seeded from config
- `apps/worker/src/context-diff.ts`: `FULL_CONTEXT_EVERY_TICKS`, `MAX_DIFF_TOKENS`, constants at top of file → accept as parameters or source from module-level config
- `apps/worker/src/tick-thinking.ts`: `<= -2` → inject threshold
- `packages/domain/src/runtime-composition.ts`: `DEFAULT_RUNTIME_BUDGETS` object → source from resolved config at startup

### 5. New `llm.retry`, `llm.scout`, `llm.thinking` sub-blocks — `schema.ts` + `default.yaml`

```yaml
llm:
  retry:
    maxRetries: 2
    timeoutBackoffMs: [5000, 15000]   # per-attempt delays for timeout errors
    serverErrorBackoffMs: 10000        # fixed delay for 5xx errors
    defaultRateLimitBackoffMs: 60000   # fallback when no Retry-After header
  scout:
    defaultModels:
      anthropic: claude-3-5-haiku-latest
      openai: gpt-4.1-mini
      openrouter: openai/gpt-4.1-mini
  thinking:
    lightBudgetTokens: 2048
    deepBudgetTokens: 10240
```

Wire ups:
- `apps/worker/src/runtime-errors.ts`: `maxRetries ?? 2`, `timeoutDelays`, `10_000`, `60_000` fallbacks → inject from config
- `apps/worker/src/scout-dispatch.ts`: `resolveDefaultScoutModel` map → read from config
- `packages/llm/src/llm-provider.ts`: `toAnthropicThinkingBudget` return values `2_048` / `10_240` → inject from config

---

## Changes: Remove Literal Fallbacks (Config Surface Already Exists)

These require no new schema. Just remove the hard-coded fallback and let the missing config value fail loudly or use the schema default.

| Literal | File | Action |
|---|---|---|
| `'wss://stream.bybit.com/v5/public/linear'` | `apps/worker/src/index.ts#L312` | Remove fallback; require `venues.bybit.wsPublicUrl` to be set |
| `'https://api.coingecko.com/api/v3'` | `apps/worker/src/index.ts#L322` | Remove fallback; `marking.oracleBaseUrl` has a schema default already |
| `'https://api.1inch.dev/swap/v6.0/8453'` | `apps/worker/src/index.ts#L575` | Remove env fallback; use `venues.1inch.baseUrl` from config only |
| `'https://mainnet.base.org'` | `apps/worker/src/index.ts#L579` | Move to `venues.1inch.rpcUrl` in schema + default.yaml; remove `process.env['BASE_RPC_URL']` inline read |
| `'https://quote-api.jup.ag/v6'` | `apps/worker/src/index.ts#L600` | Already covered by `venues.jupiter.baseUrl` schema default; just remove the duplicate literal |
| `'https://api.mainnet-beta.solana.com'` | `apps/worker/src/index.ts#L601` | Add `venues.jupiter.rpcUrl` to schema + default.yaml; remove `process.env['SOLANA_RPC_URL']` inline read |

### LLM provider base URL consolidation

- `packages/llm/src/llm-provider.ts:166` — Anthropic path ignores `config.baseUrl` and hard-codes the URL. Fix: use `config.baseUrl ?? resolveBaseUrl(config.provider)` consistently, same as the OpenAI/OpenRouter path.
- `packages/strategy/src/llm-provider.ts` — duplicate copy of the same `resolveBaseUrl` and `callAnthropicProvider`. Consolidate both into one shared implementation in `packages/llm`. This is a code-quality fix, not a new config surface.

### Oracle mark source tuning

Add to `marking` block in schema + default.yaml:
```yaml
marking:
  oracleTimeoutMs: 10000
  oracleVsCurrency: usd
```
Wire in `apps/worker/src/index.ts` when constructing `OracleMarkSource`.

### EVM signer confirmation timeout

Add to `venues.1inch` block (or a new `venues.evm` block if other EVM venues arrive):
```yaml
venues:
  1inch:
    confirmationTimeoutMs: 60000
```
Wire in `packages/venues/src/evm-signer.ts` constructor.

### Hyperliquid + Bybit testnet/stream URLs

Add explicit fields to each venue config in schema + default.yaml:
```yaml
venues:
  hyperliquid:
    testnetBaseUrl: https://api.hyperliquid-testnet.xyz
    testnetWsUrl: wss://api.hyperliquid-testnet.xyz/ws
  bybit:
    wsPrivateUrl: wss://stream.bybit.com/v5/private
    wsTestnetPrivateUrl: wss://stream-testnet.bybit.com/v5/private
```
Wire in `packages/venues/src/hyperliquid.ts` and `packages/venues/src/bybit.ts`.

---

## Changes: Paid Provider Fail-Fast Validation

In `packages/domain/src/config/schema.ts`, add `.superRefine` or `.refine` on `MarketDataConfigSchema`:

- if `birdeye.enabled === true`, `birdeye.apiKey` must be non-empty
- if `coinMarketCap.enabled === true`, `coinMarketCap.apiKey` must be non-empty

Add tests in `apps/worker/src/config.test.ts` covering enabled-but-missing-key rejection.

---

## Documentation Update

`docs/best-practices/configuration.md` — add one section:

> **Schema presence does not imply env override support.**
> Not every operator-config field needs an env override. Structured policy (budgets, intervals, thresholds) belongs in YAML. Env overrides are for secrets, deployment wiring, and a small set of infra scalars. Worker-to-agent JSON payload fields (`TRADING_HOURS_JSON`, `MARKET_DATA_CONFIG_JSON`) are internal transport contract, not operator env variables. Docker Compose is infra wiring only.

---

## Explicit Out of Scope

- Do not add `LLM_TRADING_HOURS_JSON` as an operator env override.
- Do not add blanket `MARKET_DATA_*` env overrides.
- Do not add `TRADING_HOURS_JSON` or `MARKET_DATA_CONFIG_JSON` to `docker-compose.yaml`.
- Do not move `DOCKER_HOST`, `DOCKER_NETWORK`, `AGENT_IMAGE` into typed operator config unless there is a concrete reason — leave them as documented infrastructure env exceptions.
- `LLM_PROVIDER`, `LLM_MODEL`, `LLM_BASE_URL` may stay in compose as optional override passthroughs; this decision is deferred.
- Sandbox defaults, billing tolerances, Creem test URL, and OAuth cookie TTL — see `002-tasks-deferred.md`.
