# Agent Evolution — ROADMAP

**Goal:** Make herobids agents cheaper to run, smarter about market conditions, and resilient to failures.

**Implementation protocol:** [how-to-implement.md](how-to-implement.md)

---

## Current State (2026-06-08)

herobids has a working agent runtime: Docker containers per agent, Redis Streams messaging, LLM dispatch via `callLlmProvider`, and a set of trading tools (create/start/stop bots, list positions, check regime, etc.).

**What's broken:**
- Every agent tick fires the LLM unconditionally — ~80% of ticks result in "hold" and waste $0.01–$0.10 each
- The agent's context is minimal: it sees little market data and must burn tool calls (extra tokens + round-trips) to get basic information
- The tick loop has no retry logic, no error classification — a transient timeout and a revoked API key are treated the same way

**What we're fixing, in order:**

| Priority | Epic | Why this order |
|----------|------|---------------|
| 1 | [A — Cost Reduction](#epic-a--agent-cost-reduction) | Existential. Epic B increases context richness (more tokens) — if we haven't cut call frequency first, costs compound. Fix the multiplier before increasing the payload. |
| 2 | [B — Agent Intelligence](#epic-b--agent-intelligence) | Directly improves decision quality and *also* reduces costs (pre-computed context = fewer tool call round-trips). High ROI. |
| 3 | [C — Market Data Infrastructure](#epic-c--market-data-infrastructure) | The data layer that makes Epic B possible at scale across multiple concurrent agents. |
| 4 | [D — Agent Reliability](#epic-d--agent-reliability) | The system currently works — it just isn't resilient. Lower urgency than the above. |

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

**Status: Active**

**Target:** 60–90% reduction in LLM spend per agent per day, with no degradation in decision quality.

**Reference:** [Agent Cost Reduction Pipeline](references/agent-cost-reduction-pipeline.md)
**Task list:** [tasks/001-agent-cost-reduction-tasks.md](tasks/001-agent-cost-reduction-tasks.md)
**Start here:** T1 or T6.

---

## Epic B — Agent Intelligence

**Status: Not started — begins when Epic A is substantially complete (T1–T7 done)**

**Target:** Agent makes better trading decisions because it sees richer, pre-computed market state — not a bare price and P&L summary.

**What changes:**
- Tick context includes funding rates, open interest, venue-specific signals, regime summary — pre-computed, not fetched via tool calls
- Agent has a progress score telling it how it's doing relative to its goal
- Discovery tools expose trending/new tokens across DEX and CEX

**References:**
- [Agent Context and Progress](references/agent-context-and-progress.md) — what data must be in every tick prompt
- [Agent Data Contract by Venue](references/agent-data-contract-by-venue.md) — per-venue data catalog and freshness rules
- [Market Data Discovery and Venue Intelligence](references/market-data-discovery-and-venue-intelligence.md) — how to build new data sources (funding, OI, DexScreener, GeckoTerminal)

**Task list:** [tasks/002-agent-intelligence-tasks.md](tasks/002-agent-intelligence-tasks.md) *(to be populated)*

---

## Epic C — Market Data Infrastructure

**Status: Not started — begins when Epic B is in progress**

**Target:** Data providers are reliable, rate-limited correctly, and tested under multi-agent load.

**References:**
- [Market Data Provider Strategy](references/market-data-provider-strategy.md) — full provider map, free vs paid tiers, Birdeye integration plan
- [Market Data Rate Limit Testing](references/market-data-rate-limit-testing.md) — multi-agent load test harness

**Task list:** [tasks/003-market-data-infrastructure-tasks.md](tasks/003-market-data-infrastructure-tasks.md) *(to be populated)*

---

## Epic D — Agent Reliability

**Status: Not started — begins when Epic B is substantially complete**

**Target:** Transient failures retry cleanly. Non-recoverable errors stop the agent safely. LLM reasoning never leaks into user-visible output.

**Reference:** [Agent Runtime Hardening](references/agent-runtime-hardening.md)

**Task list:** [tasks/004-agent-reliability-tasks.md](tasks/004-agent-reliability-tasks.md) *(to be populated)*

---

## Cross-Epic Notes

- Epic A Gate 2 (regime gate) already uses `evaluateRegime()` which exists and works. Epic B will enrich the regime signal further — this improves scout accuracy but does **not** block Epic A.
- Epic B discovery tools (DexScreener, GeckoTerminal) must respect rate budgets that Epic C validates. Build the tools first (B), test under load second (C).
- Funding rates and open interest (Epic B, Part A of the discovery plan) are free data from existing venue connections — implement these early in Epic B for maximum impact on Epic A scout decisions.
