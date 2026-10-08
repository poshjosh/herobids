# Plan: Infer trading-ness for custom providers in the generic Add Connection form

Status: done — core implementation was already present in the working tree
(confirmed by direct read); the backend regression-proof test was added to
`setup.test.ts` and the full verification checklist passed (targeted test,
`pnpm lint`, full relevant suites, full `pnpm test`). See "Remaining Work" for
the test added and the Verification Checklist for what was run.
Owner: (unassigned)

## Goal

Remove trading-specific provider options (Hyperliquid, Bybit, 1inch, Jupiter)
from the generic "Add connection" form's dropdown, while still allowing those
same providers to be added through the existing "Custom provider" entry —
functionally, so the resulting connection can actually back trades. The
trading-ness of a custom-typed provider name must be **inferred** by matching
it against the catalog's `categories`, exactly like the existing non-custom
path already does. No checkbox, no new copy, no "is this a trading venue"
prompt of any kind, anywhere.

## Current State (verified by direct read, 2026 session)

`apps/web/src/features/setup/ProviderSetupForm.tsx` and
`apps/web/src/features/setup/provider-setup-form.test.tsx` **already contain**
the full resolved design described below. This plan exists to (a) record the
design as a durable artifact per repo convention, (b) call out the one gap
found during verification (a backend regression test proving the custom-mode
request shape succeeds end-to-end), and (c) define the sign-off checklist for
closing this out.

Confirmed present in `ProviderSetupForm.tsx`:

- An exported, pure `deriveApiCapability(isCustomProvider, effectiveProvider, selectedProvider, catalogProviders)` function that, for custom-mode, looks up `effectiveProvider` (the typed/lowercased label) against the **full** `catalogQuery.data?.providers ?? []` list — not just the dropdown-rendered subset — and classifies via `providerCapabilityGroup`. For non-custom mode it uses `selectedProvider?.categories` directly, unchanged from the original behavior.
  ```ts
  export function deriveApiCapability(
    isCustomProvider: boolean,
    effectiveProvider: string,
    selectedProvider: { categories: string[] } | undefined,
    catalogProviders: ReadonlyArray<{ id: string; categories: string[] }>,
  ): 'trading' | undefined {
    const customProviderCatalogMatch = isCustomProvider
      ? catalogProviders.find((p) => p.id === effectiveProvider)
      : undefined;
    const categories = (isCustomProvider ? customProviderCatalogMatch : selectedProvider)?.categories ?? [];
    return providerCapabilityGroup(categories) === 'trading' ? 'trading' : undefined;
  }
  ```
  Used in the component as `const apiCapability = deriveApiCapability(isCustomProvider, effectiveProvider, selectedProvider, catalogQuery.data?.providers ?? []);`, which feeds `capability: apiCapability` in the `setupApi.providerLink(...)` mutation payload.
- The Trading `<optgroup>` in the provider `<select>` is gated on `defaultCapability === 'trading' && tradingProviders.length > 0` (previously just `tradingProviders.length > 0`). Email and Other optgroups are unconditional on `defaultCapability`, matching the original design intent (only the Trading group is capability-gated).
- `tradingProviders` / `emailProviders` / `otherProviders` arrays are still computed unconditionally from `allProviders`, used by both the default-selection logic (`capabilityGroup`) and the gated JSX — no change to the array computation itself, only to the Trading group's render condition.
- The non-custom derivation path (`selectedProvider` lookup when `!isCustomProvider`) is untouched, so `SetupProviderLinkPage.tsx`, `AgentCapabilityPage.tsx`, and `AgentsPage.tsx` (all pass `defaultCapability="trading"` explicitly) are unaffected by the capability-derivation change and correctly keep showing the Trading optgroup via the dropdown-visibility change (`defaultCapability === 'trading'` is true for them).
- No checkbox, no new state, no new i18n key was added for this mechanism.

Confirmed present in `provider-setup-form.test.tsx`:

