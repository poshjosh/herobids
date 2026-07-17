# Bug Report: Billing Top-Up Packs Expose Both Primary and Fallback Providers to Users

- **Status:** CLOSED
- **Severity:** Medium
- **Date:** 2026-07-16
- **Discovered By:** Code review — billing page design discussion.
- **Summary:** The billing page top-up dropdown shows packs from ALL configured payment providers (primary + fallback) combined. Users see duplicate entries like "Topup500 · $500.00 · stripe" and "Topup500 · $500.00 · creem" side by side, leaking an implementation detail and creating confusing UX. The fallback provider should be a transparent failover mechanism, not a user-facing choice.

## Environment

- **Config:** `config/default.yaml` → `usageBilling.topUpProductsByProvider` is keyed by provider (`mock`, `creem`, `stripe`) with identical pack IDs across providers.
- **Frontend:** `apps/web/src/features/billing/BillingPage.tsx` — top-up dropdown renders `<packId> · <price> · <provider>` per pack.
- **API:** `apps/api/src/routes/billing.ts` — `resolveTopUpPacks()` merges all providers' packs into a single flat list.

## Observed Behavior

With `config/default.yaml` configuring both `mock` and `creem` providers under `topUpProductsByProvider`, the billing page dropdown shows:

```
Topup5 · $5.00 · mock
Topup20 · $20.00 · mock
Topup50 · $50.00 · mock
Topup100 · $100.00 · mock
Topup200 · $200.00 · mock
Topup500 · $500.00 · mock
Topup1000 · $1000.00 · mock
Topup5 · $5.00 · creem
```

In production, where the primary might be `stripe` and the fallback `creem`, users would see:

```
Topup5 · $5.00 · stripe
Topup5 · $5.00 · creem
Topup20 · $20.00 · stripe
Topup20 · $20.00 · creem
...
```

This is confusing: users do not know (and should not need to know) which provider to use, and seeing what looks like duplicate options erodes trust.

## Root Cause

### 1. `resolveTopUpPacks()` merges all providers (primary + fallback)

**File:** `apps/api/src/routes/billing.ts`, line 42:

```typescript
return Object.entries(usageBillingConfig.topUpProductsByProvider).flatMap(([provider, packs]) =>
  providerManager.getProvider(provider as BillingProvider)
    ? packs
        .filter((pack) => allowedPackIds.has(pack.packId))
        .map((pack) => ({
          provider,        // ← provider name exposed to frontend
          packId: pack.packId,
          cents: pack.cents,
        }))
    : [],
);
```

This iterates over **all** configured providers — primary, fallback, and mock — and returns every pack from every provider. It does not scope to the primary (or subscription-owning) provider. The fallback provider should only be used at checkout time as a transparent failover (which `PaymentProviderManager.createCheckoutUrl` already handles correctly for subscriptions), not as a source of additional top-up options.

### 2. Frontend renders provider name inline

**File:** `apps/web/src/features/billing/BillingPage.tsx`, line ~548:

```tsx
<option key={`${pack.provider}_${pack.packId}`} value={pack.packId}>
  {pack.packId} · {formatCurrencyFromCents(intl, pack.cents)} · {pack.provider}
</option>
```

The provider field is rendered as a user-visible label. Users should not see or care about the payment processor.

### 3. Top-up checkout endpoint also iterates all providers

**File:** `apps/api/src/routes/billing.ts`, line 999:

```typescript
for (const [provider, packs] of Object.entries(usageBillingConfig.topUpProductsByProvider)) {
  // ...
  const pack = packs.find((p) => p.packId === packId);
  if (pack) {
    matchedPack = pack;
    matchedProvider = provider;
    break;
  }
}
```

While this technically works (first match wins), it means a user whose subscription is on Stripe could end up creating a Creem top-up checkout session if Creem's pack is listed first. This creates a split-provider billing relationship (subscription on Stripe, top-up credit on Creem), which is a reconciliation and support headache.

### 4. The design contradicts the PaymentProviderManager's own failover pattern

`PaymentProviderManager.createCheckoutUrl` (for subscriptions) correctly implements "try primary, fall back on error." But the top-up flow bypasses this entirely — it uses `createCheckoutUrlViaProvider` with whichever provider happened to match first in the config iteration order. The failover mechanism exists but is not used for top-ups.

## What Should Happen

1. **`resolveTopUpPacks` should scope to a single provider** — either the user's subscription-owning provider, or the configured primary provider. The fallback provider should not contribute to the list of available packs.

2. **The frontend dropdown should not display the provider name.** The label should simply be the pack amount and price (e.g. "$5.00", "$20.00", "$50.00").

3. **The top-up checkout endpoint should route through the subscription-owning provider first**, and fall back transparently (just like subscription checkout) if that provider is unavailable. It should not iterate all providers to find a pack. Using the subscription's provider keeps the billing relationship on a single provider — avoiding a split-provider scenario where subscription is on Stripe but top-up credit is on Creem.

