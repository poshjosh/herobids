# Phase 2 — Step 8 Audit Reconciliation (T5.1)

**Status:** living. **Created:** 2026-10-01 (T5.1).
**Purpose:** confirm every trading-coupled surface from BOTH Step 8 audits —
the frontend audit (`../../003-frontend-trading-coupling-audit.md`) and the
backend audit (`../../005-backend-trading-coupling-audit.md`) — is accounted
for: either **done** (GENERIC/MOVE/REMOVE-SAFE executed), **deferred** (with a
recorded lockstep/Phase-3 note), **escalated** (in `ESCALATIONS.md`), or
**KEEP** (legitimately generic / runtime mechanics / the Phase-3 boundary).
**No surface is left unclassified.**

Dispositions:
- ✅ **done** — change executed + verified in this program.
- 🕓 **deferred** — classified, but intentionally not executed now (contract/
  lockstep per P2-7/P2-12, or Phase-3-owned, or a larger feature move). Carries
  a note; not a gap.
- ⤴ **escalated** — a legal/product-boundary call; row in `ESCALATIONS.md`.
- 🧱 **KEEP** — not product coupling (generic plumbing / runtime mechanics / the
  deployed boundary). Out of scope by design.

---

## 1. Frontend audit (003)

### Bucket B — agent form & detail (GENERICIZE) → ✅ done (T1.1)
| Surface | Disposition |
|---|---|
| `AgentDetailPage.tsx` (trading-only capability listing) | ✅ derives families from skills; one readiness card per family (T1.1). |
| `agent-display.ts` (`CAPABILITY_FAMILY_LABELS`, `SkillPresetId`) | ✅ labels data-driven; `SkillPresetId`→`SuggestedSkillSetId`, demoted from identity (T1.1). |
| `AdvancedSettingsSection.tsx` (Trading/Strategy tabs) | ✅ replaced by a generic **Capabilities** tab (T1.1). |
| `AgentFormBody.tsx` (`ADVANCED_FIELD_TAB`, trading wake/strategy) | ✅ re-mapped; trading fields family-gated (T1.1). |
| `agent-payloads.ts`, `agent-form-state.ts` | ✅ `capabilityMode` kept; trading gated on family. 🕓 **but** both still SEND `skillPresetId`/`strategyPreset` (P2-12) — backend removal is lockstep. |
| `RuntimePolicySection.tsx`, `StyleSelector.tsx`, `style-mapping.ts` | ✅ trading-session presets render only for the trading family (T1.1). |
| `AgentCapabilityPage.tsx` | ✅ renders by `:family` (T1.1). |
| `OutcomeBoardPage.tsx` | 🧱 already family-gated (`showExecutionMode`). KEEP/verified. |

### Bucket C — API client (GENERICIZE partial) → ✅ / 🕓
| Surface | Disposition |
|---|---|
| `presentation(id, family, …)` | 🧱 already generic by `family`. |
| `tradingConnections(id)` + `/capabilities/trading/{connections,positions}` | 🕓 kept as thin trading aliases — deployed boundary contract (P2-7). Lockstep removal = backend follow-on 6 (see backend §B below). |

### Bucket D — i18n (RELABEL) → ✅ done (T1.1)
Trading keys relabelled/retired across en/ar/hi in T1.1. 🕓 one orphaned key
(`goalPlaceholder.personalAssistant`) noted in Outstanding Issues (parity-safe).

### Bucket A — whole trading features (MOVE/GATE) → 🕓 deferred (Phase-3 / larger)
`BotsPage`, `BotCustomConfigSection`, `InstanceDetailPage`,
`trading-instances/InstancesPage`, `ExposurePage`, `PortfoliosPage`,
`TradingCapabilityPresentation` (the renderer; its dangling funding link was
fixed in T3.2), `useTradingVenues`/`venue-mapping`, `technical-config-helpers`/
`technical-types`/`TechnicalConfigSection`, `StrategyPresetSelector`.
→ 🕓 **deferred.** These are whole trading FEATURES, not product-identity
labels. Per 003 §"Size & sequencing" and **P2-4**, they are NOT part of the
genericize-UI slice; they overlap the "move trading to Traderton" question and
belong to the Phase-3 module work (the trading product surface moving behind the
boundary). Recorded here so none is lost; none is a safe standalone GENERIC/
REMOVE in Phase 2.

