# Non-Trading Tick-Interval Resolver

Status: PENDING — identified during the 2026-11 LLM cost/cadence cleanup.

## Summary

Move the "non-trading agents default to a 24 h tick interval" rule **out of the
frontend** and into a **single backend resolver**, so there is one source of
truth and the system can tell a *user-chosen* interval apart from a *defaulted*
one.

Today the 24 h default is baked into the web create/edit form: when an agent has
no trading-capability skill, the form pre-fills `tickIntervalMins = 1440` and
sends `tickIntervalMs = 86_400_000` in the create/update payload. Because the
value is pre-filled, the backend cannot distinguish "the creator explicitly
picked 24 h" from "the form defaulted to 24 h". That ambiguity blocks skill-
driven defaults (plan 071) and the agent-controlled interval (plan 070 / routine-
tasks Part 2), both of which need to know whether the stored value is an explicit
user choice.

This plan:

1. **Stops the frontend pre-filling 1440** for non-trading agents, so an unset
   interval genuinely means "resolve the default server-side".
2. **Applies the non-trading 24 h default in the backend**, gated on
   `hasTradingCapability`, only when there is no explicit user override.
3. **Preserves back-compat** for existing agents that already have
   `tickIntervalMs = 86_400_000` stored.

## Motivation

- **One source of truth.** The 24 h rule lives in the frontend
  (`resolveStyleTickIntervalMins`) *and* the backend ships
  `NON_TRADING_DEFAULT_TICK_INTERVAL_MS` + `AgentRuntimeNonTradingDefaultsSchema`
  but never actually applies it as a *resolver default* — the frontend beats it
  to the punch. Two half-owners, no authority.
- **User-vs-default is currently unknowable.** The DB column
  `agents.tick_interval_ms` is nullable (`integer('tick_interval_ms')`), so
  `null` is already available to mean "unset". The frontend throws that signal
  away by pre-filling 1440. Recovering it is the core of this change.
- **Unblocks adjacent plans.** 071 (skill-driven defaults) wants the API to only
  compute a default "if `tickIntervalMs` was not explicitly provided". 070 /
  routine-tasks Part 2 want "a creator edit clears the agent's runtime override".
  Both depend on an unset value being distinguishable from an explicit one.

## Current State (verified)

### Frontend — applies the 24 h rule today

`apps/web/src/features/agents/style-mapping.ts`:

```ts
export const NON_TRADING_DEFAULT_TICK_INTERVAL_MINS =
  String(NON_TRADING_DEFAULT_TICK_INTERVAL_MS / MS_PER_MINUTE); // "1440"

export function resolveStyleTickIntervalMins(style, hasTradingCapability): string {
  if (!hasTradingCapability) return NON_TRADING_DEFAULT_TICK_INTERVAL_MINS; // 24 h
  return resolveStyleDefaults(style).tickIntervalMins;                       // style interval
}
```

- `CreateAgentFlow.tsx` seeds `tickIntervalMins` via `resolveStyleTickIntervalMins`
  at init (no skills → non-trading → `'1440'`), on style change, and when the
  selected skills' trading capability changes.
- `EditAgentModal.tsx` re-applies `resolveStyleTickIntervalMins` on style change,
  keeping the 24 h default for a non-trading agent.
- `agent-payloads.ts` `getTickIntervalMsOrThrow(tickIntervalMins)` converts the
  minutes string → `tickIntervalMs`. The create payload only includes
  `tickIntervalMs` when non-empty; update always sends `tickIntervalMs`
  (number or null, unless `preserveOriginalTickIntervalMs`).

Net effect: a non-trading agent's create/update payload carries an explicit
`tickIntervalMs = 86_400_000` that is indistinguishable from a deliberate choice.

### Backend — has the constant, does not apply it as a resolver default

`packages/domain/src/config/schema.ts`:

```ts
export const NON_TRADING_DEFAULT_TICK_INTERVAL_MS = 86_400_000; // 24 h
export const AgentRuntimeNonTradingDefaultsSchema = z.object({
  tickIntervalMs: z.number().int().min(60_000).default(NON_TRADING_DEFAULT_TICK_INTERVAL_MS),
}).default({});
```

