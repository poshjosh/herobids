# Bug Report: Billing Top-Up Packs Expose Both Primary and Fallback Providers to Users

- **Status:** OPEN
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

3. **The top-up checkout endpoint should route through the primary provider first**, and fall back transparently (just like subscription checkout) if the primary is unavailable. It should not iterate all providers to find a pack.

4. **`UsageBillingConfig.topUpProductsByProvider` should still exist** (it's needed so each provider can map `packId` → provider-specific `externalId`), but the resolution logic should pick one provider — not merge all.

## Files That Need Changes

- `apps/api/src/routes/billing.ts`:
  - `resolveTopUpPacks()` (line 31–54): scope to a single provider instead of flat-mapping all providers.
  - `GET /billing/usage-summary` (line 575): pass the scoped provider to `resolveTopUpPacks`.
  - `POST /billing/top-up-checkout-session` (line 975): route through primary provider with failover, rather than iterating all providers.

- `apps/web/src/features/billing/BillingPage.tsx`:
  - Top-up dropdown (line ~548): remove `· {pack.provider}` from the option label. Display only `packId` + formatted cents.

- `apps/api/src/billing/provider-manager.ts` (optional enhancement):
  - Consider adding a `createTopUpCheckoutUrl` method that wraps `createCheckoutUrl` with the same primary→fallback failover, so the route handler doesn't need to know about providers at all.

- `apps/web/src/lib/api-client.ts`:
  - `BillingTopUpPack` type (if any) should no longer include a `provider` field visible to the frontend.

## Verification

- [ ] Staging/dev: billing page top-up dropdown shows only one set of packs (no duplicates, no provider label).
- [ ] Staging/dev: selecting a top-up pack and completing checkout routes through the correct (primary) provider.
- [ ] Staging/dev: if the primary provider is unavailable, top-up checkout silently falls back to the fallback provider.
- [ ] `pnpm lint` passes.
- [ ] Existing billing tests (`apps/api/src/routes/billing.test.ts`) pass.
