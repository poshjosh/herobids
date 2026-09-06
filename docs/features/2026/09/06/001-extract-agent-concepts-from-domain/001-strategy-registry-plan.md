# Plan 001 — Extract LLM/Hybrid decision modes from the strategy registry (herobids)

**Repository to change:** `herobids` (the monorepo at the root you are working in).
**Status:** ready to implement.
**Type:** behaviour-preserving refactor. herobids runtime behaviour must be identical before and after. Validated by herobids' existing test suite.

## Implementation Checklist

- **[DONE]** Step 1 — make `initStrategyRegistry` require only mechanical schemas
- **[DONE]** Step 2 — add an agent-mode registration hook (`registerAgentDecisionModes`)
- **[DONE]** Step 3 — relocate llm/hybrid registration behind the hook and wire it (Option B: schema definitions kept in domain; hook invoked from `schema.ts` at module load — see rationale below)
- **[DONE]** Step 4 — preserve DCA-across-all-modes behaviour
- **[DONE]** Step 5 — update the domain-side call site

### Step-3 decision (recorded per plan deliverable)

Took **Option B** (kept `LlmParamsSchema`/`HybridParamsSchema` defined in `packages/domain/src/config/schema.ts`). Moving them would break the large `@herobids/domain` re-export surface (`index.ts` + `LlmParams`/`HybridParams` types), and `HybridParamsSchema` is deeply coupled to domain indicator schemas. The domain registry *file* (`strategy-parameters.ts`) is now free of LLM concepts and initializes with `{ mechanical, empty }` only, satisfying the plan's core constraint.

Deviated from the plan's *recommended* wiring: `registerAgentDecisionModes` is invoked from `schema.ts` at module load (right after `initStrategyRegistry`) rather than from `packages/strategy`. Reason: `apps/api` validates `momentum:llm`/`momentum:hybrid` via `StrategyIdentitySchema` but does not import `@herobids/strategy` at runtime, so strategy-package wiring would leave the API path unregistered — a real regression. Both `apps/api` and `apps/worker` import `@herobids/domain`, so registering there guarantees registration-before-validation with no module cycle.

## Outstanding Issues

Non-blocking (LOW) observations from code review (0 CRITICAL / 0 HIGH / 0 blocking MEDIUM):

- [Step 3] The domain *package* still defines the LLM param schemas in `schema.ts` (permitted Option B trade-off). A downstream consumer wanting a fully LLM-free domain package could revisit moving these; not required for herobids.
- [Step 2] No dedicated runtime guard for the "agent mode unregistered" case; it falls back to the existing "Unsupported strategy" error path — acceptable and pre-existing behaviour.

---

## Who this is for

You are an agent working **inside the herobids monorepo**. You do not need any
knowledge of any other repository. This plan is fully self-contained. Everything
you touch is in `herobids`.

Do not worry about "Traderton" — it is a downstream consumer that will copy the
result of this change later. This plan notes *why* the change is wanted only for
context; your job is purely the herobids-side refactor described below, and the
acceptance bar is **herobids' own tests stay green**.

## Background — what the strategy registry is

File: `packages/domain/src/config/strategy-parameters.ts`.

It is a validation lookup table keyed by `` `${strategyType}:${decisionMode}` ``
→ `{ schema, defaults, description }`. Its job is to validate a strategy's
`params` against the correct Zod schema for its `(type, decisionMode)`
combination. Public functions: `validateStrategyParams`, `getStrategyParameters`,
`isStrategySupported`, `listStrategyCombinations`, plus the deferred initializer
`initStrategyRegistry`.

The registry uses **deferred initialization** to avoid a module cycle:
`packages/domain/src/config/schema.ts` owns the actual param schemas
(`MechanicalParamsSchema`, `HybridParamsSchema`, `LlmParamsSchema`) and also owns
`StrategyIdentitySchema` which validates *through* the registry. To avoid
`strategy-parameters.ts` and `schema.ts` importing each other, `schema.ts` calls
`initStrategyRegistry({ mechanical, hybrid, llm, empty })` at module load to inject
the schemas.

The current registry registers these `(type, mode)` combinations:
- `dca` → all three modes (`mechanical`, `llm`, `hybrid`), all with an empty
  params schema (DCA is timer-driven, no params).
- `momentum`, `range`, `contrarian`, `swing`, `scalper` → `mechanical` (uses
  `MechanicalParamsSchema`).
- `momentum` → `hybrid` (uses `HybridParamsSchema`).
- `momentum` → `llm` (uses `LlmParamsSchema`).

## Why the change is wanted (context only)

The `llm` and `hybrid` decision modes are *reasoning* modes. In the downstream
split they belong to the agent side, not the mechanical trading side. We want the
**strategy registry itself to be mechanical-first**: the `llm`/`hybrid`
registration and the `LlmParamsSchema`/`HybridParamsSchema` should live in an
agent-side location, so a mechanical consumer can use the registry without
pulling LLM concepts.

