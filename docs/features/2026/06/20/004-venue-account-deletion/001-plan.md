# Venue Account Deletion & Credential Unblock Plan

## Problem

Users cannot delete credentials from the UI when venue accounts still reference them. The `venue_accounts.credentialId` FK has `ON DELETE RESTRICT`, so PostgreSQL blocks credential deletion until all referencing venue accounts are removed. But there is no way to delete a venue account — the API has no `DELETE /venue-accounts/:id` endpoint, and the UI has no delete button.

Additionally, when the API returns 409 `credential_in_use`, the frontend tries to display a localized error using the message ID `credentials.deleteBlocked` — but that message key is missing from all locale files. The user sees either a raw untranslated string or nothing, making the error invisible.

The prior plan `docs/features/2026/06/20/003-agent-deletion-cleanup/001-plan.md` solved for the agent-deletion path (nulling `venue_accounts.credentialId` when an agent using that account is deleted). But venue accounts created directly by users (via `quick-setup.prod.sh`, `/venue-accounts` UI, or the `/setup` API) have no cleanup path at all.

### Root cause chain

```
User creates credential + venue account (via quick-setup or UI)
  → venue_accounts.credentialId = <credential_id>
  → User later wants to delete credential
  → DELETE /credentials/:id returns 409 (venue_accounts still reference it)
  → Frontend tries to show credentials.deleteBlocked → message not found → invisible error
  → User sees "noop"
```

## What changes

### 1. API: Add `DELETE /venue-accounts/:id` endpoint

**File:** `apps/api/src/routes/accounts.ts`

Add a delete handler after the existing `GET /venue-accounts` list route:

```ts
// DELETE /venue-accounts/:id — delete a venue account
app.delete<{ Params: { id: string } }>('/venue-accounts/:id', async (request, reply) => {
  const { id } = request.params;

  const [account] = await db
    .select({ id: venueAccounts.id, label: venueAccounts.label, venue: venueAccounts.venue, credentialId: venueAccounts.credentialId })
    .from(venueAccounts)
    .where(and(eq(venueAccounts.id, id), eq(venueAccounts.userId, request.userId)));

  if (!account) {
    return reply.status(404).send({ error: 'not_found' });
  }

  // Block deletion if any bots reference this venue account.
  // bots.venueAccountId has ON DELETE RESTRICT — must check before attempting delete.
  const blockingBots = await db
    .select({ id: bots.id, label: bots.config })
    .from(bots)
    .where(eq(bots.venueAccountId, id));

  if (blockingBots.length > 0) {
    return reply.status(409).send({
      error: 'venue_account_in_use',
      venueAccountId: id,
      blockingBotIds: blockingBots.map((b) => b.id),
    });
  }

  await db.delete(venueAccounts).where(eq(venueAccounts.id, id));

  return reply.send({ status: 'deleted', venueAccountId: id });
});
```

Imports needed (add at top):
```ts
import { bots } from '@herobids/db';
```

### 2. API: Expand `findCredentialDependents` to include `agent_credentials`

**File:** `apps/api/src/credential-dependents.ts`

The current `findCredentialDependents` checks `connections` and `venue_accounts` but not `agent_credentials`. The `agent_credentials.credentialId` FK also has `ON DELETE RESTRICT`. If an agent references a credential via `agent_credentials`, the DELETE will fail with a PG FK violation (code `23503`). The catch block in the credential delete handler re-queries `findCredentialDependents` — which won't find the `agent_credentials` row — and returns 409 with empty blocking arrays.

Add a check for `agent_credentials`:

```ts
// Find agent_credentials that reference this credential
const linkedAgentCredentials = await db
  .select({ id: agentCredentials.id, agentId: agentCredentials.agentId, label: agentCredentials.label })
  .from(agentCredentials)
  .where(eq(agentCredentials.credentialId, credentialId));

// Return in the dependents result
```

Also add the new field to the `CredentialDependents` interface and to the 409 response body.

### 3. Frontend: Add locale messages for `credentials.deleteBlocked`

**Files:**
- `apps/web/src/app/i18n/locales/en.ts`
- `apps/web/src/app/i18n/locales/ar.ts`
- `apps/web/src/app/i18n/locales/hi.ts`

Add after `credentials.deleteConfirm`:

```
'credentials.deleteBlocked': 'Cannot delete this credential. It is still in use by {venueAccounts, plural, =0 {} one {# venue account} other {# venue accounts}}{bots, plural, =0 {} one {, # bot} other {, # bots}}{connections, plural, =0 {} one {, # connection} other {, # connections}}. Remove the listed items first, then try again.',
```

Or a simpler version without ICU plural rules (match existing patterns in the locale file):

```
'credentials.deleteBlocked': 'Cannot delete credential. Still referenced by: venue accounts: {venueAccounts}; bots: {bots}; connections: {connections}. Remove these first.',
```

### 4. Frontend: Add delete button to `VenueAccountsPage`

**File:** `apps/web/src/features/venue-accounts/VenueAccountsPage.tsx`

Add a `deleteMutation` and a delete button per venue account card:

```tsx
const deleteMutation = useMutation({
  mutationFn: (id: string) => venueAccountsApi.delete(id),
  onSuccess: () => {
    setDeleteError(null);
    void qc.invalidateQueries({ queryKey: ['venue-accounts'] });
  },
  onError: (error: ApiError) => {
    if (error.code === 'venue_account_in_use') {
      setDeleteError(
        `Cannot delete venue account — still referenced by bots: ${(error.params?.blockingBotIds as string[])?.join(', ') ?? 'none'}`
      );
    }
  },
});
```