- Operator config path: `appConfig.agentRuntime.nonTradingDefaults.tickIntervalMs`
  is already threaded into the API agents router (see `apps/api/src/index.ts`
  route wiring). It is used when *adding a trading skill* to replace a stored
  non-trading tick (`resolveTradingTickIntervalMs` in
  `packages/domain/src/config/agent-schedule.ts`), **not** when choosing the
  initial non-trading default.
- `resolveAgentRuntimePolicy(style, overrides, { hasTradingCapability })` already
  takes `hasTradingCapability` and already gates `allowedHoursUtc`,
  `weekendPause`, `tradingSessions`, and `skipUnchangedTicks` on it via the
  `styleHoursApply` pattern. **It does not currently resolve `tickIntervalMs` at
  all** — tick lives outside the resolved policy.

### Where the tick is authoritatively decided today

The stored `agents.tick_interval_ms` flows:

1. `agent-session-manager.ts` reads `agent.tickIntervalMs` (nullable) and passes
   it through `agentConfig.tickIntervalMs` to the container. It *separately*
   computes `resolvedRuntimePolicy` via `resolveAgentRuntimePolicy(..., {
   hasTradingCapability: deriveHasTradingCapability(resolvedSkills) })`.
2. In the worker, `apps/worker/src/agent.ts` calls `resolveAgentCostProfile({
   baseTickIntervalMs: TICK_INTERVAL_MS, tickIntervalMs: agentConfig.tickIntervalMs,
   ... })`. `resolveAgentCostProfile` (`packages/domain/src/cost-profile.ts`,
   re-exported by `apps/worker/src/cost-profile.ts`) honours an explicit
   `tickIntervalMs > 0` over the preset-derived one ("explicit tick interval
   wins"). The result `costProfile.tickIntervalMs` seeds `effectiveTickIntervalMs`.

So **today the authoritative tick resolution is `resolveAgentCostProfile`**, and
the frontend-set 1440 flows in as its explicit input. `resolveAgentRuntimePolicy`
does not touch tick. This split is the crux of the design decision below.

## Design Decision: where the non-trading default should live

Two candidate homes:

| Candidate | For | Against |
|---|---|---|
| **`resolveAgentRuntimePolicy`** (schema.ts) | Already `hasTradingCapability`-gated; the 24 h rule is a *behavioural cadence* policy that sits beside the same flag's existing gates (hours, weekend, skip-unchanged). Resolved policy already reaches the worker (`resolvedRuntimePolicy`). | Tick is not currently in resolved policy, so adding it means reconciling with `resolveAgentCostProfile`, which also decides tick. |
| **`resolveAgentCostProfile`** (cost-profile.ts) | Already the authoritative tick resolver (`effectiveTickIntervalMs` comes from here). | Cost-profile is about *cost/model* (preset, budget, model tiers, gates). Overloading it with a trading-capability behavioural rule muddies its single responsibility, and it does not receive `hasTradingCapability` today. |

**Recommendation: put the non-trading 24 h *default* in `resolveAgentRuntimePolicy`,
and keep `resolveAgentCostProfile` as the place that *applies* an explicit tick.**

Rationale and the **reconciliation that avoids two resolvers both deciding the
tick**:

- Define a single precedence, resolved once, at the point the tick is passed into
  the worker:
  1. **Explicit user override** (stored `agents.tick_interval_ms != null`) — wins.
  2. **Non-trading default** — if no explicit override *and*
     `hasTradingCapability === false`, use
     `agentRuntime.nonTradingDefaults.tickIntervalMs` (24 h).
  3. **Preset/style baseline** — otherwise fall through to the existing
     preset-derived tick (`resolveAgentCostProfile`) / style trading tick.
- `resolveAgentRuntimePolicy` becomes the owner of step 2 only (the *default when
  unset and non-trading*). It must **not** invent a tick when the agent is
  trading or when an explicit override exists — in those cases it returns
  `undefined`/omits the field and `resolveAgentCostProfile` stays authoritative.
- `resolveAgentCostProfile` keeps "explicit tick interval wins" unchanged. The
  only change to its *callers* is that the input they feed as the explicit
  `tickIntervalMs` is now the already-precedence-resolved value (explicit override
  ⟶ non-trading default ⟶ undefined), so cost-profile never sees a *defaulted*
  1440 masquerading as explicit.

Concretely, add a small, pure helper that both the session-manager (worker path)
and the API decoration path can call, so the precedence is written once:

```
resolveEffectiveTickIntervalMs({
  storedTickIntervalMs: number | null,      // agents.tick_interval_ms
  hasTradingCapability: boolean,
  nonTradingDefaultTickIntervalMs: number,  // operator config
}): { tickIntervalMs: number | null; source: 'user' | 'non_trading_default' | 'unset' }
```

- `storedTickIntervalMs != null` → `{ tickIntervalMs: stored, source: 'user' }`.
- `!hasTradingCapability` → `{ tickIntervalMs: nonTradingDefault, source: 'non_trading_default' }`.
- otherwise → `{ tickIntervalMs: null, source: 'unset' }` (let cost-profile/style
  decide the trading cadence).

This keeps `resolveAgentRuntimePolicy` as the natural, flag-gated home for the
*rule* (it can expose the resolved value on `ResolvedAgentRuntimePolicy` for
transparency), while `resolveAgentCostProfile` remains the single place that
turns an explicit tick into `effectiveTickIntervalMs`. One precedence function,
no double-resolution.

> Open decision (see below): whether to surface the resolved tick on
> `ResolvedAgentRuntimePolicy` or keep it as a standalone helper result. The
> recommendation is the standalone helper + an optional read-only field on the
> resolved policy for prompt/UI transparency.

## Relationship to existing pending plans

Read before implementing — this plan must not contradict them:

- **`docs/features/pending/071-skill-driven-tick-interval-defaults`** — wants the
  API to compute a *skill-derived* default **only when `tickIntervalMs` was not
  explicitly provided**. That requirement is exactly what this plan enables: once
  the frontend stops pre-filling, "not provided" is finally detectable. **Overlap
  to resolve:** both plans touch the create-flow default. Order them so this plan
  (distinguish user-vs-unset) lands first; 071's skill-derived computation then
  slots into the *same* "unset" branch for *trading* agents, while the non-trading
  branch resolves to 24 h here. They are complementary: non-trading → 24 h (this
  plan); trading-but-unset → skill-derived (071); explicit → user value (both).
- **`docs/features/pending/070-agent-min-tick-interval-extension`** (superseded by
  routine-tasks Part 2) — "a creator edit clears the agent's runtime override" and
  "stored `tickIntervalMs` is no longer always the effective cadence". **No
  conflict:** this plan only governs the *creator-time default vs explicit*
  distinction and the *storage* semantics; it does not touch runtime agent-set
  overrides. Keep the precedence helper's step 1 ("explicit stored value wins")
  compatible with Part 2's notion that a creator edit writes an explicit value.
- **`docs/features/pending/071` note #6** already states the intended end state:
  "Non-trading agents default to 24 h (operator config
  `agentRuntime.nonTradingDefaults.tickIntervalMs`)". This plan is the mechanism
  that makes that note true in the backend rather than the frontend.