- `'hides trading provider options for general setup by default, keeping custom mode'` — replaces the old `'renders known provider options plus custom mode...'` expectation; asserts hyperliquid/bybit/jupiter/1inch are **absent** as `<option>` values with no `defaultCapability`, and `__custom__` is present.
- `'renders the email provider group for general setup by default'` — asserts the Email group renders and the Trading group label does **not**.
- `'renders the trading provider group when defaultCapability is trading'` — asserts the Trading group label renders when `defaultCapability="trading"`.
- `'renders all providers including email providers in trading mode'`, `'defaults to the first trading provider for trading capability'`, `'preselects initialProviderId ahead of the capability default'`, `'ignores an initialProviderId not present in the catalog'`, `'does not break existing trading call sites without initialProviderId'` — all still present, all still exercise `renderForm('trading', ...)`, unmodified in intent.
- A new `describe('ProviderSetupForm — deriveApiCapability (custom-mode trading inference)')` block with 5 cases:
  - infers `'trading'` for a custom label matching a known trading-category provider id (`hyperliquid`)
  - infers `'trading'` for a custom label matching a swap-category provider id (`jupiter`)
  - does **not** infer trading for a custom label matching a non-trading provider id (`gmail`)
  - does **not** infer trading for a custom label with no catalog match (`mycustomtool`) — the false-positive guard
  - confirms non-custom selections ignore catalog matching entirely and use `selectedProvider` directly

This fully covers items 1, 2, 3, 5a, 5b, 5c, 5d, and 6 (do-not-touch list) from
the original design brief.

## Remaining Work

### 1. Backend regression proof (item 4 from the brief)

File: `apps/api/src/routes/setup.test.ts`

No code change is expected on the backend — `createProviderLink` branches on
`provider` (string) + `capability` (`'trading' | undefined`) only; it has no
knowledge of `isCustomProvider`, so a custom-mode submission for `hyperliquid`
is byte-for-byte the same request shape as a dropdown-mode submission for
`hyperliquid`. Verified by reading `apps/api/src/routes/setup.ts`
(`providerAllowsTradingSetup` → `findProviderRegistryEntry` in
`apps/api/src/providers/registry.ts`, matched by provider-id string only) and
`apps/api/src/providers/venue-secrets.ts` / `validator.ts`
(`canonicalizeProviderSecrets` / `validateProviderSecrets` already alias-match
freeform key names such as `apiSecret` → `secret`).

Existing coverage already proves the shape works:
`'provisions the venue account over the boundary and inserts only the
connection for capability=trading'` (uses `VALID_HL_PAYLOAD` +
`capability: 'trading'`, provider `hyperliquid`) and `'accepts bybit with
apiSecret field name (canonicalized to secret)'` together cover: known
trading provider id + `capability: 'trading'` + freeform/aliased secret keys
→ successful boundary provisioning. This is exactly what the custom-mode
frontend now sends for `label` typed as `"hyperliquid"`.

Action: add one new test case making this explicit so the regression is
pinned to the actual frontend contract, not just inferred from provider-id
reuse:

```ts
it('provisions a custom-mode-shaped hyperliquid submission (freeform secrets, capability=trading) identically to the catalog path', async () => {
  const { client, invoke } = makeTradertonClient({ kind: 'success', /* ...mirror VALID_HL_PAYLOAD's success fixture... */ });
  const app = Fastify();
  decorateWithAuth(app);
  await app.register(setupRoutes, { tradertonClient: client });

  const response = await app.inject({
    method: 'POST',
    url: '/setup/provider-link',
    payload: {
      provider: 'hyperliquid', // what effectiveProvider resolves to when label="Hyperliquid" in custom mode
      label: 'My Custom Hyperliquid',
      credentialMode: 'manual',
      secrets: { apiKey: 'test-key', apiSecret: 'test-secret' }, // freeform entry keys, as typed via the custom secret-entry rows, not the structured-field UI
      capability: 'trading',
    },
    headers: authHeaders,
  });

  expect(response.statusCode).toBe(201);
  expect(invoke).toHaveBeenCalledWith(/* provision_venue_account */ expect.anything());
});
```

Adapt fixture/mock setup to match whatever helper (`makeTradertonClient`,
`authHeaders`, `VALID_HL_PAYLOAD`) the surrounding tests in the same file
already use — follow the existing `'provisions the venue account over the
boundary...'` test as the template, changing only the payload shape to the
custom-mode-equivalent one above and the test name/intent comment.

