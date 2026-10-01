# Frontend Trading-Coupling Audit (apps/web/src)

**Date:** 2026-10-01
**Scope:** `apps/web/src` only (the web frontend). Audit of every surface that
assumes trading is the agent's domain, in service of the program goal "herobids
is a generic agent host; trading-specific UI/docs must not be first-party."
**Relation to roadmap:** this is the **frontend slice of Phase 2 Step 8**
(legal/product boundary audit) in
`docs/features/2026/09/24/001-staging-first-external-backend-roadmap.md`.
**Triggered by:** three agent-form/capabilities defects reported by the operator
(see §Issues that triggered this audit).

## Method

`rg` over `apps/web/src/**/*.{ts,tsx}` (excluding tests) for
`trading|strategy|venue|position|portfolio|pnl` and `/capabilities/trading`,
plus a read of the nav (`Sidebar.tsx`), router (`router.tsx`), the agent-form
components, and the API client. **58 non-test files** reference trading
concepts. This is an inventory + classification, not an implementation.

## Issues that triggered this audit (root causes found)

1. **Capabilities list is trading-only** — `AgentDetailPage.tsx` computes
   `hasTradingCapability = hasCapabilityFamily(selectedSkills, 'trading')` and
   only ever calls `agentsApi.capabilityReadiness(id, 'trading')`. There is no
   iteration over the agent's *actual* capability families. Hence:
   - trading agent → trading shown (the only family checked);
   - trading+email agent → trading only (email never queried);
   - email agent → "no capability setup" (trading absent, nothing else checked).
2. **Agent "type" selector exists in the UI** — `agent-display.ts` defines
   `SkillPresetId = 'trading' | 'direct-trading' | 'trading-assistant' |
   'personal-assistant' | 'custom'`, surfaced as a creation-time picker.
   **DB fact:** there is **no `type` column** on the agents table. Identity is
   stored only as `skillIds` + `unifiedConfig` (`capabilityMode`,
   `technical`/`intelligence`). `skillPresetId` is persisted in
   `unifiedConfig.metadata` as a *preset selector*, not an identity.
3. **Advanced settings has Trading + Strategy tabs** —
   `AdvancedSettingsSection.tsx` renders tabs `[aiConfig, tradingSetup,
   strategy]`; `AgentFormBody.tsx` maps validation fields to those indices
   (`ADVANCED_FIELD_TAB`: `0=AI, 1=Trading, 2=Strategy`).

## Classification

Each surface is tagged: **GENERICIZE** (make capability-neutral, driven by the
agent's skills/families), **MOVE/GATE** (a whole trading feature → belongs to
Traderton or behind a capability gate), **RELABEL** (i18n/wording), or **KEEP**
(legitimately generic or runtime-mechanics, not product policy).

### A. Whole trading features — MOVE/GATE

| Surface | Note |
|---|---|
| `features/bots/BotsPage.tsx`, `BotCustomConfigSection.tsx` | Bots are a trading tool. Nav item `/bots` is in `PREVIEW_ITEMS`. |
| `features/instances/detail/InstanceDetailPage.tsx` | Bot/instance detail: positions, strategy, symbol, journal. Route `/bots/:id`. |
| `features/trading-instances/InstancesPage.tsx` | Strategy-typed bot list. |
| `features/exposure/ExposurePage.tsx` | Trading exposure. Nav `/exposure` (preview). |
| `features/portfolios/PortfoliosPage.tsx` | Portfolio view (not in main router — verify dead vs lazy). |
| `features/agents/TradingCapabilityPresentation.tsx` | Trading-specific capability renderer. |
| `features/agents/useTradingVenues.ts`, `venue-mapping.ts` | Venue list/mapping — trading-domain. |
| `features/agents/technical-config-helpers.ts`, `technical-types.ts`, `TechnicalConfigSection.tsx` | Trading strategy/technical config. |
| `lib/StrategyPresetSelector.tsx` | Strategy preset picker. |

### B. Agent form & detail — GENERICIZE (the reported defects live here)

