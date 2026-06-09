# Config Hardening: Task Breakdown

Reference spec: `001-spec.md`.

Execute tasks in order. Each task is independently testable and can be a single commit or PR.

---

## Task 1 — New `worker` block and extend `backtesting` block

**Files touched:** `packages/domain/src/config/schema.ts`, `config/default.yaml`, `apps/worker/src/index.ts`, `apps/worker/src/config.test.ts`

**What:**
- Add `WorkerConfigSchema` with `scanIntervalMs`, `concurrency`, `agents.healthCheckIntervalMs`
- Add `backtesting.concurrency`
- Wire all four literals in `index.ts` to resolved config
- Add tests

**Acceptance:**
- `pnpm lint` passes
- `apps/worker/src/config.test.ts` covers new fields including out-of-range rejection
- `index.ts` contains no bare numeric literals for these four values

---

## Task 2 — New `agentRuntime` block

**Files touched:** `packages/domain/src/config/schema.ts`, `config/default.yaml`, `apps/worker/src/agent.ts`, `apps/worker/src/context-diff.ts`, `apps/worker/src/tick-thinking.ts`, `packages/domain/src/runtime-composition.ts`, `apps/worker/src/config.test.ts`

**What:**
- Add `AgentRuntimeConfigSchema`: `failureBackoff`, `toolCircuitBreaker`, `thinking`, `contextDiff`, `defaultBudgets`
- Inject into `FailureBackoffController` and `ToolCircuitBreaker` constructors in `agent.ts`
- Replace `FULL_CONTEXT_EVERY_TICKS`, `MAX_DIFF_TOKENS`, `changedLines >= 12` in `context-diff.ts` with injected values
- Replace `<= -2` in `tick-thinking.ts` with injected threshold
- Replace inline `budgets` literal in `agent.ts` with `DEFAULT_RUNTIME_BUDGETS` seeded from config
- Update `DEFAULT_RUNTIME_BUDGETS` in `runtime-composition.ts` to source from config

**Acceptance:**
- `pnpm lint` passes
- All relevant unit tests still pass
- No bare numeric literals remain for these values in the affected files

---

## Task 3 — New `llm.retry`, `llm.scout`, `llm.thinking` sub-blocks

**Files touched:** `packages/domain/src/config/schema.ts`, `config/default.yaml`, `apps/worker/src/runtime-errors.ts`, `apps/worker/src/scout-dispatch.ts`, `packages/llm/src/llm-provider.ts`, `apps/worker/src/config.test.ts`

**What:**
- Add `llm.retry` with `maxRetries`, `timeoutBackoffMs`, `serverErrorBackoffMs`, `defaultRateLimitBackoffMs`
- Add `llm.scout.defaultModels` map (anthropic, openai, openrouter)
- Add `llm.thinking.lightBudgetTokens` and `deepBudgetTokens`
- Wire `runtime-errors.ts` retry policy to config
- Wire `scout-dispatch.ts` default model resolution to config
- Wire `llm-provider.ts` thinking budget tokens to config

**Acceptance:**
- `pnpm lint` passes
- `apps/worker/src/config.test.ts` covers new fields
- `resolveDefaultScoutModel` reads from config rather than a hard-coded switch

---

## Task 4 — Remove literal fallbacks where config surface already exists

**Files touched:** `apps/worker/src/index.ts`, `packages/venues/src/hyperliquid.ts`, `packages/venues/src/bybit.ts`, `packages/venues/src/oracle-mark-source.ts`, `packages/venues/src/evm-signer.ts`, `packages/llm/src/llm-provider.ts`, `packages/strategy/src/llm-provider.ts`, `packages/domain/src/config/schema.ts`, `config/default.yaml`

