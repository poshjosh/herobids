# 002 - Agent Blueprint Marketplace Field Classification

**Status:** Post-harmonization canonical manifest
**Created:** 2026-08-01
**Harmonization completed:** 2026-08-01 (Plan 008)
**Depends on:** [003-target-state-brief.md](./003-target-state-brief.md), [004-adr-list.md](./004-adr-list.md), [002-agent-bot-config-harmonization-closure.md](../003-agent-bot-config-harmonization/002-agent-bot-config-harmonization-closure.md)
**Required by:** [003-agent-blueprint-marketplace-phase-1-implementation.md](../003-agent-bot-config-harmonization/003-agent-blueprint-marketplace-phase-1-implementation.md)
**Implements:** [ADR 002 — Template vs Instance Boundary](../../../../../tech/adrs/2026/08/002-template-vs-instance-boundary.md)

## Purpose

ADR 002 requires every behavior-affecting field to be classified as **template-eligible** or **instance-only** *before* projection implementation (WP4) is considered complete. This document is that classification manifest.

It is the single source of truth for what server-side projection copies into a blueprint and what it deliberately drops. Projection tests in WP4 must assert against this table field-by-field.

> **Post-harmonization status.** Plan 008 (config harmonization closure) is implemented at the domain layer. Nine superseded flat columns have been removed from the agents table (see [Plan 008 Column Removal Log](#plan-008-column-removal-log)). Canonical shared fields — `strategy` (StrategyIdentity | null), `risk` (RiskPosture | null), `executionDefaults` (ExecutionDefaults | null) — are now the authoritative sources. Every `unifiedConfig` branch has been classified and relocated or preserved per the [unifiedConfig Branch Classification](#unifiedconfig-branch-classification) below. This document is the canonical post-harmonization projection manifest. Plan 009 projection uses it as source of truth.

## Classification Rules

1. **Template-eligible** — authored recipe data that materially shapes behavior and contains no private binding, secret, or runtime-derived state. Copied into the blueprint payload.
2. **Instance-only** — private bindings, secrets, per-user delivery destinations, ownership, or runtime-derived state. Never copied into a published blueprint.
3. **Split** — a single stored field conflates authored recipe and runtime/private data. Projection must decompose it; the two halves are classified separately below.

## Decision: user-configured risk limits are template-eligible

The gray zone flagged in the Phase 1 critique (do user-configured limits such as `risk.dailyMaxLossPct` travel with the blueprint?) is resolved in [ADR 002, Amendment 1](../../../../../tech/adrs/2026/08/002-template-vs-instance-boundary.md#amendment-1--user-configured-risk-limits-are-template-eligible): they are **template-eligible**.

Summary of the ADR decision applied here:
1. The installer *chooses* the limit at the moment they choose to copy the agent or blueprint. Copying is consent to the recipe as authored, including its risk posture.
2. Risk posture is a defining characteristic of an agent recipe; stripping it produces a materially different copy, which ADR 002 explicitly forbids.
3. Agent-purity (AGENTS.md) is preserved: the copied limits become *the installer's own* user-configured limits on their new instance. They are immutable to the running agent, exactly as if the installer had typed them.

Guard: instantiation must surface the inherited limits to the installer, and the installer may edit the copied blueprint before or after instantiation (see "Editable copy" below). This keeps intent explicit without stripping behavior.

## Agent Fields

Source column names refer to [packages/db/src/schema/agents.ts](../../../../../../packages/db/src/schema/agents.ts).

### Canonical Columns (Post-Harmonization)

| Field | Source | Classification | Notes |
|---|---|---|---|
| `id` | column | instance-only | identity |
| `userId` | column | instance-only | ownership |
| `name` | column | template-eligible | copied as default; installer may rename |
| `style` | column | template-eligible | promoted to blueprint column for filter/sort |
| `prompt` | column | template-eligible | the goal/recipe |
| `runtimePolicyOverrides` | column | template-eligible | creator-set deviations from style defaults |
| `toolPolicy` | column | template-eligible | capability grants shape behavior; hold no secrets |
| `modelPolicy` | column | template-eligible | model/LLM selection; credentials live in `connections`, not here |
| `strategy` | column | template-eligible | `StrategyIdentity \| null`; canonical shared field; optional for non-trading agents |
| `risk` | column | **split** → template-eligible (raw) | `RiskPosture \| null`; canonical shared field; raw nullable creator posture; resolved effective profile is instance-only (see [Split-Field Handling](#split-field-handling)) |
| `executionDefaults` | column | template-eligible | `ExecutionDefaults \| null`; canonical shared field; replaces removed `executionMode` column |
| `capital` | column | template-eligible | agent-only retained; default/suggestion; installer confirms at instantiate |
| `maxBots` | column | template-eligible | agent-only retained; max concurrent bots |
| `tickIntervalMs` | column | template-eligible | agent-only retained; cadence is behavioral |
| `riskOverrides` | column | instance-only | runtime mutation state; `AgentRiskOverrides \| null`; agent self-adjustment, never creator configuration |
| `wakePreferences` | column | template-eligible | wake-source subscriptions are behavioral, not private |
| `openPositionEscalationToJudgePolicy` | column | template-eligible | behavioral policy |
| skill assignments | join table | template-eligible | skill IDs are shareable references |
| `unifiedConfig` (authored technical/intelligence/execution config) | column | **split** → template-eligible | the authored half of the recipe (preserved branches per [unifiedConfig Branch Classification](#unifiedconfig-branch-classification)) |
| `unifiedConfig` (agent runtime self-adjustments) | column | **split** → instance-only | overrides the running agent set for itself |
| `notificationPolicy` | column | instance-only | per-user delivery preference tied to the installer's channels |
| `telegramChatId` | column | instance-only | private destination (ADR 002) |
| `status` | column | instance-only | runtime |
| `pauseState` | column | instance-only | runtime |
| connection IDs / venue account bindings | `agent_connections` | instance-only | private bindings (ADR 002) |
| credentials / secret references | `connections` | instance-only | secrets (ADR 002) |
| open positions, fills, P&L, analytics | derived | instance-only | runtime-derived (ADR 002) |
| `createdAt`, `updatedAt` | column | instance-only | row metadata |

### Removed Columns (Plan 008)

These 9 columns were superseded by canonical shared fields and removed. They must not appear in API shapes, repository methods, worker runtime paths, or projection code.

| Column | DB Name | Superseded By |
|---|---|---|
| `executionMode` | `execution_mode` | `executionDefaults.mode` |
| `dailyLossLimit` | `daily_loss_limit` | `risk.dailyMaxLossPct` |
| `maxDrawdownPct` | `max_drawdown_pct` | `risk.maxDrawdownPct` |
| `maxDrawdown` | `max_drawdown` | `risk.maxDrawdownPct` (percentage replaces absolute) |
| `maxSlippageBps` | `max_slippage_bps` | `executionDefaults.slippageBps` |
| `maxOpenPositions` | `max_open_positions` | `risk.maxOpenPositions` |
| `maxPositionSizePct` | `max_position_size_pct` | `risk.maxPositionSizePct` |
| `stopLossPct` | `stop_loss_pct` | `risk.stopLossPct` |
| `stopLossCooldownMs` | `stop_loss_cooldown_ms` | `risk.stopLossCooldownMs` |

## unifiedConfig Branch Classification

Every `unifiedConfig` branch has been classified post-harmonization. Branches marked "preserve" remain in `unifiedConfig` as authored recipe content. Branches marked "relocated" have been moved to their canonical destination and must not be read from or written to `unifiedConfig`. Branches marked "remove" have been deleted.

| Branch | Destination | Status |
|---|---|---|
| `technical` | `unifiedConfig.technical` | **preserve** |
| `intelligence` | `unifiedConfig.intelligence` | **preserve** |
| `capabilityMode` | `unifiedConfig.capabilityMode` | **preserve** |
| `hybridMode` | `unifiedConfig.hybridMode` | **preserve** |
| `execution.mode` | → `executionDefaults.mode` | relocated, then removed from `unifiedConfig` |
| `execution.positionSizeMode` | → `unifiedConfig.executionPolicy.positionSizeMode` | relocated |
| `execution.fixedPositionSize` | → `unifiedConfig.executionPolicy.fixedPositionSize` | relocated |
| `risk.maxPositions` | → canonical `risk.maxOpenPositions` | relocated, then removed from `unifiedConfig` |
| `risk.maxPositionSizePct` | → canonical `risk.maxPositionSizePct` | relocated, then removed from `unifiedConfig` |
| `risk.dailyMaxLossPct` | → canonical `risk.dailyMaxLossPct` | relocated, then removed from `unifiedConfig` |
| `risk.stopLossPct` | → canonical `risk.stopLossPct` | relocated, then removed from `unifiedConfig` |
| `risk.takeProfitPct` | → `unifiedConfig.executionPolicy.takeProfitPct` | relocated |
| `allowedPresets` | `unifiedConfig.allowedPresets` | **preserve** |
| `presetTransition` | `unifiedConfig.presetTransition` | **preserve** |
| `platformAssessment` | `unifiedConfig.platformAssessment` | **preserve** |
| `authorizationMode` | `unifiedConfig.authorizationMode` | **preserve** |
| `metadata.strategyPreset` | superseded by `agents.strategy` | **remove** |
| `metadata.strategyPresetName` | superseded by `agents.strategy` | **remove** |
| `metadata.strategyPresetStyle` | superseded by `agents.strategy` | **remove** |
| `metadata.strategyPresetSource` | superseded by `agents.strategy` | **remove** |
| `metadata.skillPresetId` | `unifiedConfig.metadata.skillPresetId` | **preserve** until exact skill references replace it |

### Post-harmonization unifiedConfig Layout

After all relocations and removals, the `unifiedConfig` column contains only these branches:

```
unifiedConfig
├── technical
├── intelligence
├── capabilityMode
├── hybridMode
├── executionPolicy
│   ├── positionSizeMode
│   ├── fixedPositionSize
│   └── takeProfitPct
├── allowedPresets
├── presetTransition
├── platformAssessment
├── authorizationMode
└── metadata
    └── skillPresetId
```

## Plan 008 Column Removal Log

The following 9 superseded flat columns were removed from `agents` during Plan 008 execution. No runtime code reads or writes them. Migration SQL drops them from the database.

| # | Column | DB Name | Canonical Replacement |
|---|---|---|---|
| 1 | `executionMode` | `execution_mode` | `executionDefaults.mode` |
| 2 | `dailyLossLimit` | `daily_loss_limit` | `risk.dailyMaxLossPct` |
| 3 | `maxDrawdownPct` | `max_drawdown_pct` | `risk.maxDrawdownPct` |
| 4 | `maxDrawdown` | `max_drawdown` | `risk.maxDrawdownPct` (percentage replaces absolute USD) |
| 5 | `maxSlippageBps` | `max_slippage_bps` | `executionDefaults.slippageBps` |
| 6 | `maxOpenPositions` | `max_open_positions` | `risk.maxOpenPositions` |
| 7 | `maxPositionSizePct` | `max_position_size_pct` | `risk.maxPositionSizePct` |
| 8 | `stopLossPct` | `stop_loss_pct` | `risk.stopLossPct` |
| 9 | `stopLossCooldownMs` | `stop_loss_cooldown_ms` | `risk.stopLossCooldownMs` |

`maxBots`, `capital`, and `tickIntervalMs` are agent-only fields that remain in the schema.

## Bot Fields

Source column names refer to [packages/db/src/schema/bots.ts](../../../../../../packages/db/src/schema/bots.ts).

| Field | Source | Classification | Notes |
|---|---|---|---|
| `config` (strategy params, execution mode, risk) | column | template-eligible | the bot recipe |
| `config.strategy.type` | column path | template-eligible | strategy identity; promoted to blueprint column |
| `venueAccountId` | column | instance-only | private binding |
| `connectionId` | column | instance-only | private binding |
| `configSnapshot` | column | instance-only | audit snapshot of a specific instantiation |
| `blueprintId` | column | attribution | lineage pointer, not recipe content |
| `blueprintRevisionId` | column | attribution | exact revision instantiated (added for symmetry with agents) |
| `status`, `startedAt`, `stoppedAt` | column | instance-only | runtime |
| `creatorType`, `creatorId` | column | instance-only | ownership/provenance |
| `userId` | column | instance-only | ownership |

## Split-Field Handling

Four fields require decomposition rather than a straight include/exclude. Projection helpers must handle these explicitly and tests must cover both halves:

1. **`unifiedConfig`** — separate authored technical/intelligence/executionPolicy/preset config (template-eligible) from agent runtime self-adjustments (instance-only). The runtime-set portion is identified the same way `riskOverrides` is: it is state the agent wrote for itself, not authored recipe. See [unifiedConfig Branch Classification](#unifiedconfig-branch-classification) for the exact branches preserved vs removed.

2. **`risk`** — raw nullable `RiskPosture` (template-eligible) vs resolved effective profile (instance-only). The raw column stores exactly what the creator configured or `null` (use operator defaults). The resolved effective profile is computed at runtime from raw + operator defaults + `riskOverrides` — it is instance-only and must never leak into a blueprint payload. Projection copies the raw column as-is; the installer's instance recomputes its own effective profile from the copied raw posture plus its own operator defaults.

3. **`executionDefaults.mode`** — recorded in the blueprint but never auto-applied as `live`. Instantiation defaults to `paper` unless the installer supplies a live connection binding and explicitly opts in. This replaces the removed `executionMode` flat column.

4. **`notificationPolicy`** — the enable/disable *preference* is not portable because it is meaningless without the installer's own delivery channels; treated as instance-only in full.

## Editable Copy

To keep installer intent explicit without stripping behavior:

1. Instantiation returns the fully-resolved template-eligible field set to the client for review.
2. The installer may edit the copied values (including inherited risk limits) before creating the instance.
3. A deeper "fork and edit the blueprint itself" authoring flow may land in Milestone B or Phase 2; the review-and-edit-at-instantiate path is the Phase 1 minimum.

## Verification Hook

Plan 009 Milestone A projection tests must, for each row in the post-Plan-008 rewrite:
1. assert every template-eligible field survives save-as-blueprint,
2. assert every instance-only field is absent from the stored blueprint payload,
3. assert each split field is decomposed correctly (authored half present, runtime/private half absent).
