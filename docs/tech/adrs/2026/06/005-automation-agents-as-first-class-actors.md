# ADR 005: Automation Agents as First-Class Actors

Status: Proposed  
Date: 2026-06-16

## Context

HeroBids agents are currently LLM-only (`AgentTradingActor`). Every agent wake
cycle involves an LLM call costing $0.01–$0.10+. For users in cost-sensitive
markets (India, Pakistan, Nigeria — key target demographics with Hindi and Arabic
as first i18n languages), this per-decision cost is prohibitive for small accounts.

The old `aitradingbot` system proved that a rule-based mechanical strategy stack
(RSI, MACD, CHOCH, confidence scoring, regime gating) can discover and trade
across 20+ instruments at near-zero marginal cost. HeroBids has no equivalent.

The current alternatives are:
1. User manually creates N bots (must know instruments — violates "trade for me" UX)
2. AI Agent creates bots (works, but costs money per reasoning cycle)
3. No option for zero-cost multi-instrument automation

## Decision

Introduce **Automation Agents** as a second agent kind alongside AI Agents:

```
agents.agent_kind: 'ai' | 'automation'
```

An Automation Agent:
- Is a first-class actor with full agency (discovers, selects, trades)
- Uses rule-based intelligence (technical indicators, filters, regime gates)
- Operates on multiple instruments in a single scan loop
- Costs ~$0 per decision cycle (compute only, no LLM)
- Shares the same API surface as AI Agents (create/start/stop/status)
- Has its own config schema (`AutomationAgentConfigSchema`)
- Has its own runtime actor (`AutomationAgentActor`)

### Key Design Choices

**1. Same API, different runtime.**
Users create agents via `POST /agents` with `agent_kind` discriminator. The
worker instantiates the correct actor class. No separate endpoints.

**2. Config-driven intelligence.**
All "smart" behavior comes from config: which indicators to use, what thresholds,
how to weight confidence, which instruments to filter. No LLM involved.

**3. Shared execution infrastructure.**
Automation Agents reuse the same plan → order → fill pipeline as AI Agents and
bots. Position tracking, risk enforcement, and fill persistence are common.

**4. Discovery is built-in.**
Unlike bots (which must be told their instrument), Automation Agents discover
instruments using the existing market-data discovery pipeline (DexScreener,
GeckoTerminal, Hyperliquid asset list) filtered by user-specified criteria.

**5. Regime awareness is native.**
The existing `evaluateRegime()` function is called before each scan cycle. If
the market regime fails, new entries are blocked (existing positions still managed).

## Consequences

- Users in low-cost markets can run multi-instrument automation for near $0
- The product has a clear two-tier offering: AI (premium, flexible) vs Automation
  (free/cheap, config-driven, deterministic)
- Strategy-stack work (indicators, scan engine) has a clear home — it powers the
  Automation Agent's brain
- The "hybrid" use case (cheap pre-filter + expensive reasoning) becomes two
  cooperating agents rather than one monolithic strategy
- DB schema gains one column (`agent_kind`) — minimal migration
- AI Agent code path is completely unaffected
- Backtesting can evaluate Automation Agent configs using the same infrastructure
- Future presets ("conservative momentum", "aggressive breakout") can ship as
  default Automation Agent configs

## Alternatives Considered

**A. Multi-instrument bot with built-in discovery.**
Rejected because it conflates execution (bot's job) with agency (agent's job).
A bot that discovers instruments is really an agent mislabeled.

**B. AI Agent with aggressive caching to reduce cost.**
Partially viable but doesn't reach zero-cost. Caching helps but fundamentally
an LLM call is still required for each reasoning cycle.

**C. Strategy port expansion (multi-instrument Strategy interface).**
Rejected because the existing Strategy port serves bots well for single-instrument
evaluation. Adding multi-instrument capability to the port forces all strategies
to handle complexity they don't need. Better to have a separate ScanEngine
abstraction used by Automation Agents.
