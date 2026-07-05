# Split Agent Loss And Drawdown Limits

## Status

- Implemented
- Date: 2026-06-15
- Implemented: 2026-07-05

## Problem

The agent risk contract currently overloads one creator-facing field, `dailyLossLimit`, with two different meanings:

- older worker wiring and some tests treat it as a drawdown halt by mapping it to `RiskLimits.maxDrawdown`
- newer runtime-policy documentation describes it as a rolling daily loss cap

That ambiguity is now a product and implementation risk:

- users cannot tell whether the field limits total drawdown or just one bad day
- worker code enforces both behaviors from one input, which makes the effective policy hard to reason about
- documentation, tests, and runtime prompts drift because they are describing different semantics
- future risk work will keep reintroducing confusion unless the contract is split first

A narrower review finding exposed the same problem from another angle:

- `get_risk_limits` currently reports operator-default drawdown as read-only
- `adjust_risk_limits` cannot accept any drawdown field
- runtime-boundary docs say operator-default drawdown should be agent-mutable

That inconsistency is real, but it should not be fixed by bolting runtime mutability onto the legacy absolute `maxDrawdown` path in isolation. The architecturally sound fix is to solve drawdown as part of the same end-to-end contract split described in this plan.

## Product Decision Assumed By This Plan

This plan assumes the platform adopts two separate agent risk controls:

1. `dailyLossLimit`
   Meaning: hard cap on rolling 24h realized loss for the agent's direct trading path.
   Units: USD / account base currency, stored as a decimal string.

2. `maxDrawdownPct`
   Meaning: hard cap on peak-to-current equity drawdown for the agent's direct trading path.
   Units: percentage of peak equity, stored as a numeric percentage.

This plan intentionally keeps `dailyLossLimit` as the daily-loss field and stops using it for drawdown.

## Architectural Decision

This plan is the canonical fix for the current drawdown-mutability inconsistency.

Decision:

1. Do not add a standalone runtime override path for the legacy absolute `maxDrawdown` field.
2. Fold drawdown into the same two-path risk contract as the other agent-adjustable risk controls.
3. Implement drawdown mutability only for the canonical split field, `maxDrawdownPct`, not for the legacy overloaded path.
4. Keep the repo in a consistent state at every intermediate step: until the write path, persistence path, and enforcement path all exist together, the runtime must not advertise drawdown as mutable.

Why this is the clean version:

- adding mutability to the current absolute `maxDrawdown` field would entrench a model this plan is already replacing
- it would create duplicate adjustment semantics that would need to be removed once `maxDrawdownPct` ships
- it would force migration logic between two different drawdown representations instead of one canonical contract
- it increases the chance of another half-state where tool metadata, persistence, and enforcement drift again

## Goals

- make daily loss and drawdown distinct concepts across API, DB, worker, runtime prompt, and UI
- document the exact meaning of every related config property in `config/default.yaml`
- ensure the risk engine evaluates daily loss and drawdown through separate checks
- expose the new drawdown control in the frontend where agent risk controls are edited
- remove the old implicit mapping `dailyLossLimit -> maxDrawdown`

## Non-Goals

- redesigning the entire generic `RiskConfigSchema` used by non-agent trading instances
- changing historical feature-plan documents beyond adding a brief superseded note where necessary
- reworking unrelated bot blueprint risk semantics

## Canonical Field Semantics

### Creator-facing agent fields

| Field | Surface | Meaning | Units | Defaulting behavior |
|---|---|---|---|---|
| `capital` | API, DB, UI, worker | Deployable allocation cap for the agent's direct trading path | USD / account base currency | Explicit user value, no silent derivation |
| `dailyLossLimit` | API, DB, UI, runtime descriptor | Rolling 24h realized-loss hard cap | USD / account base currency | If unset, fall back to `config.agentRiskDefaults.dailyMaxLossPct` |
| `maxDrawdownPct` | API, DB, UI, runtime descriptor | Peak-to-current equity drawdown hard cap | Percent of peak equity | If unset, fall back to `config.agentRiskDefaults.maxDrawdownPct` |
| `maxOpenPositions` | API, DB, UI, worker | Hard cap on simultaneous non-flat positions | Count | If unset, fall back to `config.agentRiskDefaults.maxOpenPositions` |
| `maxPositionSizePct` | API, DB, UI, worker | Hard cap on resulting position notional as % of equity | Percent | If unset, fall back to `config.agentRiskDefaults.maxPositionSizePct` |
| `stopLossPct` | API, DB, UI, worker | Forced-exit threshold per position based on unrealized loss | Percent of equity | If unset, fall back to `config.agentRiskDefaults.stopLossMaxUnrealizedLossPct` |
| `stopLossCooldownMs` | API, DB, UI, worker | Minimum re-entry cooldown after a forced stop-loss exit | Milliseconds | If unset, fall back to `config.agentRiskDefaults.stopLossCooldownMs` |