## Detailed Plan

### 1. Domain: precedence helper + resolver wiring

Files:
- `packages/domain/src/config/schema.ts`
- `packages/domain/src/config/agent-schedule.ts` (co-locate the helper if it fits
  better beside `resolveTradingTickIntervalMs`)
- `packages/domain/src/config/index.ts` (export the new helper)
- `packages/domain/src/config/schema.test.ts`
- `packages/domain/src/config/agent-schedule.test.ts`

Changes:
- Add `resolveEffectiveTickIntervalMs({ storedTickIntervalMs, hasTradingCapability,
  nonTradingDefaultTickIntervalMs })` returning `{ tickIntervalMs, source }` as
  defined above. Pure, no I/O.
- Keep `NON_TRADING_DEFAULT_TICK_INTERVAL_MS` and
  `AgentRuntimeNonTradingDefaultsSchema` as the operator-config source for the
  default value (do not hard-code 24 h in the helper — take it as a parameter).
- `resolveAgentRuntimePolicy`: do **not** change its existing field gating.
  Optionally add a read-only `resolvedTickIntervalMs?: number | undefined` to
  `ResolvedAgentRuntimePolicy` for transparency, populated by the same helper when
  the caller supplies the stored value + non-trading default. If adopted, this is
  informational only; the authoritative application of the tick stays in the
  worker's cost-profile step.

