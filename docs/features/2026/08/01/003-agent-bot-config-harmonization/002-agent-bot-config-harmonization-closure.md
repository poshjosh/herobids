# 008 - Agent and Bot Configuration Harmonization Closure Plan

**Status:** Ready for implementation  
**Created:** 2026-08-01  
**Closes:** [001-agent-bot-config-harmonization](./001-plan.md)  
**Blocks:** [003-agent-blueprint-marketplace-phase-1-implementation.md](./003-agent-blueprint-marketplace-phase-1-implementation.md)

## Purpose

Finish the configuration harmonization that introduced `StrategyIdentity`, `RiskPosture`, and `ExecutionDefaults` but left legacy agent columns, API fields, and strategy metadata active beside them. Marketplace projection must not begin until each shared concept has one authoritative representation and every noncanonical `unifiedConfig` behavior has an explicit destination.

## Assumptions

1. Backward compatibility, dual reads, dual writes, and compatibility aliases are out of scope.
2. Postgres, Redis, and derived local state are reset for deployment. This is a destructive schema replacement with no data migration or backfill.
3. Bot configuration remains behaviorally complete while adopting the shared strategy, risk, execution, and token-safety vocabulary. Engine `RiskLimits` remains an enforcement projection, not another persisted source.

## Canonical Contract

### Shared fields

| Concept | Canonical agent source | Contract |
|---|---|---|
| strategy identity | `agents.strategy` | `StrategyIdentity`; optional only for a non-trading agent |
| creator risk | `agents.risk` | raw nullable `RiskPosture`; never persist resolved operator defaults here |
| execution defaults | `agents.executionDefaults` | `ExecutionDefaults`; required for a trading agent |
| runtime risk mutation | `agents.riskOverrides` | `AgentRiskOverrides`; runtime state, never creator configuration |

The current `RiskPosture` fields are `maxPositionSizePct`, `maxOpenPositions`, `stopLossPct`, `stopLossCooldownMs`, `dailyMaxLossPct`, `maxDrawdownPct`, `maxNewPositionsPerDay`, `avoidParabolicMovePct`, and `maxOrderNotional`. Implementation must recheck `RiskPostureSchema` before migration generation and update this list and the field classification if it has changed.

An agent is **trading-capable** when its resulting exact skill assignments include a pinned skill revision whose `capabilityFamilies` contains `trading`. This resolved revision data, not `capabilityMode`, a preset name, or a hard-coded skill-ID map, controls whether `strategy` and `executionDefaults` are required. `capabilityMode` continues to control intelligence/hybrid reasoning behavior.

### Agent risk resolution

The five-field mutable contract remains exactly `maxOpenPositions`, `maxPositionSizePct`, `stopLossPct`, `stopLossCooldownMs`, and `maxDrawdownPct`. The complete persisted posture resolves as follows:

| Field | Null/omitted creator value | Creator number | Agent mutable | Enforcement/default source |
|---|---|---|---|---|
| `maxOpenPositions` | `agentRiskDefaults.maxOpenPositions` | immutable | yes when defaulted | engine risk gate; operator default is override ceiling |
| `maxPositionSizePct` | `agentRiskDefaults.maxPositionSizePct` | immutable | yes when defaulted | engine risk gate; a defaulted value is unenforced without capital/equity context |
| `stopLossPct` | `agentRiskDefaults.stopLossPct` | immutable | yes when defaulted | engine unrealized-loss guard; operator default is ceiling |
| `stopLossCooldownMs` | `agentRiskDefaults.stopLossCooldownMs` | immutable | yes when defaulted | forced-exit cooldown; operator default is ceiling |
| `maxDrawdownPct` | `agentRiskDefaults.maxDrawdownPct` | immutable | yes when defaulted | engine risk gate; operator default is ceiling |
| `dailyMaxLossPct` | `agentRiskDefaults.dailyMaxLossPct` | immutable | no | creator/default-only engine guard; operator value is platform ceiling |
| `maxNewPositionsPerDay` | disabled (`null`) | immutable | no | creator-only scanner/entry guard; no Phase 1 operator default |
| `avoidParabolicMovePct` | disabled (`null`) | immutable | no | creator-only entry filter; no Phase 1 operator default |
| `maxOrderNotional` | derive `capital * agentRiskDefaults.maxOrderNotionalMultiplier`; disabled without capital | immutable | no | creator/derived-only order guard; live rollout cap independently clamps live orders |

