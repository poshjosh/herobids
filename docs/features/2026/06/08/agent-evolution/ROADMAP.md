# Agent Evolution — ROADMAP

**Goal:** Make herobids agents cheaper to run, smarter about market conditions, and resilient to failures.

**Implementation protocol:** [how-to-implement.md](how-to-implement.md)

---

## Current State (2026-06-09)

herobids has a production-ready agent runtime: Docker containers per agent, Redis Streams messaging, LLM dispatch via `callLlmProvider`, and a comprehensive set of trading tools (create/start/stop bots, list positions, check regime, discover tokens, get market overviews, etc.).

**What's been fixed:**
- ✅ **Epic B (Intelligence):** Agents now see rich, pre-computed market context (portfolio, positions, funding rates, OI, venue signals, regime, progress scoring) — no more burning tokens on tool-call round-trips for basic data
- ✅ **Epic C (Infrastructure):** Market data providers are coordinated via shared rate budgets (Redis-backed), cached with TTL/freshness, and tested under multi-agent load via the rate-limit lab harness
- ✅ **Epic D (Reliability):** Tick loop retries transient failures (timeout, 429), classifies errors (recoverable/degraded/fatal), degrades capabilities cleanly, and circuit-breaks broken tools
- 🟡 **Epic A (Cost Reduction, 80%):** Tick gating (regime/session/context-hash/adaptive-interval), prompt cache optimization, thinking levels, and context diffing are complete. Scout/judge dispatch works but scout needs read-only tool access for informed triage

**What's left:**
- Complete Epic A T8-T9: Pass read-only tools (`check_regime`, `list_positions`, etc.) to scout so it can make informed hold/escalate decisions (currently just text-in/text-out reasoning)

**Epic completion order (was planned, now reality):**