**Crucial constraint:** herobids must keep working exactly as today. herobids
still supports `momentum:llm` and `momentum:hybrid` at runtime — you are
*relocating where those registrations come from*, not removing the capability
from herobids.

## Goal

Refactor so that:

1. `strategy-parameters.ts` / the domain registry can be initialized with **only
   the mechanical schemas** (`mechanical` + `empty`) and be fully functional for
   mechanical + dca strategies.
2. The `llm` and `hybrid` registrations (and `LlmParamsSchema` / `HybridParamsSchema`)
   are provided from an **agent-side module**, not baked into the domain-side
   `initStrategyRegistry` call.
3. herobids end-to-end behaviour is unchanged: `momentum:llm` and
   `momentum:hybrid` still validate exactly as they do today when herobids runs.

## Current consumer map (verified — so you know the blast radius)

- `initStrategyRegistry` is called in exactly one production place:
  `packages/domain/src/config/schema.ts` (~line 2168), which passes
  `{ mechanical: MechanicalParamsSchema, hybrid: HybridParamsSchema, llm: LlmParamsSchema, empty: z.object({}).strict() }`.
- It is also called in `packages/domain/src/config/strategy-parameters.test.ts`
  (with test schemas).
- `MechanicalParamsSchema` is consumed by `packages/strategy/src/mechanical-strategy.ts`.
- `HybridParamsSchema` is consumed by `packages/strategy/src/hybrid-strategy.ts`.
- `LlmParamsSchema` is consumed by `packages/strategy/src/llm.ts`.
- `validateStrategyParams` / `getStrategyParameters` etc. are consumed only inside
  `packages/domain/src/config/schema.ts` (via `StrategyIdentitySchema`).
- `MechanicalParamsSchema` depends only on `IndicatorConfigSchema` and
  `SentimentConfigSchema` (both trading-shaped). `HybridParamsSchema` wraps
  `MechanicalParamsSchema` plus LLM fields. `LlmParamsSchema` is standalone.

`packages/strategy` already physically splits mechanical vs agent:
`mechanical-strategy.ts`, `dca-strategy.ts`, `scan-engine.ts` (mechanical) vs
`llm.ts`, `hybrid-strategy.ts`, `llm-provider.ts` (agent). That existing split is
a good guide for where the agent-side registration should live.

## Recommended approach

The cleanest behaviour-preserving reshape is to make the domain registry
**mechanical-only by construction** and add a **separate, optional
registration hook** for the agent modes, then have an agent-side module call that
hook at startup. Concretely:

### Step 1 — make `initStrategyRegistry` require only mechanical schemas

In `packages/domain/src/config/strategy-parameters.ts`:

- Change the `initStrategyRegistry` signature so `llm` and `hybrid` are **no
  longer required**. Keep it accepting `{ mechanical, empty }` as the required
  shape. Register:
  - `dca` → `mechanical` mode with the empty schema (see step 4 re DCA modes),
  - the five mechanical types (`momentum`, `range`, `contrarian`, `swing`,
    `scalper`) → `mechanical` with `schemas.mechanical`.
- Do **not** register `momentum:llm` / `momentum:hybrid` from inside
  `initStrategyRegistry` anymore.

### Step 2 — add an agent-mode registration hook

- Add a new exported function in `strategy-parameters.ts`, e.g.
  `registerAgentDecisionModes(schemas: { llm: z.ZodTypeAny; hybrid: z.ZodTypeAny })`,
  that registers `momentum:llm` (→ `schemas.llm`) and `momentum:hybrid`
  (→ `schemas.hybrid`) with the same `description` strings currently used. This
  keeps the registration logic in the domain registry (so the Map stays the
  single source of truth) but makes the agent modes an explicit, separate,
  optional step rather than a required init argument.
- `SUPPORTED_DECISION_MODES` currently is `['mechanical', 'llm', 'hybrid']`. Keep
  this union as-is in herobids (it is a type-level catalogue and other herobids
  code may rely on it). Do **not** narrow it in herobids. (The downstream
  consumer will narrow its own copy; that is not your concern.)

### Step 3 — move `LlmParamsSchema` / `HybridParamsSchema` to an agent-side location and wire the hook

The two LLM param schemas currently live in `packages/domain/src/config/schema.ts`.
For the domain registry to be free of LLM concepts, these should be defined
agent-side. Options (pick whichever keeps herobids cleanest and its tests green):

