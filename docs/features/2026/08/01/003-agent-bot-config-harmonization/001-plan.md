# 001 - Agent and Bot Configuration Harmonization Plan

**Status:** Draft
**Created:** 2026-08-01
**Blocks:** [002-agent-blueprint-marketplace](../002-agent-blueprint-marketplace/001-plan.md)

## Purpose

Establish one canonical, typed vocabulary for the concepts that agents and bots share — strategy identity, risk posture, and execution defaults — so that the blueprint marketplace can build its contract on shared domain value objects instead of translating between two divergent representations.

This plan lands **before** the blueprint marketplace feature and is a prerequisite for it.

## Why this is separate

The blueprint marketplace needs a typed, first-class strategy identity and a single risk representation. The divergence is **only at the config/storage layer** — the enforcement layer is already shared:

- **Enforcement is already harmonized.** Both agent and bot flows build the same engine `RiskLimits` interface ([packages/engine/src/risk-gate.ts](../../../../../../packages/engine/src/risk-gate.ts)) and pass it to the same `checkRisk` gate. `RiskLimits` already uses the canonical vocabulary (`maxDrawdownPct`, `dailyMaxLossPct` as percent-of-equity, `maxPositionSizePct`, `stopLossMaxUnrealizedLossPct`, `stopLossCooldownMs`, `maxOpenPositions`, `maxOrderNotional`). This plan does **not** change enforcement logic.
- **Bot config** expresses the pre-enforcement representation as composable typed value objects inside `BotConfigSchema`: `StrategySchema` (`{ type, decisionMode, params }`), `RiskConfigSchema`, `ExecutionConfigSchema`. Bot config values are the effective values — bots have no runtime-mutability contract.
- **Agent config** expresses the same concepts as scattered nullable columns (`dailyLossLimit`, `maxDrawdownPct`, `stopLossPct`, `maxOpenPositions`, `maxPositionSizePct`, `maxSlippageBps`, `stopLossCooldownMs`, `maxDrawdown`, `maxBots`) plus a runtime-mutability contract (`riskOverrides` + operator ceilings) and a strategy identity buried in a `unifiedConfig` metadata sidecar.

So the work is to converge the **config/storage vocabulary** onto shared value objects that both actors express, while preserving (a) the already-shared enforcement projection and (b) the agent's runtime-mutability contract. Building the marketplace on top of the current storage divergence would either invent a third representation or bake a permanent translation layer into projection and instantiation. Harmonizing first removes both problems.

## The agent risk contract is a separate layer (must be preserved)

The agent risk model is **not** a flat value bag like bot config — it is a three-source provenance/mutability contract defined in [packages/domain/src/agent-risk-contract.ts](../../../../../../packages/domain/src/agent-risk-contract.ts):

- `AgentRiskCreatorInput` — the creator-configured **nullable** values. A non-null field is user-configured and **immutable at runtime**; a null field means "use the operator default" and is **agent-mutable**.
- `AgentRiskCeilings` — operator defaults from `config.agentRiskDefaults`, which double as the ceiling no override may exceed.
- `AgentRiskOverrides` — the agent's persisted runtime mutations (via the `adjust_risk_limits` tool).
- `resolveAgentRiskContract(...)` folds these three into a `ResolvedAgentRiskContract`, where each field carries `{ effectiveValue, source, mutable, operatorCeiling, enforced }`. The bridge `buildAgentRiskLimits` ([apps/worker/src/agent-risk-limits.ts](apps/worker/src/agent-risk-limits.ts)) then projects the effective values into the engine `RiskLimits`.

**Design consequence:** the shared value objects introduced by this plan are the **value vocabulary** (the field names, units, and nullable shape). The provenance/mutability layer wraps that vocabulary and stays agent-specific. Concretely:

