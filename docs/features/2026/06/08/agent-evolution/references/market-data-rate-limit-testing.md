# Market Data Rate-Limit Testing

Behavioral testing of the system under realistic rate-limit constraints. Not functionality testing — behavior-under-load testing.

---

## Background

We operate on free tiers for most data providers:
- DexScreener: 60 req/min
- GeckoTerminal: 10–30 req/min
- Binance: 1200 req/min
- Hyperliquid REST: ~10 req/s (undocumented, conservative estimate)
- Bybit REST: 120 req/min (linear endpoints)

Multiple agents share the same provider endpoints. Without coordination, agents exhaust rate budgets on low-priority calls (discovery, exploration) and starve high-priority calls (position monitoring, execution quotes).

This plan defines a testing methodology for validating system behavior under constrained resources.

---

## Scope

### In scope

- Load test harness for simulating multiple concurrent agents
- Rate-limit behavior validation per provider
- Fallback chain behavior under pressure
- Degradation reporting
- Report template for results

### Out of scope

- Implementation of rate limiters (already exist in `@herobids/market-data`)
- Provider-side rate limit negotiation
- Paid tier testing

---

## 1. Test Scenarios

### Scenario A: Single agent, free-tier limits

- 1 agent, normal tick interval (15 min)
- Provider budgets set to free-tier limits
- Run for 100 ticks (simulated)
- Measure: API calls made, rejections, fallback invocations, data staleness

### Scenario B: Multiple agents, shared budget

- 3 agents, all using the same provider endpoints
- Provider budgets set to free-tier limits (shared, not per-agent)
- All agents tick simultaneously
- Measure: fair distribution of budget, starvation events, priority enforcement

### Scenario C: Provider degradation

- 1–3 agents
- Simulate one provider returning 429 for 5 minutes
- Measure: fallback activation time, data continuity, recovery time

### Scenario D: Burst demand (regime change)

- 3 agents
- Simulate market event triggering all agents to request data simultaneously
- Measure: queue depth, response latency, rejection rate, cooldown behavior

### Scenario E: Discovery vs. execution priority

- 2 agents: one actively trading (needs price data), one exploring (needs discovery)
- Shared provider budget
- Measure: execution-priority data never starved by discovery calls

---

## 2. Test Harness Design

The harness does NOT make real API calls. It simulates provider responses with configurable latency and rate-limit behavior.

```typescript
interface MockProviderConfig {
  name: string;
  maxRequestsPerMinute: number;
  latencyMs: { p50: number; p95: number };
  errorRate: number; // 0–1, probability of 5xx
  rateLimitBehavior: 'reject_429' | 'queue_and_delay';
}

interface AgentSimConfig {
  tickIntervalMs: number;
  callsPerTick: { discovery: number; price: number; candles: number };
  priority: 'discovery' | 'execution';
}
```

The harness:
1. Instantiates N mock providers with rate limit state.
2. Instantiates M simulated agents making calls through the real `TokenBucketRateLimiter`.
3. Runs for T simulated seconds.
4. Records all events: request, accept, reject, fallback, stale-data-served.

---

## 3. Metrics to Capture

| Metric | Unit | Good | Bad |
|---|---|---|---|
| Rejection rate per provider | % of total calls | <5% | >20% |
| Execution-priority starvation | Events where price/position call was rejected | 0 | >0 |
| Fallback activation count | Times fallback provider was used | Low | N/A (depends on scenario) |
| Data staleness (max) | Seconds since last successful refresh | <60s for prices, <300s for discovery | >300s for prices |
| Recovery time after outage | Seconds from provider recovery to normal operation | <30s | >120s |
| Fair share deviation | Max variance in calls-per-agent vs. expected | <20% | >50% |
| Total cost (API calls) per agent per hour | Calls | Within free-tier budget | Exceeds budget |

---

## 4. Report Template

Each test run produces a structured report:

```markdown
# Rate-Limit Behavior Report

## Configuration
- Agents: N
- Duration: T seconds (simulated)
- Providers: [list with limits]
- Scenario: [A/B/C/D/E]

## Results Summary

| Metric | Value | Status |
|---|---|---|
| Total requests attempted | ... | — |
| Total requests accepted | ... | — |
| Total requests rejected (429) | ... | ✅/❌ |
| Execution-priority starvation events | ... | ✅/❌ |
| Max data staleness (prices) | ...s | ✅/❌ |
| Max data staleness (discovery) | ...s | ✅/❌ |
| Fallback activations | ... | — |
| Recovery time (if applicable) | ...s | ✅/❌ |

## Per-Provider Breakdown

| Provider | Attempted | Accepted | Rejected | Avg latency |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

## Per-Agent Breakdown

| Agent | Calls made | Calls rejected | Stale data events |
|---|---|---|---|
| ... | ... | ... | ... |

## Observations

[Free-form notes on behavior, anomalies, recommendations]

## Verdict

PASS / FAIL / DEGRADED (with explanation)
```

---

## 5. Location and Execution

- Harness code: `tests/rate-limit-lab/` (new directory)
- Reports: `docs/test-reports/rate-limit/` (one report per run, dated)
- Execution: `pnpm --filter rate-limit-lab test` or a dedicated script
- Not part of CI (too slow, behavioral not correctness). Run manually before releases or after rate-limit logic changes.

---

## 6. Success Criteria

The system passes if, under Scenario B (3 agents, free-tier shared budget):
1. Zero execution-priority starvation events.
2. Price data staleness never exceeds 60s.
3. Discovery data staleness never exceeds 5 min.
4. Rejection rate per provider stays below 10%.
5. Recovery from simulated outage completes within 60s.

---

## Dependencies

- `@herobids/market-data` — TokenBucketRateLimiter (already exists)
- Provider mock infrastructure (to build)
- Report template (defined above)