### `config/default.yaml` properties after this change

| Property | Meaning after change | Why it exists |
|---|---|---|
| `agentRiskDefaults.dailyMaxLossPct` | Operator default and ceiling for rolling 24h realized-loss risk when the creator did not set `dailyLossLimit` | Keeps a platform fallback that scales with account equity |
| `agentRiskDefaults.maxDrawdownPct` | New operator default and ceiling for peak-to-current equity drawdown when the creator did not set `maxDrawdownPct` | Makes drawdown an explicit, separately tunable default |
| `agentRiskDefaults.maxOpenPositions` | Default and ceiling for concurrent positions | Existing behavior, semantics unchanged |
| `agentRiskDefaults.maxPositionSizePct` | Default and ceiling for position notional % of equity | Existing behavior, semantics unchanged |
| `agentRiskDefaults.stopLossMaxUnrealizedLossPct` | Default and ceiling for per-position stop loss | Existing behavior, semantics unchanged |
| `agentRiskDefaults.stopLossCooldownMs` | Default and ceiling for stop-loss cooldown | Existing behavior, semantics unchanged |
| `risk.globalMaxDrawdownPct` | System-level operator risk boundary outside the per-agent creator control flow | Must remain distinct from agent direct-trading defaults |

## Required Changes

### 1. Operator config and schema

Update `config/default.yaml` and `packages/domain/src/config/schema.ts` so the operator layer documents and validates the new split explicitly.

Required work:

- Add `agentRiskDefaults.maxDrawdownPct` to the Zod schema and resolved config type.
- Add `agentRiskDefaults.maxDrawdownPct` to `config/default.yaml` with an inline comment that states:
  - it applies to agent direct trading
  - it is a peak-to-current equity drawdown percentage
  - it is used only when the creator did not set `maxDrawdownPct`
  - it also acts as the ceiling for any creator or agent adjustment
- Rewrite the inline comment for `agentRiskDefaults.dailyMaxLossPct` so it explicitly says it is the fallback/ceiling for rolling 24h realized loss when `dailyLossLimit` is unset.
- Review the surrounding comments in `config/default.yaml` so `agentRiskDefaults` reads as a coherent contract rather than a loose list of thresholds.
- Clarify in docs that `risk.globalMaxDrawdownPct` is not the same thing as the new per-agent drawdown default.

### 2. Database and repository layer

Persist drawdown separately instead of overloading the daily-loss column.

Required work:

- Add a nullable `max_drawdown_pct` column to the `agents` table via Drizzle migration.
- Update `packages/db/src/schema/agents.ts` with a precise comment matching the new semantics.
- Extend repository insert/update types and any row-to-domain mapping to include `maxDrawdownPct`.
- Ensure API responses serialize the new field consistently with existing decimal risk fields.

Migration policy:

- Do not auto-copy existing `daily_loss_limit` values into `max_drawdown_pct`.
- Treat existing `daily_loss_limit` rows as daily-loss-only after the change.
- Add a rollout step to audit agents with non-null `daily_loss_limit` and decide whether they also need an explicit drawdown setting.

### 3. API contract and validation

The agent API must express the split directly.

Required work:

- Add `maxDrawdownPct` to create/update schemas in `apps/api/src/routes/agents.ts` and any mirrored schemas such as `apps/api/src/routes/agent-interactivity.ts`.
- Extend agent response mapping and client-facing types to include the new field.
- Extend `validateAgentRiskBounds()` so user-provided `maxDrawdownPct` cannot exceed `config.agentRiskDefaults.maxDrawdownPct`.
- Keep `dailyLossLimit` validation as a positive decimal string, but stop treating it as a drawdown input anywhere in the API layer.
- Update the `/agents/risk-defaults` route payload to include at least:
  - `dailyMaxLossPct`
  - `maxDrawdownPct`
  - existing risk default fields already surfaced to the UI

Validation policy:

- Require `capital` whenever `dailyLossLimit` is set, because daily-loss fallback/derivation needs an equity baseline.
- Require `capital` whenever `maxDrawdownPct` is set, because drawdown is meaningless without an equity baseline.
- If product wants a stricter rule, promote this to: any trading-capable agent must define `capital`.

### 4. Runtime risk contract and tooling

The current mutability bug exists because drawdown is handled outside the typed runtime risk contract. That split must be removed.

Required work:

- Extend `ResolvedAgentRiskContract` and `AgentRiskOverrides` in `packages/domain/src/agent-risk-contract.ts` to include the canonical drawdown field.
- Extend `AgentRiskCreatorInput` and `AgentRiskCeilings` so drawdown participates in the same resolution path as the existing four adjustable risk fields.
- Update helper code such as `extractCeilings()`, `extractCreatorInput()`, and `buildRiskContractOps()` so drawdown resolution, mutability, and ceiling validation all come from one source of truth.
- Extend `validateRiskOverride()` and any related contract tests so operator-default drawdown can be adjusted, reset, and capped with the same semantics as the other default-derived fields.
- Extend `adjust_risk_limits` in `apps/worker/src/tools/risk-limits.ts` so its schema, write path, and returned limits include drawdown.
- Update `get_risk_limits` so it no longer resolves drawdown through a bespoke side path with ad hoc mutability metadata; it should format the contract field the same way as the other adjustable limits.
- Remove or collapse the current split between contract-backed risk fields and the standalone `resolveMaxDrawdownLimit()` path once the new contract is wired end to end.

Safety rule:

- Do not flip drawdown to `mutable: true` in tool output until the corresponding adjust path, persistence path, and enforcement path are all live.

### 5. Engine risk model

The engine already models daily loss and drawdown as different checks, but drawdown is currently absolute while daily loss is percentage-based.

Required work:

- Extend `RiskLimits` and `RiskSnapshot` in `packages/engine/src/risk-gate.ts` to represent drawdown percentage explicitly instead of relying only on absolute `maxDrawdown`.
- Add a dedicated drawdown-percentage check, separate from the existing rolling daily-loss check.
- Preserve the existing absolute `maxDrawdown` path only where non-agent trading flows still depend on it; do not route agent daily-loss inputs into it.
- Extend `EquityTracker` or the risk snapshot builder so the risk gate can compare current drawdown against `maxDrawdownPct` using the same authoritative equity series that daily loss already depends on.

Expected end state:

- drawdown breach produces a drawdown-specific rejection
- rolling daily loss breach produces a daily-loss-specific rejection
- no agent path derives both from the same user field

### 6. Worker risk wiring

Replace the current overloaded risk-limit builder with a split mapping.

Required work:

- Update `apps/worker/src/agent-risk-limits.ts` so:
  - `dailyLossLimit` only contributes to daily-loss enforcement
  - `maxDrawdownPct` only contributes to drawdown enforcement
  - `dailyLossLimit` no longer sets `maxDrawdown`
- Extend `AgentRiskLimitSource` to include `maxDrawdownPct`.
- Thread the new field through worker startup and intake resolution paths, including:
  - `apps/worker/src/index.ts`
  - `apps/worker/src/agents/agent-intake-resolver.ts`
  - any direct `agentRepo.getAgent()` consumers that construct risk inputs
- Update tests that currently expect `dailyLossLimit` to populate `riskLimits.maxDrawdown`.

### 7. Runtime descriptor and prompt visibility

The agent must be able to see both limits with the same meaning the engine enforces.

Required work:

- Extend `RuntimeGuardrailDescriptor` in `packages/domain/src/runtime-composition.ts` with `maxDrawdownPct`.
- Update runtime-descriptor builders in `packages/db/src/agent-runtime-descriptor.ts` and any related composition helpers to carry the new field.
- Update prompt composition in `apps/worker/src/runtime-composition.ts` so the system prompt renders two distinct lines when applicable:
  - daily loss limit
  - max drawdown
- Rewrite prompt wording so `dailyLossLimit` is described as rolling 24h realized loss, not a generic loss/drawdown guardrail.

Optional but recommended:

- If the runtime currently only shows creator-configured guardrails, consider adding resolved default values to the prompt context so the agent can see the effective limits it is trading under.

### 8. Frontend changes

The UI must let users set the new field and must stop implying that daily loss and drawdown are the same thing.

Required work:

- Update agent API client types in `apps/web/src/lib/api-client.ts` to include `maxDrawdownPct` and the expanded risk-defaults response shape.
- Update payload builders in `apps/web/src/features/agents/agent-payloads.ts` so create/update requests include `maxDrawdownPct`.
- Extend `AgentControlsSection.tsx` trading guardrails UI with a dedicated drawdown input.
- Update create/edit agent flows, including at minimum the current edit surface in `apps/web/src/features/agents/EditAgentModal.tsx` and the corresponding create surface, so both fields are editable.
- Add client-side form copy that makes the distinction obvious:
  - `dailyLossLimit`: rolling 24h realized loss cap
  - `maxDrawdownPct`: max peak-to-current equity decline
- Use risk-defaults placeholders/help text so users can see the operator default when leaving a field blank.
- Add validation messaging around the `capital` dependency if either field is set.

Localization work:

- Update `en.ts` and the other supported locale files so the new field has labels and help text everywhere the existing daily-loss label appears.
- Tighten the existing daily-loss help text so it explicitly says rolling 24h realized loss.

### 9. Documentation updates

The split must be reflected in the live source-of-truth docs, not only in code comments.

Required work:

- Update `config/default.yaml` inline comments as the primary documentation.
- Update `docs/best-practices/configuration.md` only where the operator-vs-runtime risk contract needs clarification.
- Update `docs/tech/agents/runtime-boundary-and-message-contract.md` so daily loss and drawdown are described as separate controls.
- Update `AGENTS.md` so its example no longer says `dailyLossLimit` implies a daily cap while the worker still treats it as drawdown.
- Review any currently active docs that still say `dailyLossLimit -> maxDrawdown` and either:
  - update them if they are still normative, or
  - add a short note that the mapping was superseded by the split

Historical docs policy:

- Do not silently rewrite closed historical plans as if the old design never existed.
- Prefer a short superseded note when a historical file is still likely to be read during future work.

### 10. Tests and validation

Update the test suite to enforce the new semantics across all layers.

Backend tests:

- `apps/worker/src/agent-risk-limits.test.ts`
- `apps/worker/src/agents/agent-intake-resolver.test.ts`
- `packages/engine/src/risk-gate.test.ts`
- runtime composition tests that render guardrail summaries
- API route tests for create/update validation and `risk-defaults` response shape

Frontend tests:

- `apps/web/src/features/agents/agent-payloads.test.ts`
- form/component tests for the new drawdown field and updated daily-loss help text

Repo validation:

- `pnpm lint`
- targeted vitest suites for touched worker, engine, API, and web files

## Suggested Implementation Order

1. Finalize the canonical split contract and comments for `config/default.yaml`.
2. Add DB column + repository + API types.
3. Extend runtime risk contract types and risk-override persistence to include drawdown.
4. Extend worker/API schemas and tool surfaces so drawdown mutability is expressed through the contract, not a special case.
5. Refactor engine and worker risk wiring to stop mapping `dailyLossLimit` to drawdown.
6. Expose the new drawdown field in UI and runtime prompt text.
7. Update docs and tests.
8. Audit existing agent rows with `daily_loss_limit` before enabling the new UI in production.

## Rollout Notes

- This is a semantic correction, not just a UI tweak.
- Existing agents with `dailyLossLimit` set may behave differently after the change because that value will no longer implicitly protect against total drawdown.
- The rollout therefore needs an operator review step for existing agents before or immediately after deploy.
- Do not ship an intermediate state where docs or tool metadata say drawdown is mutable before the adjustment path is actually available.
- If a low-risk rollout is preferred, ship in two deploys:
  1. additive schema/API/UI support for `maxDrawdownPct`
  2. contract/tool/enforcement switch that removes the old `dailyLossLimit -> maxDrawdown` mapping after existing agents have been reviewed

## Done Criteria

- `dailyLossLimit` has exactly one meaning everywhere: rolling 24h realized-loss cap
- `maxDrawdownPct` exists as a separate agent risk control end to end
- `config/default.yaml` comments clearly document the meaning of `dailyMaxLossPct` and `maxDrawdownPct`
- worker risk wiring no longer maps `dailyLossLimit` onto `maxDrawdown`
- `get_risk_limits` and `adjust_risk_limits` expose the same drawdown field, provenance, ceiling, and mutability semantics
- runtime prompt and frontend copy show daily loss and drawdown as separate controls
- tests cover the split semantics across engine, worker, API, and web