This is additive only. No other change to `setup.ts`, `registry.ts`,
`venue-secrets.ts`, or `validator.ts` is required or in scope.

### 2. `autoCreatesTradingConnection` on `CustomModeDefinition` — leave untouched

Searched for read-sites of `customMode.connections.autoCreatesTradingConnection`
(`packages/domain/src/provider-catalog.ts`'s `CustomModeDefinition`,
hardcoded `false` in both `apps/api/src/providers/registry.ts`'s `CUSTOM_MODE`
and the test catalog fixture). No production code path reads this field today
— `providerAllowsTradingSetup` only consults the per-provider registry entry
(`findProviderRegistryEntry(providerId)?.connections?.autoCreatesTradingConnection`),
never the `CUSTOM_MODE` constant, when `effectiveProvider` resolves to a known
id like `hyperliquid`. The `CUSTOM_MODE.connections.autoCreatesTradingConnection
= false` value is accurate as a statement about the custom-mode *mechanism*
itself (custom mode has no inherent trading affordance; only an id match
grants one) and requires no change. No action needed.

### 3. Do-not-touch confirmation

No changes needed to, and none found in, the following (confirmed by this
session's reads where listed as "Current State" above, otherwise unchanged
since brief was written): `SetupProviderLinkPage.tsx`,
`AgentCapabilityPage.tsx`, `AgentsPage.tsx`, `AgentConnectionField.tsx`,
`apps/api/src/providers/registry.ts`, `venue-secrets.ts`, `validator.ts`,
`schemas.ts`, `provider-templates.ts`, `packages/domain/src/provider-catalog.ts`,
any traderton repo file.

## Test Strategy

- Unit: `deriveApiCapability` pure-function cases (already present,
  5 cases) — covers the inference logic in isolation, no rendering needed.
- Unit/render (via `renderToStaticMarkup`, matching existing file convention):
  dropdown visibility cases for default/trading/email/other capability
  (already present).
- Integration (backend): the one new `setup.test.ts` case above, proving the
  exact request shape the custom-mode frontend now produces succeeds
  end-to-end through `createProviderLink` → boundary provisioning, with the
  same outcome as the existing catalog-driven hyperliquid test.
- No visual/browser verification needed — this is a pure logic + markup
  change with existing SSR-based test coverage; no new interactive behavior
  (no new clicks, no new state machine) was introduced.

## Verification Checklist (for Implementer to run before closing out)

1. `pnpm --filter @herobids/web test -- provider-setup-form` (or the
   repo's equivalent targeted run) — confirm all `ProviderSetupForm` cases
   pass, including the 5 new `deriveApiCapability` cases and the flipped
   dropdown-visibility cases.
2. Add and run the new `setup.test.ts` case from section 1 above.
3. `pnpm lint` — must pass clean (TypeScript strict, no `any`/`@ts-ignore`).
4. Full relevant suite: `apps/web`'s `ProviderSetupForm` / `ConnectionsPage`
   / `AgentConnectionField` tests, `apps/api`'s `setup.ts` /
   `providers.test.ts`.
5. Confirm no other call site of `ProviderSetupForm` (grep for
   `<ProviderSetupForm`) was missed — expected set: `ConnectionsPage.tsx`
   and `AgentConnectionField.tsx` (no `defaultCapability`, in scope for the
   behavior change) and `SetupProviderLinkPage.tsx` /
   `AgentCapabilityPage.tsx` / `AgentsPage.tsx` (`defaultCapability="trading"`,
   unaffected).

## Risks / Open Questions

- None blocking. The only non-trivial judgment call — whether
  `CUSTOM_MODE.connections.autoCreatesTradingConnection` needed updating — is
  resolved above by confirming it has no live reader.
- Minor residual risk: if a future provider is added to the registry with a
  `trading` or `swap` category and an id that collides with a common
  freeform label a user might type for an unrelated purpose (e.g. a
  hypothetical provider id as generic as `wallet`), that label would
  silently gain `capability: 'trading'` in custom mode. This is inherent to
  "infer from id string match" and was explicitly accepted by the design
  (exact id match, not fuzzy); flagging only for awareness, not as a
  required mitigation.