### 2. Backend consumption: session-manager (worker path)

Files:
- `apps/worker/src/agents/agent-session-manager.ts`
- `apps/worker/src/agent.ts`
- associated tests (`*.test.ts`, `runtime-policy-propagation.integration.test.ts`)

Changes:
- In `agent-session-manager.ts`, where `agent.tickIntervalMs` is passed into
  `agentConfig`, run it through `resolveEffectiveTickIntervalMs` using
  `deriveHasTradingCapability(resolvedSkills)` (already computed there) and the
  operator `nonTradingDefaults.tickIntervalMs`. Pass the *resolved* tick (or
  `null`/omit) as `agentConfig.tickIntervalMs`.
  - Thread `nonTradingDefaults.tickIntervalMs` into the session manager if it is
    not already available (it is wired into the API today; confirm the worker's
    config exposes `agentRuntime.nonTradingDefaults`).
- In `agent.ts`, no behavioural change beyond receiving the already-resolved
  `agentConfig.tickIntervalMs`. `resolveAgentCostProfile` continues to apply
  "explicit tick wins" — but now a non-trading agent with no user choice arrives
  with the resolved 24 h, and a trading agent with no choice arrives as `undefined`
  so the preset/style cadence applies. Verify `effectiveTickIntervalMs` still
  seeds correctly.

### 3. API: create/patch + response decoration

Files:
- `apps/api/src/routes/agents.ts`
- `apps/api/src/routes/agent-config-helpers.ts`
- `apps/api/src/routes/agents.test.ts`
- `apps/api/src/routes/agent-config-helpers.test.ts`

Changes:
- **Create:** when `tickIntervalMs` is absent from the payload, store `null`
  (unset) rather than defaulting to 24 h. Do **not** write 24 h into the column at
  create time. (The default is resolved at read/worker time by step 2; this keeps
  "user-vs-default" recoverable forever.)
  - Coordinate with plan 071: for *trading* agents the "unset" branch may compute
    a skill-derived default; that is 071's job and should also key off "payload
    omitted `tickIntervalMs`". This plan only guarantees the omission is
    detectable and that *non-trading* unset → 24 h at resolve time.
- **Patch:** preserve current semantics — an explicit `tickIntervalMs` writes an
  explicit value; omission leaves the stored value untouched. Sending `null`
  explicitly means "clear back to unset/default" (confirm the route accepts null
  to clear; today update sends number-or-null).
- **Response decoration:** expose the *resolved effective* tick (and ideally its
  `source`) so the UI can display the effective 24 h without the stored column
  being 24 h. Add it to the decorated agent response via the resolved policy /
  helper so the form can show "Default: 24 h (non-trading)".
- `validateMaxHoldDurationInvariant` (agent-config-helpers): review the existing
  tests that pass `tickIntervalMs = 24 h` for non-trading agents — the invariant
  must still be validated against the *effective* tick, so validation should run
  on the resolved value, not the raw stored null. Ensure non-trading + null still
  validates as 24 h for the max-hold invariant.

### 4. Frontend: stop pre-filling, display effective default

Files:
- `apps/web/src/features/agents/style-mapping.ts`
- `apps/web/src/features/agents/agent-form-state.ts`
- `apps/web/src/features/agents/agent-payloads.ts`
- `apps/web/src/features/agents/CreateAgentFlow.tsx`
- `apps/web/src/features/agents/EditAgentModal.tsx`
- `apps/web/src/features/agents/style-mapping.test.ts`
- create/edit render + flow tests

Changes:
- **Remove the pre-fill:** delete `resolveStyleTickIntervalMins`' non-trading 24 h
  branch (and likely the function, if trading agents can read the style interval
  directly). Stop seeding `tickIntervalMins = '1440'` at init, on style change, and
  on trading-capability change in `CreateAgentFlow.tsx` / `EditAgentModal.tsx`.
  - For a non-trading agent, leave the Tick interval field **empty** (meaning
    "use default"), and show the effective default as placeholder/helper text
    (e.g. "Default: 1440 min (24 h) for non-trading agents"). The field stays
    editable — typing a value makes it an explicit user choice.
  - `NON_TRADING_DEFAULT_TICK_INTERVAL_MINS` may be retained purely for the
    *display* string, but must no longer feed the payload.
