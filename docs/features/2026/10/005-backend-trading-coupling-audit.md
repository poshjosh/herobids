# Backend Trading-Coupling Audit (apps/api, apps/worker, packages/*)

**Date:** 2026-10-01
**Scope:** the backend — `apps/api`, `apps/worker`, and `packages/*` (domain,
engine, strategy, venues, db). Audit of every backend surface that makes
herobids *present as a trading application* rather than a generic agent host, in
service of the program goal "herobids is a generic agent host; trading-specific
product/identity must not be first-party."
**Relation to roadmap:** this is the **backend slice of Phase 2 Step 8**
(legal/product boundary audit), task **T2.1**, in
`docs/features/2026/09/24/001-staging-first-external-backend-roadmap.md`. It is
the companion to the frontend audit
`docs/features/2026/10/003-frontend-trading-coupling-audit.md` and mirrors its
shape.
**Nature:** this is an **inventory + classification**, not an implementation. No
code was changed.

## Method

`rg` over the backend sources for `trading|strategy|venue|position|portfolio|
pnl`, `skillPresetId`, `strategyPreset`, `/capabilities/trading`,
`assessment`, `sitemap|robots|og:|meta.*description`, plus direct reads of:

- `apps/api/src/routes/agents.ts` (create/patch schemas, preset metadata stamping)
- `apps/api/src/routes/capabilities/{index,trading}.ts`
- `apps/api/src/routes/chat.ts` (guided setup)
- `apps/api/src/routes/blueprints.ts`
- `packages/domain/src/skills.ts`, `apps/api/src/sync-system-skills.ts`
- `packages/domain/src/traderton/contract.ts` (to fix the boundary line)
- `config/default.yaml`, `config/strategy-presets/*.yaml`
- `apps/web/index.html`, `apps/web/src/features/public-pages/contentRegistry.ts`
  (web noted for completeness; **backend is the focus**)

Backend files touching trading concepts: ~60 non-test files (the large majority
are legitimate engine/boundary mechanics — see KEEP). The product/identity
coupling that this audit targets concentrates in **~8 files**.

## Classification rubric

Each surface is tagged with **exactly one** of:

- **GENERIC** — capability-neutral but trading-hardcoded; make it
  skills/`capabilityFamilies`-driven. (Agent decides + acts.)
- **MOVE** — trading-domain content that belongs to Traderton
  (venue/wallet/reference docs, trading product copy). (Feeds the doc-move /
  Traderton-site tasks.)
- **REMOVE-SAFE** — a trading-only surface herobids should not carry whose
  removal/hiding has **no** legal/billing/entitlement ambiguity and is
  reversible. (Agent acts.)
- **ESCALATE-LEGAL** — removing/keeping it is a legal / payment-provider /
  product-identity judgment. (Do **not** decide — goes to ESCALATIONS.md.) When
  unsure between REMOVE-SAFE and ESCALATE-LEGAL, treated as ESCALATE-LEGAL.
- **KEEP** — legitimately generic runtime-mechanics or the Traderton boundary
  (not product policy).

**Contract constraint (decision P2-7).** The deployed herobids↔Traderton
boundary must not be broken without a lockstep change. Separately: although the
web UI has been genericized, `apps/web/src/features/agents/agent-payloads.ts`
**still sends** `skillPresetId` and `strategyPreset` on create/update
(L133/183/265/273). So several backend API-field removals are **not safe
standalone** — they need a lockstep web change or a tolerate-and-ignore period.
This is flagged per-row below.

## Issues this audit confirms (root causes)

1. **The capability catalog is trading-only.** `GET /capabilities`
   (`capabilities/index.ts` L23–30) hardcodes a single family `trading`
   ("Algorithmic trading across multiple venues"). The *per-agent* readiness
   endpoint right below it (L35+) is already generic (it iterates each agent's
   skill `capabilityFamilies` ∪ connection-provider families) — proof the
   generic mechanism exists and the catalog simply never adopted it.
