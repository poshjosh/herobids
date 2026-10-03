# Plan — Genericize the agent capability UI

**Status:** planned (not implemented)
**Date:** 2026-10-01
**Parent:** `000-analysis.md`
**Audit:** `../003-frontend-trading-coupling-audit.md`

## Objective

Make the agent create/edit/detail UI capability-neutral: capabilities are
derived from the agent's skills (their `capabilityFamilies`), there is no agent
"type" selector, and trading/strategy config lives behind a generic
**Capabilities** tab shown only for the families the agent actually has.

## Non-goals

- No persisted agent `type` (identity stays derived from skills).
- No change to whole trading features/pages (bots, exposure, instance detail,
  portfolios) — those are the broader Step 8 decision.
- No behavior change for trading agents (no regression).
- No breaking change to the deployed boundary/API contract without a lockstep
  API change (see Stage 3).

## Ordered work

### Stage 1 — Generic capabilities list on the detail page (fixes issue 1)

- `features/agents/AgentDetailPage.tsx`: replace the trading-only block with:
  - families = `resolveCapabilityFamilies(selectedSkills)` (already exists);
  - fetch all readiness via `agentsApi.capabilityReadiness(id)` (no-family form
    already returns `{ capabilities: CapabilityReadiness[] }`);
  - render one readiness card per family; empty state only when the agent has
    **zero** families.
- `features/agents/agent-display.ts`: make `CAPABILITY_FAMILY_LABELS`
  non-exhaustive-safe — fall back to a humanized family id when no explicit
  label exists (so `email`, etc. render without a hardcoded entry).
- Keep the per-family "open capability" navigation (`/agents/:id/capabilities/:family`).
- **Exit:** trading agent shows trading; trading+email shows both; email agent
  shows email (not "no capabilities").

### Stage 2 — Capabilities tab replaces Trading/Strategy tabs (fixes issue 3)

- `features/agents/AdvancedSettingsSection.tsx`: replace the
  `[aiConfig, tradingSetup, strategy]` slots with `[aiConfig, capabilities]`
  (or `[aiConfig, capabilities]` + any genuinely generic tab). The Capabilities
  tab renders per-family config sections; the trading/strategy editors render
  **inside** it only when the trading family is present.
- `features/agents/AgentFormBody.tsx`: update `ADVANCED_FIELD_TAB`, `expandSeq`,
  and `errorTabIdx` mapping to the new tab layout so field-error focus still
  jumps to the right tab. Gate `TRADING_WAKE_SOURCES` /
  `AGENT_STRATEGY_PRESET_KEYS` / `StrategyPresetSelector` /
  `RuntimePolicySection.showTradingSessionPresets` on trading-family presence.
- **Exit:** no top-level Trading/Strategy tab; trading config reachable via
  Capabilities only when relevant.

### Stage 3 — Remove the agent "type" selector (fixes issue 2)

- Remove the type/preset *picker* from create/edit UI
  (`AgentFormBody.tsx` + any `skillPresetId` selector). If a creation
  convenience is kept, reframe it as "suggested skills" that just pre-selects
  skills — never stored or shown as a type.
- `agent-display.ts`: retire `SkillPresetId` as an identity concept (keep a
  minimal mapping only if the suggested-skills helper needs it).
- Verify `agent-form-state.ts` / `agent-payloads.ts` no longer surface a type;
  `capabilityMode` stays.
- API lockstep check: `skillPresetId` in `apps/api/src/routes/agents.ts` is
  create/patch-optional and only stamps `metadata` + resolves skills — leaving
  the enum accepted (ignored by UI) is safe short-term; schedule its removal
  with the backend audit. **Do not** remove the API field in this slice unless
  the backend audit lands with it.

### Stage 4 — API client + route family-generalization (bucket C)

- `lib/api-client.ts`: prefer `presentation(id, family)` /
  `capabilityReadiness(id)` generic forms. For `tradingConnections` /
  trading `positions`, either (a) parameterize by `family`, or (b) keep a thin
  trading alias until the API route is generalized. Choose (b) if the API route
  is not generalized in the same change, to avoid breaking the contract.
- Record the matching API route change as a dependency for the backend audit
  (`/agents/:id/capabilities/:family/{connections,positions}`).

### Stage 5 — i18n relabels (bucket D)

- `app/i18n/locales/{en,ar,hi}.ts`: rename/retire `agents.advanced.tradingSetup`
  → capabilities wording; keep `agents.skillPresetId.*` only if the
  suggested-skills helper survives. Keep all three locales in sync.
- Update `app/i18n/i18n-regressions.test.ts` expectations where tab/label keys
  moved.

## Verification

- `pnpm --filter @herobids/web run build` + `pnpm lint` clean.
- Unit/component tests: extend `AgentDetailPage` / capability-presentation tests
  with (a) trading-only, (b) trading+email, (c) email-only, (d) no-skills agents
  — asserting the right families render.
- Keep the existing `derive-capability-mode` and i18n regression tests green.
- Manual (VisualTester / local xstack): create an email-only agent and a
  trading+email agent; confirm the detail page capabilities and the Capabilities
  tab render correctly for both; confirm a trading-only agent is unchanged.

## Sequencing / dependencies

- Stages 1–3 are the operator-reported defects and can land together (frontend
  only). Stage 4/5 support them.
- The deeper API `skillPresetId` removal and the whole-trading-feature decisions
  (audit buckets A/E) are **follow-ups** gated on the broader Step 8
  legal/product decision — not part of this slice.
- A **backend trading-coupling audit** (API routes, `skillPresetId` enum,
  system-skill seeds) is recommended next to mirror this frontend one.