### Bucket E — navigation & routes (MOVE/GATE) → 🕓 / 🧱
- `Sidebar.tsx` `PREVIEW_ITEMS` already hides `/bots`,`/exposure`,`/outcomes`,
  `/activity` behind a preview toggle; `NAV_ITEMS` is generic. 🧱 KEEP (already
  de-emphasized); full removal rides with Bucket A (Phase 3). 🕓
- `router.tsx` trading routes `/bots`,`/bots/:id`,`/exposure`. 🕓 deferred with
  Bucket A. `/agents/:agentId/capabilities/:family` is 🧱 generic.

### Bucket F — peripheral → mixed
| Surface | Disposition |
|---|---|
| `billing/BillingDetails.tsx` (`assessment.request` = "strategy assessment") | ⤴ **E2** (billable trading entitlement — legal/payment). |
| `public-pages/contentRegistry.ts` + trading-venue/crypto docs | ✅ **moved to Traderton** (T3.1/T3.2); glossary split. |
| `blueprints/*` (`blueprint-types.ts`, browse/instantiate) | 🕓 deferred — blueprint facet schema is Phase-3-adjacent (backend §E `strategyType`/`venueType` facets). |
| `setup/{ProviderSetupForm,WalletCreatedStep}.tsx`, `connections/ConnectionsPage.tsx` | 🧱 KEEP — wallet/venue connection setup is runtime mechanics for trading-capable agents; not product-identity copy. (The guided-setup funding link was de-linked in T3.2.) |
| SEO/OG positioning (`apps/web/index.html`) | ⤴ **E3** (public product positioning — legal). |

---

## 2. Backend audit (005)

### §A — agent create/patch schema & preset stamping
| Surface | Disposition |
|---|---|
| `skillPresetId` enum (create/patch) + metadata stamping | 🕓 deferred — lockstep (web still sends it; **P2-12**). Backend follow-on 7. |
| `strategyPreset` enum + resolve/stamp | 🕓 deferred — lockstep (P2-12). Follow-on 7. |
| `boundaryUnconfiguredError` copy (`agents.ts:108`) | ✅ relabelled capability-neutral (T2.2). |
| `isTradingCapable` cross-validation | 🧱 KEEP (capability-derived, not hardcoded identity). |

### §B — capability catalog & routes
| Surface | Disposition |
|---|---|
| `GET /capabilities` (hardcoded trading family) | ✅ derives families from `SYSTEM_SKILLS` (T2.2). |
| `/capabilities/trading` + `/providers` + `/connections` (literal routes) | 🕓 deferred — route generalization is lockstep with the web api-client (P2-7). Follow-on 6. |
| `/agents/:id/capabilities/trading/*` | 🕓 deferred — lockstep (follow-on 6). |
| `/agents/:id/capabilities/:family/presentation` (trading-only gate) | ✅ no-op — route already generic by `:family`; no 404 gate exists (verified in T2.2, **P2-13**). |
| `SUPPORTED_ACTIONS`, boundary read plumbing | 🧱 KEEP (generic verbs; the deployed boundary = Phase 3). |

### §C — Guided Setup chat
| Surface | Disposition |
|---|---|
| Greeting "AI crypto trader" preset button (`chat.ts:108`) | ⤴ **E1** (product-identity positioning — legal). |
| `buildTradingPrompt` venue/strategy reference COPY | ✅ venue/crypto reference MOVED to Traderton (T3.2). 🕓 flow *mechanics* (family-shaped guided flow) deferred (follow-on 5, coordinate with E1). |
| `buildPersonalAssistantPrompt`/`buildCustomPrompt` "no trading" carve-outs | 🕓 deferred — collapse into one family-driven flow (follow-on 5). |
| `skillPresetId` tool param + schema | 🕓 deferred — lockstep (follow-on 7). |
| `resolveSkillPresetSkillIds`/`deriveCapabilityMode`/`generateAgentName` | 🕓 deferred (follow-on 5/7). |
| `synthesizePrompt` default goal ("Grow this portfolio") | ✅ capability-neutral default (T2.2). |
| `filterTrades`/`platformAssessment*` tool params | 🕓 deferred — family-gate (follow-on 5). |
| `preferredCapability` enum | 🧱 KEEP (already family-shaped). |