2. **`skillPresetId` is a product "agent type" enum on the API.** Both
   `CreateAgentSchema` (L196) and `UpdateAgentSchema` (L281) accept
   `['trading','direct-trading','trading-assistant','personal-assistant',
   'custom']` and stamp it into `unifiedConfig.metadata` — the exact field the
   frontend audit demoted. Identity should be derived from skills, not a preset.
3. **Guided Setup hard-codes a crypto-trading product narrative.** `chat.ts`
   greets with "AI crypto trader" (L108) and carries a full
   `buildTradingPrompt` (L255–359) with venue tables, strategy presets, capital,
   and scanner copy — herobids speaking as a trading product.

---

## Classified inventory

### A. API — agent create/patch schema & preset stamping

| Surface | Location (file:line) | What couples it | Class | Action / Note |
|---|---|---|---|---|
| `skillPresetId` enum | `apps/api/src/routes/agents.ts:196` (create), `:281` (patch) | A trading-first "agent type" enum (`trading`/`direct-trading`/`trading-assistant`) persisted as identity | **GENERIC** | Demote to a non-identity "suggested skills" hint, or drop. **Not safe standalone** — web still sends it (`agent-payloads.ts:273`). Keep accepting-and-ignoring, or remove in lockstep. This is the T1.1-deferred follow-on. |
| `skillPresetId` metadata stamping | `agents.ts:305` (`extractPresetMeta`), `:320–345` (`enrichAgentResponse`), `agent-create-normalization.ts:357` | Reads/writes `unifiedConfig.metadata.skillPresetId` and returns it on every agent response | **GENERIC** | Stop treating as identity; derive family from skills. Response field can stay (null) during the ignore window. |
| `strategyPreset` enum | `agents.ts:176` (create), `:261` (patch) | Trading-domain strategy identity (`momentum`/`range`/`swing`/`scalper`/`contrarian`) accepted at the generic agent API | **GENERIC** | Should be driven by the trading family's config schema, not a top-level agent field. Web still sends it — lockstep. |
| `strategyPreset` resolve + metadata | `agents.ts:1361–1409` (`resolveAgentStrategyPreset`), `extractPresetMeta:305` | Resolves preset → risk/technical and stamps `metadata.strategyPreset`/`strategyPresetName` | **GENERIC** | Fold under per-family (trading) config once the API is family-shaped. |
| `boundaryUnconfiguredError` copy | `agents.ts:108` ("Trading service is unavailable …") | A generic precondition surfaced with trading-specific wording | **GENERIC** | Relabel to a capability-neutral message (e.g. "Capability service unavailable"). Also at `blueprints.ts:1026`, `:1040`. |
| `isTradingCapable` cross-validation | `agents.ts:224` | `executionDefaults` required when the agent has the trading family / hybrid mode | **KEEP** | Legitimate validation gated on the *trading family's* presence — already capability-driven, not hardcoded identity. |

### B. API — capability catalog & routes

