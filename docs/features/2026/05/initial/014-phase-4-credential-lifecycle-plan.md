# Phase 4: Credential Lifecycle Hardening Plan

**Goal:** Close the credential lifecycle gaps called out in [TODO.md](../../../../../TODO.md) while staying consistent with the live rollout contract in [010-phase-4-live-rollout-plan.md](010-phase-4-live-rollout-plan.md).

This plan is intentionally narrow. It does not widen Phase 4 into broader rollout work. It hardens one boundary: how credentials are created, linked, reloaded, rotated, and deleted without letting the system drift into a broken or silently unsafe state.

## Current gaps

The current code has two concrete failure modes:

1. [apps/api/src/routes/credentials.ts](../../../../../apps/api/src/routes/credentials.ts) hard-deletes the credential row immediately.
2. [packages/db/src/schema/venue-accounts.ts](../../../../../packages/db/src/schema/venue-accounts.ts) stores `credential_id` as a nullable text column with no foreign key.
3. [apps/worker/src/index.ts](../../../../../apps/worker/src/index.ts) resolves and decrypts the credential once at actor startup, then passes the resolved credential ID into the actor.
4. Running actors therefore keep using the already-loaded credential even if the row is later deleted.
5. On the next startup, the worker fails with a dangling-reference credential resolution error instead of the API preventing that broken state up front.

## Lifecycle contract

An implementing agent should preserve and make explicit this credential lifecycle:

1. **Create**
   - API encrypts the secrets blob and stores only ciphertext plus metadata.
   - Emit `credential.created`.
2. **Link**
   - A venue account may reference a credential only if that credential exists and is compatible with the same user and venue.
   - Invalid links are rejected at write time; they are not discovered later by the worker.
3. **Load / decrypt**
   - The worker decrypts credentials only at actor startup or restart.
   - Emit `credential.decrypted` with success or failure metadata.
4. **Use**
   - Live order submission emits `credential.used`.
5. **Rotate**
   - Rotation updates the encrypted blob and emits `credential.rotated`.
   - Rotation does **not** hot-swap into a running actor.
   - Running dependent instances must restart to reload the new credential.
6. **Delete**
   - Delete is destructive cleanup, not a live revocation primitive.
   - A credential may be deleted only when nothing still references it.
   - The API must reject delete while any venue account still links to the credential.

## Resolved design decisions

These choices should be treated as the implementation contract for this slice.

1. **Keep restart-time reload semantics.**
   - Do not hot-swap secrets into a running actor.
   - The worker contract stays simple: credentials are loaded once at start, then reused until restart.

2. **Delete is fail-closed cleanup, not implicit revocation.**
   - Do not let `DELETE /credentials/:id` silently create dangling references.
   - Do not auto-null `venue_accounts.credential_id`.
   - Do not delete first and let the worker discover the missing row later.

3. **Prefer referential integrity over route-only convention.**
   - Add a foreign key from `venue_accounts.credential_id` to `credentials.id` with `ON DELETE RESTRICT`.
   - Keep the column nullable so uncredentialed or wallet-only account setups still fit the existing model.

4. **Do not add soft-delete or revoke state in this slice.**
   - The immediate bugs are caused by missing dependency enforcement, not by absence of a state machine.
   - If explicit revocation is needed later, add a separate `revoke` flow on top of the same dependency helper.

## Concrete implementation plan

### 1. Add dependency-aware credential linkage validation

**Files to modify**

- [packages/db/src/schema/venue-accounts.ts](../../../../../packages/db/src/schema/venue-accounts.ts)
- `packages/db/drizzle/*` migration output
- [apps/api/src/routes/accounts.ts](../../../../../apps/api/src/routes/accounts.ts)
- `apps/api/src/routes/accounts.test.ts` or adjacent route tests

**Change**

- Add a foreign key from `venue_accounts.credential_id` to `credentials.id` with delete restriction.
- Reject `POST /venue-accounts` when `credentialId` references a missing credential.
- Reject `POST /venue-accounts` when the credential belongs to a different user or venue.

**Why first**

- This closes the write-time gap that currently allows the API to create a broken startup state.
- It establishes the data integrity boundary before mutating delete/rotate behavior.

### 2. Introduce one API-side helper for credential dependents

**Files to add/modify**

- Add a small helper under `apps/api/src/` for credential dependency lookup and lifecycle queue actions
- [apps/api/src/routes/credentials.ts](../../../../../apps/api/src/routes/credentials.ts)
- [apps/api/src/index.ts](../../../../../apps/api/src/index.ts)
- credential route tests

