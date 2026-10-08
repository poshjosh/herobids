# Plan: Infer trading capability for custom-mode providers; hide Trading optgroup outside trading contexts

Status: ready for implementation
Scope: `apps/web` only (one component + its test file). No backend, no new UI copy, no checkbox.

## Goal

The generic "Add connection" form (`ConnectionsPage` → `ProviderSetupForm` with no
`defaultCapability`, also reused inside `AgentConnectionField`) currently:

- always renders a "Trading" optgroup (hyperliquid/bybit/jupiter/1inch) in the provider
  dropdown, even in non-trading contexts, and
- always sends `capability: undefined` for any Custom-mode submission, even when the
  user types a known trading provider's id (e.g. "hyperliquid") as the connection label.

Target behavior:

- The Trading optgroup only renders when `defaultCapability === 'trading'` (i.e. the
  existing trading-aware call sites: `SetupProviderLinkPage`, `AgentCapabilityPage`,
  `AgentsPage`). The generic form shows Email / Other / Custom only.
- A Custom-mode submission whose typed label matches a known trading provider id in the
  full catalog (case-insensitively, via the existing lowercasing) still produces
  `capability: 'trading'` in the API payload — inferred from the catalog, never asked.
- No checkbox, no new copy, no new i18n key. This is a pure derivation + a pure
  rendering-gate change.

Explicitly rejected: any "is this a trading venue?" checkbox or prompt. Do not add one.

## Files in scope

- `apps/web/src/features/setup/ProviderSetupForm.tsx` (the only behavior change)
- `apps/web/src/features/setup/provider-setup-form.test.tsx` (test updates)

## Files confirmed NOT to change (verified by reading)

- `apps/web/src/features/connections/ConnectionsPage.tsx` — renders
  `<ProviderSetupForm onClose={...} onSuccess={...}>` with no `defaultCapability`; needs
  no edit, it inherits the new behavior automatically.
- `apps/web/src/features/setup/SetupProviderLinkPage.tsx`,
  `apps/web/src/features/agents/AgentCapabilityPage.tsx`,
  `apps/web/src/features/agents/AgentsPage.tsx` — all pass `defaultCapability="trading"`
  explicitly; unaffected by both changes (optgroup stays visible, capability derivation's
  non-custom branch is untouched).
- `apps/web/src/features/agents/AgentConnectionField.tsx` — renders `ProviderSetupForm`
  with no `defaultCapability`; inherits the change with no edit needed (its own "Trading"
  vs "Other" grouping of *existing* connections elsewhere in that component is a separate,
  unrelated display concern).
- `apps/api/src/routes/setup.ts`, `apps/api/src/providers/registry.ts`,
  `apps/api/src/providers/venue-secrets.ts`, `apps/api/src/providers/validator.ts` — the
  API only ever sees `{ provider, capability }` as plain strings; `providerAllowsTradingSetup`
  (registry.ts:341) matches by provider-id string against the registry regardless of how
  the frontend derived that string. Confirmed via read — no backend change needed.
- `apps/web/src/features/setup/provider-templates.ts`,
  `packages/domain/src/provider-catalog.ts` — out of scope, unrelated to this mechanism.
- Any `traderton` repo file — out of scope.

## Step 1 — Gate the Trading optgroup on `defaultCapability === 'trading'`

File: `apps/web/src/features/setup/ProviderSetupForm.tsx`

Current JSX (inside `formContent`, provider `<select>`):

```tsx
{tradingProviders.length > 0 && (
  <optgroup label={intl.formatMessage({ id: 'setup.form.group.trading' })}>
    {tradingProviders.map((provider) => (
      <option key={provider.id} value={provider.id}>{provider.displayName}</option>
    ))}
  </optgroup>
)}
```

Change the condition to:

```tsx
{defaultCapability === 'trading' && tradingProviders.length > 0 && (
  <optgroup label={intl.formatMessage({ id: 'setup.form.group.trading' })}>
    {tradingProviders.map((provider) => (
      <option key={provider.id} value={provider.id}>{provider.displayName}</option>
    ))}
  </optgroup>
)}
```

Do not touch the `tradingProviders`/`emailProviders`/`otherProviders` array computations —
they stay as-is; `tradingProviders` is still read by `capabilityGroup` for the
`defaultCapability === 'trading'` default-selection branch, which is unaffected by this
JSX-only gate.

No change to `emailProviders`/`otherProviders` optgroups — they remain unconditional on
length only, matching current behavior for the generic form.

## Step 2 — Infer trading capability for Custom-mode submissions from the full catalog

File: `apps/web/src/features/setup/ProviderSetupForm.tsx`

Current:

```tsx
// Derive the API capability from the selected provider's categories.
// For custom providers we don't know the categories, so omit capability.
const apiCapability: 'trading' | undefined =
  !isCustomProvider && providerCapabilityGroup(selectedProvider?.categories ?? []) === 'trading'
    ? 'trading'
    : undefined;
```

Replace with:

```tsx
// Derive the API capability from the selected provider's categories.
// For custom providers, infer trading-ness by matching the typed/lowercased
// label against the full (unfiltered) catalog — the same categories-based
// classification the dropdown path already uses. This never prompts the user;
// it only recognizes a known trading provider id typed into Custom mode
// (e.g. "hyperliquid"), exactly like picking it from a trading dropdown would.
const customProviderCatalogMatch = isCustomProvider
  ? (catalogQuery.data?.providers ?? []).find((p) => p.id === effectiveProvider)
  : undefined;
const apiCapability: 'trading' | undefined =
  providerCapabilityGroup((isCustomProvider ? customProviderCatalogMatch : selectedProvider)?.categories ?? []) === 'trading'
    ? 'trading'
    : undefined;
```

Notes:
- `effectiveProvider` is already `label.toLowerCase().trim()` in custom mode (pre-existing,
  unchanged) and catalog ids are already lowercase, so this is a direct string-equality
  lookup — no new normalization.
- This must be placed after `effectiveProvider` is computed (it already is, further down
  in the component) — keep the declaration order: `isCustomProvider` → `effectiveProvider`
  → this block. Verify placement when editing since the existing `apiCapability` block
  currently sits between the `canGenerateWallet` effect and the `mutation` definition;
  keep it in the same position, just swap the body.
- Does not change `isOAuthProvider` or `selectedProvider` — both remain driven solely by
  `effectiveProviderChoice`/dropdown sentinel, confirmed structurally impossible to
  misclassify custom-mode as OAuth.

## Step 3 — Update `provider-setup-form.test.tsx`

File: `apps/web/src/features/setup/provider-setup-form.test.tsx`

### 3a. Flip the "general setup by default" rendering test

Current (around the `ProviderSetupForm rendering` describe block):

```tsx
it('renders known provider options plus custom mode for general setup by default', () => {
  const html = renderForm();
  for (const provider of ['hyperliquid', 'bybit', 'jupiter', '1inch']) {
    expect(html).toContain(`value="${provider}"`);
  }
  expect(html).toContain('value="__custom__"');
});
```

Replace with:

```tsx
it('hides trading provider options for general setup by default, keeping custom mode', () => {
  const html = renderForm();
  for (const provider of ['hyperliquid', 'bybit', 'jupiter', '1inch']) {
    expect(html).not.toContain(`value="${provider}"`);
  }
  expect(html).toContain('value="__custom__"');
});
```

Also update the adjacent test (same describe block) that currently asserts both group
labels are present with no capability:

```tsx
it('renders email providers grouped separately from trading providers', () => {
  const html = renderForm();
  expect(html).toContain(messages['setup.form.group.trading']);
  expect(html).toContain(messages['setup.form.group.email']);
});
```

The `setup.form.group.trading` assertion is no longer valid for the no-capability case
(the Trading optgroup is now hidden) — this test must be re-targeted at
`renderForm('trading')` for the trading-label assertion, and keep the email-grouping
assertion on the default render. Rename and split:

```tsx
it('renders the email provider group for general setup by default', () => {
  const html = renderForm();
  expect(html).toContain(messages['setup.form.group.email']);
  expect(html).not.toContain(messages['setup.form.group.trading']);
});

it('renders the trading provider group when defaultCapability is trading', () => {
  const html = renderForm('trading');
  expect(html).toContain(messages['setup.form.group.trading']);
});
```

### 3b. Confirm (do not change) — these must keep passing unmodified

- `'renders all providers including email providers in trading mode'` (`renderForm('trading')`)
- `'defaults to the first trading provider for trading capability'`
- `'defaults to the first email provider for email capability'`
- `'defaults to the custom entry when the capability group is empty'`
- `'preselects initialProviderId ahead of the capability default'`
- `'ignores an initialProviderId not present in the catalog'`
- `'does not break existing trading call sites without initialProviderId'`

These all pass `'trading'`/`'email'`/`'other'` explicitly and exercise the
default-selection logic, which Step 1/2 do not touch.

### 3c. New test — capability inference for a recognized custom label

The existing test file only renders static markup via `renderToStaticMarkup` and does not
simulate `onChange`/typing or inspect mutation payloads — there's no live-DOM harness here
(no `@testing-library/react`, no event simulation elsewhere in this file). Rather than
bolt on a new rendering paradigm, extract the capability-derivation logic itself into a
pure, directly-testable function so it can be unit tested the same way `canAutoApplyProviderTemplate`
already is — this matches the file's existing convention of exporting pure predicates
for logic that would otherwise need DOM interaction to exercise.

Add to `ProviderSetupForm.tsx` (exported alongside `canAutoApplyProviderTemplate`):