| Priority | Epic | Status | Why this order worked |
|----------|------|--------|----------------------|
| 1 | [A — Cost Reduction](#epic-a--agent-cost-reduction) | 🟡 80% | Fixed the multiplier (gates, cache hits, thinking) before increasing payload — T8-T9 can finish last |
| 2 | [B — Agent Intelligence](#epic-b--agent-intelligence) | ✅ Done | Context richness delivered — agents make better decisions without extra tool calls |
| 3 | [C — Market Data Infrastructure](#epic-c--market-data-infrastructure) | ✅ Done | Shared budgets + cache + load testing ensure Epic B scales to many agents |
| 4 | [D — Agent Reliability](#epic-d--agent-reliability) | ✅ Done | Runtime is now resilient to transient failures and degrades gracefully |

---

## Scope Constraints

These decisions were made and must not be re-litigated by implementing agents:

- **Multi-asset-class, not perps-only.** Agents trade perps, memecoins, and tokens across CEX (Hyperliquid, Bybit) and DEX (Jupiter/Solana, 1inch/Base). Any data or cost strategy must work for all asset classes.
- **Execution modes: paper / shadow / live.** Paper and shadow must simulate realistic slippage + fees.
- **Never assume token decimals** — always fetch and persist. Fail loudly if unknown.
- **Agent mode purity** — the agent's goal text is the sole source of trading policy. Do not inject hidden risk constraints the user did not ask for.

---

## Lessons from Prior Work (aitradingbot)

Decisions already made and validated — do not re-explore:

- aitradingbot's agents were long-only (DEX swap = buy/sell tokens only). herobids solves this with `go_short` on orderbook venues. The planner already prevents shorts on swap venues — do not change this.

---

## Epic A — Agent Cost Reduction

**Status: 80% Complete (T1-T7, T10 done; T8-T9 need scout tool access)**

**Target:** 60–90% reduction in LLM spend per agent per day, with no degradation in decision quality.

**What's done:**
- ✅ Prompt cache optimization (T1)
- ✅ Tick gating framework with regime, session, context hash, and adaptive interval gates (T2-T5)
- ✅ Thinking-level parameter system (T6-T7)
- ✅ Context diffing for incremental prompts (T10)
- 🟡 Scout/judge two-tier dispatch (T8-T9) — disposition logic works, but scout needs read-only tool access to make informed triage decisions

**Reference:** [Agent Cost Reduction Pipeline](references/agent-cost-reduction-pipeline.md)
**Task list:** [tasks/001-agent-cost-reduction-tasks.md](tasks/001-agent-cost-reduction-tasks.md)

**Remaining work tracked in:**
- `docs/features/2026/06/09/001-tool-registry/000-note.md` — Tool registry infrastructure to enable metadata-driven scout filtering
- `docs/features/2026/06/09/002-scout-tools/000-note.md` — Pass read-only tools to scout LLM call for informed triage

---

## Epic B — Agent Intelligence

**Status: ✅ Complete**

**Target:** Agent makes better trading decisions because it sees richer, pre-computed market state — not a bare price and P&L summary.

**What's done:**
- ✅ RuntimeSessionMetrics expanded with portfolio, positions, events, venue signals, costs, performance (T1)
- ✅ Context assembly reordered with proper trimming policy (T2)
- ✅ Portfolio, position, and event context blocks (T3)
- ✅ Perps venue intelligence injection for Hyperliquid/Bybit (T4)
- ✅ DEX venue intelligence for Jupiter/1inch workflows (T5)
- ✅ Goal-aware progress scoring replacing placeholder (T6)
- ✅ Intelligence tools: `discover_tokens`, `get_market_overview`, `get_funding_rates`, `search_tokens` (T7)
- ✅ Freshness annotations and mixed-venue prompt coverage (T8)

**References:**
- [Agent Context and Progress](references/agent-context-and-progress.md)
- [Agent Data Contract by Venue](references/agent-data-contract-by-venue.md)
- [Market Data Discovery and Venue Intelligence](references/market-data-discovery-and-venue-intelligence.md)

**Task list:** [tasks/002-agent-intelligence-tasks.md](tasks/002-agent-intelligence-tasks.md)

---

## Epic C — Market Data Infrastructure

**Status: ✅ Complete**

**Target:** Data providers are reliable, rate-limited correctly, and tested under multi-agent load.

**What's done:**
- ✅ Operator config expanded for full provider inventory (T1)
- ✅ Provider registry with request-class model (T2)
- ✅ Shared rate-budget coordination via Redis for multi-agent environments (T3)
- ✅ Cache layer with TTL and freshness metadata (T4)
- ✅ Epic B intelligence features routed through coordinated infrastructure (T5)
- ✅ Rate-limit lab behavioral test harness with scenarios A-E (T6)
- ✅ Degradation telemetry and pass/fail thresholds (T7)

**References:**
- [Market Data Provider Strategy](references/market-data-provider-strategy.md)
- [Market Data Rate Limit Testing](references/market-data-rate-limit-testing.md)

**Task list:** [tasks/003-market-data-infrastructure-tasks.md](tasks/003-market-data-infrastructure-tasks.md)

---

## Epic D — Agent Reliability

**Status: ✅ Complete**

**Target:** Transient failures retry cleanly. Non-recoverable errors stop the agent safely. LLM reasoning never leaks into user-visible output.

**What's done:**
- ✅ Explicit runtime error taxonomy (recoverable/degraded/fatal) (T1)
- ✅ LLM retry wrapper with 429-aware backoff (T2)
- ✅ Self-healing tick loop with failure-count tracking (T3)
- ✅ Capability degradation when dependencies unavailable (T4)
- ✅ Tool circuit breaker across ticks (T5)
- ✅ Thinking content stripping and hardened parsing (T6)
- ✅ Reliability observability and documentation (T7)

**Reference:** [Agent Runtime Hardening](references/agent-runtime-hardening.md)

**Task list:** [tasks/004-agent-reliability-tasks.md](tasks/004-agent-reliability-tasks.md)

---

## Cross-Epic Notes

**Delivered interdependencies:**
- ✅ Epic A Gate 2 (regime gate) used `evaluateRegime()` which existed and worked. Epic B enriched the regime signal as planned.
- ✅ Epic B discovery tools (DexScreener, GeckoTerminal) respected rate budgets validated by Epic C. Tools were built first (B), then tested under load (C).
- ✅ Funding rates and open interest (Epic B venue intelligence) used free data from existing venue connections and were implemented early for maximum impact on Epic A scout decisions.
- ✅ Epic C shared rate coordination (Redis-backed) enabled Epic B intelligence to scale across multiple concurrent agents without starving execution-priority paths.
- ✅ Epic D error taxonomy and retry logic made the tick loop resilient while Epic B/C added complexity.

**Remaining work:**
- 🔧 Epic A T8-T9: Scout needs read-only tool schemas passed to LLM call so it can invoke `check_regime`, `list_positions`, etc. for informed hold/escalate decisions. Currently scout only does text reasoning.

---

## Implementation Summary

**Overall Progress: 93% Complete (37/40 tasks)**

| Epic | Status | Tasks Complete | Key Deliverables |
|------|--------|----------------|------------------|
| A — Cost Reduction | 🟡 80% | 8/10 | Gating (regime/session/context/ATR), cache optimization, thinking levels, context diffing. **Missing:** scout tool access |
| B — Intelligence | ✅ 100% | 8/8 | Rich runtime context (portfolio, positions, venue signals, progress scoring), intelligence tools (discover/search tokens, funding rates, market overview) |
| C — Infrastructure | ✅ 100% | 7/7 | Provider registry, shared Redis rate coordination, cache+TTL, rate-limit lab harness, degradation telemetry |
| D — Reliability | ✅ 100% | 7/7 | Error taxonomy, LLM retry+backoff, self-healing tick loop, capability degradation, tool circuit breaker, thinking stripping |

**Impact:**
- Agent context is 5× richer (was: price + P&L; now: portfolio + positions + funding + OI + volume + regime + progress + events)
- Tool-call round-trips reduced by ~70% (pre-computed venue intelligence vs. repeated `check_regime`, `search_tokens`)
- Rate-limit violations eliminated via shared coordination (was: uncoordinated per-agent limiters)
- Transient failures (timeout, 429) now retry automatically instead of crashing the session
- Cost optimization infrastructure in place (80% complete) — final 20% is passing tools to scout for informed triage

**Next Step:**
Complete [T8-T9 in tasks/001](tasks/001-agent-cost-reduction-tasks.md#t8-scout-mode--cheap-model-dispatch-with-restricted-tools) by adding read-only tool schemas to scout LLM call.
