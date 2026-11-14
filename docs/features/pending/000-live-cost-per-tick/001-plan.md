# Live Cost-Per-Tick Estimate

> Status: PENDING — deferred from the 2026-11 LLM cost/cadence cleanup.

## Summary

Today the per-tick LLM cost used for custom-preset cadence derivation is a fixed,
non-per-model guess: `COST_PER_TICK = { minimal: 0.12, standard: 0.21, premium: 0.31 }`
in `packages/domain/src/cost-profile.ts`. The web form already knows how to compute a
realistic per-model estimate (`resolveModelPricing` + `formatStyleSummary` in
`apps/web/src/features/agents/style-mapping.ts`): it multiplies per-tick token counts
by the selected economy/premium model prices and an escalation rate.

This feature makes the per-tick cost estimate use **live per-model pricing** wherever a
cost-per-tick number is needed, while keeping a **mandatory, explicit, tested fallback**
to the existing `COST_PER_TICK` constants whenever live pricing cannot be resolved
(missing provider/model/price, no pricing passed in, or non-finite/zero values).

Because `packages/domain/src/cost-profile.ts` lives in the zero-dependency pure `domain`
package, pricing must be **passed in**, never fetched there. The plan threads an optional
`ModelPricingInfo` through `AgentCostProfileInput` and computes the live per-tick cost from
the token-per-tick constants that already exist in `style-mapping.ts`, which are first
lifted into a shared domain helper so both the display estimate and the cadence derivation
use one implementation.

This is a cost **estimate**, not an enforced cap. Nothing here changes trading behaviour or
spend limits; it only improves the accuracy of the cadence-derivation input and the displayed
daily-cost estimate.

## Architecture / Recommendation

### Where live pricing comes from

- The provider pricing catalog is `ProvidersYaml` (`packages/domain/src/models/llm-models.ts`),
  loaded by `loadProvidersConfig` and forwarded to the worker as `agentConfig.providersYaml`.
  Per-model pricing fields there are `inputUsdPerM` / `outputUsdPerM` (USD per 1M tokens).
- There is also a runtime pricing snapshot path: `apps/worker/src/index.ts` calls
  `upsertPricingSnapshot`, and `getLlmModelPricing(snapshot, modelId)` returns a
  `ModelPricing` (`inputUsdPerM` / `outputUsdPerM`) or `undefined`.
- **Units/shape mismatch to resolve:** `style-mapping.ts`'s `ModelPricingInfo` uses the field
  names `economyInputUsdPer1M` / `economyOutputUsdPer1M` / `premiumInputUsdPer1M` /
  `premiumOutputUsdPer1M`, and its `resolveModelPricing` reads a provider shape with
  `pricing.inputUsdPer1M` / `pricing.outputUsdPer1M` — neither matches the canonical
  `ModelPricing { inputUsdPerM, outputUsdPerM }`. The plan standardises on the canonical
  `*UsdPerM` naming and the canonical catalog shape, and has `style-mapping.ts` adapt into it.

### Recommendation: one shared pure helper, two consumers

Introduce a single pure domain function that computes a per-tick USD cost from model pricing,
and reuse it in both places that need a cost-per-tick number:

1. `deriveCustomTickIntervalMs` in `cost-profile.ts` (cadence for the `custom` preset).
2. The display estimate in `style-mapping.ts` (`formatStyleSummary`).

Keep the two consumers calling the same helper so the cadence and the displayed estimate
cannot drift. Keep everything pure: pricing is an argument, never fetched inside `domain`.

Recommended new domain surface (in `packages/domain`, e.g. a new
`packages/domain/src/cost-per-tick.ts` or an addition to `cost-profile.ts`):

```
interface PerTickPricing {
  economyInputUsdPerM: number;
  economyOutputUsdPerM: number;
  premiumInputUsdPerM: number;
  premiumOutputUsdPerM: number;
}

// Pure. Returns undefined when pricing is missing/zero/non-finite so callers
// can apply the mandatory fallback explicitly.
function computeLiveCostPerTickUsd(pricing: PerTickPricing | undefined, escalationRate: number): number | undefined
```