Add a danger button per card (mirror the pattern in `CredentialsPage.tsx`):

```tsx
<Button
  variant="danger"
  size="sm"
  onClick={() => {
    if (confirm(`Delete venue account "${va.label}"?`)) {
      deleteMutation.mutate(va.id);
    }
  }}
  disabled={deleteMutation.isPending}
>
  Delete
</Button>
```

### 5. Frontend: Add `delete` method to `venueAccounts` API client

**File:** `apps/web/src/lib/api-client.ts`

Add to the `venueAccounts` object:

```ts
delete: (id: string) => request<void>(`/venue-accounts/${id}`, { method: 'DELETE' }),
```

### 6. Frontend: Add catch-all error handler for credential deletion

**File:** `apps/web/src/features/credentials/CredentialsPage.tsx`

The current `onError` only handles `credential_in_use`. All other errors (404, 500, network) are silently swallowed. Add a fallback:

```tsx
onError: (error: ApiError) => {
  if (error.code === 'credential_in_use') {
    setDeleteError(intl.formatMessage({ id: 'credentials.deleteBlocked' }, {
      venueAccounts: (error.params?.blockingVenueAccountIds as string[])?.join(', ') ?? '',
      bots: (error.params?.blockingBotIds as string[])?.join(', ') ?? '',
      connections: (error.params?.blockingConnectionIds as string[])?.join(', ') ?? '',
    }));
  } else {
    // Catch-all: surface any unexpected error to the user
    setDeleteError(error.message || 'Failed to delete credential. Please try again.');
  }
},
```

## Order of operations

1. Add locale messages (step 3) — safe, no API changes
2. Add `venueAccounts.delete` API client method (step 5)
3. Add `DELETE /venue-accounts/:id` endpoint (step 1)
4. Add delete button to VenueAccountsPage (step 4)
5. Expand `findCredentialDependents` for `agent_credentials` (step 2)
6. Add catch-all error handler (step 6)

Steps 1-4 unblock the user's scenario. Steps 2 and 6 are hardening.

## Edge cases

| Scenario | Behaviour |
|---|---|
| Venue account has running bots | API returns 409 `venue_account_in_use` with `blockingBotIds`. User must stop/delete bots first. |
| Venue account has stopped bots (status=`stopped` or `crashed`) | Same — the FK is `ON DELETE RESTRICT` regardless of bot status. User must delete bots first. |
| Venue account has no bots | Deletion succeeds. Credential is now unblocked (assuming no other venue accounts reference it). |
| Venue account is referenced by `trading_bindings.sourceVenueAccountId` | No FK constraint — the `sourceVenueAccountId` is a plain text field. Deletion succeeds. The `sourceVenueAccountId` value in `trading_bindings` becomes a dangling reference (acceptable — it's trace-only). |
| Venue account was created by an agent | Same path as user-created. The agent deletion cleanup plan nulls `credentialId` during agent deletion, but this plan gives users a direct path to delete the venue account itself. |
| Multiple venue accounts reference the same credential | Delete one venue account → credential still blocked by the others. Delete all → credential becomes deletable. |
| Admin deleting another user's venue account | The `eq(venueAccounts.userId, request.userId)` guard prevents this. Only the owner can delete. |

## What this does NOT change

- `connections` deletion — already works (soft-delete to `revoked`)
- `user_credentials` deletion — already works, blocked only by dependents
- Agent deletion cleanup — untouched
- `bots` table — no schema changes needed (already has `ON DELETE RESTRICT`, correctly blocks venue account deletion while bots exist)
- `trading_bindings` — no changes (no FK to venue_accounts, just a trace field)

## Files touched

| File | Change |
|---|---|
| `apps/api/src/routes/accounts.ts` | Add `DELETE /venue-accounts/:id` handler; import `bots` |
| `apps/api/src/credential-dependents.ts` | Add `agent_credentials` check to `findCredentialDependents` |
| `apps/web/src/lib/api-client.ts` | Add `venueAccounts.delete()` method |
| `apps/web/src/features/venue-accounts/VenueAccountsPage.tsx` | Add delete button and delete mutation |
| `apps/web/src/features/credentials/CredentialsPage.tsx` | Add catch-all error handler in `deleteMutation.onError` |
| `apps/web/src/app/i18n/locales/en.ts` | Add `credentials.deleteBlocked` message |
| `apps/web/src/app/i18n/locales/ar.ts` | Add `credentials.deleteBlocked` message (Arabic) |
| `apps/web/src/app/i18n/locales/hi.ts` | Add `credentials.deleteBlocked` message (Hindi) |

## Test plan

1. Create credential + venue account → verify venue account appears in `/venue-accounts` with delete button
2. Delete venue account with no bots → verify 200, credential now deletable
3. Create bot on venue account → try to delete venue account → verify 409 `venue_account_in_use`
4. Delete bot → delete venue account → verify 200
5. Delete credential after removing all venue accounts → verify 200
6. Delete credential still referenced by venue account → verify 409 with clear localized message
7. Delete credential still referenced by agent_credentials → verify 409 with blocking info
8. Delete credential with network error → verify error banner shows fallback message (not silent)
