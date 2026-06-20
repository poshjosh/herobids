# Agent Deletion Cleanup Plan

## Problem

When an agent is deleted, the deletion handler (`agents.ts`) only cleans up agent-scoped tables. The FK cascade chain leaves **orphaned rows** in `trading_bindings`, `venue_accounts`, and `bots` (agent-created) that block subsequent credential deletion via `DELETE /credentials/:id` → 409 `credential_in_use`. The frontend also swallows the 409 error silently.

## What changes

### 1. API: Delete agent-created bots during agent deletion

**File:** `apps/api/src/routes/agents.ts`

Add to the existing deletion block (after the explicit deletes, before deleting `agents`):

```ts
// Delete agent-created bots (creatorType='agent', creatorId = agentId)
// User-created bots (creatorType='user') and system bots are untouched.
await db.delete(bots).where(
  and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, id))
);
```

Wait — `bots.venueAccountId` has `ON DELETE RESTRICT` and `bots.tradingBindingId` also has `ON DELETE RESTRICT`. So deleting bots is safe (nothing references bots). But we can't delete `venue_accounts` or `trading_bindings` while bots exist. By deleting agent-created bots **first**, we remove the FK blockers.

### 2. API: Null `venue_accounts.credentialId` for bindings orphaned by grant cascade

**File:** `apps/api/src/routes/agents.ts`

After capability_grants cascade-delete (which happens via FK when `agents` row is deleted), the `trading_bindings` rows that were linked to those grants become orphaned. The associated `venue_accounts` still have `credentialId` set, which blocks credential deletion.

Insert **before** the final `db.delete(agents)`:

```ts
// Find trading_bindings that were linked to this agent's capability_grants
// These become orphaned after capability_grants cascade-delete.
const orphanedBindings = await db
  .select({ id: tradingBindings.id, sourceVenueAccountId: tradingBindings.sourceVenueAccountId })
  .from(tradingBindings)
  .innerJoin(capabilityGrants, eq(capabilityGrants.bindingId, tradingBindings.id))
  .where(eq(capabilityGrants.agentId, id));

// Null credentialId on the venue accounts linked to those bindings.
// The venue account itself is preserved (user-owned), but the credential
// link is severed to unblock credential deletion.
if (orphanedBindings.length > 0) {
  const venueAccountIds = [...new Set(
    orphanedBindings
      .map((b) => b.sourceVenueAccountId)
      .filter((id): id is string => id !== null)
  )];
  if (venueAccountIds.length > 0) {
    await db
      .update(venueAccounts)
      .set({ credentialId: null })
      .where(inArray(venueAccounts.id, venueAccountIds));
  }
}
```

### 3. API: Mark orphaned trading_bindings as revoked

**File:** `apps/api/src/routes/agents.ts`

Same location — after resolving orphaned bindings:

```ts
// Mark orphaned bindings as revoked so they don't appear as usable
if (orphanedBindings.length > 0) {
  const bindingIds = orphanedBindings.map((b) => b.id);
  await db
    .update(tradingBindings)
    .set({ status: 'revoked' })
    .where(inArray(tradingBindings.id, bindingIds));
}
```

### 4. Frontend: Surface 409 credential_in_use errors

**File:** `apps/web/src/features/credentials/CredentialsPage.tsx`

Add an `onError` handler to the `deleteMutation`:

```tsx
const deleteMutation = useMutation({
  mutationFn: (id: string) => credentialsApi.delete(id),
  onSuccess: () => qc.invalidateQueries({ queryKey: ['credentials'] }),
  onError: (error: ApiError) => {
    if (error.code === 'credential_in_use') {
      // Show blocking dependents to the user so they know what to unlink
      alert(intl.formatMessage({ id: 'credentials.deleteBlocked' }, {
        venueAccounts: (error.params?.blockingVenueAccountIds as string[])?.join(', ') ?? '',
        bots: (error.params?.blockingBotIds as string[])?.join(', ') ?? '',
        connections: (error.params?.blockingConnectionIds as string[])?.join(', ') ?? '',
      }));
    }
  },
});
```

Also add the `ApiError` import (already available via `../../lib/api-client.js`).

## Order of operations (critical)

The agent deletion handler must execute in this order:

1. DELETE `agent_outbound_messages` (explicit)
2. DELETE `agent_artifacts` (explicit)
3. DELETE `agent_runtime_sessions` (explicit — must precede agents due to FK)
4. NULL `billing_usage_events.agentId/sessionId` (explicit — ON DELETE NO ACTION)
5. DELETE agent-created `bots` (NEW — must precede step 7)
6. RESOLVE orphaned `trading_bindings` (NEW — query before capability_grants cascade)
7. NULL `venue_accounts.credentialId` on orphaned venue accounts (NEW)
8. MARK orphaned `trading_bindings` as `revoked` (NEW)
9. DELETE `agents` (triggers cascades: agent_skills, agent_credentials, capability_grants, capability_grant_audit)

## Edge cases

| Scenario | Behaviour |
|---|---|
| Multiple agents share a trading_binding | Only null credentialId + revoke binding when the LAST agent using it is deleted. Implementation: step 6 queries bindings JOIN capability_grants WHERE agentId = THIS agent. If other grants for the same binding exist (different agentId), they won't match → binding stays active. |
| Agent-created bots are running | The agent must be `stopped` before deletion (existing check). Bots should also be stopped. If any bot is `running`, the `ON DELETE RESTRICT` on `bots.tradingBindingId` will block the binding revocation — but since we delete bots before touching bindings, this is fine. |
| User-created bots reference same venue_account | User bots (creatorType='user') are untouched. Their `venueAccountId` FK keeps the venue_account alive, which is correct — the user still uses it. The `credentialId` is nulled, but the bot doesn't need the credential (it uses its own resolved credential at startup). |
| No orphaned bindings | Steps 6-8 are no-ops when the agent had no trading capability grants. |
| Agent had `agent_credentials` rows | Cascade-deleted via FK. The `credentialId` FK to `user_credentials` is `ON DELETE RESTRICT` — but agent_credentials rows are gone before credential deletion is attempted, so no blocker. |

## What this does NOT change

- `venue_accounts` rows are never deleted (user-owned)
- `connections` rows are never deleted (user-owned)
- `user_credentials` rows are never deleted by agent deletion (user-owned)
- `trading_bindings` rows are marked `revoked`, not deleted (preserves audit trail)
- `bots` with `creatorType='user'` or `creatorType='system'` are untouched

## Files touched

| File | Change |
|---|---|
| `apps/api/src/routes/agents.ts` | Add steps 5, 6, 7, 8 to deletion handler |
| `apps/web/src/features/credentials/CredentialsPage.tsx` | Add `onError` to deleteMutation |
| `packages/db/src/schema/` | No schema changes needed (credentialId is already nullable, trading_bindings.status already supports 'revoked') |

## Test plan

1. Create agent with trading capability → verify credential is linked
2. Stop agent → delete agent → verify credential is now deletable (200)
3. Create two agents sharing one trading_binding → delete one → verify binding still active, credential still linked
4. Delete second agent → verify binding is revoked, credential deletable
5. Verify user-created bots are untouched after agent deletion
6. Frontend: verify 409 error from credential delete shows blocking info