Do not add the final four fields to `AgentRiskOverrides`. Add a resolved read model covering all nine with `rawValue`, nullable `effectiveValue`, `source` (`user`, `default`, `agent_override`, `derived`, or `disabled`), `mutable`, nullable `operatorCeiling`, and `enforced`. The existing five-field mutation contract remains the only input accepted by `adjust_risk_limits`.

`operatorCeiling` is the corresponding `agentRiskDefaults` number for the five mutable fields and `dailyMaxLossPct`; it is `null` for `maxNewPositionsPerDay`, `avoidParabolicMovePct`, and `maxOrderNotional` because no general operator ceiling exists. The independent live-rollout notional cap is reported separately. Disabled fields report `effectiveValue: null`, `source: disabled`, `mutable: false`, and `enforced: false`. Configured/defaulted fields report `enforced: true` only when their required runtime inputs exist: equity/price for percentage/notional guards, daily loss plus equity for daily loss, peak/current equity for drawdown, stop-exit timestamps for cooldown, daily entry count for new-position limits, and 24-hour change for the parabolic filter.

For every field with a numeric `operatorCeiling`, creator and installer values above that ceiling are rejected with a validation error at agent create, PATCH, blueprint create/edit/publish, preview, and confirmation. Values are never silently clamped. Runtime agent overrides keep their existing explicit ceiling rejection. The three fields with no general ceiling still obey their Zod bounds and any independent live-rollout constraint.

### Canonical bot contract

`BotConfigSchema` must use `StrategyIdentity`, `ExecutionDefaults`, canonical risk field names and units, and `TokenSafety` directly. Complete the unfinished bot convergence as follows:

1. Replace the divergent `RiskConfigSchema` vocabulary with a strict bot risk schema composed from the canonical `RiskPosture` fields. The risk object is required; individual members may be absent when disabled/not configured, but must never be `null` and have no agent-style provenance or runtime mutability.
2. Store `maxOrderNotional` as a number in both shared and bot risk contracts. Remove the current string/number mismatch and convert to the engine `Price` type only in the enforcement projection.
3. Remove persisted bot `maxPositionSize` and `maxDrawdown` config fields in favor of canonical `maxPositionSizePct` and `maxDrawdownPct`. Keep absolute engine guards only as explicitly optional `RiskLimits` mechanics for non-agent callers that still supply them; do not synthesize hard-coded absolute limits in the worker.
4. Remove the `stopLossMaxUnrealizedLossPct` input alias and deprecated `risk.minSwapToken*` / `risk.allowSwapTokenSafetyOverride` fields. With no compatibility requirement, `tokenSafety` is the sole token-safety source and legacy keys fail strict boundary validation.
5. Keep bot-only `tokenSafety`, venue, symbol, venue type, swap assets, and polling fields outside `RiskPosture`. Update bot presets, routes, worker projection, tests, fixtures, and docs together.

This closure may make the absolute `RiskLimits.maxPositionSize` and `RiskLimits.maxDrawdown` members optional so canonical percentage-only bot configs can project without magic sentinel values. The risk gate must preserve existing behavior whenever an absolute member is supplied and must skip only an absent absolute guard. Add parity tests before changing those members.

Every canonical bot risk member, including `maxOpenPositions`, is optional-but-non-null and has one rule: present means enforce the supplied value; absent means that guard is disabled. Defaults belong in a selected preset or API/domain schema default and must be materialized into persisted bot config, never supplied by a worker call-site fallback. Make `RiskLimits.maxOpenPositions` optional alongside the two absolute guards and skip it only when absent. Existing zero semantics remain field-specific (`0` is not interchangeable with absence); boundary and risk-gate tests cover both.

### Canonical strategy parameter registry