- `RiskPosture` is the nullable value shape. The agent's creator input, the operator ceilings, and the agent overrides are all `RiskPosture`-shaped (or subsets of it).
- Bots express `RiskPosture` as effective (non-null) values — no contract wrapper.
- The mutable contract covers exactly five fields (`maxOpenPositions`, `maxPositionSizePct`, `stopLossPct`, `stopLossCooldownMs`, `maxDrawdownPct`). `dailyLoss` and `maxOrderNotional` are creator/derived-only and are **not** agent-mutable — the converged shape must keep them outside the mutable set.
- Null-means-default semantics, operator ceilings, and the `mutable`/`enforced` flags must survive the refactor unchanged. The `adjust_risk_limits` / `get_risk_limits` tools ([apps/worker/src/tools/risk-limits.ts](apps/worker/src/tools/risk-limits.ts)) must behave identically.

## Locked Decisions

1. **Converge now.** Agent risk representation converges onto the shared value objects in this plan rather than being translated at the marketplace boundary. Risks are enumerated and mitigated below.
2. **One canonical form.** Where agent and bot vocabularies diverge, pick a single canonical field and unit. Carry both forms only where genuinely unavoidable (documented per field).
3. **Separate instance tables.** `agents` and `bots` remain distinct tables and distinct actors. Only the contract and value objects are harmonized — the entities are not merged.

## Target State

### Shared domain value objects

Three value objects live in `packages/domain/src/config/schema.ts` and are the single value vocabulary used by both actor kinds and by the blueprint contract:

1. `StrategyIdentity` — canonicalized from the existing `StrategySchema` (`{ type, decisionMode, params }`). **Required for bots; optional/absent for agents.** Non-trading agents (`capabilityMode: intelligence`, personal-assistant) have no strategy — see [ADR 005 unified agent capabilities](../../../../../tech/adrs/2026/06/005-unified-agent-capabilities.md) and UAT AG-S02 (Capital/Exchange hidden). The value object must be attachable per actor kind, not a mandatory shared core field.
2. `RiskPosture` — the canonical **nullable** value shape, canonicalized from `RiskConfigSchema` and the agent risk columns. This is the value vocabulary only; the agent provenance/mutability contract wraps it (see the section above) and is unchanged.
3. `ExecutionDefaults` — canonicalized from the existing `ExecutionConfigSchema` plus the agent `executionMode` and `maxSlippageBps`.

### Instance layer

- `bots` compose these value objects inside their config payload as effective values (already close to this today).
- `agents` store the creator-configured `RiskPosture` (nullable) as a single typed `risk` JSONB column, keep the existing `riskOverrides` JSONB (the `AgentRiskOverrides` runtime mutations) as-is, adopt a first-class optional `StrategyIdentity`, and store `ExecutionDefaults`. This **replaces the scattered risk columns and the `unifiedConfig` strategy metadata sidecar** while preserving null-means-default semantics that the contract depends on.
- Both tables keep their kind-specific fields (agents: prompt, skills, style, model policy, technical/intelligence config, wake prefs, escalation, capital, maxBots; bots: venue/symbol/venueType/swapAssets binding shape).

### Storage decision (column vs JSONB)

Converged agent risk is stored as **one typed `risk` JSONB column** (shaped as `RiskPosture`, nullable fields = "use operator default"), not as renamed individual columns. Rationale: (a) it preserves the null-means-default semantics the contract requires per field; (b) it matches how bots already store risk (inside config JSONB), keeping the two representations structurally identical; (c) it lets the marketplace project one typed blob without column-by-column translation. `riskOverrides` stays a separate JSONB column because it is a distinct concern (runtime agent mutations), not creator config. The blueprint-facet columns called out in [007-field-classification](../002-agent-blueprint-marketplace/007-field-classification.md) (`kind`, `strategyId`, `style`, `tags`) remain denormalized columns — those are marketplace facets, not risk values.

### Enforcement layer (unchanged)

The engine `RiskLimits` and `checkRisk` gate are already canonical and shared. This plan changes only how each actor's config is stored and how it is projected into `RiskLimits`. `RiskLimits.maxDrawdown` (absolute USD) is **retained** for non-agent trading flows; agent flows already neutralize it with a large operator default and rely on `maxDrawdownPct`, so no enforcement change is needed there.

