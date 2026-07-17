# Remove Unused Provider Table and Gmail Readonly Scope

**Status:** proposed
**Created:** 2026-07-17
**Depends on:** [003-gmail-oauth-connection](../003-gmail-oauth-connection/001-plan.md)

## Summary

Remove the unused `providers` database table path before it lands anywhere durable, remove the Gmail `gmail.readonly` OAuth scope, and stop exposing inbox-search functionality until we intentionally reintroduce it.

This change keeps one source of truth for provider taxonomy (`categories`) and replaces the database-only `capabilities` field with derived runtime families in shared code. We should not keep both stored concepts unless they solve materially different problems; today they do not justify separate persisted representations.

## Current Problems

1. `packages/db/drizzle/0042_gmail_provider.sql` seeds a `providers` row for Gmail, but runtime does not read its OAuth metadata (`authUri`, `tokenUri`, `revokeUri`, `scopes`).
2. The only meaningful runtime use of the `providers` table is `packages/db/src/agent-runtime-descriptor.ts`, which joins it for `providers.capabilities`.
3. The API-side provider catalog already has `categories`, but `packages/db` cannot depend on `apps/api`, so the current split creates drift instead of reuse.
4. Gmail currently requests `gmail.readonly`, which increases Google review cost and timeline, while the associated `search_emails` capability is optional for the near term.
5. `search_emails` is still exposed through the worker tool registry, shared tool catalog, and Gmail system skill, so simply removing the OAuth scope would leave a broken advertised tool.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Provider table | Remove the unused `providers` table path entirely | One Gmail-only provider table is not justified, and the current implementation does not use its OAuth metadata. |
| Migration removal | Delete `0042_gmail_provider.sql` only if it has not been applied anywhere | Deleting an applied migration would corrupt migration history; verify first. |
| Source of truth | Keep `categories` as the only provider classification stored in the catalog model | Avoid carrying both `categories` and `capabilities` as separate persisted fields. |
| Runtime connection families | Derive them in shared code from provider metadata instead of storing `providers.capabilities` | `packages/db` needs a shared source, but not a table for static provider metadata. |
| Gmail scope | Reduce OAuth scope to `https://www.googleapis.com/auth/gmail.send` | Avoid the review burden tied to inbox-read access. |
| Gmail tool surface | Remove `search_emails` from active exposure for now | A non-functional tool should not appear in skills, catalogs, or runtime registration. |

## Design Notes

### Categories vs runtime families

We should not keep both `categories` and `capabilities` as stored fields. They are adjacent concepts, but not identical values in every case:

- Catalog/UI taxonomy today uses values like `trading`, `swap`, `messaging`.
- Runtime binding families today use values like `trading` and `email`.

The fix is not to persist both. The fix is to keep `categories` as the shared provider taxonomy, then derive runtime binding families from provider metadata in shared code.

Example intended behavior:

- `['trading']` -> runtime family `trading`
- `['trading', 'swap']` -> runtime family `trading`
- `['messaging']` for Gmail -> runtime family `email`

That derivation should live in a shared package (`packages/domain` or another package already allowed below `apps/*`), not in `apps/api`, so `packages/db` can consume it without violating dependency direction.

### No replacement table

Do not introduce a new `oauth2_providers` table in this change. If we later support multiple dynamic OAuth providers and genuinely need DB-backed provider metadata, we can design that intentionally. Right now the correct move is removal, not renaming dead metadata.

## Implementation Plan

### Phase 0: Verify migration deletion is safe

1. Confirm `0042_gmail_provider` has not been applied to any developer, staging, or production database that matters.
2. Check both:
   - the target database migration state (`__drizzle_migrations` or equivalent), and
   - any shared environment that another developer or deployment may already have migrated.
3. If `0042` has been applied anywhere important, stop this deletion plan and replace it with a forward migration that drops the table and cleans up dependent code.
4. If `0042` truly has not been applied anywhere, proceed with hard deletion of the migration artifacts.

### Phase 1: Remove the unused DB provider path

1. Delete `packages/db/drizzle/0042_gmail_provider.sql`.
2. Remove the matching `0042_gmail_provider` entry from `packages/db/drizzle/meta/_journal.json`.
3. Delete `packages/db/drizzle/meta/0042_snapshot.json`.
4. Delete `packages/db/src/schema/providers.ts`.
5. Remove the `providers` export from `packages/db/src/schema/index.ts`.
6. Remove the `providers` import and join from `packages/db/src/agent-runtime-descriptor.ts`.

### Phase 2: Replace DB `capabilities` with shared derived runtime families

1. Introduce a shared helper in a package allowed by dependency direction, for example a domain module that answers:
   - provider categories by provider id, and/or
   - runtime binding families derived from provider metadata.
2. Make the API provider registry consume that shared metadata instead of owning a disconnected copy of categories.
3. Update `packages/db/src/agent-runtime-descriptor.ts` to derive connection families from the shared helper rather than `providers.capabilities`.
4. Preserve current runtime behavior:
   - trading connections still satisfy `trading` bindings,
   - Gmail connections still satisfy `email` bindings.
5. Do not add a new stored `capabilities` field anywhere.

### Phase 3: Reduce Gmail OAuth scope and hide inbox-read features

1. Update `apps/api/src/routes/connections-oauth.ts` so `GMAIL_SCOPES` only requests `https://www.googleapis.com/auth/gmail.send`.
2. Remove `search_emails` from the active worker tool surface in `apps/worker/src/tools/email.ts`.
3. Remove `search_emails` from `apps/worker/src/tools/index.ts` indirectly by ensuring `emailTools` exports only `send_email`.
4. Update `packages/domain/src/skills.ts` so the Gmail skill describes send-only behavior and requires only `send_email`.
5. Remove `search_emails` from the shared tool catalog in `packages/domain/src/tools.ts` so it is not advertised as an available tool.
6. Remove or park any now-unused Gmail inbox-search implementation code if it becomes dead after the export changes.

### Phase 4: Documentation cleanup

1. Update [docs/features/2026/07/17/003-gmail-oauth-connection/001-plan.md](../003-gmail-oauth-connection/001-plan.md) to reflect send-only Gmail for now, or mark the read-email portion as deferred.
2. Update `CHANGELOG.md` so it does not claim inbox-read support if we are removing that capability.
3. Document the reintroduction gate clearly: inbox-read support returns only when Google scope verification is approved and the tool is intentionally re-enabled.

## Validation

1. Run targeted tests covering provider-family resolution and Gmail tool exposure.
2. Run the relevant package tests for:
   - `packages/db/src/agent-runtime-descriptor.test.ts`
   - Gmail tool tests in the worker, if present
   - provider catalog tests in the API, if affected by shared metadata extraction
3. Run `pnpm lint` before considering the change complete.
4. Grep for stale references to:
   - `0042_gmail_provider`
   - `providers.capabilities`
   - `gmail.readonly`
   - `search_emails`

## Risks and guards

1. The main risk is deleting a migration that has already been applied somewhere. Guard that first.
2. The main behavior risk is breaking runtime family resolution for existing trading or Gmail connections when removing the DB join. Cover this with focused tests before and after the refactor.
3. The main product risk is leaving `search_emails` advertised anywhere after removing its scope. Remove it from runtime registration, skills, and shared tool metadata together.

## Out of scope

1. Adding a new OAuth-provider table.
2. Generalizing provider metadata storage beyond what is required to remove the current dead path.
3. Reintroducing inbox-read support before Google review is complete.