**Change**

- Add one helper that can:
  - list venue accounts linked to a credential
  - list trading instances that use those venue accounts
  - filter running instances that need restart
- Inject the lifecycle queue into `credentialRoutes()` the same way `instanceRoutes()` already receives it, or inject a narrower helper abstraction if that keeps the route cleaner.

**Why**

- Rotate and delete both need the same dependency graph.
- This avoids duplicating fragile query logic across route handlers.

### 3. Make rotation restart dependent running instances

**Files to modify**

- [apps/api/src/routes/credentials.ts](../../../../../apps/api/src/routes/credentials.ts)
- credential route tests

**Change**

- Keep the current encrypted-blob update and `credential.rotated` audit event.
- After a successful rotate, find running instances that depend on the linked venue accounts and enqueue `restart-instance` jobs for them.
- Return the affected instance IDs in the response so the operator sees the blast radius.

**Response shape recommendation**

```json
{
  "status": "rotated",
  "credentialId": "...",
  "restartedTradingInstanceIds": ["..."]
}
```

**Notes**

- Restart only running instances.
- Do not restart stopped instances.
- Do not hot-swap secrets into already-running actors.

### 4. Make delete fail closed instead of creating a dangling-reference state

**Files to modify**

- [apps/api/src/routes/credentials.ts](../../../../../apps/api/src/routes/credentials.ts)
- credential route tests

**Change**

- Before deleting, query linked venue accounts.
- If any linked venue accounts exist, return `409` and include the blocking venue account IDs and any running instance IDs.
- Only perform the physical delete when the credential is truly unreferenced.
- Emit `credential.deleted` only after the delete succeeds.

**Response shape recommendation**

```json
{
  "error": "credential_in_use",
  "credentialId": "...",
  "blockingVenueAccountIds": ["..."],
  "blockingTradingInstanceIds": ["..."]
}
```

**Important semantic choice**

- `DELETE /credentials/:id` should not stop actors implicitly.
- Operators must stop or relink dependents first, then delete.
- That keeps delete deterministic and prevents surprise stop behavior from a destructive endpoint.

### 5. Keep the worker contract explicit and tested

**Files to modify**

- [apps/worker/src/index.ts](../../../../../apps/worker/src/index.ts)
- [apps/worker/src/trading-actor.ts](../../../../../apps/worker/src/trading-actor.ts)
- worker tests if existing assertions need to be updated

**Change**

- Keep the current worker behavior: load and decrypt on startup, emit decrypt audit, use cached credentials until restart.
- Add or update comments/tests so the restart-on-rotate contract is explicit rather than incidental.
- Preserve loud failure when startup encounters a missing or undecryptable credential.

**Why**

- The API-side hardening should solve the dangling-reference bug without making the worker lifecycle more stateful or magical.

### 6. Test coverage and focused validation

**Tests to add or update**

- `POST /venue-accounts` rejects nonexistent credential IDs.
- `POST /venue-accounts` rejects cross-user or cross-venue credential links.
- `POST /credentials/:id/rotate` restarts dependent running instances and leaves stopped instances alone.
- `DELETE /credentials/:id` returns `409` when linked venue accounts exist.
- `DELETE /credentials/:id` succeeds only when no links remain.
- Audit events remain metadata-only and do not leak decrypted secrets.
- Existing worker tests still prove startup fails loudly on missing or undecryptable credentials.

**Focused validation order**

1. Run the credential route tests.
2. Run the affected venue-account route tests.
3. Run the affected worker tests.
4. Run `pnpm test`.
5. Run `pnpm lint`.

## Non-goals for this slice

- No hot credential swap inside running actors.
- No soft-delete or `revoked` credential status column.
- No new operator dashboard work.
- No change to swap-wallet handling.

## Follow-up backlog (only if needed later)

- Add an explicit `revoke credential` flow if operators need one-click immediate stop semantics instead of the current stop-or-relink-then-delete contract.
- Reuse the same dependency helper for any future `PATCH /venue-accounts/:id` route that changes `credentialId`.

## TODO consolidation

The two credential lifecycle bullets currently at the top of [TODO.md](../../../../../TODO.md) should be removed as duplicate free-form backlog once this plan exists.

Replace them with one pointer item:

- [ ] Credential lifecycle hardening is tracked in [docs/features/2026/05/initial/014-phase-4-credential-lifecycle-plan.md](014-phase-4-credential-lifecycle-plan.md).