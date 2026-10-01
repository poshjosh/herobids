# Phase 2 Program — ESCALATIONS (legal / payment-provider product-boundary batch)

**Status:** living. **This is the single batch of questions that engineering
cannot decide.** Append each ESCALATE-LEGAL surface here and KEEP WORKING on
everything else (ENTRYPOINT §5.3). The operator resolves the whole batch at
Step 8 wrap-up (TASKS T5.2). Never pause mid-flight to ask one of these.

Append a row per surface. Do not remove rows; mark them `Resolved:` inline once
the operator decides, and mirror the decision into `DECISIONS.md`.

| # | Surface (what it is) | Location (file:line) | Options | Engineering-neutral recommendation | Why it needs legal/payment input | Resolution |
|---|---|---|---|---|---|---|
| E1 | Guided Setup advertises a first-party "AI crypto trader" preset — the onboarding greeting offers a headline quick-reply button presenting crypto trading as a first-party product during agent creation. | `apps/api/src/routes/chat.ts:108` (button `value: 'preset:trading'`) | (a) keep the trading preset button as-is; (b) relabel/retire it so onboarding is capability-neutral and trading is discovered via skills; (c) keep but route through Traderton attribution. | Retire the dedicated trading greeting button in favor of a capability-neutral "what should your agent do?" entry, with trading reachable through skill discovery. Low engineering cost either way. | Whether herobids may advertise/offer a crypto-trading agent as a headline product is a product-identity and potentially financial-promotions judgment, not engineering. | _(open)_ |
| E2 | Billable "strategy assessment" entitlement — the billing rate card defines a paid meter `assessment.request` (priceMicrousd 200000), surfaced to users as "strategy assessment". A billed, trading-specific product line item. | `config/default.yaml:987`; surfaced in web `features/billing/BillingDetails.tsx` | (a) keep the paid trading-assessment meter on the herobids bill; (b) move the entitlement/billing to Traderton; (c) relabel to a capability-neutral meter name while keeping the charge. | Keep the mechanism (metered usage billing is generic) but treat the trading-specific naming/entitlement as a product/billing decision — do not unilaterally rename/remove a live billing line item. | Billing copy and entitlements are payment-provider- and revenue-affecting; changing or removing a live meter has contractual/billing implications. | _(open)_ |
| E3 | SEO/marketing copy positions herobids as a crypto-trading product — meta description, OpenGraph, Twitter card, and JSON-LD state herobids does "…from crypto trading to personal assistance," making crypto trading a headline offering in indexed/share-preview metadata. (Web surface; paired with E1.) | `apps/web/index.html:7,11,20,41` | (a) keep the crypto-trading positioning; (b) make public positioning capability-neutral and drop the explicit crypto-trading claim; (c) keep but attribute trading to Traderton. | Make the public SEO/OG copy capability-neutral and let trading be a discoverable capability rather than a headline product claim. | Public marketing/SEO positioning around a financial activity is a brand, product, and potentially regulatory (financial-promotions) decision. | _(open)_ |

## How to use

- Classify with the ENTRYPOINT §5.1 rubric. Only the **ESCALATE-LEGAL** class
  lands here. GENERIC / MOVE / REMOVE-SAFE are acted on directly.
- If unsure between REMOVE-SAFE and ESCALATE-LEGAL → treat as ESCALATE-LEGAL and
  record it here.
- Give a concrete engineering-neutral recommendation anyway (what you *would* do
  if it were purely technical) so the operator decides faster.