```tsx
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

Then in Step 2, replace the inline `apiCapability` derivation with a call to this function:

```tsx
const apiCapability = deriveApiCapability(isCustomProvider, effectiveProvider, selectedProvider, catalogQuery.data?.providers ?? []);
```

This keeps the component's runtime behavior identical while making the logic unit
testable without a DOM-interaction harness. (`providerCapabilityGroup` is already a
private top-level function in the same module — it does not need to be exported since
`deriveApiCapability` wraps it.)

Add new tests (new describe block), importing `deriveApiCapability` alongside the existing
`canAutoApplyProviderTemplate` import:

```tsx
import { ProviderSetupForm, canAutoApplyProviderTemplate, deriveApiCapability } from './ProviderSetupForm.js';
```

```tsx
describe('ProviderSetupForm — deriveApiCapability (custom-mode trading inference)', () => {
  const catalogProviders = TEST_PROVIDER_CATALOG.providers;

  it('infers trading for a custom label matching a known trading provider id', () => {
    expect(deriveApiCapability(true, 'hyperliquid', undefined, catalogProviders)).toBe('trading');
  });

  it('infers trading for a custom label matching a swap-category provider id', () => {
    expect(deriveApiCapability(true, 'jupiter', undefined, catalogProviders)).toBe('trading');
  });

  it('does not infer trading for a custom label matching a non-trading provider id', () => {
    expect(deriveApiCapability(true, 'gmail', undefined, catalogProviders)).toBeUndefined();
  });

  it('does not infer trading for a custom label with no catalog match', () => {
    expect(deriveApiCapability(true, 'mycustomtool', undefined, catalogProviders)).toBeUndefined();
  });

  it('ignores catalog matching entirely for non-custom selections, using selectedProvider directly', () => {
    expect(deriveApiCapability(false, 'hyperliquid', { categories: ['trading'] }, catalogProviders)).toBe('trading');
    expect(deriveApiCapability(false, 'gmail', { categories: ['messaging'] }, catalogProviders)).toBeUndefined();
  });
});
```

These exercise exactly the scenarios the design calls for: "hyperliquid" (and a
swap-category id) typed into Custom mode infers trading; an unrecognized label
("mycustomtool") does not — proving no false positives.

## Step 4 — Backend verification (no code change expected)

File: `apps/api/src/routes/setup.ts` / `apps/api/src/routes/setup.test.ts` (read-only check)

Confirmed by reading `setup.test.ts`: `VALID_HL_PAYLOAD` (provider: `'hyperliquid'`,
manual secrets) combined with `capability: 'trading'` is already exercised by multiple
existing test cases (e.g. around line 284). This is structurally identical to what the
frontend now sends from Custom mode once `effectiveProvider` resolves to `'hyperliquid'`
and `apiCapability` resolves to `'trading'` — the backend has no notion of "custom mode",
it only sees the resolved strings. No new backend test is required; this step is just
confirming (by running the suite, see Step 5) that this coverage still passes unchanged.

If, when running the suite, this coverage turns out to be thinner than expected (e.g. no
case exactly matching provider+manual-secrets+capability:'trading' for hyperliquid),
add one minimal case to `setup.test.ts` asserting 201 + `resolvedVenueAccountId` set,
reusing `VALID_HL_PAYLOAD` — but this is a fallback, not an expected need.

## Step 5 — Verification

In order:

1. `pnpm --filter <web-package-name> test provider-setup-form.test.tsx` (or the
   repo-root equivalent targeting just this file) — confirm all updated/new tests pass.
2. Run the full `apps/web` test suite to catch any other test referencing the Trading
   optgroup behavior for a non-trading `ProviderSetupForm` render (search first with
   `grep -r "group.trading"` across `apps/web/src` test files to be sure
   `provider-setup-form.test.tsx` is the only place this is asserted for the no-capability
   case; `ConnectionsPage`/`AgentConnectionField` tests, if any exist, should be checked
   for the same assumption).
3. `apps/api` suite: run `setup.test.ts` and `providers.test.ts` to confirm no regression
   (expected: no change, since no backend file is touched).
4. `pnpm lint` (TypeScript typecheck) across the touched packages.
5. `pnpm build` if lint alone doesn't catch type errors in emitted output.

## Risks / open questions

- None blocking. The one judgment call (Step 3c) is converting the inline `apiCapability`
  derivation into an exported pure function (`deriveApiCapability`) so it's unit-testable
  without introducing a new DOM-interaction test harness into a file that currently has
  none. This is a refactor-for-testability, not a behavior change — the inline logic and
  the extracted function are equivalent. If the Implementer prefers to keep the derivation
  fully inline and instead add a lightweight interaction-based test (e.g. introducing
  `@testing-library/react` to this file), that is an acceptable alternative but is a larger
  footprint (new dependency / new test pattern) for no behavioral difference — the plan's
  default is the pure-function extraction.
- Verify no other test file (`ConnectionsPage.test.tsx`, `AgentConnectionField.test.tsx`,
  if they exist) asserts the Trading optgroup is present in a no-`defaultCapability`
  render of `ProviderSetupForm` — grep for `group.trading` across `apps/web/src` before
  finalizing to avoid an unexpected regression outside the planned file.