## Canonical Vocabulary

Where agent and bot fields mean the same thing, this table picks the single canonical field. Percent is preferred for ratio limits because it scales across account sizes and is portable in a shared blueprint. Note the enforcement baseline: `checkRisk` evaluates `dailyMaxLossPct` and `maxDrawdownPct` against **live equity/peak equity** ([risk-gate.ts](../../../../../../packages/engine/src/risk-gate.ts)), while the agent config→limits bridge derives the percent from `capital`. Config is expressed relative to capital; enforcement is against equity. This is existing behavior and is not changed here.

| Concept | Agent today | Bot today (`RiskConfigSchema`) | Canonical | Notes |
|---|---|---|---|---|
| Strategy identity | `unifiedConfig` metadata sidecar | `StrategySchema.type` (first-class) | `StrategyIdentity` (reuse `StrategySchema`) | agent adopts the bot representation; **optional for agents** (absent for non-trading), required for bots |
| Max position size | `maxPositionSizePct` (%) | `maxPositionSizePct` (%) | `maxPositionSizePct` (%) | already agree; agent-mutable |
| Max open positions | `maxOpenPositions` | `maxOpenPositions` | `maxOpenPositions` | already agree; agent-mutable |
| Stop-loss threshold | `stopLossPct` (%) | `stopLossMaxUnrealizedLossPct` (%) | `stopLossPct` (%) | the agent contract and `agent-risk-limits.ts` **already** call this `stopLossPct` and map it to engine `stopLossMaxUnrealizedLossPct`; renaming the bot field aligns bot→agent→engine. This is the **risk-gate unrealized-loss guard**, distinct from per-trade stop-loss/take-profit ([2026/07/06/010](../../../07/06/010-per-trade-stoploss-takeprofit/001-plan.md)). Resolves the TODO.md mismatch. Agent-mutable |
| Stop-loss cooldown | `stopLossCooldownMs` | `stopLossCooldownMs` | `stopLossCooldownMs` | already agree; agent-mutable |
| Daily loss cap | `dailyLossLimit` (USD, absolute) | `dailyMaxLossPct` (%) | `dailyMaxLossPct` (%) | **config semantic change** for agents. The bridge already converts `dailyLossLimit / capital * 100 → dailyMaxLossPct`; the engine already enforces as **percent-of-equity**. Creator-only — **not** agent-mutable |
| Drawdown cap | `maxDrawdownPct` (%) **and** `maxDrawdown` (USD) | `maxDrawdown` (USD) | `maxDrawdownPct` (%) at config | drop the absolute form from **agent config**; engine `RiskLimits.maxDrawdown` stays for non-agent flows. Peak-to-current equity drawdown, percent. Agent-mutable |
| New positions per day | — | `maxNewPositionsPerDay` | `maxNewPositionsPerDay` | promoted to shared; optional for agents |
| Parabolic-move guard | — | `avoidParabolicMovePct` | `avoidParabolicMovePct` | shared, optional |
| Per-order notional cap | — | `maxOrderNotional` (USD) | `maxOrderNotional` (USD) | **carry absolute** — notional is inherently a currency amount (unavoidable). For agents it is derived from `capital × maxOrderNotionalMultiplier`; not agent-mutable |
| Slippage cap | `maxSlippageBps` | `execution.slippageBps` | `ExecutionDefaults.slippageBps` | one canonical, in execution |
| Execution mode | `executionMode` | `execution.mode` | `ExecutionDefaults.mode` (`paper`\|`shadow`\|`live`) | keep existing venue refinements (swap venues cannot be `paper`) |
| Concurrency (bot count) | `maxBots` | n/a | agent-extension `maxBots` | agent-only; bots do not spawn bots |
| Capital allocation | `capital` (USD) | n/a | agent-extension `capital` | agent-only; baseline for percent→USD derivation |
| Operator-default field name | `agentRiskDefaults.stopLossMaxUnrealizedLossPct` | n/a | `agentRiskDefaults.stopLossPct` | rename the operator-config default for full naming consistency (`extractCeilings` maps it today) |
| Token-safety guards | operator token-safety defaults | `minSwapTokenLiquidityUsd`, `minSwapTokenVolume24hUsd`, `minSwapTokenAgeHours`, `allowSwapTokenSafetyOverride` | separate `TokenSafety` section, not `RiskPosture` | venue/DEX-specific; kept out of the shared risk core |