Add one executable `StrategyParameterRegistry` in `packages/domain/src/config/strategy-parameters.ts`, keyed by the supported `(StrategyIdentity.type, decisionMode)` combinations. Each entry owns its strict Zod parameter schema, defaults, and discovery metadata. Combinations with no parameters use `z.object({}).strict()`; no registry entry means the identity is unsupported.

`StrategyIdentitySchema` validates `params` through this registry instead of `z.record(z.unknown())`. Move or compose the existing API strategy descriptors, mechanical/hybrid parameter schemas, DCA schema, tool-schema discovery, presets, and runtime parsing from this registry. `BotConfigSchema`, agent canonical preset resolution, schema-discovery routes/tools, blueprint create/edit/publish/preview/confirmation, and strategy runtime startup all call the same parser. Remove duplicate validators rather than synchronizing copies. Adding a strategy or decision mode requires one registry entry and parity tests proving every consumer accepts/rejects the same payload.

### Agent-only fields that remain

`agents.capital`, `agents.maxBots`, and `agents.tickIntervalMs` remain first-class agent fields. They are not members of the shared value objects and must not be removed, folded into `risk`, or lost from API, worker, web, export, fixture, or blueprint projection surfaces.

### Exact columns removed

Remove only these superseded columns from `agents`:

1. `executionMode`
2. `dailyLossLimit`
3. `maxDrawdownPct`
4. `maxDrawdown`
5. `maxSlippageBps`
6. `maxOpenPositions`
7. `maxPositionSizePct`
8. `stopLossPct`
9. `stopLossCooldownMs`

`maxBots` stays. At plan authoring time, `packages/db/src/schema/agents.ts` contains no other flat agent risk column. If implementation finds another one, it must be classified and this plan plus 007 updated before deletion; it must not be silently added to the removal list.

## Boundary And Patch Semantics

All API writes validate through shared domain schemas. Unknown legacy flat fields are rejected with `400`; they are not ignored.

### Create

1. `strategy` omitted or explicit `null` means no strategy and is valid only when the resulting agent is non-trading. A value is parsed as the complete `StrategyIdentity`.
2. `risk` omitted or explicit `null` persists `null`, meaning every field uses the operator default and remains agent-mutable where the risk contract permits. A value persists the raw object exactly: an omitted member inherits the operator default, explicit member `null` also selects the operator default, and a number is creator-configured and immutable to the running agent.
3. `executionDefaults` omitted or explicit `null` persists `null` only for a non-trading agent. Trading creation requires a valid value; schema defaults may fill `mode` only while parsing that supplied object. A supplied `slippageBps` value is creator configuration.
4. `capital`, `maxBots`, and `tickIntervalMs` omission uses the existing create/default behavior; explicit `null` means no agent override where the column contract permits it; a value is validated and persisted.

### PATCH

1. Omission always means unchanged.
2. `strategy: null` clears strategy only when the resulting configuration is non-trading; a value replaces the complete identity.
3. `risk: null` clears the whole creator posture to operator defaults. For a `risk` object, omitted members remain unchanged, explicit member `null` clears that member to operator default/mutable, and a number sets creator-configured/immutable. The server merges the patch into the stored raw posture and never into effective defaults.
4. `executionDefaults: null` clears execution defaults only when the resulting configuration is non-trading. For an object, omitted members remain unchanged, `slippageBps: null` clears the optional slippage override, and supplied values replace their members. A trading result must have a valid mode.
5. `capital`, `maxBots`, and `tickIntervalMs` omitted remain unchanged; explicit `null` clears the instance override where permitted; values replace after validation.
6. PATCH validation evaluates the resulting complete agent configuration, including the strategy/capability/execution cross-field rules, before writing anything.

Create and PATCH resolve the resulting pinned skill revisions before applying the trading-capable rule. A request cannot bypass required strategy/execution fields by using an unknown skill ID or stale capability map.

Responses return only canonical shared fields plus retained agent-only fields. They preserve raw `risk` nulls; effective risk belongs in the risk-contract response, not the agent persistence response.

## Mandatory `unifiedConfig` Inventory