The token-per-tick constants (`SCOUT_INPUT_TOKENS_PER_TICK = 332_000`,
`SCOUT_OUTPUT_TOKENS_PER_TICK = 33_000`, `JUDGE_INPUT_TOKENS_PER_TICK = 1_030_000`,
`JUDGE_OUTPUT_TOKENS_PER_TICK = 42_000`) move into this shared module as the single source of
truth, with a `STALE` caveat (see step 6). `style-mapping.ts` imports them instead of
redefining them.

## Detailed Plan

### 1. Add a shared pure cost-per-tick helper in `domain`

Files:
- `packages/domain/src/cost-per-tick.ts` (new) — or extend `packages/domain/src/cost-profile.ts`
- `packages/domain/src/index.ts` — export the new symbols
- `packages/domain/src/cost-per-tick.test.ts` (new)

Changes:
- Move `SCOUT_INPUT_TOKENS_PER_TICK`, `SCOUT_OUTPUT_TOKENS_PER_TICK`,
  `JUDGE_INPUT_TOKENS_PER_TICK`, `JUDGE_OUTPUT_TOKENS_PER_TICK` here as the single definition,
  with a prominent comment that they are STALE eval estimates (see step 6).
- Add `PerTickPricing` (canonical `*UsdPerM` naming) and `computeLiveCostPerTickUsd(...)`.
- `computeLiveCostPerTickUsd` returns `undefined` when pricing is absent, or any of the four
  prices is `<= 0` / non-finite, so every caller applies the fallback explicitly. It must never
  return `NaN` or `Infinity`.
- Formula (matches the existing display math, input + output, escalation applied to judge only):
  `scout = (scoutIn*ecoIn + scoutOut*ecoOut)/1e6`,
  `judge = (judgeIn*premIn + judgeOut*premOut)/1e6 * escalationRate`,
  `costPerTick = scout + judge`.

Dependency: none (pure). This is the foundation for steps 2 and 4.

### 2. Thread optional pricing into `resolveAgentCostProfile` and the fallback

Files:
- `packages/domain/src/cost-profile.ts`
- `packages/domain/src/cost-profile.test.ts` (and the worker re-export test
  `apps/worker/src/cost-profile.test.ts`)

Changes:
- Extend `AgentCostProfileInput` with an optional `pricing?: PerTickPricing` and an optional
  `escalationRate?: number` (default a conservative constant if omitted; do not invent a magic
  number silently — document the default).
- Change `deriveCustomTickIntervalMs(dailyBudgetUsd, estimatedCostPerTick)` to accept the
  estimated cost-per-tick as a parameter instead of computing it from the hardcoded tiers inline.
- In `resolveAgentCostProfile` (the `custom` branch), compute:
  `live = computeLiveCostPerTickUsd(input.pricing, input.escalationRate ?? DEFAULT_ESCALATION_RATE)`;
  `const estimatedCostPerTick = live ?? legacyCostPerTickForBudget(dailyBudgetUsd)` where
  `legacyCostPerTickForBudget` is the **existing** `COST_PER_TICK` tier logic kept as the
  mandatory fallback.
- Keep `COST_PER_TICK` constants in place as the fallback source; do not delete them.
- Keep the function pure and keep back-compat: when no `pricing` is passed, behaviour is
  byte-identical to today (fallback path).

Dependency: step 1.

### 3. Decide whether the display estimate reuses the shared helper

Files:
- `apps/web/src/features/agents/style-mapping.ts`
- `apps/web/src/features/agents/style-mapping.test.ts` (if present; otherwise add)

Changes:
- Replace the locally-defined token-per-tick constants and the inline cost math in
  `formatStyleSummary` with a call to `computeLiveCostPerTickUsd` + the shared constants.
- Reconcile `ModelPricingInfo` and `resolveModelPricing` with the canonical catalog shape:
  either (a) rename `ModelPricingInfo` fields to `*UsdPerM` and adapt them into `PerTickPricing`,
  or (b) keep the web-facing `ModelPricingInfo` names but map explicitly to `PerTickPricing`
  before calling the helper. Recommend (a) for one naming convention across the repo.