## Work Packages

### 1. Define shared value objects (additive) — **DONE**

Add `StrategyIdentity`, `RiskPosture`, `ExecutionDefaults` to `packages/domain/src/config/schema.ts`, canonicalizing field names and units per the table above. `RiskPosture` is a nullable value shape (each field optional/nullable = "use operator default"). Keep them additive first so nothing breaks yet. Do **not** fold provenance/mutability into these — they are values only.

### 2. Capture a risk-gate parity harness — **DONE**

Before changing any storage or bridge path, add tests that record the current `checkRisk` decisions ([packages/engine/src/risk-gate.ts](../../../../../../packages/engine/src/risk-gate.ts)) and the current `buildAgentRiskLimits` output ([apps/worker/src/agent-risk-limits.ts](../../../../../../apps/worker/src/agent-risk-limits.ts)) for a representative matrix of inputs — including the three provenance paths (creator-set/immutable, operator-default/mutable, agent-override/mutable) and the `hasCapital` false case. These are the golden reference the refactor must preserve, modulo the one intended config unit canonicalization for daily loss and drawdown. Enforcement logic itself does not change, so parity must stay green.

### 3. Converge bot config — **DONE**

Recompose `BotConfigSchema` from the shared value objects, renaming `RiskConfigSchema.stopLossMaxUnrealizedLossPct` to `stopLossPct` and aligning risk fields to canonical names. Bot risk values remain effective (non-null) values with no contract wrapper.

### 4. Converge agent instance — **DONE**

Replace the scattered agent risk columns and the `unifiedConfig` strategy metadata sidecar with the typed shared value objects:

- Store creator `RiskPosture` in a single typed `risk` JSONB column (nullable = operator default), preserving null-means-default per field.
- Keep the existing `riskOverrides` JSONB (`AgentRiskOverrides`) unchanged — it is runtime agent mutations, a distinct concern.
- Adopt a first-class **optional** `StrategyIdentity` (absent for non-trading agents), sourced from the `unifiedConfig` metadata sidecar today.
- Store `ExecutionDefaults` (folding `executionMode` + `maxSlippageBps`).
- Keep agent-only fields (`capital`, `maxBots`, prompt, skills, style, model policy, technical/intelligence config, wake prefs, escalation) as agent extensions.
- Update `AgentRiskLimitSource` and `extractCreatorInput`/`extractCeilings` in [apps/worker/src/agent-risk-limits.ts](../../../../../../apps/worker/src/agent-risk-limits.ts) to read the new `risk` JSONB instead of columns. **Do not touch** `agent-risk-contract.ts` resolution logic or the mutable-field set — only the source of the raw values changes.

### 5. Update enforcement bridge and consumers — **PENDING**

Enforcement logic (`checkRisk`) is unchanged. Update the value-sourcing seams:

- [apps/worker/src/agent-risk-limits.ts](../../../../../../apps/worker/src/agent-risk-limits.ts) — `buildAgentRiskLimits`, `resolveContract`, `extractCreatorInput`, `extractCeilings`, `AgentRiskLimitSource`.
- [apps/api/src/routes/agent-config-helpers.ts](../../../../../../apps/api/src/routes/agent-config-helpers.ts) — creator-input validation and defaults resolution.
- [apps/worker/src/tools/risk-limits.ts](../../../../../../apps/worker/src/tools/risk-limits.ts) — `adjust_risk_limits` / `get_risk_limits` must read/write the same override shape and report identical `source`/`mutable`/`operatorCeiling`.
- Agent create/update routes, worker agent-evaluation (`evidence-assembler`, `trading` analyzer), and domain exports.
- Rename `config.agentRiskDefaults.stopLossMaxUnrealizedLossPct` → `stopLossPct` and update `extractCeilings`.