| Surface | Location (file:line) | What couples it | Class | Action / Note |
|---|---|---|---|---|
| `GET /capabilities` | `apps/api/src/routes/capabilities/index.ts:23–30` | Hardcodes `families: [{ family: 'trading', description: 'Algorithmic trading across multiple venues' }]` | **GENERIC** | Derive the family list from registered skills' `capabilityFamilies` (the readiness endpoint already does this). |
| `GET /capabilities/trading` + `/providers` + `/connections` | `capabilities/trading.ts:257`, `:270`, `:286` | Trading-literal top-level routes; `SUPPORTED_TRADING_PROVIDERS` (`:75`), venue list hyperliquid/jupiter/1inch/bybit | **GENERIC** | Generalize to `/capabilities/:family/*`; venue/provider lists come from the trading skill/adapters, not route literals. The T1.1-deferred route generalization. |
| `/agents/:id/capabilities/trading/*` (state, readiness, connections, activity, …) | `capabilities/trading.ts` (multiple: `:300`, `:355`, `:430`, `:540`, …) | Each hardcodes the `trading` literal in the path and response `family` | **GENERIC** | Route by `:family`. The data behind them (positions/fills/decisions over the boundary) is KEEP (boundary). |
| `/agents/:id/capabilities/:family/presentation` | `capabilities/trading.ts:377` | Route **is** generic-by-`:family`, but gated `if (family !== 'trading') → 404` (`:410`) | **GENERIC** | Remove the trading-only gate; render per family. Already the right shape — just un-gate. |
| `GET /capabilities` catalog `supportedActions` | `capabilities/index.ts:28`, `trading.ts:38` (`SUPPORTED_ACTIONS`) | `start/stop/pause/resume` listed under trading | **KEEP** | Generic lifecycle verbs; neutral. |
| boundary read plumbing (`loadAgentEvidence`, `createTradertonReadBoundary`, `get_agent_positions`/`_fills`/`_decisions`) | `capabilities/trading.ts` throughout; `routes/exports-traderton.js` | Reads trading evidence over the deployed REST contract | **KEEP** | Boundary — Phase 3, not this audit. |

### C. API — Guided Setup chat (`apps/api/src/routes/chat.ts`)