- `resolveModelPricing` currently reads `pricing.inputUsdPer1M` / `outputUsdPer1M` from the
  provider arg; update it to read the canonical `inputUsdPerM` / `outputUsdPerM`, or adapt at the
  call site that builds the provider array for the form.
- Preserve the current UX fallback: when pricing is absent/incomplete, `formatStyleSummary`
  returns just the style name with no cost clause (unchanged).

Dependency: steps 1–2. This keeps the display estimate and the cadence math on one implementation.

### 4. Supply live pricing at the worker call site

Files:
- `apps/worker/src/agent.ts` (the `resolveAgentCostProfile({...})` call around the model
  resolution block)
- `apps/worker/src/cost-profile.ts` (thin re-export — verify it still re-exports the extended type)

Changes:
- Resolve `PerTickPricing` for the agent's selected `provider`, `lightModel` (economy/scout), and
  `heavyModel` (premium/judge) from `agentConfig.providersYaml` (preferred — already forwarded)
  and/or `getLlmModelPricing` against a pricing snapshot. Build a small worker-local
  `resolvePerTickPricing(providersYaml, provider, lightModel, heavyModel): PerTickPricing | undefined`.
- Resolve the escalation rate from the agent's resolved runtime policy / style where available;
  otherwise pass `undefined` and let the domain default apply.
- Pass `pricing` and `escalationRate` into `resolveAgentCostProfile`.
- When pricing cannot be resolved, pass `pricing: undefined` — the domain fallback handles it.
  Log at debug/info which path was taken (live vs fallback) for observability.

Dependency: steps 1–2.

### 5. Second call site: narrative LLM resolution

Files:
- `apps/api/src/routes/agent-evaluation-narrative-llm.ts`
- `apps/api/src/routes/agent-evaluation-narrative-llm.test.ts`

Changes:
- This call site uses `resolveAgentCostProfile` only to derive the effective heavy model, not for
  cadence, so it does **not** need pricing. Confirm the new optional fields default cleanly
  (pricing omitted → fallback path → identical heavy-model resolution). No behaviour change expected;
  add a regression test asserting the omitted-pricing path is stable.

Dependency: step 2. (Listed so the "single call site" assumption in the brief is corrected — there
are two callers of `resolveAgentCostProfile`.)

### 6. Flag and schedule recalibration of the stale token-per-tick constants

Files:
- `packages/domain/src/cost-per-tick.ts` (doc comment)
- `docs/lessons/llm-cost-optimization-guide.md` (cross-reference)

Changes:
- Document that the four token-per-tick constants are STALE estimates derived from
  `.ignore/eval/2026/06/` (balanced style, deepseek-v4-flash scout / deepseek-v4-pro judge near
  100% escalation) and the `STYLE_ESCALATION_RATES` are approximate post-ladder shifts.
- Add a recommendation (not implemented here) to recalibrate from live telemetry, referencing the
  truncation/observability logging recently added and `docs/lessons/lessons-from-previous-project.md`
  lesson #9 ("Monitor input token counts per tick"). Note that because input tokens dominate cost
  (10–25× output), the input constant is the highest-leverage number to re-measure.

Dependency: none (documentation + comments).

## Testing Plan

Unit (domain, `cost-per-tick.test.ts` + `cost-profile.test.ts`):
- Live-pricing path computes the expected per-tick cost for known pricing and escalation
  (assert the scout+judge formula with fixed inputs).
- Fallback path: `pricing` omitted → `computeLiveCostPerTickUsd` returns `undefined` and
  `resolveAgentCostProfile` reproduces today's tiered `COST_PER_TICK` cadence exactly.
- Fallback path: any price `0` / negative / `NaN` / `Infinity` → `undefined` → fallback.
- Cadence derivation under both paths: `deriveCustomTickIntervalMs` clamps to the 300_000 ms floor
  and never produces `NaN` or divide-by-zero (budget 0, tiny budget, huge price).
