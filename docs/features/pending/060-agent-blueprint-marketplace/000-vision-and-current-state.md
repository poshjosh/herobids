# Marketplace Discovery — Vision & Current State

**Status:** draft
**Created:** 2026-07-08

## Vision

Agents, bots, blueprints, and skills are **discoverable, rankable, copyable, and purchasable** in a marketplace. A user can browse ranked listings, find a trading strategy that resonates, fork it, and have a fully configured agent or bot running in minutes — with clear attribution back to the original creator.

## Objectives

1. **Template / instance split.** Redesign agent config, bot config, and blueprints around a clean boundary: templates contain only shareable, non-sensitive fields (strategy, skills, prompt, risk posture, technical config, style), while instances hold private runtime state (venue accounts, API keys, P&L, live positions, connection credentials). Blueprints become the unified template entity capable of faithfully recreating either an agent or a bot.

2. **Marketplace discovery.** Complete the blueprint data model to capture the full agent recipe — prompt, skills, style, strategy preset, risk posture, technical/intelligence config, execution mode, capital allocation — so that agents and blueprints can be ranked, filtered, browsed, forked, and purchased. Reuse the existing skill ranking infrastructure (popularity/trending scores, usage events, likes, forks) as the foundation.

---

## Current State

### Skills — Marketplace Already Built

The skills subsystem has a fully functional marketplace with ranking:

| Capability | Status | Details |
|-----------|:------:|---------|
| Publication lifecycle | ✅ | `draft → private → published → delisted → archived` |
| Pricing | ✅ | `priceCents` column; free and paid skills |
| Likes | ✅ | `skillLikes` table; `likeCount` column |
| Forks | ✅ | `forkCount` column; `forkOf` self-referencing FK for lineage |
| Popularity score | ✅ | 90-day rolling window: `0.45·log1p(users) + 0.25·log1p(likes) + 0.20·log1p(sessions) + 0.10·log1p(forks)` |
| Trending score | ✅ | Same formula, 30-day window |
| Usage events | ✅ | `skillUsageEvents` table tracks `session_started`, `fork_created` |
| Score recompute | ✅ | Hourly via `recomputeAllSkillScores()` |
| Indexed for sorting | ✅ | `idx_skills_popularity_score`, `idx_skills_trending_score` |
| UI metrics toggle | ✅ | "Show metrics" on Skills page |
| User ratings | ❌ | Not yet implemented (on the long-term list) |
| Agent quality signal | ❌ | No link between skill usage and agent evaluation scores |

### Blueprints — Bot-Only Templates

Blueprints exist but only template the **bot** layer, not the **agent** layer:

**What a blueprint captures today (`blueprints.configData` — JSONB):**

| Section | Fields |
|---------|--------|
| `strategy` | `type` (momentum/swing/scalper/range/contrarian/dca), `decisionMode` (mechanical/llm/hybrid), `params` |
| `risk` | `maxPositionSizePct`, `stopLossPct`, `takeProfitPct`, `maxDrawdownPct`, `maxLeverage`, `dailyMaxLossPct`, token safety filters |
| `execution` | `mode` (paper/shadow/live), `slippageBps` |
| Venue wiring | `venue`, `symbol`, `venueType`, `swapAssets`, `shadowPollIntervalMs` |

**What a blueprint does NOT capture:**

| Missing | Where it lives today |
|---------|---------------------|
| Prompt / goal | `agents.prompt` |
| Style (careful/balanced/bold) | `agents.style` |
| Skill assignments | `agentSkills` join table |
| Technical scan config (indicators, filters, candles, signal bias) | `agents.unifiedConfig.technical` |
| Intelligence config (LLM provider, model, wake interval) | `agents.unifiedConfig.intelligence` |
| Execution mode + position sizing | `agents.unifiedConfig.execution` + `agents.executionMode` |
| Risk guardrails (daily loss, max drawdown, max positions) | `agents` columns + `agents.unifiedConfig.risk` |
| Capital allocation | `agents.capital` |
| Strategy preset lineage | `agents.unifiedConfig.metadata.strategyPreset` |
| Marketplace metadata | Not present — no `publicationStatus`, `priceCents`, `likeCount`, `forkCount`, scores |

**Blueprint metadata columns are minimal:** `name`, `description`, `visibility` (private/public), `configVersion`. No marketplace lifecycle, no ranking.

**Blueprint ↔ Bot relationship:** A bot references a blueprint via `bots.blueprintId` and snapshots the config at creation time in `bots.configSnapshot`. Blueprints are versioned (`configVersion` incremented on PUT) but have no usage tracking — there is no way to know how many bots use a given blueprint, or how well those bots perform.

### Agents — Config Scattered Across Two Layers

An agent's full configuration is split between the `agents` table columns and the `unifiedConfig` JSONB:

```
agents table (typed columns)
├── prompt          — high-level goal/mission
├── style           — careful | balanced | bold
├── executionMode   — paper | shadow | live
├── dailyLossLimit  — rolling 24h realized-loss cap
├── maxDrawdownPct  — peak-to-current equity drawdown cap
├── maxDrawdown     — absolute USD drawdown (legacy)
├── maxBots         — max concurrent bots
├── maxSlippageBps  — allowed slippage
├── maxOpenPositions
├── maxPositionSizePct
├── stopLossPct
├── stopLossCooldownMs
├── tickIntervalMs  — base cadence
├── capital         — deployable allocation cap
├── riskOverrides   — JSONB: agent-adjusted risk fields
├── toolPolicy      — JSONB: per-capability tool grants
├── modelPolicy     — JSONB: LLM model config
└── unifiedConfig   — JSONB: see below

agents.unifiedConfig (JSONB)
├── technical
│   ├── filters        — venue, venueType, minVolume, minLiquidity, networks, symbols, excludeSymbols
│   ├── regime         — market regime detection params
│   ├── indicators     — RSI, MACD, Volume, S/R, VWAP, Price Action, CHoCH, confidence weights
│   ├── candles        — interval (5m–1D), limit
│   ├── signalBias     — trend-following | mean-reverting
│   ├── scanIntervalMs
│   ├── scanBatchSize
│   └── autonomousExit
├── intelligence
│   ├── provider       — LLM provider
│   ├── lightModel     — cheap/fast model
│   ├── heavyModel     — capable model for hard decisions
│   ├── maxTokens
│   └── wakeIntervalMs
├── execution
│   ├── mode           — paper | shadow | live
│   ├── positionSizeMode — fixed | percent_equity
│   └── fixedPositionSize
├── risk
│   ├── maxPositions
│   ├── maxPositionSizePct
│   ├── dailyMaxLossPct
│   ├── stopLossPct
│   └── takeProfitPct
└── metadata
    ├── strategyPreset       — e.g. "momentum", "swing" (only when preset used)
    ├── strategyPresetName   — display name
    ├── strategyPresetStyle  — economy | standard | premium
    └── strategyPresetSource — "agent-style"
```

**Key problems with this split:**

1. **No template/instance boundary.** Everything lives on the `agents` row. There is no concept of "this is my agent's shareable recipe" vs "this is my agent's private runtime state." To fork an agent, you'd need to manually pick which fields to copy and which to leave behind.

2. **Field duplication.** Risk fields appear in both `agents` columns (`stopLossPct`, `maxPositionSizePct`) AND `unifiedConfig.risk` (`stopLossPct`, `maxPositionSizePct`). Execution mode appears as both `agents.executionMode` and `unifiedConfig.execution.mode`.

3. **Strategy type is hidden.** When a preset is used, the strategy type (`momentum`, `swing`, etc.) is preserved only in `unifiedConfig.metadata.strategyPreset` — an untyped, unvalidated metadata sidecar. The `UnifiedAgentConfigSchema` has no `strategy` field. When the user chooses "Custom" in the UI, no strategy type is stored at all — the agent has a fully custom technical config with no categorical label. This makes it impossible to filter or browse agents by trading style.

4. **Custom agents have no lineage.** A custom agent's technical config is fully hand-crafted via `TechnicalConfigSection`. The values are valid and used by the runtime, but there is no record of *why* those values were chosen. The agent cannot be categorized, and reproducing it requires copying every individual field.

### Bot Config vs UnifiedAgentConfig — Overlap

The two config schemas overlap in risk and execution but serve different purposes:

| Concept | Bot Config (`BotConfigSchema`) | UnifiedAgentConfig |
|---------|-------------------------------|-------------------|
| **Purpose** | Concrete execution: "Trade SOL on Jupiter with momentum strategy" | Scanning philosophy: "Find momentum candidates on Solana DEXes" |
| Strategy type | `strategy.type` — first-class, validated | Only in `metadata.strategyPreset` — untyped |
| Decision mode | `strategy.decisionMode` — mechanical/llm/hybrid | Not present |
| Indicators | `strategy.params.indicators` | `technical.indicators` — same shape |
| Risk params | `risk.*` | `risk.*` — overlapping fields |
| Execution mode | `execution.mode` | `execution.mode` — duplicated |
| Venue + symbol | `venue`, `symbol` — concrete | `technical.filters.venue` — abstract |
| Market filters | Not present | `technical.filters.*` — volume, liquidity, networks |
| LLM config | Not present | `intelligence.*` |
| Scan cadence | Not present | `technical.scanIntervalMs` |

The overlap exists because the agent's `unifiedConfig` is *upstream* of the bot's config. The agent decides *what* to scan and *how* to evaluate it; the bot executes a *specific trade* on a *specific venue*. But the boundary is informal — nothing in the schema or code enforces it.

### Agent Evaluations — Quality Signal Exists but Is Sparse

Agent evaluations produce a 0–100 scorecard across 9 sections (session health, tool usage, cost, security, persistence, trading performance, trading behavior, market data, rate limits). However:

- Evaluations are on-demand (manual trigger, session stop, trade test) — most agents have no recent evaluation
- Scores are per-agent, per-session — not aggregated into a persistent "agent quality score"
- No evaluation-to-blueprint link exists (cannot say "blueprints used by high-scoring agents")
- Evaluation is gated by admin permission (no self-service for users)

### What's Missing — Summary

| Need | Status |
|------|:------:|
| Skills marketplace + ranking | ✅ Done |
| Blueprint marketplace + ranking | ❌ |
| Agent marketplace + ranking | ❌ |
| Unified template entity (blueprint = agent + bot recipe) | ❌ |
| Template/instance boundary | ❌ |
| Strategy type as queryable field | ❌ |
| Blueprint usage tracking | ❌ |
| Blueprint → agent evaluation link | ❌ |
| Fork lineage for agents/blueprints | ❌ |
| Agent quality score (persistent) | ❌ |
| Marketplace UI for agents/blueprints | ❌ |
| Paid blueprints (purchase flow) | ❌ |