| Surface | Location (file:line) | What couples it | Class | Action / Note |
|---|---|---|---|---|
| Greeting preset button "AI crypto trader" | `chat.ts:108` (`value: 'preset:trading'`) | First-party onboarding presents **crypto trading** as a headline product offering | **ESCALATE-LEGAL** | Product-identity positioning (may herobids advertise a crypto-trading preset?). See ESCALATIONS. |
| `buildTradingPrompt` | `chat.ts:255–359` | Full "Trading Agent Setup" system prompt: venue tables (hyperliquid/jupiter/1inch), strategy presets, capital, scanner/assessment copy — herobids speaking *as* a trading product | **GENERIC** + **MOVE** | Flow *mechanics* (ask skills → resolve connections) → GENERIC (make the guided flow skill-shaped, one prompt per family). Venue/strategy/wallet *reference copy* → MOVE to Traderton docs. |
| `buildPersonalAssistantPrompt` / `buildCustomPrompt` "do NOT mention trading" carve-outs | `chat.ts:360–416` | Non-trading prompts are defined by *excluding* trading — trading is the implicit default | **GENERIC** | Collapse to one capability-driven setup flow; drop trading-as-default framing. |
| `skillPresetId` tool param + schema | `chat.ts:565` (enum), `:601` (required), `GuidedSetupCreateAgentInput:607` | The guided tool *requires* the trading-first preset enum | **GENERIC** | Same demotion as A; drive skill selection by discovered skills/families. |
| `resolveSkillPresetSkillIds` / `deriveCapabilityMode` / `generateAgentName` | `chat.ts:656`, `:673`, `:680` | Preset→skillIds map, preset→`hybrid` mode, `TX` name prefix for `trading` | **GENERIC** | Mirror the domain `SKILL_PRESET_MAP`; name prefix should not encode a product type. |
| `synthesizePrompt` default goal | `chat.ts:692` ("Grow this portfolio") | The default agent goal is a trading goal | **GENERIC** | Default goal must be capability-neutral (operator-config, not a trading literal). |
| `filterTrades` / `platformAssessment*` tool params | `chat.ts:578–589`, `:1266–1272` | Trading scanner / strategy-assessment onboarding fields on the generic create tool | **GENERIC** | Render only when the trading family is selected (same intent as the frontend's family-gating). |
| `preferredCapability` enum `['trading','email','other']` | `chat.ts` (CHAT_TOOLS) | Connection filter lists `trading` first but is already family-shaped | **KEEP** | Generic enough; grows with families. |

### D. Domain — system-skill seeds & preset map

| Surface | Location (file:line) | What couples it | Class | Action / Note |
|---|---|---|---|---|
| `TRADING_SKILL`, `BOT_MANAGEMENT_SKILL`, `RISK_MONITORING_SKILL` | `packages/domain/src/skills.ts` (TRADING ~L150, BOT_MANAGEMENT ~L110, RISK_MONITORING ~L190) | Trading tool bundles, `capabilityFamilies: ['trading']`, `requiredContextBlocks: ['tradingContext']` | **KEEP** | Skills **are** the generic mechanism; trading is one family among many (email, web-access, task-management, …). A trading skill existing is not product coupling. |
| `SKILL_PRESET_MAP` | `skills.ts` (`SKILL_PRESET_MAP`, trading/direct-trading/trading-assistant/personal-assistant/custom) | The domain twin of `skillPresetId` — preset → skillIds | **GENERIC** | Demote alongside `skillPresetId` (A/C). It is a convenience bundle, not identity. |
| `TOOL_OWNER_OVERRIDES` (trading tools) | `skills.ts` (`TOOL_OWNER_OVERRIDES`) | Maps shared tools (`get_analytics`, `list_positions`, …) to the `trading` owner | **KEEP** | Internal dependency inference; trading is incidental, mechanism is generic. |
| `syncSystemSkills` | `apps/api/src/sync-system-skills.ts` | Generic append-only seeding loop over `SYSTEM_SKILLS` | **KEEP** | Mechanism-neutral; seeds whatever skills exist. |

### E. API — blueprints / marketplace

| Surface | Location (file:line) | What couples it | Class | Action / Note |
|---|---|---|---|---|
| Blueprint `strategyType` / `venueType` facets | `apps/api/src/routes/blueprints.ts:534–543` (filters), `:747–751`, `:906–910` (stamping); `services/agent-blueprint-sync-service.ts:82–84` | The marketplace schema has trading-typed, first-class facet columns | **GENERIC** | Make marketplace facets capability-generic (tags/family), with trading facets as one family's metadata. (Schema change — larger; sequence with Phase 3.) |
| `isTradingCapable(payload)` | `blueprints.ts:180` | Branches on `strategy != null && executionDefaults != null` | **KEEP** | Capability-driven derivation, not a hardcoded product flag. |
| `GET /blueprints/defaults` → `getPreset('momentum','standard')` | `blueprints.ts:448` | The generic "defaults" endpoint returns a **trading momentum** preset | **GENERIC** | Defaults must be family-scoped; a generic blueprint has no trading default. |
| "Trading service is unavailable" copy | `blueprints.ts:1026`, `:1040` | Generic dependency-unavailable surfaced with trading wording | **GENERIC** | Relabel (same as A). |

### F. Billing — product copy / entitlement

| Surface | Location (file:line) | What couples it | Class | Action / Note |
|---|---|---|---|---|
| `assessment.request` rate-card meter | `config/default.yaml:987` (`meterKey: "assessment.request"`, `priceMicrousd: 200000`) | A **billable** entitlement for strategy/market assessment — a paid trading feature; the frontend surfaces it as "strategy assessment" (`BillingDetails.tsx`) | **ESCALATE-LEGAL** | Billing/entitlement copy and whether a trading-specific paid line item is appropriate on a generic host. See ESCALATIONS. |
| Platform-assessment review routes | `apps/api/src/routes/agent-platform-assessment-reviews.ts:38+` (`POST/GET /agents/:id/platform-assessment/reviews`) | User-triggered **forced strategy review** — a trading-strategy feature exposed on the agent API | **KEEP** | Runtime mechanics for trading-capable agents (the assessor runs only for trading agents). Not product-identity copy. Revisit only if the assessor itself moves to Traderton (Phase 3). |

### G. SEO / marketing / public docs (web — noted; backend has none)

No sitemap/robots/OpenGraph/meta or marketing copy exists in **`apps/api`** or
**`apps/worker`** — the backend serves no public marketing surface. For
completeness (these are web, triage in the web slice):

| Surface | Location (file:line) | What couples it | Class | Action / Note |
|---|---|---|---|---|
| Meta description / OG / Twitter / JSON-LD | `apps/web/index.html:7,11,20,41` | "…from **crypto trading** to personal assistance" positions trading as a headline product | **ESCALATE-LEGAL** | SEO/marketing product positioning. See ESCALATIONS. |
| `trading-venues` public-docs section | `apps/web/src/features/public-pages/contentRegistry.ts:91–98` (hyperliquid/bybit/jupiter/1inch/funding-wallets) | First-party venue + wallet-funding reference docs | **MOVE** | Venue/wallet reference → Traderton docs/site. Sitemap (`sitemap-plugin.ts`, `lib/sitemap-urls.ts`) regenerates from the registry, so the sitemap follows automatically once these pages move. |
| `reference/crypto-ecosystem*` docs | `contentRegistry.ts:86–87` | First-party crypto reference content | **MOVE** | Crypto reference → Traderton docs. |

### H. Worker / engine (runtime mechanics)

| Surface | Location (file:line) | What couples it | Class | Action / Note |
|---|---|---|---|---|
| "You are a trading agent" scanner prompt | `apps/worker/src/hybrid-agent-prompt.ts:104` | Runtime prompt rendered **only** for hybrid/scanner trading agents | **KEEP** | Engine mechanics for a trading-capable agent — not herobids' product identity. |
| `tradingHours` / `TradingSessionName` tick gate | `apps/worker/src/tick-gates.ts:68,111,130` | Session-window gating for trading agents | **KEEP** | Runtime scheduling mechanics (mirrors the frontend `capabilityMode` KEEP). |
| Agent-evaluation trading analyzer / "Trading Performance" labels | `apps/worker/src/agent-evaluation/{run-evaluation,render-report,analyzers/trading}.ts` | Eval scorecard has trading sections | **KEEP** | Internal operator tooling that analyzes whatever evidence the boundary returns. |

---

## Follow-on engineering tasks (GENERIC / REMOVE-SAFE → T2.2)

Concrete, safe-to-build items. Order roughly by independence. **None of the
`skillPresetId`/`strategyPreset` API-field removals are safe *standalone*** —
the web still sends them (`agent-payloads.ts:265,273`); either keep
accepting-and-ignoring, or remove in lockstep with a web change (P2-7).

1. **Genericize `GET /capabilities`** — `capabilities/index.ts:23–30`: build the
   family list from registered skills' `capabilityFamilies` (reuse the logic the
   readiness endpoint at `:35+` already uses) instead of the hardcoded `trading`
   entry. *Fully safe standalone* (read-only catalog; additive).
