# Decision Brief B4: Assessment/wake/blueprint edges — platform data carrying trading identity

- **Question:** Several **platform-owned** subsystems persist trading-identity data in herobids' DB: the assessment tables (`market_assessment_runs/requests`, `agent_scan_candidates`, `agent_scan_metrics`, `agent_preset_transitions`, `agent_preset_bindings`, `review_advice`, `agent_assessment_review_*`), wake preferences/context flowing through `agent_messages` + `chat_threads.setupContext`, and the **blueprint marketplace** (`blueprints.venueType/strategyType` + full bot-config revision payloads). Keep them platform-side, or re-home any behind the boundary?
- **Status:** OPEN — pre-loaded for chat. **B3 is ratified (ADR 012), so its prerequisite is satisfied.** Partially B1-linked (blueprint payloads carry capital/risk presets).
- **Evidence:** audit §3.2 (platform-assessment rows, blueprints rows, chat setupContext), §7-S15; herobids `packages/db/src/schema/*`.

## Component analysis

### 1. Assessment subsystem tables

Per-B3, the *assessor* stays (platform monetization; evidence already boundary-served). The tables store results keyed by trading identity (instrumentKind/venueFamily/symbol/network). Two observations:
- `market_assessment_artifacts`/`_runs` are **already shared** with traderton (counterpart schema exists there) — the write path is platform, the read path potentially both.
- The remaining tables (`_requests`, scan candidates/metrics, preset transitions/bindings, review advice) are platform-only. They describe *platform decisions about presets*, not trading state. No enforcement reads them.
- **Recommendation: keep all platform-side.** They are the audit trail of platform thinking (B3's category), not trading authority. Re-homing them would relocate a product feature without moving any enforcement — pure churn. One candidate exception, noted not recommended: if traderton ever needs preset context for bot execution decisions, expose via boundary read rather than copying tables.

### 2. Wake/context flow (wakePreferences, market-context cards, `chat_threads.setupContext`)

- Wake *scheduling* (which agent gets woken when) is unambiguously platform. The ungated market-context cards (audit §7-S14: watch/discovery/regime cards render for any agent that receives such a wake) are a **consistency gap, not an ownership gap** — see B5 for the fix.
- `chat_threads.setupContext` persisting `venue/capital/preset` is a guided-setup *summary* — chat state, platform-owned. Its capital value is a UI echo of the form at setup time; once B1 lands, it should reference (or drop) capital rather than store a second copy — small Track-C hygiene item, not a decision.
- **Recommendation: keep platform-side**; fold the setupContext-capital hygiene into whichever B1 outcome's Track-C list applies.

### 3. Blueprint marketplace

The genuinely hard item. Blueprints carry **full bot trading config** (venueType, strategyType, strategy/risk/execution/swapAssets payloads) and instantiate through the boundary (`instantiate_bot` outside the local tx — the documented bounded divergence). Options:
- **(a) Keep as-is (RECOMMENDED).** Blueprints are marketplace *templates* — product content. They contain trading config the way a recipe contains ingredients; nothing enforces from them (instantiation sends the config over the boundary, which validates). The performance scorer reads positions via boundary already. Known accepted risk stays: boundary-success/local-crash orphans (documented).
- **(b) Move bot-kind blueprints behind the boundary.** Traderton would own bot templates. Rejected direction: destroys the marketplace product (agent-kind blueprints are platform; splitting kinds across repos bifurcates the product), and templates-without-enforcement aren't traderton's concern.
- **(c) Keep, but stop persisting capital/risk in revision payloads.** With B1=(ii), blueprint payloads that embed creator capital/risk presets would instead reference profile defaults — hygiene item for Track C, dependent on B1.
- **Recommendation: (a) + (c-if-B1-lands).** Also fold in the known S7-adjacent risk: instantiation's local-tx/boundary ordering — leave as accepted divergence, re-document in the C-slice if touched.

## Cascade

- B4-stays-all ⇒ Track C contains no assessment/wake/blueprint migration; only the two hygiene items (setupContext capital, blueprint payload references) ride their parents' slices.
- The scan/wake *machinery* (monitor/coordinator) was already classed platform in the audit — B4 does not reopen it.

## Open questions for the chat session

1. Assessment tables: accept "stays + already-shared artifacts remain shared"?
2. Blueprints: accept (a) keep-as-product-content (with (c) hygiene if B1=(ii))?
3. Any appetite for exposing preset context to traderton via boundary read (not recommended), or leave dormant until a real consumer exists?