- Back-compat: existing `cost-profile.test.ts` cases still pass unchanged when no pricing is passed.

Unit (web, `style-mapping.test.ts`):
- `formatStyleSummary` with full pricing returns a `~$X.XX/day estimated` string matching the
  shared helper output.
- `formatStyleSummary` with missing/zero pricing returns just the style name (no cost clause).
- `resolveModelPricing` returns `undefined` for missing provider/model/price and the adapted
  canonical fields otherwise.

Integration (worker):
- `resolvePerTickPricing` returns pricing from a representative `providersYaml` and `undefined`
  when the model is absent or pricing fields are missing.
- `agent.ts` passes resolved pricing through and falls back cleanly when absent (assert via the
  resolved `costProfile.tickIntervalMs` for the `custom` preset).

Regression (api): narrative LLM resolution unchanged with pricing omitted.

## Suggested Implementation Order

1. Step 1 — shared pure helper + constants + tests (foundation, no consumers yet).
2. Step 2 — thread optional pricing/escalation into `resolveAgentCostProfile`, keep fallback, tests.
3. Step 5 — confirm narrative call site is stable (cheap regression, de-risks step 2).
4. Step 4 — worker `resolvePerTickPricing` + wire into the `agent.ts` call site.
5. Step 3 — migrate `style-mapping.ts` to the shared helper and reconcile pricing shapes.
6. Step 6 — documentation/comments for stale constants + recalibration recommendation.
7. Run focused tests for changed files, then `pnpm lint`, then the relevant build/test suite.

## Risks / Guardrails

- **Estimate, not a cap.** Live pricing improves accuracy but the result is still a display/cadence
  estimate, not an enforced spend limit. Keep wording ("~$X/day estimated") and do not let any code
  treat it as a hard cap.
- **Stale token constants.** Even with live prices, the token-per-tick counts are stale; the estimate
  can be materially off until recalibrated. Flag prominently (step 6).
- **Catalog availability.** `providersYaml` may lack pricing for a dynamic provider (e.g. OpenRouter
  pricing lives in the DB snapshot; Ollama has none). The mandatory fallback must cover every such
  case; never crash or emit `NaN`.
- **Units / shape mismatch.** Mixing `*UsdPer1M` (web) and `*UsdPerM` (domain) risks a silent 1×/1M
  error. Standardise on the canonical `*UsdPerM` and add a test asserting the numeric magnitude.
- **Currency.** Catalog pricing is assumed USD; if a non-USD provider is ever added, the estimate
  would be wrong. Out of scope but noted — document the USD assumption at the helper boundary.
- **Back-compat.** Adding optional fields must not change any existing behaviour when pricing is
  omitted; both call sites must be verified.

## Open Decisions

1. Unify cadence + display math (recommended) vs keep them separate? Recommendation: unify via the
   shared helper so they cannot drift.
2. Should `deriveCustomTickIntervalMs` consume live cost-per-tick (so custom cadence tracks real model
   cost)? Recommendation: yes, with the mandatory fallback — this is the main point of the feature.
   Back-compat implication: custom-preset agents' derived interval will shift when live pricing is
   available; acceptable because it is a derived default the user can override with explicit
   `tickIntervalMs`, which still wins.
3. Where should the escalation rate for the cadence path come from — resolved runtime policy, style
   default, or a domain default constant? Recommendation: resolved policy/style when available, else a
   documented domain default.
4. New module (`cost-per-tick.ts`) vs extend `cost-profile.ts`? Recommendation: new module to keep the
   token constants and the pure cost math separable and independently testable.

## Non-Goals

- No enforcement of a spend cap; this remains an estimate.
- No recalibration of the token-per-tick constants in this change (only flagged + recommended).
- No new network fetches inside `packages/domain` (stays pure; pricing is passed in).
- No change to trading behaviour, risk gates, or the meaning of `dailySpendBudgetUsd`.
- No migration of base `tickIntervalMs` semantics or preset tick intervals.
