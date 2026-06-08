# Trading Binding Schema Mismatch in Blueprint Tests

**Status:** FIXED
**Severity:** High
**Date:** 2026-06-07
**Summary:** 4 blueprint test failures due to test payloads and mock database using outdated `venueAccountId` field instead of `tradingBindingId` following the trading_bindings migration.

## Root Cause
The trading_bindings migration updated the bot creation API to use `tradingBindingId` instead of `venueAccountId`. However, the blueprint tests in `apps/api/src/routes/blueprints.test.ts` were not fully updated:

1. Test payloads still used `venueAccountId: 'va-1'` instead of `tradingBindingId: 'tb-1'`
2. Mock database implementations returned trading binding objects with incorrect structure:
   - **Returned:** `{ id: 'va-1' }`
   - **Expected:** `{ id: 'tb-1', sourceVenueAccountId: 'va-1' }`

The bots endpoint performs a transaction-based trading binding lookup that expects the proper structure with both `id` and `sourceVenueAccountId` fields.

## Fix
Updated all test payloads and mock database configurations:

### Changes Made
1. **Test payloads (2 occurrences):**
   - Line 683: Changed `venueAccountId: 'va-1'` → `tradingBindingId: 'tb-1'`
   - Line 722: Changed `venueAccountId: 'va-1'` → `tradingBindingId: 'tb-1'`

2. **Mock database implementations (3 occurrences):**
   - Line 655: Updated transaction mock where clause return value to include both id and sourceVenueAccountId
   - Line 743: Updated transaction mock where clause return value  
   - Line 826: Updated transaction mock where clause return value

### Updated Mock Structure
```typescript
// Before
where: vi.fn().mockResolvedValue([{ id: 'va-1' }])

// After
where: vi.fn().mockResolvedValue([{ id: 'tb-1', sourceVenueAccountId: 'va-1' }])
```

## Files Changed
- [apps/api/src/routes/blueprints.test.ts](apps/api/src/routes/blueprints.test.ts)

## Verification
✅ All 30 blueprint tests pass
✅ Overall test suite: 918 passed | 121 skipped
✅ No regressions in related tests

## Test Cases Fixed
1. "creates bot from blueprint and stores configSnapshot" - Line 690
2. "returns 404 when referenced blueprint does not exist" - Line 729
3. "sets Deprecation header when using legacy inline config" - Line 774
4. "returns 404 (not 500) when blueprint is deleted between lookup and insert (FK race)" - Line 858
