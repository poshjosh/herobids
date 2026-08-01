# 002 - Agent Blueprint Marketplace Field Classification

**Status:** Draft
**Created:** 2026-08-01
**Depends on:** [003-target-state-brief.md](./003-target-state-brief.md), [004-adr-list.md](./004-adr-list.md)
**Implements:** [ADR 002 — Template vs Instance Boundary](../../../../../tech/adrs/2026/08/002-template-vs-instance-boundary.md)

## Purpose

ADR 002 requires every behavior-affecting field to be classified as **template-eligible** or **instance-only** *before* projection implementation (WP4) is considered complete. This document is that classification manifest.

It is the single source of truth for what server-side projection copies into a blueprint and what it deliberately drops. Projection tests in WP4 must assert against this table field-by-field.

> **Note on representation.** The template-eligible strategy, risk, and execution fields below are expressed through the shared `StrategyIdentity`, `RiskPosture`, and `ExecutionDefaults` value objects delivered by the [config harmonization prerequisite](../003-agent-bot-config-harmonization/001-plan.md). After that work lands, the scattered agent risk columns referenced in this table are replaced by those typed structures; the classification (template-eligible vs instance-only) is unchanged.

## Classification Rules

1. **Template-eligible** — authored recipe data that materially shapes behavior and contains no private binding, secret, or runtime-derived state. Copied into the blueprint payload.
2. **Instance-only** — private bindings, secrets, per-user delivery destinations, ownership, or runtime-derived state. Never copied into a published blueprint.
3. **Split** — a single stored field conflates authored recipe and runtime/private data. Projection must decompose it; the two halves are classified separately below.

## Decision: user-configured risk limits are template-eligible

The gray zone flagged in the Phase 1 critique (do user-configured limits such as `dailyLossLimit` travel with the blueprint?) is resolved in [ADR 002, Amendment 1](../../../../../tech/adrs/2026/08/002-template-vs-instance-boundary.md#amendment-1--user-configured-risk-limits-are-template-eligible): they are **template-eligible**.

Summary of the ADR decision applied here:
1. The installer *chooses* the limit at the moment they choose to copy the agent or blueprint. Copying is consent to the recipe as authored, including its risk posture.
2. Risk posture is a defining characteristic of an agent recipe; stripping it produces a materially different copy, which ADR 002 explicitly forbids.
3. Agent-purity (AGENTS.md) is preserved: the copied limits become *the installer's own* user-configured limits on their new instance. They are immutable to the running agent, exactly as if the installer had typed them.

Guard: instantiation must surface the inherited limits to the installer, and the installer may edit the copied blueprint before or after instantiation (see "Editable copy" below). This keeps intent explicit without stripping behavior.

## Agent Fields

Source column names refer to [packages/db/src/schema/agents.ts](../../../../../../packages/db/src/schema/agents.ts).

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
| `executionMode` | column | template-eligible (guarded) | recorded in blueprint, but instantiation forces `paper` unless the installer supplies a live connection binding and opts in |
| `tickIntervalMs` | column | template-eligible | cadence is behavioral |
| `capital` | column | template-eligible | default/suggestion only; installer confirms at instantiate |
| `dailyLossLimit` | column | template-eligible | see risk-limit decision above |
| `maxDrawdownPct` | column | template-eligible | see risk-limit decision above |
| `maxDrawdown` | column | template-eligible | see risk-limit decision above |
| `maxBots` | column | template-eligible | see risk-limit decision above |
| `maxSlippageBps` | column | template-eligible | see risk-limit decision above |
| `maxOpenPositions` | column | template-eligible | see risk-limit decision above |
| `maxPositionSizePct` | column | template-eligible | see risk-limit decision above |
| `stopLossPct` | column | template-eligible | see risk-limit decision above |
| `stopLossCooldownMs` | column | template-eligible | see risk-limit decision above |
| `wakePreferences` | column | template-eligible | wake-source subscriptions are behavioral, not private |
| `openPositionEscalationToJudgePolicy` | column | template-eligible | behavioral policy |
| skill assignments | join table | template-eligible | skill IDs are shareable references |
| strategy identity | `unifiedConfig` metadata today | template-eligible | promoted to first-class typed field + blueprint column (WP1/WP2) |
| `unifiedConfig` (authored technical/intelligence/execution config) | column | **split** → template-eligible | the authored half of the recipe |
| `unifiedConfig` (agent runtime self-adjustments) | column | **split** → instance-only | overrides the running agent set for itself |
| `notificationPolicy` | column | instance-only | per-user delivery preference tied to the installer's channels |
| `telegramChatId` | column | instance-only | private destination (ADR 002) |
| `riskOverrides` | column | instance-only | runtime self-adjustment (ADR 002) |
| `status` | column | instance-only | runtime |
| `pauseState` | column | instance-only | runtime |
| connection IDs / venue account bindings | `agent_connections` | instance-only | private bindings (ADR 002) |
| credentials / secret references | `connections` | instance-only | secrets (ADR 002) |
| open positions, fills, P&L, analytics | derived | instance-only | runtime-derived (ADR 002) |
| `createdAt`, `updatedAt` | column | instance-only | row metadata |

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

Three fields require decomposition rather than a straight include/exclude. Projection helpers must handle these explicitly and tests must cover both halves:

1. **`unifiedConfig`** — separate authored technical/intelligence/execution config (template-eligible) from agent runtime self-adjustments (instance-only). The runtime-set portion is identified the same way `riskOverrides` is: it is state the agent wrote for itself, not authored recipe.
2. **`executionMode`** — recorded in the blueprint but never auto-applied as `live`. Instantiation defaults to `paper` unless the installer supplies a live connection binding and explicitly opts in.
3. **`notificationPolicy`** — the enable/disable *preference* is not portable because it is meaningless without the installer's own delivery channels; treated as instance-only in full.

## Editable Copy

To keep installer intent explicit without stripping behavior:

1. Instantiation returns the fully-resolved template-eligible field set to the client for review.
2. The installer may edit the copied values (including inherited risk limits) before creating the instance.
3. A deeper "fork and edit the blueprint itself" authoring flow may land in Phase 1b or Phase 2; the review-and-edit-at-instantiate path is the Phase 1 minimum.

## Verification Hook

WP4 projection tests must, for each row above:
1. assert every template-eligible field survives save-as-blueprint,
2. assert every instance-only field is absent from the stored blueprint payload,
3. assert each split field is decomposed correctly (authored half present, runtime/private half absent).