- **Payload:** `agent-payloads.ts` — when the field is empty, continue to **omit**
  `tickIntervalMs` on create (already the behaviour of `getTickIntervalMsOrThrow`
  returning `undefined` → omitted). On update, an empty field should send the
  value that means "unset/default" per the API contract agreed in step 3 (null to
  clear vs omit to leave). Make the empty-field semantics explicit and tested.
- **Hydration (`agent-form-state.ts`):** `formatTickIntervalMinutesForInput(
  agent.tickIntervalMs)` — when the stored value is `null`, the field should
  hydrate as empty (not 1440), so editing a defaulted non-trading agent does not
  silently persist 24 h as explicit. Use the decorated *effective* value only for
  display/helper text, not for the editable field's value.
- **Max-hold auto-derivation:** `applyAutoMaxHoldOverride` /
  `reconcileMaxHoldOverride` currently derive max-hold from the (pre-filled) tick.
  With an empty tick for non-trading agents, derive against the *effective* tick
  (24 h) for display/validation parity, mirroring the backend invariant.

### 5. Migration / back-compat for existing ~1440 agents

Files:
- `docs/features/.../000-...` note; no data migration required (recommended).

Decision & rationale:
- **Do not rewrite existing rows.** Existing non-trading agents already have
  `tick_interval_ms = 86_400_000` stored. Under the new precedence that is read as
  an **explicit user value** (`source: 'user'`), which resolves to the same 24 h
  cadence they run today — **zero behaviour change**. They simply lose the
  "defaulted" signal, which is acceptable because they predate the distinction.
- The alternative (a migration that nulls out any non-trading agent whose stored
  tick equals the operator non-trading default) would *reclaim* the defaulted
  signal for old agents but risks reinterpreting an agent whose creator genuinely
  chose 24 h. **Reject for v1**; call it out as an open decision only if 071/070
  later need old agents to pick up skill-derived/agent-set defaults.
- Document the one observable consequence: an old non-trading agent edited in the
  form will show 24 h as an explicit value (field populated), whereas a
  newly-created one shows it as a placeholder default (field empty). This is
  cosmetic and expected.

### 6. Operator config / `.env` twins

Files:
- `config/default.yaml` (confirm `agentRuntime.nonTradingDefaults.tickIntervalMs`
  exists and is the single source for the 24 h value)
- any `.env*.example` only if a new env override is introduced (not expected)

Changes:
- No new env var is anticipated — the default already lives in operator config.
  If step 2 needs to thread `nonTradingDefaults` to the worker and that requires a
  config surface change, keep it in YAML operator config (not instance config) per
  the configuration best-practices split, and update `.example` twins only if an
  env override key is added.

## Testing Plan

**Domain (unit — the resolver is pure, favour property-style coverage):**
- `resolveEffectiveTickIntervalMs`:
  - stored non-null → `source: 'user'`, value passed through (both trading and
    non-trading).
  - stored null + non-trading → `source: 'non_trading_default'`, value = operator
    default.
  - stored null + trading → `source: 'unset'`, `tickIntervalMs: null`.
  - operator default is respected (not hard-coded 24 h) — vary the input.
- `resolveAgentRuntimePolicy` existing gating unchanged (regression).
- If `resolvedTickIntervalMs` is added to `ResolvedAgentRuntimePolicy`, assert it
  matches the helper.

**API (integration):**
- Create non-trading agent without `tickIntervalMs` → stored column is `null`;
  decorated response shows effective 24 h with `source: non_trading_default`.
- Create non-trading agent with explicit `tickIntervalMs` → stored = explicit;
  `source: user`.
- Create trading agent without `tickIntervalMs` → stored `null`; effective resolves
  to style/preset cadence (and, once 071 lands, skill-derived) — not 24 h.
- Patch: omit → unchanged; explicit → stored; null → cleared to unset.
- `validateMaxHoldDurationInvariant` runs against the effective tick; non-trading
  null still validates as 24 h.

