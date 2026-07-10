# Marketplace Discovery — Vision & Current State

**Status:** draft
**Created:** 2026-07-08
**Revised:** 2026-07-10 — added operational policy layer analysis

## Vision

Agents, bots, blueprints, and skills are **discoverable, rankable, copyable, and purchasable** in a marketplace. A user can browse ranked listings, find a trading strategy that resonates, fork it, and have a fully configured agent or bot running in minutes — with clear attribution back to the original creator.

## Objectives

1. **Template / instance split.** Redesign agent config, bot config, and blueprints around a clean boundary: templates contain only shareable, non-sensitive fields (strategy, skills, prompt, risk posture, technical config, style, operational policies), while instances hold private runtime state (venue accounts, API keys, P&L, live positions, connection credentials). Blueprints become the unified template entity capable of faithfully recreating either an agent or a bot.

2. **Operational completeness.** A copied agent must work out of the box — no hidden configuration that the user has to discover. If the original agent can send emails, the copy must be able to send emails. If the original agent has wake preferences, the copy must inherit them. The blueprint must capture the full operational policy surface, not just the strategy and risk config.

3. **Marketplace discovery.** Complete the blueprint data model to capture the full agent recipe — prompt, skills, style, strategy preset, risk posture, technical/intelligence config, execution mode, capital allocation, operational policies — so that agents and blueprints can be ranked, filtered, browsed, forked, and purchased. Reuse the existing skill ranking infrastructure (popularity/trending scores, usage events, likes, forks) as the foundation.

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
| Operational policies (notification, wake, escalation) | `agents` top-level columns — see Operational Policy Layer below |
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

5. **Operational policies are invisible.** Several top-level agent columns control whether features actually work (email delivery, wake sources, escalation behavior, runtime tuning). These are not part of `unifiedConfig`, not part of blueprints, and have no UI in the create/edit agent form. A copied agent silently lacks these policies — the user has no way to know why their copy behaves differently from the original.

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

### Operational Policy Layer — Hidden Agent Columns

Beyond `unifiedConfig` and the risk/execution typed columns, agents have a third layer of configuration: **operational policy columns**. These are top-level JSONB or text columns on the `agents` table that control whether features actually function at runtime. They are not part of any config schema, not visible in any UI, and not captured by blueprints.

**Discovery context:** On 2026-07-10, a user asked their agent to send them an email. The agent correctly called `send_message` with `emailDelivery: "if_allowed"`. The email was silently blocked because: (a) the agent's `notificationPolicy` was `NULL` (email not enabled), and (b) the broker rejects `messageClass: "routine"` for email delivery. Neither of these policies is visible to the user or the agent. There is no UI to configure `notificationPolicy`. The user experienced "my agent can't email me" with zero feedback about why.

This is not just a `notificationPolicy` problem — it reveals a category of agent state that is invisible to users and would be silently lost when copying an agent.

**Operational policy columns (template-eligible):**

| Column | Purpose | Has UI? | Should be in blueprint? |
|--------|---------|:-------:|:-----------------------:|
| `notificationPolicy` | Controls email fanout for `send_message` | ❌ No UI | ✅ Yes |
| `wakePreferences` | Which market signals wake this agent | ✅ In create form | ✅ Yes |
| `openPositionEscalationToJudgePolicy` | When to escalate open positions to judge | ✅ In create form | ✅ Yes |
| `runtimePolicyOverrides` | Per-agent runtime tuning (scout/judge turns, thinking tokens, budgets) | ✅ In create form | ✅ Yes |
| `style` | Personality hint (careful/balanced/bold) | ✅ In create form | ✅ Yes |
| `toolPolicy` | Per-capability tool grants | ❌ API only | ✅ Yes |
| `modelPolicy` | LLM model configuration | ❌ API only | ✅ Yes |

**Operational policy columns (instance-only, NOT template-eligible):**

| Column | Purpose | Why not in blueprint |
|--------|---------|---------------------|
| `telegramChatId` | User's private messaging destination | Private — each user has their own |
| `riskOverrides` | Agent's self-adjusted risk fields at runtime | Ephemeral runtime state |
| `pauseState` | Why and when the agent was paused | Runtime state |

**Key insight for blueprints:** A blueprint that captures strategy, risk, and execution but omits operational policies will produce a copy that *looks* right but *behaves* differently. The original agent emails the user on alerts; the copy silently doesn't. The original agent wakes on regime changes; the copy ignores them. This is worse than a missing feature — it's a silent degradation that the user cannot diagnose.

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
| Operational policies in blueprint | ❌ — `notificationPolicy`, `wakePreferences`, `runtimePolicyOverrides`, etc. not captured |
| UI for `notificationPolicy` | ❌ — no create/edit form field; API-only |
| Strategy type as queryable field | ❌ |
| Blueprint usage tracking | ❌ |
| Blueprint → agent evaluation link | ❌ |
| Fork lineage for agents/blueprints | ❌ |
| Agent quality score (persistent) | ❌ |
| Marketplace UI for agents/blueprints | ❌ |
| Paid blueprints (purchase flow) | ❌ |

### UX Issues Discovered During Email Testing (2026-07-10)

These are not marketplace blockers but affect the "copied agent works out of the box" objective:

1. **`notificationPolicy` has no UI.** The only way to enable email for an agent is `PATCH /api/agents/:id` with `notificationPolicy.sendMessage.email.enabled: true`. Users cannot discover or configure this.

2. **`messageClass` gates email silently.** The broker rejects email for `messageClass: "routine"` even when the agent explicitly sets `emailDelivery: "if_allowed"`. The user's intent ("email me") is overridden by an internal classification. When `emailDelivery` is explicitly `"if_allowed"`, `messageClass` should not block delivery.

3. **No feedback on email skip.** When email is blocked by policy, the agent gets `{ success: true, note: "message queued for delivery" }` — the same response as a successful send. Neither the user nor the agent knows the email was suppressed.