### 6. Update surfaces — **PENDING**

Update `apps/web` agent forms and `api-client` types, i18n locales (unit labels change from USD to % for daily loss / drawdown), config strategy-presets, and test/seed scripts (`create-agents.sh`, `agent-trade-test.ts`, `agent-bot-cascade-test.ts`). Ensure non-trading agent forms still hide strategy/capital/exchange (UAT AG-S02).

### 7. Update docs — **PENDING**

Update AGENTS.md, `docs/tech/agents/runtime-boundary-and-message-contract.md`, `docs/tech/glossary.md`, and `docs/tech/user-acceptance-tests.md` to the canonical names/units; resolve the `stopLossPct` naming-mismatch item in TODO.md.

### Prior art (constraining context for the implementer)

- [2026/07/05/002-split-agent-loss-and-drawdown-limits](../../../07/05/002-split-agent-loss-and-drawdown-limits/001-plan.md) — why loss and drawdown are separate fields.
- [2026/07/06/010-per-trade-stoploss-takeprofit](../../../07/06/010-per-trade-stoploss-takeprofit/001-plan.md) — per-trade SL/TP is distinct from the risk-gate unrealized-loss guard.
- [2026/06/27/007-per-agent-runtime-controls](../../../06/27/007-per-agent-runtime-controls/001-plan.md) and [2026/06/15/009-agent-risk-config-ui](../../../06/15/009-agent-risk-config-ui/001-plan.md) — the runtime-mutability contract and its UI.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Losing the agent provenance/mutability contract (user-set immutable vs operator-default agent-mutable) when converging onto shared values | The shared value objects are values only; the contract layer (`agent-risk-contract.ts`) is untouched. WP4 changes only the *source* of raw values. Parity harness (WP2) asserts the three provenance paths and null-means-default still resolve identically |
| Risk-gate enforcement regression from representation change | Enforcement logic (`checkRisk`) is not modified. Parity harness (WP2) captures current `checkRisk` and `buildAgentRiskLimits` output; refactor must keep them green |
| Treating strategy identity as mandatory for agents | Strategy identity is optional per actor kind; non-trading agents (`capabilityMode: intelligence`) carry none. WP6 keeps the non-trading form hiding it (UAT AG-S02) |
| Config unit change: agent daily loss / drawdown move from absolute USD to percent | Data resets and no backward compatibility, so re-derivation is clean. The bridge already converts `dailyLossLimit/capital*100 → dailyMaxLossPct` and the engine already enforces percent-of-equity, so this is a config-representation change, not an enforcement change. UAT AG-S01 (`dailyLossLimit=50` from `capital=1000` = 5%) already aligns. Update UAT and i18n labels |
| Wide blast radius (engine bridge, API, worker, web, i18n, config presets, scripts, docs — ~35 files) | Land as a standalone plan with a full `pnpm lint` + `pnpm test` pass before the marketplace builds on it. Sequence additive value objects → switch storage → delete old columns |
| Confusing the risk-gate unrealized-loss guard with per-trade SL/TP during the `stopLossPct` rename | The rename targets only the risk-gate guard; the agent contract already calls it `stopLossPct`. Per-trade SL/TP (feature 2026/07/06/010) is untouched |
| Token-safety guards mis-scoped into risk posture | Keep token-safety in its own `TokenSafety` section, excluded from the shared `RiskPosture` core |
| AGENTS.md and runtime-boundary docs cite old field names/units | Update those docs in WP7 as part of the same change |

## Sequencing

1. shared value objects (additive)
2. risk-gate + `buildAgentRiskLimits` parity harness (incl. provenance paths)
3. converge bot config
4. converge agent instance (typed `risk` JSONB, optional `StrategyIdentity`, keep `riskOverrides`)
5. enforcement bridge and consumers (no enforcement-logic change)
6. surfaces (web, i18n, config, scripts)
7. docs and TODO cleanup
8. full lint + test pass with parity green