Before deleting or reshaping any branch, implementation must produce a field-level inventory in the revised [007-field-classification.md](../002-agent-blueprint-marketplace/007-field-classification.md). For each persisted key and every API/worker/web consumer, record its owner, classification, destination, and focused test. Unknown keys block deletion.

The known inventory baseline is:

| Current branch | Required treatment |
|---|---|
| `technical` | preserve |
| `intelligence` | preserve |
| `capabilityMode` | preserve |
| `hybridMode` | preserve |
| `execution.mode` | move to `executionDefaults.mode`, then remove duplicate |
| `execution.positionSizeMode` | move to `unifiedConfig.executionPolicy.positionSizeMode` |
| `execution.fixedPositionSize` | move to `unifiedConfig.executionPolicy.fixedPositionSize` |
| `risk.maxPositions` | map to `risk.maxOpenPositions`, then remove duplicate |
| `risk.maxPositionSizePct` | map to canonical `risk`, then remove duplicate |
| `risk.dailyMaxLossPct` | map to canonical `risk`, then remove duplicate |
| `risk.stopLossPct` | map to canonical `risk`, then remove duplicate |
| `risk.takeProfitPct` | move to `unifiedConfig.executionPolicy.takeProfitPct` |
| `allowedPresets` | preserve |
| `presetTransition` | preserve |
| `platformAssessment` | preserve |
| `authorizationMode` | preserve |
| observed raw `metadata` | classify every key; do not blanket-delete the object |

`unifiedConfig.executionPolicy` is the exact retained destination for sizing and take-profit policy not represented by `ExecutionDefaults` or `RiskPosture`. After relocation, the old `unifiedConfig.execution` and `unifiedConfig.risk` branches are removed. This is not permission to discard behavior.

Observed strategy preset metadata (`strategyPreset`, `strategyPresetName`, `strategyPresetStyle`, and `strategyPresetSource`) may be removed only after `agents.strategy` is populated by the canonical preset resolver and every API, worker, Telegram, assessment, fixture, and display consumer reads canonical strategy or the authoritative active preset binding. `skillPresetId` is not strategy identity: preserve it until exact skill references replace it, and classify any other metadata key independently.

Runtime self-adjustments belong only in `riskOverrides` or another explicitly named runtime-state field. Authored technical, intelligence, preset-transition, authorization, sizing, and take-profit behavior remains template-eligible.

## Work Packages

### 1. Lock canonical schemas

1. Add create, PATCH, response, and persistence schemas implementing the tri-state rules above.
2. Define one projection from raw persisted creator risk plus `riskOverrides` and operator defaults into the existing risk contract.
3. Require strategy and execution defaults for trading-capable results using resolved skill revision capabilities while allowing genuinely non-trading agents to omit both.
4. Replace bot strategy/risk/execution/token-safety aliases and divergent types with the canonical contract above.
5. Establish the canonical strategy parameter registry and convert every validation/discovery/runtime consumer to it.
6. Add contract tests for all nine agent fields and their source/default/mutability/enforcement rows, unknown legacy fields, nullable raw round trips, partial nested PATCH, retained agent-only fields, strict bot legacy-key rejection, canonical bot risk parsing, and every strategy/decision-mode registry entry.

### 2. Inventory and relocate `unifiedConfig`

1. Search persisted fixtures, route transforms, repository reads, worker runtime assembly, preset assessment, tools, Telegram, exports, and web forms for every branch and metadata key.
2. Update 007 with the completed classification and destinations before deleting a branch.
3. Relocate canonical duplicates and preserve the exact technical execution policy defined above.
4. Remove strategy preset identity metadata only after all canonical readers and active-binding behavior pass focused tests.

### 3. Convert consumers and persistence

1. Convert API routes, repositories, worker intake/runtime assembly, evaluation, connection flows, exports, web forms, presets, seeds, and trade-test fixtures to canonical fields.
2. Keep `adjust_risk_limits` and `get_risk_limits` provenance, mutability, ceilings, and enforcement reporting unchanged.
3. Convert bot risk projection without hard-coded absolute fallback values and preserve risk-gate behavior for supplied absolute guards.
4. Remove the exact superseded columns, fallback reads, dual writes, aliases, casts, and precedence rules.
5. Generate the migration with Drizzle; do not hand-create an unjournaled SQL file.

