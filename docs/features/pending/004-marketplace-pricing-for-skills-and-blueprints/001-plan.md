## Plan: Marketplace Pricing For Skills And Blueprints

**Status:** Proposed
**Scope:** Research and implement marketplace pricing for skills and blueprints in a phased way, completing the missing end-to-end skill pricing flow first and then adding paid blueprint access without breaking the current free-only blueprint portability contract.

**Depends on:**
- [docs/features/2026/08/01/008-blueprint-marketplace-likes/001-plan.md](../../2026/08/01/008-blueprint-marketplace-likes/001-plan.md)
- [docs/features/2026/08/01/003-agent-bot-config-harmonization/003-agent-blueprint-marketplace-phase-1-implementation.md](../../2026/08/01/003-agent-bot-config-harmonization/003-agent-blueprint-marketplace-phase-1-implementation.md)
- [docs/features/2026/06/13/002-skills-management/001-skills-model-normalization-plan.md](../../2026/06/13/002-skills-management/001-skills-model-normalization-plan.md)

**TL;DR:** Skills already have a backend `priceCents` field and an entitlement table, but there is no purchase flow and the web UI does not let authors set a price. Blueprints have no pricing model at all, and the current blueprint contract explicitly rejects paid skill dependencies. The safest path is: define one catalog-level purchase contract for marketplace assets, finish skills pricing end to end, then add blueprint pricing for blueprints whose dependencies remain free/system in v1. Runtime usage billing remains separate from marketplace asset purchases.

---

## Problem

OpenAIdom has partial marketplace pricing scaffolding but no coherent paid-asset flow:

1. Skills already carry a price field, but authors cannot currently set it from the web UI.
2. Paid skills are modeled as entitlement-gated assets, but there is no checkout flow that grants those entitlements.
3. Blueprints have marketplace browse/like/publication behavior, but no commercial metadata, no entitlements, and no purchase flow.
4. Blueprint Phase 1 portability explicitly rejects paid skills, so naive blueprint monetization would conflict with the current installability contract.

The result is an inconsistent system: skills look partly monetizable in the backend, blueprints are not, and there is no careful boundary between marketplace asset pricing and ongoing runtime usage billing.

---

## Current Code Truth (verified)

1. **Skills already store a list price.** `packages/db/src/schema/skills.ts` defines `priceCents` on the catalog row.

2. **Skill pricing is already enforced on authoring writes.** `apps/api/src/routes/skills.ts` rejects `priceCents > 0` unless the creator's plan has `canPriceSkills`.

3. **The create-skill web form does not expose price input.** `apps/web/src/features/skills/SkillsPage.tsx` renders name, description, instructions, tools, and visibility, but no `priceCents` field.

4. **There is already a paid-skill entitlement table.** `packages/db/src/schema/skill-entitlements.ts` models active access grants by `(skillId, userId)`.

5. **Paid skill selectability is already modeled.** `apps/api/src/routes/skills.ts` returns `selectabilityReason: 'paid_entitlement_required'` when a published paid skill is visible but the viewer is not entitled.

6. **The skills marketplace currently has no purchase flow.** There is no checkout or purchase endpoint in the skill routes or UI that inserts entitlement rows for a buyer.

7. **Billing checkout exists, but only for plans and credit top-ups.** `apps/api/src/routes/billing.ts` exposes plan checkout and top-up checkout, but not generic one-time marketplace asset purchase checkout.

8. **Blueprints have no pricing fields today.** `packages/db/src/schema/blueprints.ts` has marketplace counters/scores and revision pointers, but no price column.

9. **Blueprints have no entitlement table today.** There is no `blueprint_entitlements` schema or equivalent buyer-grant model.

10. **Blueprint Phase 1 explicitly rejects paid skill dependencies.** `apps/api/src/services/blueprint-skill-validator.ts` and the Phase 1 implementation doc reject paid skills in blueprint dependencies.