## Outstanding Issues

### WP1 — Define shared value objects
- **MEDIUM:** `maxOrderNotional` type mismatch — `RiskPostureSchema` uses `z.number()` but existing bot `RiskConfigSchema` uses `z.string()`. WP3 implementer must reconcile. Add comment noting the type decision.
- **LOW:** `avoidParabolicMovePct` lacks `.max()` upper bound; other percentage fields have `.max(100)`.
- **LOW:** `ExecutionDefaultsSchema` duplicates `ExecutionConfigSchema` shape without linking; risk of silent divergence before WP3 convergence.

### WP2 — Risk-gate parity harness
- **MEDIUM:** Test name `"reports dailyMaxLossPct as non-mutable"` and `"reports maxOrderNotional as non-mutable"` are misleading — the fields are *absent* from the contract, not "present but non-mutable." Rename to `"dailyMaxLossPct is absent from the mutable contract"` / `"maxOrderNotional is absent from the mutable contract"`.
- **LOW:** Test name `"resolves contract with exactly five risk fields and no extra keys"` describes a structural invariant, not behavior. Rename to `"exposes only the five agent-mutable risk fields in the contract"`.
- **LOW:** Test name `"maps stopLossMaxUnrealizedLossPct operator default to stopLossPct"` describes mapping internals. Rename to `"returns stopLossPct ceiling from the operator stopLossMaxUnrealizedLossPct default"`.
- **LOW:** Minor redundancy between unit and e2e capital-null tests — intentional but worth a clarifying comment.

### WP3 — Converge bot config
- **MEDIUM:** `config.tokenSafety!` non-null assertions in `apps/worker/src/index.ts` (lines ~2000). Guard makes them safe but violates strict TS conventions. Use a local variable after guard.
- **LOW:** `addLegacyRiskFields` named "Fields" (plural) but only adds one field. May grow later.
- **LOW:** No diagnostic when both canonical and legacy `stopLoss*` field present in input — add `console.debug` warning.
- **LOW:** PATCH `/bots/:id/config` does not validate through `BotConfigSchema` (pre-existing, not introduced by WP3).

### WP4 — Converge agent instance
- **LOW:** `agent-intake-resolver.ts` and `index.ts` use `(agent.risk as RiskPosture | null) ?? null` — the `?? null` is redundant since the cast already includes `| null`. Harmless, could be simplified.
- **LOW:** PATCH handler does not strip null keys from merged `riskPostureUpdate` (unlike POST handler). No behavioral impact — `??` in `extractCreatorInput` falls through on `null` — but the JSONB may accumulate null-valued keys from explicit-null PATCHes. Purely cosmetic.
- **LOW:** `extractCeilings` uses `defaults as Record<string, number>` to read the canonical `stopLossPct` field before it exists on `AgentRiskDefaultsConfig`. Documented as a WP5 workaround.

## Acceptance Criteria

1. `StrategyIdentity`, `RiskPosture`, and `ExecutionDefaults` are the single shared value vocabulary used by both agents and bots.
2. No divergent duplicate config fields remain except the explicitly justified absolute (`maxOrderNotional`) and the retained non-agent `RiskLimits.maxDrawdown`.
3. `agents` and `bots` remain separate instance tables. Agent creator risk is one typed `risk` JSONB; `riskOverrides` stays separate.
4. The agent provenance/mutability contract is unchanged: `adjust_risk_limits` / `get_risk_limits` report identical `source` / `mutable` / `operatorCeiling`, user-set limits remain immutable, and null-means-operator-default still holds per field.
5. Parity tests prove identical `checkRisk` and `buildAgentRiskLimits` decisions, modulo the intended daily-loss and drawdown config unit canonicalization.
6. Strategy identity is optional for agents and absent for non-trading agents (UAT AG-S02 unaffected).
7. The blueprint marketplace can define its contract directly on the shared value objects with no translation layer.
