# Runtime turn-budget precedence ladder (scout/judge maxTurns)

Status: **Pending** — plan only, not yet implemented.

## Problem

The number of tool turns a scout/judge loop may take (`scoutMaxTurns`,
`judgeMaxTurns`) is currently defined in **two independent places with
conflicting values**, and the resolution between them is both inverted and
hidden:

1. **Operator tier** — `agentRuntime.llm.scout.maxTurns` / `llm.judge.maxTurns`
   in `config/default.yaml` (backed by Zod `.default()` in
   `AgentRuntimeLlmScoutControlsSchema` / `LlmJudgeConfigSchema`,
   `packages/domain/src/config/schema.ts`). This is external operator config.
2. **Instance/style tier** — `AGENT_STYLE_RUNTIME_DEFAULTS.scoutMaxTurns` /
   `judgeMaxTurns`, resolved per-agent from `style` + `runtime_policy_overrides`
   (Postgres, set via UI/API) by `resolveAgentRuntimePolicy`.

### What the code actually does today

- `apps/worker/src/index.ts` builds `AGENT_RUNTIME_CONFIG_JSON` from the
  operator config (`judge: appConfig.agentRuntime.llm.judge`, scout merged from
  `appConfig.llm.scout` + `appConfig.agentRuntime.llm.scout`).
- `apps/worker/src/agent.ts` (around lines 537–554) then **unconditionally
  overwrites** `agentRuntimePolicy.llm.scout.maxTurns` /
  `llm.judge.maxTurns` with the resolved style/instance value (`rp.scoutMaxTurns`
  / `rp.judgeMaxTurns`). The guard `if (agentConfig.resolvedRuntimePolicy)` is
  effectively always true for a real agent (`resolveAgentRuntimePolicy` always
  returns a fully-resolved object, and the session manager always passes it).
- The loop reads the now-overwritten values via `scoutLoopConfig` /
  `judgeLoopConfig` (around lines 858–859).

**Consequence:** the external operator value is loaded, shipped into the
container, then discarded. An operator who sets `agentRuntime.llm.judge.maxTurns`
in `config/default.yaml` has **no effect**. When the user set no override, the
clobbering value is merely the hardcoded style default — so **hardcoded beats
operator**, the opposite of the intended precedence. The in-code comment
("resolved policy … tops the operator defaults") documents the inversion as if
intended. No other consumer reads these fields
(`http-client.ts` / `web-access.ts` / `code.ts` read only `tools` / `webAccess`
/ `http` sub-objects of `AGENT_RUNTIME_CONFIG_JSON`), so the operator values are
dead everywhere except where they are overwritten.

## Desired precedence (the real fix)

Lowest to highest priority, bounded by the ceiling:

1. **Hardcoded literals** — code defaults (style defaults; schema `.default()`
   fallback). Zero-config baseline only.
2. **External operator config** — `config/default.yaml` + env overrides. Wins
   over hardcoded literals.
3. **User-supplied values** — frontend UI / API → per-agent
   `runtime_policy_overrides` (Postgres). Win over external operator config.

Across all tiers: **`RUNTIME_POLICY_CEILINGS` is the absolute cap.** No tier may
exceed it; the effective value is clamped to the ceiling.

```
effective = clamp(userOverride ?? operatorConfig ?? hardcodedDefault, ceiling)
```

## Design

1. **Make tiers distinguishable by presence.** Change the operator-tier fields
   (`AgentRuntimeLlmScoutControlsSchema.maxTurns`, `LlmJudgeConfigSchema.maxTurns`,
   and any other field to join the ladder) from `.default(n)` to **optional, no
   default**. `undefined` means "operator did not set it → fall through to the
   hardcoded baseline." A present value means "operator set it → it wins over the
   baseline" (still subject to user override and the ceiling). The hardcoded
   baseline moves to being the final `??` fallback inside the resolver, not a Zod
   default.

2. **Single resolver owns the ladder.** Extend `resolveAgentRuntimePolicy` (or a
   thin wrapper at the worker composition boundary) to take the resolved operator
   config as an input alongside `style` + `overrides`, and resolve each field as
   `clamp(userOverride ?? operatorValue ?? styleDefault, ceiling)`. This becomes
   the one place precedence lives.

3. **Delete the overwrite in `agent.ts`.** Once the resolver already folds in
   operator config, the loop reads the resolved value directly. Remove the
   lines-537–554 clobber and its misleading comment; this also eliminates the
   duplicate-home smell.

4. **Enforce the ceiling as a clamp, not only at override-validation time.** The
   existing user-override `.max(ceiling)` Zod check stays, but the resolver must
   also clamp the operator tier. Decide operator-above-ceiling behaviour:
   fail-fast at startup (preferred by the configuration doc's "fail fast"
   principle for operator config) vs. clamp-with-warn.

5. **Tests + docs.** Strengthen `apps/worker/src/__tests__/integration/
   config-propagation.integration.test.ts` to prove operator-beats-hardcoded,
   user-beats-operator, and ceiling-clamp. Update `schema.test.ts` for the
   now-optional operator fields. Document the three-tier ladder + ceiling clamp in
   `docs/best-practices/configuration.md` and
   `docs/tech/agents/runtime-policy-and-reasoning.md`.

## Scope decisions to confirm before implementing

- **Field scope:** apply the ladder only to `scoutMaxTurns` / `judgeMaxTurns`, or
  convert the whole runtime policy (tokens, history budgets, thinking budgets,
  hold duration) to the same resolution? The latter is more consistent but larger
  and riskier.
- **Operator-above-ceiling:** fail-fast vs. clamp-with-warn.

## Interim stopgap (shipped ahead of this plan)

To remove the confusion and make the current (still-inverted) resolution
**harmless** until this fix lands, all tiers were aligned to the same
near-ceiling values so whichever tier wins produces the same numbers:

- `scoutMaxTurns`: ceiling 500; every style = 499; operator default
  (`config/default.yaml` + schema) = 499.
- `judgeMaxTurns`: ceiling 10,000; every style = 9,999; operator default = 9,999.

This is explicitly a stopgap: it does **not** fix the precedence; it only makes
the duplicated homes agree. The real fix above still applies.

## Affected files (real fix)

- `packages/domain/src/config/schema.ts` — operator field optionality, resolver.
- `apps/worker/src/agent.ts` — delete the overwrite; read resolved values.
- `apps/worker/src/index.ts` — feed operator config into the resolver path.
- `config/default.yaml` — comments reflecting the ladder.
- Tests: `schema.test.ts`, `runtime-policy-propagation.integration.test.ts`,
  `config-propagation.integration.test.ts`.
- Docs: `configuration.md`, `runtime-policy-and-reasoning.md`.