| Surface | What couples it | Target |
|---|---|---|
| `features/agents/AgentDetailPage.tsx` | trading-only capability query/listing | Iterate the agent's capability families; one readiness card per family. |
| `features/agents/agent-display.ts` | `CAPABILITY_FAMILY_LABELS = {trading}` only; `SkillPresetId` type | Family labels become data-driven (from skills); demote preset selector to a non-identity "suggested skills" helper. |
| `features/agents/AdvancedSettingsSection.tsx` | tabs `[aiConfig, tradingSetup, strategy]` | Replace trading/strategy tabs with a generic **Capabilities** tab rendering per-family config. |
| `features/agents/AgentFormBody.tsx` | `ADVANCED_FIELD_TAB` (AI/Trading/Strategy), `TRADING_WAKE_SOURCES`, `AGENT_STRATEGY_PRESET_KEYS` | Re-map tabs; trading wake-sources/strategy render only when the trading family is present. |
| `features/agents/agent-payloads.ts`, `agent-form-state.ts` | `hasTradingCapability`, `strategyPreset` | Keep `capabilityMode` (runtime wake/exec — KEEP); gate trading fields on family presence. |
| `features/agents/RuntimePolicySection.tsx`, `StyleSelector.tsx`, `style-mapping.ts` | `showTradingSessionPresets`, `tradingSessions`, `TradingSessionName` | Trading-session presets render only for the trading family. |
| `features/agents/AgentCapabilityPage.tsx` | route is generic (`:family`) but content assumes trading | Make the per-family page render by family, not trading. |
| `features/outcomes/OutcomeBoardPage.tsx` | `showExecutionMode = hasCapabilityFamily(..., 'trading')` | Already family-gated — minor; KEEP/verify. |

### C. API client — GENERICIZE (partial)

`lib/api-client.ts`: `tradingConnections(id)` and
`/agents/:id/capabilities/trading/{connections,positions}` hardcode
`family: 'trading'`. Note `presentation(id, family, …)` is **already generic**.
Target: route capability sub-resources by `family`, not a trading literal.
(API-side routes `apps/api/src/routes/agents.ts` carry the matching
`/capabilities/trading/*` + `skillPresetId` enum — out of this frontend audit's
scope but must move in lockstep; flagged for the plan.)

### D. i18n — RELABEL

`app/i18n/locales/{en,ar,hi}.ts` carry ~98/70/70 trading keys:
`agents.advanced.tradingSetup`, `agents.skillPresetId.*`, `nav.bots`,
`nav.exposure`, `instanceDetail.*`, `agents.capabilityPage.*`,
`agents.runtimePolicy.tradingSessions*`. These follow whatever the components do
— relabel/retire alongside B/C. (One test asserts trading-copy routing:
`app/i18n/i18n-regressions.test.ts`.)

### E. Navigation & routes — MOVE/GATE

- `app/layout/Sidebar.tsx`: `PREVIEW_ITEMS` already hides `/bots`, `/exposure`,
  `/outcomes`, `/activity` behind a preview toggle — trading surfaces are
  partly de-emphasized already. `NAV_ITEMS` (agents/skills/connections/
  billing/settings) is generic.
- `app/router.tsx`: trading-dedicated routes `/bots`, `/bots/:id`, `/exposure`.
  Generic-by-param: `/agents/:agentId/capabilities/:family`.

### F. Peripheral mentions — RELABEL/KEEP

`features/billing/BillingDetails.tsx` (`'assessment.request' = 'strategy
assessment'`), `features/blueprints/*` (`blueprint-types.ts`, browse/instantiate),
`features/setup/{ProviderSetupForm,WalletCreatedStep}.tsx`,
`features/connections/ConnectionsPage.tsx`,
`features/public-pages/contentRegistry.ts`. Mostly wording or
wallet/venue-setup flows; triage per item during Step 8 proper.

### KEEP (not product-policy coupling)

- `capabilityMode: 'intelligence' | 'hybrid'` — a legitimate **runtime** wake/
  execution mode (does the agent run a scanner loop), not a trading-product
  type. Keep it; it is domain-neutral.
- Generic capability plumbing (`CapabilityPresentation`, `presentation(family)`)
  that already renders by `family`.

## DB / persistence answer (operator question)

- **No persisted agent `type`.** Do not add one — it would contradict "agents
  are known by their skills." Identity should be **derived** from each agent's
  skills → their `capabilityFamilies`.
- `skillPresetId` (in `unifiedConfig.metadata`) is a creation-time convenience,
  not identity; demote it to a "suggested skills" helper and stop presenting it
  as a type.
- `capabilityMode` stays (runtime mechanics).

## Size & sequencing

- **Reported defects (issues 1–3)** are a small, self-contained slice in bucket
  **B** (plus the matching **C** API-client/route change and **D** relabels).
  This is the first remediation and is specced in
  `docs/features/2026/10/002-genericize-agent-capability-ui/`.
- **Buckets A/E (whole trading features + routes)** are larger and overlap the
  "move trading to Traderton" question (roadmap Steps 6 + 8). They are NOT in
  the 002 slice; they belong to the full Step 8 decision (make-generic / move /
  remove) with legal/product input.

## How this was missed

The capabilities UI was built trading-first and never genericized when other
skills (email, etc.) arrived; nothing forced generality. Phase 1 was all
infra/boundary and never touched this UI. This audit is exactly the Step 8
mechanism catching it — it had simply not run against the frontend yet. A
matching backend audit (API routes, `skillPresetId` enum, system-skill seeds)
is recommended as a follow-up but is out of this frontend audit's scope.