11. **Blueprint monetization is distinct from runtime usage billing.** Existing usage billing meters agent runtime and LLM/tool consumption; there is no existing concept of “buy this asset once, then pay separate runtime usage later.”

12. **Skill entitlement semantics are already catalog-level, not revision-level.** The active grant table keys on `skillId`, not `skillRevisionId`, which strongly favors a catalog-level purchase contract for marketplace assets.

---

## Recommended Contract Decisions

These should be treated as locked recommendations unless product chooses to override them.

### 1. Price the catalog asset, not an individual revision

For both skills and blueprints, the purchased thing is the stable marketplace listing:

- **Skill purchase** grants entitlement to the `skills.id` catalog asset.
- **Blueprint purchase** grants entitlement to the `blueprints.id` catalog asset.

The purchase record should still capture the published revision at time of sale for audit and support, but the active entitlement should live at the catalog level.

**Why:**
- Skills already use catalog-level entitlements.
- Blueprints already separate mutable catalog identity from immutable published revisions.
- This keeps updates simple: buyers keep access to later published revisions of the same listing.

### 2. Blueprint pricing covers install/use rights to the listing, not runtime compute

For agent and bot blueprints, the paid product is the reusable recipe or install right. Ongoing runtime usage, agent execution, and LLM costs remain billed by the existing usage-billing system.

**Why:**
- It cleanly separates marketplace commerce from operational metering.
- It avoids coupling a one-time asset purchase to recurring runtime charges.

### 3. Paid blueprint v1 must remain dependency-simple

In the first paid-blueprint implementation, a priced blueprint may depend only on:

1. system skills; or
2. free published user skills.

Paid skills inside paid blueprints remain out of scope until there is an explicit bundle/transitive-entitlement contract.

**Why:**
- The current Phase 1 portability contract rejects paid skill dependencies.
- Bundled paid dependencies introduce purchase composition, refund propagation, seller-share allocation, and entitlement transitivity complexity that does not belong in the initial slice.

### 4. Creator payout automation is not required for v1

The first implementation should record commercial events and settlement fields, but it does not need automated creator payout.

Recommended v1 behavior:
- record `grossPriceCents`
- record `platformFeeCents`
- record `creatorShareCents`
- record seller/author identity
- support later export/manual settlement

**Why:**
- It allows pricing to launch without blocking on payout infrastructure.
- It preserves future optionality for revenue share rules.

### 5. Refund/revocation must not silently break existing installs

If a paid skill or blueprint entitlement is revoked or refunded:

- **future new assignments / installs / instantiations** should be blocked;
- **already assigned agent skills** should remain usable;
- **already instantiated agents/bots from a blueprint** should remain intact.

**Why:**
- Revocation should not corrupt existing user state.
- The system already treats previously assigned paid skills as selectable for continuity.

---

## Goals

1. Complete skill pricing end to end: author sets price, buyer purchases, entitlement is granted, skill becomes selectable.
2. Add blueprint pricing with a parallel catalog-level entitlement model.
3. Reuse the existing billing/provider stack for one-time marketplace checkout rather than inventing a separate payment subsystem.
4. Keep runtime usage billing separate from asset purchase pricing.
5. Preserve the current blueprint dependency contract by keeping paid skill bundles out of v1.

## Non-Goals

1. Do not introduce automated creator payouts in v1.
2. Do not support paid skill dependencies inside priced blueprints in v1.
3. Do not redesign plan subscriptions or usage billing.
4. Do not change existing marketplace ranking formulas.
5. Do not define a separate hosted-agent subscription product in this slice.

---

## Proposed Design

### Phase A — Research And Contract Lock

**Purpose:** finalize the commercial contract before writing code across billing, entitlements, and marketplace surfaces.

**Deliverables:**
1. Confirm the catalog-level purchase model for both skills and blueprints.
2. Confirm that blueprint pricing applies to blueprint listings, not runtime usage.
3. Confirm that priced blueprints in v1 may include only free/system skills.
4. Confirm v1 settlement policy: record seller share, no automated payouts.
5. Confirm revocation/refund semantics: block future new use, preserve existing assigned/instantiated state.

