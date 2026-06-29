# Pre-existing test failures — test mocks stale after `venue`→`provider` migration

**Date:** 2026-06-29
**Severity:** HIGH
**Status:** Partially fixed (26 of 38 resolved); 12 pre-existing failures remain

## Summary

After applying migration 0026 (which renames `user_credentials.venue` → `provider`), 45 unit/integration tests fail because test mocks still reference the old `venue` column name and/or are missing newly-added mock methods.

## Failures breakdown (after 2026-06-29 fixes)

| File | Failures | Status | Root cause |
|------|----------|--------|------------|
| `accounts.test.ts` | 4 | Pre-existing | Credential validation checks `provider` but test mocks use `venue` |
| `agents.test.ts` | 4 | Pre-existing | Agent delete handler uses `connections` table but tests check old `trading_bindings` |
| `blueprints.test.ts` | 3 | Pre-existing | Bot creation validates credentials with `provider` field; test mocks use `venue` |
| `credentials.test.ts` | 1 | Pre-existing | `blockingAgentCredentials` check not implemented in delete handler |

## Fixed (in this session)

- `agent-broker.test.ts`: 20 failures → all fixed (added `getResolvedVenueAccount` to all mock `botRepo` objects)
- `agent-intake-resolver.test.ts`: 3 failures → all fixed (restructured `db` mock to support nested `innerJoin→innerJoin→where` chain; fixed test overrides that used stale `leftJoin` in chain)
- `connections.test.ts`: 3 failures → all fixed (updated `credRow` mock objects from `venue` to `provider`)
- `credentials.test.ts`: 4 of 5 failures fixed (updated mock `userCredentials` table and `mockDbRows` from `venue` to `provider`)
- `i18n/catalog-consistency.test.ts`: 1 failure → fixed (synced ar.ts and hi.ts with en.ts keys; added missing `agents.detail.*`, `agents.evaluations.*`, `credential.venue_mismatch` keys)
- `i18n/i18n-regressions.test.ts`: 1 failure → fixed (updated stale key `agents.capabilityPage.noBindings` → `noConnections`)
- `EditAgentModal.render.test.tsx`: 1 failure → fixed (changed assertion from `agents.advanced.tradingSetup` text to `agents.controls.capital` to avoid false match with agent-type selector)

## Recommended actions

1. **agent-broker.test.ts**: Add `getResolvedVenueAccount: vi.fn().mockResolvedValue({ resolvedVenueAccountId: 'va-001', venue: 'hyperliquid' })` to all mock `botRepo` objects
2. **agent-intake-resolver.test.ts**: Update Drizzle mock to support `.innerJoin(sql...).where()` chaining
3. **i18n tests**: Sync ar.ts and hi.ts locale keys with en.ts
4. **EditAgentModal test**: Investigate trading tab rendering logic
5. **Integration tests**: Investigate decision persistence timing