**What:**
- Remove Bybit public WS, CoinGecko, 1inch, Solana RPC, Jupiter literal fallbacks from `index.ts`; add missing fields to schema + YAML where needed (`venues.1inch.rpcUrl`, `venues.jupiter.rpcUrl`)
- Add `marking.oracleTimeoutMs` and `marking.oracleVsCurrency` to schema + YAML; wire into `OracleMarkSource`
- Add `venues.1inch.confirmationTimeoutMs` to schema + YAML; wire into `evm-signer.ts`
- Add testnet/stream URL fields to Hyperliquid and Bybit venue configs; remove hardcoded strings in adapters
- Fix `llm-provider.ts` Anthropic path to use `config.baseUrl ?? resolveBaseUrl(config.provider)` consistently
- Consolidate duplicate `resolveBaseUrl` and `callAnthropicProvider` from `packages/strategy/src/llm-provider.ts` into `packages/llm` (reuse, do not copy)

**Acceptance:**
- `pnpm lint` passes
- `apps/worker/src/index.ts` contains no bare URL string literals for these venues
- `packages/venues/src/hyperliquid.ts` and `bybit.ts` contain no bare prod/testnet URL literals
- `packages/llm` is the single source of provider base URL resolution

---

## Task 5 — Paid provider fail-fast validation + documentation update

**Files touched:** `packages/domain/src/config/schema.ts`, `apps/worker/src/config.test.ts`, `docs/best-practices/configuration.md`

**What:**
- Add `.superRefine` in `MarketDataConfigSchema`: enabled Birdeye without `apiKey` → fail fast; same for CoinMarketCap
- Add negative tests in `config.test.ts`: enabled provider with empty key must throw at startup
- Add documentation section to `configuration.md`: schema presence ≠ env override, YAML-first policy, compose is infra wiring only, container payload is internal contract

**Acceptance:**
- `pnpm lint` passes
- Starting with `birdeye.enabled: true` and empty `apiKey` throws at startup with a clear error
- `configuration.md` contains the new boundary section

---

## Task 6 — Sandbox defaults into operator config

_Extends the `agentRuntime` block introduced in Task 2. Add `agentRuntime.sandboxDefaults` to the same schema object._

**Files touched:** `packages/domain/src/config/schema.ts`, `config/default.yaml`, `apps/worker/src/agents/sandbox-enforcer.ts`, `apps/worker/src/index.ts`, `apps/worker/src/config.test.ts`

**What:**
- Add `agentRuntime.sandboxDefaults` sub-object to `AgentRuntimeConfigSchema` with fields:
  - `cpuShares: 256`
  - `memoryMb: 512`
  - `maxWallClockMs: 300_000` (5 min per session)
  - `tempStorageMb: 100`
  - `maxProcesses: 10`
  - `maxRequestsPerMinute: 60`
  - `maxConcurrentConnections: 10`
  - `maxResponseBytes: 10485760` (10 MB)
  - `maxTotalDownloadBytes: 104857600` (100 MB)
- Add block to `config/default.yaml` with inline comments explaining the Docker cgroup/ulimit relationship for each field
- Inject resolved config into `SandboxEnforcer` at construction time in `index.ts`
- Remove `DEFAULT_SANDBOX_LIMITS` constant from `sandbox-enforcer.ts`

**Acceptance:**
- `pnpm lint` passes
- `SandboxEnforcer` receives all limits from injected config, no internal constant
- `config.test.ts` covers `agentRuntime.sandboxDefaults` fields

---

## Task 7 — Code tool execution defaults

_Depends on Task 2 (`agentRuntime` block). Add `agentRuntime.tools.codeExecute` as a sub-object of the same schema block._

**Files touched:** `packages/domain/src/config/schema.ts`, `config/default.yaml`, `apps/worker/src/tools/code.ts`, `apps/worker/src/config.test.ts`

**What:**
- Add `agentRuntime.tools.codeExecute.defaultTimeoutMs` (default `60_000`) and `defaultMaxOutputBytes` (default `51200`) to `AgentRuntimeConfigSchema` + `config/default.yaml`
- Wire into `code.ts`: replace bare module-level `TIMEOUT_MS` and `MAX_OUTPUT` constants with values injected at construction time
- The capability grant path remains primary; config values are the fallback when no grant is present

**Acceptance:**
- `pnpm lint` passes
- `code.ts` contains no bare `60_000` or `50 * 1024` literals
- `config.test.ts` covers new `agentRuntime.tools.codeExecute` fields