### 4. Close documentation

1. Rewrite 007 as the canonical post-harmonization projection manifest, including every retained `unifiedConfig` and agent-only field.
2. Update routes, examples, and docs that expose removed flat fields or metadata strategy identity.
3. Mark the original harmonization plan closed only after all acceptance criteria pass.

## Sequencing And Gate

1. Boundary schemas and failing contract tests.
2. Complete `unifiedConfig` inventory and 007 draft rewrite.
3. Consumer conversion and behavior relocation.
4. Column removal and generated migration.
5. Final 007 rewrite, repository search, and full validation.

Plan 009 projection may begin only after 007 describes the implemented canonical state. Updating 007 early as a proposed manifest is allowed; presenting Plan 008 behavior as already implemented is not.

## Verification Commands

Run from the repository root. PostgreSQL and Redis must be available with test configuration before integration or functional suites; the destructive reset assumption applies, so no production-data migration test is required.

```bash
pnpm exec vitest run packages/domain/src/config/schema.test.ts packages/domain/src/agent-risk-contract.test.ts packages/engine/src/risk-gate.parity.test.ts packages/db/src/agent-repository.test.ts apps/api/src/routes/agents.test.ts apps/api/src/routes/blueprints.test.ts apps/worker/src/market-intelligence/resolve-active-preset.test.ts
pnpm --filter @herobids/db run db:generate
pnpm exec vitest run packages/db/src/journal-timestamps.test.ts
pnpm lint
pnpm test
pnpm test:integration
pnpm test:functional
pnpm build
```

After `db:generate`, review the generated SQL, snapshot, and `packages/db/drizzle/meta/_journal.json`; confirm one generated migration removes exactly the listed columns and that the journal test passes. Repository searches must find no runtime request/response/persistence use of the removed columns, no preset-identity fallback from `unifiedConfig.metadata`, no bot risk/token-safety compatibility aliases, no string `maxOrderNotional`, and no duplicate shared risk/execution branch.

## Acceptance Criteria

1. `strategy`, raw nullable `risk`, and `executionDefaults` are the sole persisted shared creator sources; runtime mutation remains `riskOverrides`.
2. All nine superseded columns are gone and `capital`, `maxBots`, and `tickIntervalMs` remain functional.
3. Create and PATCH omission, null, and value behavior matches this plan and is tested.
4. Every observed `unifiedConfig` branch and metadata key is classified; noncanonical behavior is preserved at its stated destination.
5. Strategy preset identity metadata and fallback readers are gone only after canonical strategy and active-binding behavior replace them.
6. The Drizzle SQL, snapshot, and journal agree, and reset-based deployment needs no data bridge.
7. 007 is rewritten to the implemented canonical state before Plan 009 projection starts.
8. Focused tests and all applicable repository commands above pass.
9. `BotConfigSchema` uses the canonical strategy, risk, execution, and token-safety vocabulary; deprecated aliases, absolute persisted duplicates, and magic worker fallbacks are gone.
10. Every optional bot guard has tested absent, zero, and present behavior; no required `RiskLimits` member forces a hidden fallback.
11. Strategy parameters have one domain-owned executable schema registry and cannot pass a blueprint/API boundary only to fail runtime validation.

## Risks

1. Resolving nullable risk before persistence changes provenance and agent mutability. Raw round-trip tests must detect this.
2. Blanket deletion of `unifiedConfig.execution`, `unifiedConfig.risk`, or `metadata` can silently remove sizing, take-profit, skill selection, or assessment behavior. The field inventory is a hard gate.
3. Hidden legacy consumers may compile but fail at runtime. Repository search, focused API/worker tests, and functional tests must cover them before migration acceptance.
4. Removing bot absolute risk fields without updating the engine projection can weaken or accidentally replace enforcement. Capture parity first, make absent absolute guards explicit, and prove canonical percentage guards remain active.