**Files likely touched later because of these decisions:**
- `packages/domain/src/config/schema.ts`
- `packages/db/src/schema/*.ts`
- `apps/api/src/routes/skills.ts`
- `apps/api/src/routes/blueprints.ts`
- billing provider/route surfaces

### Phase B — Shared Marketplace Purchase Infrastructure

**Purpose:** add one reusable purchase ledger and one reusable checkout path for paid marketplace assets.

**Recommended data model:**

1. `marketplace_purchases` (new, immutable commercial record)
   - `id`
   - `buyerUserId`
   - `sellerUserId`
   - `assetKind` = `skill | blueprint`
   - `assetId`
   - `publishedRevisionIdAtPurchase` nullable
   - `priceCents`
   - `currency` (`USD` in v1)
   - `platformFeeCents`
   - `creatorShareCents`
   - `provider`
   - `providerCheckoutId` / `providerPaymentId`
   - `status` (`pending | paid | refunded | revoked | failed`)
   - `createdAt`, `paidAt`, `refundedAt`

2. `blueprint_entitlements` (new)
   - modeled analogously to `skill_entitlements`
   - active grant keyed by `(blueprintId, userId)`
   - nullable pointer to the granting purchase record

3. `skill_entitlements` (existing)
   - extend to support purchase provenance, either with a nullable `purchaseId` or equivalent source metadata

**Checkout flow recommendation:**

Add a generic marketplace checkout route, for example:

```ts
POST /marketplace/checkout-session
{ assetKind: 'skill' | 'blueprint', assetId: string }
```

The route should:
1. validate asset existence and publication status
2. validate non-owner purchase attempt
3. validate asset is priced (`priceCents > 0`)
4. validate any plan-gated visibility requirements
5. create provider checkout metadata tied to the asset and buyer
6. persist a pending purchase row

Webhook confirmation should:
1. resolve the pending purchase idempotently
2. mark purchase `paid`
3. upsert the relevant entitlement row
4. leave a stable audit trail even if the entitlement already existed

**Billing extension note:**
- The current provider-manager flow is plan/top-up oriented. This slice will need a new one-time asset purchase path, not just another plan checkout.
- Mock provider behavior should auto-fulfill marketplace purchases in tests/dev exactly as it does for plan checkout.

### Phase C — Complete Skill Pricing End To End

**Purpose:** finish the half-implemented skill pricing path.

**Backend work:**
1. Keep `canPriceSkills` as the author-side gate for non-zero `priceCents`.
2. Add skill purchase checkout and entitlement grant flow using the shared marketplace purchase infrastructure.
3. Expose purchase state on skill read models, for example:
   - `isEntitledByViewer`
   - `canPurchase`
   - `purchaseState`
4. Ensure skill selection/installability continues to work from active entitlement rows.

**Frontend work:**
1. Add a price field to the create/edit skill form in `apps/web/src/features/skills/SkillsPage.tsx`.
2. Show price labels consistently in the skill cards/detail surfaces.
3. Replace the dead-end state for paid visible skills with a real “Purchase” or “Buy access” action.
4. After successful purchase, refresh/selectability state so the skill becomes assignable without manual intervention.

**Behavior rules:**
1. Free skills remain selectable when published and marketplace-visible.
2. Paid skills are visible to marketplace viewers, but selectable only when entitled, previously assigned, system-owned, or author-owned.
3. Authors cannot buy their own skills.

### Phase D — Add Blueprint Pricing On Top Of Free-Only Dependencies

**Purpose:** add paid blueprint listings without violating the current blueprint dependency contract.

**Data model:**
1. Add `priceCents` to `blueprints`.
2. Add blueprint pricing entitlement in plan config:

```ts
blueprints: {
  canViewMarketplaceBlueprints: boolean;
  canLikeMarketplaceBlueprints: boolean;
  canPriceBlueprints: boolean;
}
```

