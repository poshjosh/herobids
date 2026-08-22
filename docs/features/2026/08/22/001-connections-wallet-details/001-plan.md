# Plan: Connections Page Wallet and Account Details

**Feature:** 000-connections-wallet-details
**Date:** 2026-08-11
**Status:** Complete

## Summary

The product currently tells users to find funding addresses under Sidebar -> Connections, but the Connections page does not expose any persistent wallet detail after setup completes. The wallet address is only shown transiently in the wallet-created step, so users lose the canonical funding reference as soon as they dismiss that modal.

Phase 1 keeps the change small: make wallet-backed trading connections show a persistent funding address on the connection card, add a copy action, and include concise credential metadata on the same card when a credential is linked. Broader connection identity improvements stay out of scope for this phase.

## Goals

1. Ensure users can always recover the public funding address for a wallet-backed trading connection after setup.
2. Keep the funding address on the Connections card where users are already directed.
3. Surface applicable credential metadata on the same card without exposing secrets.

## Non-Goals

1. Do not expose raw credential secrets, decrypted values, private keys, API keys, refresh tokens, or similar protected material.
2. Do not make the Credentials page the primary source of funding wallet information.
3. Do not add credential sub-panels under each connection.
4. Do not redesign the venue-accounts page as part of this change.
5. Do not normalize every connection type into a richer identity card in this phase.
6. Do not expand this work into multi-network funding guidance unless the required public metadata is explicitly persisted.

## Current State

### User-facing mismatch

- The public funding docs tell users to look in Connections for the address.
- The standalone setup success flow also implies the user can rely on Connections after setup.
- The Connections page currently renders only label, provider, status, and action buttons.

### Existing data model support

- A connection already stores `resolvedVenueAccountId`.
- The backing venue account already stores `venueAccountRef`, which is explicitly intended for wallet addresses or equivalent provider references.
- Trading setup already derives and persists a public venue account reference for supported flows:
  - generated wallets use the generated wallet address
  - Hyperliquid manual setup uses `walletAddress`
  - Jupiter manual setup derives the public Solana address from the private key
- The connection schema also has `providerRef` and `profile`, but phase 1 does not depend on them.

### Constraint to preserve

- Credentials reads are metadata-only and intentionally do not expose secret payloads. This should remain true.

## Phase 1 Requirements

### Connection card behavior

For each connection card, phase 1 should show the following when available:

1. **Existing header information**
   - Keep the current label, provider display name, status, and action buttons.

2. **Funding address**
   - Show a `Funding address` row when the connection resolves to a venue account with a public `venueAccountRef`.
   - Add a copy action for the full value.

3. **Credential summary**
   - Show a `Credential` row when the connection is linked to a credential.
   - Render the credential label.
   - No secrets, no decrypted fields, no raw credential payloads.

4. **Usage summary**
   - Keep existing assigned-agent and bot-reference behavior unchanged.

### Provider behavior in phase 1

1. **Wallet-backed trading connections**
   - Show the funding address from the resolved venue account reference.

2. **Connections without a public funding address**
   - Omit the funding-address row.
   - Still show the credential row if a credential is linked.

3. **OAuth/public-profile connection identity**
   - No additional phase 1 work beyond the current header behavior.

## Proposed API Shape For Phase 1

Extend `GET /connections` and `GET /connections/:id` with only the fields required for persistent funding-address visibility and credential summary rendering.

Proposed additive response fields:

```ts
interface ConnectionDetailSummary {
  credential: {
    id: string;
    label: string;
    provider: string;
  } | null;
  tradingAccount: {
    venueAccountId: string;
    label: string;
    venue: string;
    publicRef: string | null;
  } | null;
}
```

Notes:

1. `publicRef` is the normalized UI field for wallet address or other non-secret venue account reference.
2. `credential.label` is safe to expose because the credentials list already returns label metadata.
3. Phase 1 intentionally does not widen the main connections route to generic provider identity fields beyond what the page already uses.
4. This should be additive to preserve existing clients.

## UX Proposal

### Card layout

Each connection card keeps its existing header and actions, then adds a compact details block beneath it.

Suggested rows:

1. `Funding address`: wallet address or venue account reference when the resolved trading account has one.
2. `Credential`: credential label when linked.

### Display behavior

1. Long addresses are visually truncated but remain copyable.
2. The copy action copies the full value.
3. Empty rows are omitted entirely.
4. The card should not render empty placeholders for connections that do not have these details.

### Copy affordance

1. Add a small secondary button or inline copy action next to the funding address.
2. Reuse the existing clipboard pattern from the wallet-created step where practical.
3. Prefer a short-lived copied state local to the card.

## Phase 1 Implementation Plan

### Step 1: Expand the connection view query minimally — DONE

Update the connections route to join only the data phase 1 needs.

Changes:

1. Extend `selectConnectionView()` in `apps/api/src/routes/connections.ts` to include:
   - credential metadata needed for summary rendering
   - venue-account metadata needed for trading account display
2. Join `user_credentials` for safe metadata only.
3. Join `venue_accounts` via `resolvedVenueAccountId`.
4. Keep the response secret-free.

Implementation notes:

1. The route should continue to be user-scoped.
2. The detail summary should be assembled server-side so the UI only does simple conditional rendering.
3. Preserve existing fields and counts unchanged.

### Step 2: Align web API types — DONE

Update `apps/web/src/lib/api-client.ts` so the `Connection` interface matches the expanded response.

Changes:

1. Add nested `credential` and `tradingAccount` summary types.
2. Keep the rest of the current `Connection` shape intact.
3. Keep fields optional only where the backend genuinely treats them as optional.

### Step 3: Render funding and credential rows on the Connections page — DONE

Update `apps/web/src/features/connections/ConnectionsPage.tsx`.

Changes:

1. Add a details section below the existing header row.
2. Render normalized rows only when data exists.
3. Add copy support for `tradingAccount.publicRef`.
4. Keep delete and revoke actions where they are.
5. Avoid introducing navigation to the Credentials page as part of the new UX.
6. Do not expand phase 1 into generic account-identity rendering.

## Testing Plan

### API tests

Update or add tests in `apps/api/src/routes/connections.test.ts` to verify:

1. `GET /connections` includes credential summary metadata when a credential is linked.
2. `GET /connections` includes trading-account summary metadata when `resolvedVenueAccountId` is set.
3. No secrets are returned in either list or detail responses.
4. Legacy fields such as counts and status are unchanged.

### Web tests

Update or add tests in `apps/web/src/features/connections/ConnectionsPage.test.tsx` to verify:

1. Funding address row is shown when `tradingAccount.publicRef` exists.
2. Funding address row is omitted when it does not exist.
3. Credential row is shown when credential metadata exists.
4. Existing revoke/delete visibility rules still hold.

### Validation

Run at minimum:

1. Targeted connections page tests.
2. Targeted connections route tests.
3. `pnpm lint` before completion.

## Risks and Mitigations

### Risk: leaking protected credential material

Mitigation:

1. Join only safe credential metadata already exposed elsewhere.
2. Do not read or decrypt encrypted credential blobs.
3. Keep the response contract limited to id, label, and provider for credentials.

### Risk: UI overfitting to current single-network assumptions

Mitigation:

1. Treat the displayed funding value as a generic `publicRef`, not as a hard-coded chain-specific wallet field.
2. Avoid showing network or bridge instructions unless that metadata is explicitly persisted and trustworthy.

### Risk: phase 1 grows into a generic connection-details project

Mitigation:

1. Limit new rows to `Funding address` and `Credential`.
2. Defer profile, providerRef, timestamps, and broader account-identity rendering.

## Rollout Notes

1. This change should be backward-compatible because the API addition is additive.
2. After implementation, re-check the funding-wallet documentation to confirm the user path is now accurate without extra qualification.
3. If phase 1 lands cleanly, broader connection identity work can be planned separately.

## Deferred To Later Phase

1. Provider-specific public account identifiers beyond funding addresses.
2. Consistent use of `providerRef` and `profile` in the main connections route.
3. Timestamps or expandable advanced-detail states on the card.
4. Additional funding metadata such as network, bridge hints, or custody annotations.


## Outstanding Issues

### Step 1: API query expansion
- MEDIUM: 5 correlated subqueries (2 for credentials, 3 for venue accounts) where lateral joins or combined subqueries could reduce to 2. PK-index access makes this negligible for typical list sizes (< 50 connections per user). Consider refactoring if latency tightens.
- LOW: Response uses flat fields (`credentialLabel`, `venueAccountRef`, etc.) instead of the plan's proposed nested `ConnectionDetailSummary` shape. Flat approach is simpler and avoids null-object ambiguity. Intentional simplification.
- LOW: `profile` field added to `selectConnectionView()` despite plan saying Phase 1 does not depend on it. Harmless and already tested.

### Step 2: Web types alignment
- No outstanding issues.

### Step 3: UI rendering
- MEDIUM: Copy button has no `aria-label`. Screen readers will announce the changing text content but lack context about what is being copied. Consider adding `aria-label` with funding address context.
- MEDIUM: No test for copy button click interaction (clipboard call). Tests use `renderToStaticMarkup` which doesn't support events. Would require `@testing-library/react` with `userEvent` for interactive testing.
- MEDIUM: No `.catch()` on `navigator.clipboard.writeText()`. If clipboard API is unavailable, the promise rejects silently. Consistent with existing `WalletCreatedStep` pattern but still a gap.
- LOW: Copy button uses native `<button>` instead of the project's `<Button>` component for size/styling reasons.
- LOW: `copiedId` state is shared across all cards — only one card shows "Copied" at a time. Acceptable UX tradeoff.