4. **`UsageBillingConfig.topUpProductsByProvider` should still exist** (it's needed so each provider can map `packId` → provider-specific `externalId`), but the resolution logic should pick one provider — not merge all.

5. **The `provider` field should be dropped from the API response entirely.** If the frontend no longer displays it, the API should stop sending it. This simplifies the contract and prevents future leakage.

## Concrete Fix Plan

### Implementation Notes

**Provider selection for display:** `resolveTopUpPacks` must use the user's subscription-owning provider when available, falling back to `billingConfig.primaryProvider`. The `GET /billing/usage-summary` endpoint currently does not query the subscription — it must be plumbed in so the correct provider can be passed.

**Provider selection for checkout:** The `POST /billing/top-up-checkout-session` handler must follow the same rule: resolve the owning provider from the subscription, not just the global primary. This prevents split-provider billing relationships where a user's subscription migrated to the fallback at signup but top-ups route through the (unavailable) primary.

**Top-up checkout failover is NOT a drop-in call to `createCheckoutUrl`.** The subscription checkout path (`createCheckoutUrl`) resolves provider-specific product/price IDs from `billingConfig` plan mappings. Top-up packs use `externalId` directly from `usageBillingConfig.topUpProductsByProvider` — a different ID resolution path. The failover must be implemented inline in the route handler (try owning provider, catch `ProviderUnavailableError`, resolve fallback's `externalId`, retry) or via a new dedicated method on `PaymentProviderManager`.

**Frontend `key` prop fix:** The dropdown currently uses `key={`${pack.provider}_${pack.packId}`}`. After removing `provider` from the response, use just `pack.packId` as the key (packs are now unique per the scoped provider).

**Test compatibility:** The existing test `"top-up checkout routes through the matched provider-specific checkout path"` (billing.test.ts line ~439) asserts the old "iterate all providers" behavior and must be updated. The `usage-summary` tests also assert on a `provider` field in the response that will be removed.

**Edge case — no pack for the owning provider:** If the user's subscription provider has no `topUpProductsByProvider` entry (e.g. operator only configured top-up packs for Creem but the user is on Stripe), `resolveTopUpPacks` returns an empty array. The frontend already handles an empty pack list gracefully. For checkout, the handler should fall back to searching the other provider's config before returning an error.

| # | File | Change |
|---|---|---|
| 1 | `apps/api/src/routes/billing.ts` | Add optional `targetProvider?: BillingProvider` param to `resolveTopUpPacks()`; scope to that single provider's packs; drop `provider` from returned objects |
| 2 | `apps/api/src/routes/billing.ts` | In `GET /billing/usage-summary`, query `billingRepo.findSubscriptionByUserId()` to determine `topUpProvider`; pass to both `resolveTopUpPacks()` calls |
| 3 | `apps/api/src/routes/billing.ts` | Import `ProviderUnavailableError` from `../billing/provider-port.js` |
| 4 | `apps/api/src/routes/billing.ts` | In `POST /billing/top-up-checkout-session`, resolve owning provider from subscription (or primary); look up pack `externalId` in that provider's config; try checkout via that provider; on `ProviderUnavailableError` fail over to fallback provider's `externalId`; drop `provider` from response |
| 5 | `apps/web/src/features/billing/BillingPage.tsx` | Remove `· {pack.provider}` from option label; change `key` from `` `${pack.provider}_${pack.packId}` `` to `pack.packId` |
| 6 | `apps/web/src/lib/api-client.ts` | Remove `provider` from `UsageSummaryResponse.topUpPacks` type |
| 7 | `apps/api/src/routes/billing.test.ts` | Update `usage-summary` tests to not assert on `provider` field; update top-up checkout test to reflect single-provider + failover logic |
| 8 | *(Optional)* `apps/api/src/billing/provider-manager.ts` | Add `createTopUpCheckoutUrl` with primary→fallback failover to centralize the logic (cleaner but not strictly required — the inline approach works) |

## Verification

- [ ] Staging/dev: billing page top-up dropdown shows only one set of packs (no duplicates, no provider label).
- [ ] Staging/dev: selecting a top-up pack and completing checkout routes through the subscription-owning provider (not a hardcoded "primary").
- [ ] Staging/dev: if the owning provider is unavailable, top-up checkout silently falls back to the fallback provider.
- [ ] Staging/dev: user whose subscription is on the fallback provider (e.g. Creem, because Stripe was down at signup) sees only Creem top-up packs and their top-up routes through Creem — no split-provider billing relationship.
- [ ] Staging/dev: user with no subscription sees top-up packs from the configured primary provider.
- [ ] Staging/dev: if the owning provider has no `topUpProductsByProvider` entry, the dropdown shows an empty list (no crash), and checkout returns a clear error.
- [ ] `pnpm lint` passes.
- [ ] Existing billing tests (`apps/api/src/routes/billing.test.ts`) pass after updating for the new behavior.
