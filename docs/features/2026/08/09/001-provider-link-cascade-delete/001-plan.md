# Provider Link Cascade Delete Plan

## Summary

Make wallet-related deletion easy from the Connections page by introducing a single destructive path for a guided trading provider link:

- keep the existing connection-only hard delete
- add a new cascade delete path that removes the connection, linked venue account row, and linked credential in one transaction
- surface that choice from the Connections UI so users do not need to visit hidden Credentials and Venue Accounts pages

This plan is about deleting platform records and stored secrets. It does **not** delete an on-chain wallet from the underlying network. For platform-generated wallets, deleting the credential destroys the stored private key/API secret, which is the practical irreversible action.

## Problem

Today, one guided trading setup can create three linked resources:

1. `connections` row
2. `venue_accounts` row
3. `user_credentials` row

Deletion is fragmented:

| Page | What it deletes | Blocked by |
|---|---|---|
| `/connections` | `connections` row | active agent grants, bots |
| `/credentials` | `user_credentials` row | linked venue accounts |
| `/venue-accounts` | `venue_accounts` row | referencing bots |

That forces users to understand backend dependency order and to discover pages that are currently hidden from regular navigation.

It also leaves an easy orphan path:

```text
delete connection only
  -> venue account survives
  -> credential survives
  -> user believes wallet is gone
  -> stored secret may still exist
```

## Goals

- Let users fully delete a guided trading provider link from one place
- Preserve the current connection-only delete path for users who want to disconnect without destroying linked wallet data
- Fail closed when agents or bots still depend on the link
- Return one structured API response that tells the UI exactly what blocks deletion
- Keep Credentials and Venue Accounts pages as advanced/debug surfaces rather than the primary workflow

## Non-goals

- Delete or burn funds from an external or on-chain wallet
- Remove the existing `/connections/:id?permanent=true` path
- Redesign the hidden advanced pages beyond light explanatory copy
- Solve agent/bot cleanup beyond reporting blockers and requiring the existing removal flow

## Current State

### Backend

- Guided setup (`POST /setup/provider-link`) creates credential, connection, and optional venue account in one transaction.
- Connection hard delete (`DELETE /connections/:id?permanent=true`) deletes only the connection and revoked `agent_connections` rows.
- Credential delete is blocked while any `venue_accounts.credentialId` still references it.
- Venue account delete is blocked while any bot references it.

### Frontend

- Connections is the only user-facing page that feels like the canonical management surface.
- Credentials and Venue Accounts pages exist but are hidden from regular navigation.
- The Connections list payload includes `credentialId` but does **not** include `resolvedVenueAccountId`, so the page cannot presently tell whether a connection has a linked trading wallet record.

## Proposed Design

### 1. Add a cascade-delete endpoint for guided provider links

Add a new endpoint that mirrors the setup abstraction:

```text
DELETE /setup/provider-link/:connectionId
```

This endpoint is for full teardown of a guided provider link.

Implementation ownership for v1:

- define the HTTP route in `apps/api/src/routes/setup.ts`
- extract shared resolution and teardown logic into `apps/api/src/provider-links.ts`

#### Eligibility rule for v1

For implementation purposes, a connection is treated as a guided trading link iff:

```ts
connections.resolvedVenueAccountId !== null
```

That is the concrete server-side and UI-side eligibility rule for v1.

Implications:

- the cascade-delete endpoint should reject connections that do not satisfy this rule
- the Connections page should only surface the cascade-delete action for connections that satisfy this rule
- the existing connection-only hard delete remains the path for all other connections

#### Required invariants

- The connection must belong to the authenticated user.
- The connection must satisfy the v1 guided-trading-link eligibility rule (`resolvedVenueAccountId !== null`).
- If the connection references a venue account or credential, those linked rows must also belong to the same user.
- No partial deletion on failure.

#### Transaction order

Inside one transaction:

1. Load the connection and linked resources.
2. Block if any active `agent_connections` rows still reference the connection.
3. Block if any bots reference the connection.
4. If there is a linked venue account, block if any bots reference that venue account.
5. Delete revoked `agent_connections` rows for that connection.
6. Delete the connection.
7. If there is a linked venue account, delete the venue account.
8. If there is a linked credential, delete the credential.

Notes:

- Step 6 must happen before credential deletion because the connection itself references `credentialId`.
- If the venue account references the credential, the venue account must be deleted before the credential.
- Because v1 eligibility requires `resolvedVenueAccountId !== null`, the normal success path always includes a linked venue account.

#### Response shape

Return `200` with a deletion summary body.

Reason:

- this endpoint tears down multiple resources, not just one row
- the existing credential and venue-account delete flows already return a body
- the UI can use the response for precise success copy and future audit/debug hooks

On success:

```json
{
  "status": "deleted",
  "connectionId": "...",
  "deleted": {
    "connection": true,
    "venueAccount": true,
    "credential": true
  }
}
```

On blocked delete:

```json
{
  "error": "provider_link.in_use",
  "params": {
    "connectionId": "...",
    "blockingAgentIds": ["..."],
    "blockingConnectionBotIds": ["..."],
    "blockingVenueAccountBotIds": ["..."],
    "hint": "Remove agent grants and bots before deleting the linked wallet data."
  }
}
```

Use a dedicated error code instead of overloading `connection.in_use`, because the cascade path can fail at more than one layer.

### 2. Add a shared resolver/helper for linked-resource teardown

Create a small shared helper used by the new route to resolve:

- connection row
- linked credential row, if any
- linked venue account row, if any
- blocker counts/IDs

This keeps deletion rules centralized and avoids reimplementing cross-table ownership checks inside the route handler.

Concrete location:

- route in `apps/api/src/routes/setup.ts`
- shared helper module in `apps/api/src/provider-links.ts`

### 3. Enrich the connection payload so the UI can drive the new action cleanly

The current `Connection` payload lacks `resolvedVenueAccountId`, which means the Connections page cannot tell whether a connection has linked wallet state.

Extend `selectConnectionView()` and the web API type so Connections can receive at least:

```ts
resolvedVenueAccountId: string | null;
```

Decision for v1:

- add `resolvedVenueAccountId`
- do **not** add a derived `deletionScope` field yet

Reason:

- `resolvedVenueAccountId` is the raw linkage the UI currently lacks
- it is enough for v1 to identify guided trading links and to decide whether to surface the cascade-delete action
- keeping the payload primitive avoids encoding extra server-side view semantics for a single consumer before they are proven necessary

### 4. Add a second destructive action to the Connections page

Expose two destructive choices from each eligible connection card:

1. `Delete connection only`
2. `Delete connection + linked wallet data`

The second action should only appear for guided trading links. For v1, the UI should use `resolvedVenueAccountId !== null` as the eligibility signal, matching the backend rule exactly.

#### UX recommendation

Use a confirmation modal rather than a brand-new dropdown primitive for v1.

Reason:

- the page already uses simple destructive confirmation patterns
- a modal can explain irreversible secret deletion clearly
- it avoids adding a general-purpose action menu just for this workflow

Suggested modal copy:

```text
Delete connection only
Removes this connection from OpenAIdom but keeps any linked wallet record and credential.

Delete connection + linked wallet data
Also deletes the linked wallet record and stored credential/private key from OpenAIdom.
This cannot be undone.
```

For platform-generated wallets, add stronger warning text about destroying the stored private key/API secret.

#### Blocked-delete UX

When the API returns blockers, the UI should:

- show inline blocker details
- deep-link to the blocking bot and agent surfaces when the response includes those IDs and the link can be added with normal page-level effort

Do not build a complex cross-surface navigation framework just for this workflow. If richer linking starts to multiply scope materially, keep v1 to inline blocker details plus direct links where trivial.

### 5. Reposition hidden advanced pages

Do not remove the Credentials and Venue Accounts pages.

Instead:

- keep them available as advanced/debug tools
- add a short note near destructive controls:
  - Credentials page: guided trading links are best removed from Connections
  - Venue Accounts page: guided trading links are best removed from Connections

This reduces future confusion when an operator reaches those pages directly.

## Scope Decisions

### Recommended functional scope for v1

Support cascade delete for all guided trading links, not only platform-generated wallets.

For v1, “guided trading link” is defined concretely as a connection whose `resolvedVenueAccountId` is non-null.

Reason:

- the schema cleanly models the guided link bundle, but does not cleanly persist generated-vs-manual provenance
- scoping to guided trading links avoids fragile heuristics
- precise UI copy can clarify that OpenAIdom deletes stored linked wallet data and secrets, not the external wallet itself

### Recommended copy for v1

Avoid copy that claims the actual wallet is deleted from the blockchain or venue.

Prefer:

- `Delete connection + linked wallet data`
- `Delete linked credential/private key from OpenAIdom`

This remains correct for both generated and manually supplied trading credentials.

## Edge Cases

| Scenario | Expected behaviour |
|---|---|
| OAuth/non-trading connection with no credential and no venue account | Cascade action is hidden; only connection-only delete is offered |
| Primitive/manual connection created outside guided trading setup | Cascade action is hidden in v1; existing connection-only delete remains available |
| Connection has `resolvedVenueAccountId = null` for any reason | Cascade endpoint rejects it; connection-only delete remains available |
| Guided trading connection with venue account but null credential | Cascade endpoint deletes connection + venue account if safe |
| Active agent grants exist | API returns 409 with blocking agent IDs; no partial deletion |
| Bots reference connection | API returns 409 with `blockingConnectionBotIds`; no partial deletion |
| Bots reference linked venue account | API returns 409 with `blockingVenueAccountBotIds`; no partial deletion |
| Concurrent new bot/grant appears after pre-check | Transaction fails and is translated to the same structured 409 where possible |
| User deletes connection only first | Existing behavior remains; linked wallet data survives intentionally |