- **Preferred:** move `LlmParamsSchema` and `HybridParamsSchema` definitions out
  of `packages/domain/src/config/schema.ts` into an agent-side module (for
  example under `packages/strategy/src/` alongside `llm.ts` / `hybrid-strategy.ts`,
  which are their only consumers), and have that module (or an agent/worker
  startup path) call `registerAgentDecisionModes({ llm, hybrid })` once at startup.
  Update `packages/strategy/src/llm.ts` and `hybrid-strategy.ts` to import the
  schemas from their new home. Update `packages/domain/src/config/index.ts` and
  any re-export of `LlmParamsSchema`/`HybridParamsSchema` accordingly.
- **If moving the definitions is too invasive** for herobids' import graph: keep
  `LlmParamsSchema`/`HybridParamsSchema` defined where they are, but remove them
  from the `initStrategyRegistry` call in `schema.ts` and instead call
  `registerAgentDecisionModes({ llm: LlmParamsSchema, hybrid: HybridParamsSchema })`
  from an agent-side startup module. This still achieves "the domain registry
  init does not require llm/hybrid," though the schema *definitions* remain in
  domain. Note in your PR which option you took and why. (The downstream consumer
  most cleanly benefits from the preferred option, but herobids correctness and a
  green suite come first.)

Ensure the agent-side registration actually runs in every herobids entrypoint
that today relies on `momentum:llm`/`momentum:hybrid` being validatable (the API
and worker startup paths). The safest way is to invoke `registerAgentDecisionModes`
from the same startup location(s) that already import the LLM strategy code, so
the modes are registered before any agent strategy validation occurs.

### Step 4 — preserve DCA-across-all-modes behaviour

The existing registry registers `dca` for **all three** decision modes (an
existing test asserts `listStrategyCombinations()` returns 3 dca combos). Decide
and preserve behaviour explicitly:

- herobids currently registers dca for `mechanical`, `llm`, `hybrid` (all empty
  schema). To keep herobids behaviour identical, dca must still resolve for all
  three modes **in herobids** after your change. The simplest way: register
  `dca:mechanical` in `initStrategyRegistry`, and register `dca:llm` + `dca:hybrid`
  inside `registerAgentDecisionModes` (empty schema). That preserves the "3 dca
  combos" behaviour in herobids while keeping the domain-only init mechanical.
- Update the registry test expectation only if you deliberately change this; if
  you preserve the 3-combo behaviour, the existing test should still pass
  unchanged.

### Step 5 — update the domain-side call site

In `packages/domain/src/config/schema.ts`, change the `initStrategyRegistry({...})`
call so it passes only the mechanical/empty schemas it still owns. The LLM/hybrid
registration now happens via `registerAgentDecisionModes` from the agent side (step 3).

## Constraints (must all hold)

1. **Behaviour-preserving in herobids.** After the change, running herobids
   validates `momentum:mechanical`, `momentum:llm`, `momentum:hybrid`, all five
   mechanical types, and `dca` (all its modes) exactly as before. No decision mode
   that worked before may stop working in herobids.
2. **No new required LLM dependency in the domain registry.** After the change,
   `packages/domain/src/config/strategy-parameters.ts` must be usable with only
   mechanical schemas — it must not require `llm`/`hybrid` schemas to initialize,
   and it must not import LLM strategy code.
3. **Do not narrow `SUPPORTED_DECISION_MODES` in herobids.**
4. **No public behavioural change to `StrategyIdentitySchema` / `StrategySchema`**
   in herobids. `StrategySchema.decisionMode` stays `['mechanical','llm','hybrid']`.
5. Keep the existing `description` strings and `defaults` for each registered
   entry identical.

## Tests & quality gates (acceptance)

Run from the herobids repo root:

1. `pnpm lint` (this repo's lint is `tsc --noEmit`) — must pass.
2. `pnpm test` — the full vitest suite must pass, in particular:
   - `packages/domain/src/config/strategy-parameters.test.ts` (registry behaviour,
     including the "3 dca combos" assertion and `momentum:hybrid` uses hybrid
     schema).
   - `packages/domain/src/config/schema.test.ts` (`LlmParamsSchema`,
     `StrategySchema`, `BotConfigSchema` blocks).
   - `packages/strategy/src/mechanical-strategy.test.ts`,
     `hybrid-strategy.test.ts`, `llm.test.ts`.
3. If you moved `LlmParamsSchema`/`HybridParamsSchema`, update any import in the
   test files and re-run until green.
4. `pnpm build` — must succeed.

## Deliverable

- A herobids branch + PR with the change, all gates green.
- In the PR description, state which Step-3 option you took (moved the schemas vs
  kept definitions in domain) and confirm herobids still validates all decision
  modes.
- Cut a release/tag so the downstream consumer can pin to the improved source.

## Out of scope

- Any change to `Traderton` (a different repo). Do not attempt it.
- Removing `llm`/`hybrid` support from herobids. herobids keeps all modes.
- Narrowing enums or changing `StrategySchema` behaviour in herobids.
