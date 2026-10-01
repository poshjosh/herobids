# Phase 2 Program — ESCALATIONS (legal / payment-provider product-boundary batch)

**Status:** living. **This is the single batch of questions that engineering
cannot decide.** Append each ESCALATE-LEGAL surface here and KEEP WORKING on
everything else (ENTRYPOINT §5.3). The operator resolves the whole batch at
Step 8 wrap-up (TASKS T5.2). Never pause mid-flight to ask one of these.

Append a row per surface. Do not remove rows; mark them `Resolved:` inline once
the operator decides, and mirror the decision into `DECISIONS.md`.

## Decision batch — READY FOR OPERATOR (finalized T5.2, 2026-10-01)

This is the **complete** set of legal / payment-provider / product-identity
questions Phase 2 surfaced. Engineering has executed every GENERIC/MOVE/
REMOVE-SAFE change (see `RECONCILIATION.md`); these are the only items that
cannot be decided in engineering. All three are the same underlying question —
**may herobids present/advertise/bill crypto-trading as a first-party product,
or must trading be Traderton-attributed/owned?** — seen on three surfaces:

- **E1** — onboarding greeting "AI crypto trader" preset button (product offer).
- **E2** — billable "strategy assessment" meter on the herobids bill (entitlement/billing).
- **E3** — SEO/OG metadata positioning herobids as a crypto-trading product (public positioning).
- **N1** (note, same family) — whether herobids may link OUT to the Traderton
  trading site once published.

**Recommended as a single coherent decision:** make herobids capability-neutral
across all four (retire the trading preset button, treat the assessment meter's
trading naming/entitlement as a Traderton/billing decision, make SEO/OG
capability-neutral, and keep herobids free of outbound trading-product links
until decided). Each row has its own engineering-neutral recommendation and the
specific reason it needs legal/payment input. **This batch is the one Phase 2
deliverable that waits on the operator** (ENTRYPOINT §5.3; TASKS T5.2).

| # | Surface (what it is) | Location (file:line) | Options | Engineering-neutral recommendation | Why it needs legal/payment input | Resolution |
|---|---|---|---|---|---|---|
| E1 | Guided Setup advertises a first-party "AI crypto trader" preset — the onboarding greeting offers a headline quick-reply button presenting crypto trading as a first-party product during agent creation. | `apps/api/src/routes/chat.ts:108` (button `value: 'preset:trading'`) | (a) keep the trading preset button as-is; (b) relabel/retire it so onboarding is capability-neutral and trading is discovered via skills; (c) keep but route through Traderton attribution. | Retire the dedicated trading greeting button in favor of a capability-neutral "what should your agent do?" entry, with trading reachable through skill discovery. Low engineering cost either way. | Whether herobids may advertise/offer a crypto-trading agent as a headline product is a product-identity and potentially financial-promotions judgment, not engineering. | _(open)_ |
| E2 | Billable "strategy assessment" entitlement — the billing rate card defines a paid meter `assessment.request` (priceMicrousd 200000), surfaced to users as "strategy assessment". A billed, trading-specific product line item. | `config/default.yaml:987`; surfaced in web `features/billing/BillingDetails.tsx` | (a) keep the paid trading-assessment meter on the herobids bill; (b) move the entitlement/billing to Traderton; (c) relabel to a capability-neutral meter name while keeping the charge. | Keep the mechanism (metered usage billing is generic) but treat the trading-specific naming/entitlement as a product/billing decision — do not unilaterally rename/remove a live billing line item. | Billing copy and entitlements are payment-provider- and revenue-affecting; changing or removing a live meter has contractual/billing implications. | _(open)_ |
| E3 | SEO/marketing copy positions herobids as a crypto-trading product — meta description, OpenGraph, Twitter card, and JSON-LD state herobids does "…from crypto trading to personal assistance," making crypto trading a headline offering in indexed/share-preview metadata. (Web surface; paired with E1.) | `apps/web/index.html:7,11,20,41` | (a) keep the crypto-trading positioning; (b) make public positioning capability-neutral and drop the explicit crypto-trading claim; (c) keep but attribute trading to Traderton. | Make the public SEO/OG copy capability-neutral and let trading be a discoverable capability rather than a headline product claim. | Public marketing/SEO positioning around a financial activity is a brand, product, and potentially regulatory (financial-promotions) decision. | _(open)_ |

## Notes attached to the batch (not new rows)

- **N1 (attaches to E1/E3) — outbound herobids→Traderton trading-product link.**
  T3.2 moved the venue/wallet reference docs to Traderton. Two kept herobids
  trading-UI renderers previously linked into those (now-removed) herobids pages:
  `apps/web/src/features/chat/GuidedSetupActionRenderer.tsx:13` and
  `apps/web/src/features/agents/TradingCapabilityPresentation.tsx:63`
  (`/docs/trading-venues/funding-wallets`). To avoid a dangling link **without**
  making a product-identity call, T3.2 removed the inline doc hyperlink and kept
  the funding guidance self-contained/capability-neutral (P2-15). **Open question
  for the operator (same family as E1/E3):** may herobids link out to the Traderton
  trading site (e.g. `staging.traderton.com/docs/trading-venues/...`), and if so at
  what URL? If yes, restore these as outbound links to the canonical Traderton docs
  once published (T4.2). Engineering-neutral recommendation: keep herobids free of
  outbound trading-product links until the E1/E3 positioning decision is made.

## How to use

- Classify with the ENTRYPOINT §5.1 rubric. Only the **ESCALATE-LEGAL** class
  lands here. GENERIC / MOVE / REMOVE-SAFE are acted on directly.
- If unsure between REMOVE-SAFE and ESCALATE-LEGAL → treat as ESCALATE-LEGAL and
  record it here.
- Give a concrete engineering-neutral recommendation anyway (what you *would* do
  if it were purely technical) so the operator decides faster.