## Files Expected To Change

| File | Change |
|---|---|
| `apps/api/src/routes/setup.ts` | Add `DELETE /setup/provider-link/:connectionId` route |
| `apps/api/src/provider-links.ts` | Add shared guided-link resolver and teardown helper |
| `apps/api/src/routes/connections.ts` | Extend connection view payload with linked-resource fields |
| `apps/web/src/lib/api-client.ts` | Extend `Connection` type and add `deleteProviderLink()` client method |
| `apps/web/src/features/connections/ConnectionsPage.tsx` | Add modal/action choice and new mutation for cascade delete |
| `apps/web/src/app/i18n/locales/en.ts` | Add copy for new modal, action labels, and blocked-delete errors |
| `apps/web/src/app/i18n/locales/ar.ts` | Same as above |
| `apps/web/src/app/i18n/locales/hi.ts` | Same as above |
| `apps/web/src/features/credentials/CredentialsPage.tsx` | Add note pointing users back to Connections for guided links |
| `apps/web/src/features/venue-accounts/VenueAccountsPage.tsx` | Add note pointing users back to Connections for guided links |
| `apps/api/src/routes/connections.test.ts` | Add payload tests if connection view is expanded |
| `apps/api/src/routes/setup.test.ts` | Add cascade delete route tests |
| `apps/web/src/features/connections/ConnectionsPage.test.tsx` | Add UI behavior tests for the second destructive action |

## Implementation Order

1. [DONE] Add shared backend resolver/helper in `apps/api/src/provider-links.ts`.
2. [DONE] Add `DELETE /setup/provider-link/:connectionId` route in `apps/api/src/routes/setup.ts` with transactional delete ordering.
3. [DONE] Extend connection read payload with linked-resource signals needed by the UI.
4. [DONE] Extend the web API client types and methods.
5. [DONE] Add the new destructive choice and confirmation modal in Connections.
6. [DONE] Add explanatory notes to Credentials and Venue Accounts pages.
7. [DONE] Add regression tests.

## Test Plan

### API

1. Guided trading connection (`resolvedVenueAccountId !== null`) with no blockers, linked credential, linked venue account -> cascade delete returns 200 and all three rows are gone.
2. Connection with active agent grants -> returns 409 and nothing is deleted.
3. Connection with connection-linked bots -> returns 409 and nothing is deleted.
4. Connection with venue-account-linked bots -> returns 409 and nothing is deleted.
5. Connection with `resolvedVenueAccountId = null` -> cascade endpoint rejects it and connection-only hard delete still works.
6. Connection with venue account but no credential -> connection + venue account deleted.
7. Connection-only hard delete remains unchanged.
8. Concurrent FK failure path is translated to structured conflict response.

### Frontend

1. Eligible trading connection shows both delete choices.
2. Ineligible connection shows only connection-only delete.
3. Modal copy reflects irreversible credential/private-key deletion.
4. 409 responses surface blocker details to the user and deep-link to blocking bot/agent pages where IDs are available.
5. Hidden advanced pages display the guidance note.

## Rollout Notes

- No schema migration is required for the core cascade endpoint.
- If we later decide to distinguish platform-generated from manual credentials precisely in the UI, that likely requires persisting provenance metadata from setup.
- Keep the existing hidden advanced pages available for recovery/debug even after the Connections flow becomes the main path.

## Open Questions

None at this time.

## Outstanding Issues

### [1] Add shared backend resolver/helper in provider-links.ts
- **[LOW]** Double query of `agent_connections` in `deleteProviderLink` — `resolveProviderLinkDependents` queries it once, then `resolveBlockingAgentLabels` queries again. Consider folding label resolution into the dependents resolver.

### [5] Add new destructive choice and confirmation modal in Connections
- **[MEDIUM]** Uses browser-native `confirm()` instead of a rich confirmation modal as recommended by the plan. The existing delete action also uses `confirm()`, so this is internally consistent. Not blocking for v1.
- **[MEDIUM]** Blocker error message displays agent/bot IDs as comma-separated text without deep links. The plan says to add deep links where trivial; keep v1 simple if scope multiplies.

### [7] Add regression tests
- **[LOW]** API connection list test uses `resolvedVenueAccountId` in the fixture but has no dedicated assertion verifying it appears in the GET `/connections` response.