### §D — domain system-skill seeds & preset map
| Surface | Disposition |
|---|---|
| `TRADING_SKILL`/`BOT_MANAGEMENT_SKILL`/`RISK_MONITORING_SKILL` | 🧱 KEEP — skills are the generic mechanism; a trading skill is not product coupling. |
| `SKILL_PRESET_MAP` | 🕓 deferred — demote alongside `skillPresetId` (follow-on 7, lockstep). |
| `TOOL_OWNER_OVERRIDES`, `syncSystemSkills` | 🧱 KEEP (mechanism-neutral). |

### §E — blueprints / marketplace
| Surface | Disposition |
|---|---|
| Blueprint `strategyType`/`venueType` facets | 🕓 deferred — marketplace facet schema is a larger Phase-3-adjacent change. |
| `isTradingCapable(payload)` | 🧱 KEEP (capability-derived). |
| `GET /blueprints/defaults` → `momentum` preset | 🕓 deferred — changes a default payload; family-scoped-defaults follow-up (Outstanding Issues, **P2-13**). |
| "Trading service is unavailable" copy (`blueprints.ts:1026,1040`) | ✅ relabelled (T2.2). |

### §F — billing
| Surface | Disposition |
|---|---|
| `assessment.request` rate-card meter | ⤴ **E2** (billable trading entitlement — legal/payment). |
| Platform-assessment review routes | 🧱 KEEP (runtime mechanics for trading-capable agents; revisit only if the assessor moves to Traderton in Phase 3). |

### §G — SEO / marketing / public docs
| Surface | Disposition |
|---|---|
| Meta/OG/Twitter/JSON-LD crypto-trading positioning (`index.html`) | ⤴ **E3** (public positioning — legal). |
| `trading-venues` public docs | ✅ MOVED to Traderton (T3.2). |
| `reference/crypto-ecosystem*` docs | ✅ MOVED to Traderton (T3.2). |

### §H — worker/engine runtime mechanics
All 🧱 KEEP (scanner prompt, `tradingHours` tick gate, eval analyzer) — runtime
mechanics for trading-capable agents, not product identity.

### Discovered-during-execution (not in either audit's original list)
| Surface | Disposition |
|---|---|
| `apps/worker/src/tools/platform-docs-data.ts` (agent docs-search index embedding the moved docs) | ✅ regenerated in T3.2 so the moved trading reference docs are no longer agent-readable (CodeReview CRITICAL C1; **P2-14** correction). |
| `GET /agents/:id/capabilities/readiness` (hardcoded `['trading']`) | ✅ emits one entry per declared family (T1.1, **P2-10**). |

---

## 3. Result

Every surface in both audits maps to exactly one disposition above:
- **✅ done:** all safe-standalone GENERIC items + all MOVE (doc) items.
- **🕓 deferred:** the P2-7/P2-12 lockstep items (route/`skillPresetId`/
  `strategyPreset`/`SKILL_PRESET_MAP` demotion, guided-setup reshape) and the
  Phase-3-owned feature/schema moves (Bucket A/E features, blueprint facets,
  `GET /blueprints/defaults`). Each is noted; none is a Phase-2 safe-standalone
  that was skipped.
- **⤴ escalated:** E1 (greeting preset), E2 (billing meter), E3 (SEO/OG) — the
  only legal/product-boundary calls — plus note N1 (herobids→Traderton outbound
  link).
- **🧱 KEEP:** trading skills, runtime/engine mechanics, capability plumbing, and
  the deployed Traderton boundary (Phase-3-owned).

**No surface is left unclassified.** T5.1 complete.
