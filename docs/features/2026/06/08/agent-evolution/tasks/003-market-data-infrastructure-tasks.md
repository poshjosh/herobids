# Plan 003 — Task List

**Epic:** C (Market Data Infrastructure)
**Plans:**
- [Market Data Provider Strategy](../references/market-data-provider-strategy.md)
- [Market Data Rate-Limit Testing](../references/market-data-rate-limit-testing.md)
**Goal:** Make provider access coordinated, budget-aware, and testable under multi-agent load so Epic B intelligence can scale without starving critical data paths.

---

## Tasks

### T1: Expand operator config for the full provider inventory

**Status:** done
**Approach:** End-to-end
**Effort:** Medium (1 session)

The current operator config only covers DexScreener, Binance, and a shared timeout. Expand it to describe the provider surface now planned:

- DexScreener search vs. discovery budgets
- GeckoTerminal budgets
- Hyperliquid intelligence endpoint settings
- Bybit intelligence endpoint settings
- optional paid-provider placeholders (Birdeye / CMC)

Keep this strictly in operator config. Do not fall back to ad hoc `process.env` reads inside new provider code.

**Files:** `packages/domain/src/config/schema.ts`, `apps/worker/src/config.ts`, `config/default.yaml`, `apps/worker/src/config.test.ts`
**Acceptance:** The resolved app config contains typed settings for every supported provider and call class needed by Epics B/C. Config tests cover defaults and overrides.

---

### T2: Introduce a single provider registry and request-class model

**Status:** done
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T1

Create one construction path for market-data clients and define request classes such as:

- execution-critical
- price / position support
- regime
- discovery
- enrichment

The registry should make priority explicit and stop each caller from instantiating its own private limiter and timeout policy.

**Files:** `packages/market-data/src/` (new provider-registry module), `packages/market-data/src/index.ts`, `apps/worker/src/index.ts`, `apps/worker/src/agent.ts`
**Acceptance:** Provider clients are created through one typed registry, request classes are explicit in code, and call sites no longer hand-roll provider config objects per use case.

---

### T3: Add shared rate-budget coordination across concurrent agents

**Status:** done
**Approach:** Vertical slice
**Effort:** Large (1–2 sessions)
**Depends on:** T2

The current `TokenBucketRateLimiter` is per-process and cannot protect shared free-tier budgets when many agent containers run in parallel. Add a coordination layer so provider budgets are enforced across concurrent agents.

Implementation is flexible, but the outcome is not:

- all agents share the same provider budget
- execution / price support traffic has reserved capacity
- discovery traffic cannot consume the last available tokens

This can be a Redis-backed limiter, a worker-owned broker, or another shared coordination mechanism. The task is complete only when budgets are truly shared, not just re-labeled.

**Files:** `packages/market-data/src/rate-limiter.ts`, `packages/market-data/src/` (new coordination module), `apps/worker/src/agent.ts`, `apps/worker/src/agents/docker-agent-manager.ts`
**Acceptance:** Three concurrent agents respect one shared quota per provider. Discovery requests cannot starve execution-priority calls. Tests simulate concurrent consumers against the shared budget.

---

### T4: Add cache, TTL, and freshness metadata for provider responses

**Status:** done
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T2

Layer provider-specific caching on top of the registry so repeated calls do not burn budget unnecessarily. Capture freshness metadata alongside cached data and expose it to both runtime context assembly and tools.

Minimum TTL coverage:

- venue intelligence (minutes)
- discovery lists (minutes)
- enrichment data (hour-scale)
- high-frequency price support (short-lived or uncached)

**Files:** `packages/market-data/src/` (new cache helpers), `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.ts`
**Acceptance:** Repeated requests within TTL do not hit upstream providers, cached responses carry age metadata, and stale-while-revalidate behavior is explicit rather than implicit.

---

### T5: Route agent intelligence features through the coordinated infra

**Status:** done
**Approach:** Vertical slice
**Effort:** Medium (1–2 sessions)
**Depends on:** T3, T4

Once the shared provider infrastructure exists, move Epic B call sites onto it:

- `search_tokens`
- `discover_tokens`
- `get_market_overview`
- `get_funding_rates`
- pre-computed venue-intelligence injection

The goal is to eliminate the current pattern where an agent container directly constructs a local limiter and fetches upstream in isolation.

**Files:** `apps/worker/src/agent.ts`, `apps/worker/src/runtime-composition.ts`, `packages/market-data/src/`, `apps/worker/src/agents/docker-agent-manager.ts`
**Acceptance:** All agent-facing market-data paths run through the same coordinated provider layer. No discovery or venue-intelligence path bypasses shared budgets.

---

### T6: Build the rate-limit lab harness and report generator

**Status:** done
**Approach:** End-to-end
**Effort:** Large (1–2 sessions)
**Depends on:** T3

Implement the behavioral test harness from the reference doc under `tests/rate-limit-lab/`.

Requirements:

- mock providers with configurable latency, errors, and 429 behavior
- simulated agents with priority classes and call mixes
- scenarios A–E from the reference plan
- structured report output matching the documented template

This harness is not a correctness unit test. It exists to validate behavior under pressure.

**Files:** `tests/rate-limit-lab/` (new directory), `scripts/` or package script wiring, `docs/test-reports/rate-limit/` (report output location)
**Acceptance:** A local command runs the harness and emits a structured report containing summary, per-provider, and per-agent sections that match the reference template.

---

### T7: Add degradation telemetry and pass/fail thresholds to the runtime surface

**Status:** done
**Approach:** End-to-end
**Effort:** Medium (1 session)
**Depends on:** T3, T4, T6

Make rate-pressure visible both in the harness and in the live runtime by tracking:

- rejection rate per provider
- fallback activation count
- execution-priority starvation events
- max data staleness by category
- recovery time after outage simulation

Use the same vocabulary in logs, reports, and future alerting so results are comparable across environments.

**Files:** `packages/market-data/src/`, `apps/worker/src/agent.ts`, `tests/rate-limit-lab/`, `docs/test-reports/rate-limit/`
**Acceptance:** Runtime and harness outputs expose the same core metrics, and the Scenario B success criteria from the reference doc are encoded as explicit PASS / FAIL thresholds.

---

## Parallelization Notes

- **T1** must happen first because provider settings belong in operator config.
- **T2** defines the common construction path that later tasks rely on.
- **T3** and **T4** can overlap once T2 exists, but shared coordination is higher priority.
- **T5** is the migration step after the infrastructure is real.
- **T6** can begin once T3 exposes the coordination behavior worth testing.
- **T7** finishes the observability contract.

```
T1 (config)
	→ T2 (registry + request classes)
		→ T3 (shared budgets) ────────┐
		→ T4 (cache + freshness) ─────┼→ T5 (wire Epic B onto infra)
																	└→ T6 (rate-limit lab)

T3 + T4 + T6 → T7 (degradation telemetry + thresholds)
```