**Web (component / flow):**
- Create flow: non-trading selection leaves Tick interval empty with a 24 h
  helper/placeholder; payload omits `tickIntervalMs`.
- Typing a value in the field makes the payload carry an explicit `tickIntervalMs`.
- Switching skills to trading no longer force-writes a style interval into an
  empty field (it stays the user's choice if set; stays empty/default if unset).
- Edit flow: hydrating an agent with `tick_interval_ms = null` shows an empty
  field + effective default; hydrating a stored explicit value shows that value.
- `style-mapping.test.ts`: remove/replace assertions tied to
  `resolveStyleTickIntervalMins` returning 1440.

**Worker (propagation / integration):**
- Session manager resolves a non-trading agent with stored null → `agentConfig`
  receives 24 h → `effectiveTickIntervalMs` = 24 h.
- Trading agent with stored null → cost-profile/style cadence (not 24 h).
- Explicit stored value → "explicit tick wins" unchanged.
- `runtime-policy-propagation.integration.test.ts` covers the end-to-end tick.

## Risks

- **Double-resolution of the tick.** If both `resolveAgentRuntimePolicy` and
  `resolveAgentCostProfile` try to decide the tick, they can disagree.
  *Mitigation:* a single precedence helper resolves it once before cost-profile;
  cost-profile only *applies* an explicit value and never re-derives the
  non-trading default.
- **Non-trading agent accidentally getting a fast cadence.** If the empty-field →
  default path regresses, a non-trading agent could fall through to a 10–30 min
  style cadence (expensive, noisy). *Mitigation:* explicit worker/integration test
  asserting non-trading + unset = 24 h; the helper's non-trading branch is
  unconditional when `hasTradingCapability === false`.
- **Breaking existing agents.** Reinterpreting stored 1440 could change behaviour.
  *Mitigation:* treat stored values as explicit (`source: user`), no migration,
  identical runtime cadence.
- **Form silently persisting the default as explicit.** If hydration fills the
  field with the effective 24 h instead of leaving it empty, the next save writes
  an explicit value and loses the signal. *Mitigation:* hydrate from the *stored*
  value (null → empty), display the effective value only as helper/placeholder.
- **Plan 071 ordering conflict.** If 071 lands first and computes a default for
  non-trading agents too, the two rules could fight. *Mitigation:* 071 note #6
  already defers non-trading to this operator default; land this plan's
  "distinguish unset" change first, then 071 keys its skill-derived computation to
  the trading-unset branch only.

## Open Decisions

1. **Surface the resolved tick on `ResolvedAgentRuntimePolicy`, or keep a
   standalone helper?** Recommendation: standalone helper for the authoritative
   value; add an optional read-only field on the resolved policy for
   prompt/UI transparency only.
2. **Patch semantics for clearing to default:** does empty field send `null`
   (clear) or omit (leave)? Recommendation: empty field = explicit "use default"
   = send `null`; omission = "don't touch". Confirm against current PATCH schema.
3. **Back-compat migration for existing ~1440 agents:** recommended none (treat as
   explicit). Revisit only if 070/071 require old agents to adopt new defaults.
4. **Operator vs instance location** for the non-trading default: it is already
   operator config (`agentRuntime.nonTradingDefaults.tickIntervalMs`); keep it
   there, do not move to instance config.

## Non-Goals

- No change to how `resolveAgentCostProfile` applies an explicit tick ("explicit
  wins" stays).
- No runtime re-derivation of tick from skills (that is plan 071).
- No agent-controlled tick override behaviour (that is 070 / routine-tasks Part 2).
- No new `tick_interval_ms` storage model — it stays a nullable column; `null`
  carries the "unset/default" meaning.
- No data migration of existing agents.
- No new agent style or new user-facing tick concept.

## Suggested Implementation Order

1. Domain: add `resolveEffectiveTickIntervalMs` + tests.
2. Worker: wire the helper into `agent-session-manager.ts`; propagation tests.
3. API: create stores null-when-unset, decoration exposes effective value +
   source, validation runs on effective tick; API tests.
4. Web: remove the 24 h pre-fill, hydrate null → empty, show effective default as
   helper/placeholder; flow + render tests.
5. Cross-check against plans 070 and 071; update their notes if needed.
6. `pnpm lint` + focused test suites.