2. **Un-gate the per-family presentation route** —
   `capabilities/trading.ts:410`: remove `if (family !== 'trading') → 404`; the
   route (`:377`) is already generic-by-`:family`. *Safe standalone* (only widens
   acceptance).
3. **Relabel trading-specific generic error copy** — `agents.ts:108`,
   `blueprints.ts:1026,1040`: "Trading service is unavailable" →
   capability-neutral wording. *Fully safe standalone.*
4. **Capability-neutral default goal** — `chat.ts:692` (`synthesizePrompt`
   default "Grow this portfolio"): source from operator config, non-trading
   default. *Safe standalone.*
5. **Family-shape the Guided Setup flow** — `chat.ts:255–416,565,601,656–692`:
   collapse `buildTradingPrompt`/`buildPersonalAssistantPrompt`/`buildCustomPrompt`
   into one capability-driven flow; gate `filterTrades`/`platformAssessment*`
   /capital on the trading family's presence. Larger; coordinate with the greeting
   decision (ESCALATION #1).
6. **Generalize `/capabilities/trading/*` → `/capabilities/:family/*`** —
   `capabilities/trading.ts` + registration in `capabilities/index.ts`: the
   T1.1-deferred route generalization. **Lockstep** with the web API client
   (frontend audit §C) and keep the trading aliases during migration.
7. **Demote `skillPresetId` + `strategyPreset` + `SKILL_PRESET_MAP`** —
   `agents.ts:196,281,305,320–345`, `chat.ts:565,607,656`,
   `skills.ts` (`SKILL_PRESET_MAP`): stop treating as identity; keep as a
   non-identity "suggested skills" helper. **Lockstep / ignore-window** (web still
   sends them).
8. **Capability-generic blueprint defaults** — `blueprints.ts:448`: a generic
   blueprint has no `momentum` default; scope defaults to the trading family.
   *Mostly safe standalone* (changes a default payload).

> **Deferred-from-frontend reminder (explicit):** the two items the frontend
> slice (T1.1) explicitly deferred to the backend are **(7)** the `skillPresetId`
> API-enum removal/demotion and **(6)** the `/capabilities/trading/*` route
> generalization. Both are captured above and both carry the P2-7 lockstep
> caveat.

---

## ESCALATE-LEGAL items (copy verbatim into ESCALATIONS.md)

### E1 — Guided Setup advertises a first-party "AI crypto trader" preset

- **What + where:** `apps/api/src/routes/chat.ts:108` — the onboarding greeting
  offers a headline quick-reply button **"AI crypto trader"** (`value:
  'preset:trading'`), presenting crypto trading as a first-party product
  offering during agent creation.
- **Options:** (a) keep the trading preset button as-is; (b) relabel/retire the
  trading button so onboarding is capability-neutral and trading is discovered
  only via skills; (c) keep the button but route it through Traderton
  attribution.
- **Engineering-neutral recommendation:** retire the dedicated trading greeting
  button in favor of a capability-neutral "what should your agent do?" entry,
  with trading reachable through skill discovery — this removes the first-party
  trading-product positioning without losing the capability. Low engineering
  cost either way.
- **Why legal/product input:** whether herobids may advertise/offer a
  crypto-trading agent as a headline product is a product-identity and
  (potentially) financial-promotions judgment, not an engineering one.

### E2 — Billable "strategy assessment" entitlement (`assessment.request`)

- **What + where:** `config/default.yaml:987` — the billing rate card defines a
  paid meter `assessment.request` (`priceMicrousd: 200000`), surfaced to users
  as "strategy assessment" (frontend `BillingDetails.tsx`). It is a billed,
  trading-specific product line item.
- **Options:** (a) keep the paid trading-assessment meter on the herobids bill;
  (b) move the trading-assessment entitlement/billing to Traderton; (c) relabel
  to a capability-neutral meter name while keeping the charge.
- **Engineering-neutral recommendation:** keep the *mechanism* (metered usage
  billing is generic) but treat the trading-specific **naming and
  entitlement** as a product/billing decision — do not unilaterally rename or
  remove a live billing line item.
- **Why legal/product input:** billing copy and entitlements are
  payment-provider- and revenue-affecting; changing or removing a live meter has
  contractual/billing implications that must not be decided in engineering.

### E3 — SEO/marketing copy positions herobids as a crypto-trading product

- **What + where:** `apps/web/index.html:7,11,20,41` — meta description,
  OpenGraph, Twitter card, and JSON-LD all state herobids does "…from **crypto
  trading** to personal assistance," positioning crypto trading as a headline
  offering in indexed/share-preview metadata. (Web surface; included because it
  is product-identity positioning and pairs with E1.)
- **Options:** (a) keep the crypto-trading positioning in SEO/marketing; (b)
  make the public positioning capability-neutral ("AI agents that get the job
  done") and drop the explicit crypto-trading claim; (c) keep but attribute
  trading to Traderton.
- **Engineering-neutral recommendation:** make the public SEO/OG copy
  capability-neutral and let trading be a discoverable capability rather than a
  headline product claim.
- **Why legal/product input:** public marketing/SEO positioning around a
  financial activity is a brand, product, and potentially regulatory
  (financial-promotions) decision.

> If unsure between REMOVE-SAFE and ESCALATE-LEGAL, these were treated as
> ESCALATE-LEGAL per the rubric.

---

## KEEP / out of scope

**Legitimately generic runtime mechanics (not product policy):**

- The per-agent readiness endpoint (`capabilities/index.ts:35+`) — already
  iterates each agent's `capabilityFamilies`. The *template* for genericizing
  the catalog.
- `isTradingCapable` cross-validation (`agents.ts:224`) and
  `isTradingCapable(payload)` (`blueprints.ts:180`) — capability-derived, not
  hardcoded identity.
- The trading **skills** themselves (`skills.ts`: `TRADING_SKILL`,
  `BOT_MANAGEMENT_SKILL`, `RISK_MONITORING_SKILL`) and `syncSystemSkills` — the
  skills mechanism is the generic host; trading is one family.
- Worker/engine trading mechanics: `hybrid-agent-prompt.ts:104`,
  `tick-gates.ts` (`tradingHours`), the agent-evaluation trading analyzer.
- Platform-assessment review routes
  (`agent-platform-assessment-reviews.ts`) — runtime mechanics for trading-capable
  agents (revisit only if the assessor moves to Traderton in Phase 3).
- `capabilityMode: 'intelligence' | 'hybrid'` — runtime wake/execution mode, not
  a trading-product type (mirrors the frontend KEEP).

**Boundary — Phase 3, not this audit** (the generic External-Backend boundary):

- `packages/domain/src/traderton/contract.ts` — the wire contract:
  `TRADERTON_INVOKE_PATH` = `/internal/v1/tools:invoke`,
  `TRADERTON_STATUS_PATH_PREFIX` = `/internal/v1/invocations/`, the invocation
  envelope / terminal result / status types.
- `TradertonClient` (the outbound signed client), HMAC signing, invocation
  envelope/result mapping.
- Read-tool proxying over this REST contract: `routes/exports-traderton.js`
  (`createTradertonReadBoundary`, `loadAgentEvidence`, `get_agent_positions` /
  `_fills` / `_decisions` / `get_account_summary`) as consumed throughout
  `capabilities/trading.ts`, `agents.ts`, `bots.ts`, `reconciliation.ts`, and the
  worker evaluation runtime.

**Phase-3-owned module internals (do NOT move here):**

- The broader genericization of `packages/domain/src/traderton/` and
  `packages/domain/src/trading/` module internals is Phase 3 (roadmap Steps
  9–16). This audit does not propose moving those modules — noted as
  Phase-3-owned.

## DB / persistence note

Consistent with the frontend audit: there is **no persisted agent `type`
column**. `skillPresetId` lives in `unifiedConfig.metadata` as a creation-time
convenience, not identity — demote it, don't elevate it. Agent identity is
derived from `skillIds` → their `capabilityFamilies`. `capabilityMode` stays
(runtime mechanics).

## Size & sequencing

- **Small, mostly-standalone (follow-ons 1–4):** generic catalog, un-gate
  presentation route, relabel error copy, neutral default goal. Buildable now
  with low risk; good first T2.2 slice.
- **Medium, lockstep (6, 7):** route generalization and `skillPresetId`/
  `strategyPreset` demotion must move with (or tolerate) the web, per P2-7.
- **Larger / Phase-3-adjacent (5, 8 + blueprint facet schema E-table):** the
  guided-setup reshaping and the blueprint marketplace facet schema overlap the
  "move trading to Traderton" question and should sequence with the Phase 3
  module work.
- **ESCALATIONS (E1–E3):** blocked on legal/product/payment input — do not
  implement until resolved.