3. Add `blueprint_entitlements` as described above.

**Publication rules:**
1. A creator may publish a priced blueprint only if `canPriceBlueprints` is true.
2. A priced blueprint must pass dependency validation proving that all pinned skills are system or free published skills.
3. A blueprint containing a paid skill dependency is rejected until a later bundle contract lands.

**Access rules:**
1. Marketplace viewers may browse paid blueprints if `canViewMarketplaceBlueprints` allows it.
2. Non-entitled viewers may read listing metadata and price.
3. Fork/instantiate/install actions for a paid blueprint require active entitlement unless the viewer is the author or admin.
4. Already instantiated assets remain unaffected if entitlement is later revoked.

**Frontend work:**
1. Show blueprint price in browse cards and detail pages.
2. If not entitled, primary CTA becomes purchase instead of instantiate/fork.
3. If entitled, existing instantiate/fork flows remain available.

**Important boundary:**
- Pricing a blueprint does **not** price the runtime of the created agent/bot.
- After purchase and instantiation, normal usage billing still applies.

### Phase E — Observability, Audit, And Supportability

**Purpose:** make paid marketplace assets operable in production.

**Additions:**
1. structured purchase audit logs
2. admin visibility into purchase records and entitlement grants
3. idempotent webhook handling tests
4. refund/revoke operational path
5. buyer-facing receipt or purchase-history read model

---

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Blueprint pricing conflicts with current free-only dependency contract | Keep paid skill dependencies explicitly out of v1 priced blueprints |
| Skill pricing remains half-finished because blueprint work expands scope | Sequence skills first, then blueprints |
| Marketplace asset checkout gets mixed up with subscription checkout | Add a distinct marketplace purchase flow and ledger, even if provider adapters are reused |
| Refunds or revocations break existing agents/bots | Make revocation block only future new use; preserve existing assigned/instantiated state |
| Creator monetization blocks launch | Record fee/seller-share data now; keep automated payout out of v1 |
| Catalog-level purchase creates support ambiguity around later revisions | Record `publishedRevisionIdAtPurchase` for audit while keeping active entitlement catalog-level |

---

## Implementation Order

1. Lock the commercial contract decisions in this document.
2. Add shared marketplace purchase ledger + provider checkout extension.
3. Extend existing skill-entitlement flow with purchase provenance.
4. Ship end-to-end skills pricing, including UI price input and purchase CTA.
5. Add blueprint commercial metadata and `canPriceBlueprints` entitlement.
6. Add `blueprint_entitlements` and paid blueprint gating.
7. Restrict priced blueprints to free/system skill dependencies in v1.
8. Add purchase history, audit, and refund/revoke support.
9. Run repo lint/typecheck and focused API/web tests.

---

## Acceptance Criteria

1. Authors with `canPriceSkills` can set or update a skill price from the web UI.
2. A published paid skill can be purchased through a real checkout flow, and successful payment grants entitlement automatically.
3. After purchase, a paid skill becomes selectable/assignable for the buyer without manual intervention.
4. The system records immutable marketplace purchase rows for paid skill purchases.
5. Authors with `canPriceBlueprints` can price a blueprint listing.
6. A published paid blueprint can be purchased through the same marketplace purchase infrastructure.
7. A non-entitled user cannot instantiate or fork a paid blueprint.
8. A paid blueprint containing a paid skill dependency is rejected in v1.
9. Existing instantiated agents/bots and already assigned skills are not broken by refund/revocation.
10. Marketplace asset pricing remains separate from runtime usage billing.

---

## Open Questions

These do not block drafting, but they should be resolved before implementation begins.

1. Should marketplace buyers always receive access to future published revisions of a purchased skill/blueprint, or should there be an author-controlled major-upgrade boundary later?
2. Should paid marketplace assets be buyable by any user who can view the marketplace, or should there be a separate buyer-side entitlement gate in a later phase?
3. Is creator payout manual in v1, or should the platform simply record creator-share liability without any payout workflow initially?
