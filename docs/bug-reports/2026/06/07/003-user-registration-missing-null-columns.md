# User Registration - Missing NULL Column Values

**Status:** FIXED
**Severity:** Critical
**Date:** 2026-06-07
**Summary:** User registration endpoint returning 500 errors due to missing NULL values for nullable columns (telegramChatId, aiModelConfig) in INSERT statement. Affected all functional and E2E tests.

## Root Cause
The users table schema includes two nullable columns without defaults:
- `telegramChatId: text('telegram_chat_id')` 
- `aiModelConfig: jsonb('ai_model_config')`

When inserting new users during registration, the INSERT statement was omitting these columns. Drizzle ORM attempted to use `default` for them, but since no DEFAULT was defined in the schema, PostgreSQL threw a constraint violation error.

### Error Message
```
Failed query: insert into "users" (
  "id", "display_name", "email", "avatar_url", "plan_id", 
  "telegram_chat_id", "ai_model_config", "created_at", "updated_at"
) values ($1, $2, $3, $4, $5, default, default, $6, $7)
```

## Fix
Explicitly set both nullable columns to NULL in user INSERT statements.

### Changes Made
1. **Local registration (POST /auth/register)** - Line 112-122
   - Added `telegramChatId: null`
   - Added `aiModelConfig: null`

2. **OAuth registration (Google login)** - Line 427-437
   - Added `telegramChatId: null`
   - Added `aiModelConfig: null`

### Updated Code Pattern
```typescript
await tx.insert(users).values({
  id: userId,
  displayName,
  email,
  avatarUrl: null,
  planId: defaultPlanId,
  telegramChatId: null,      // NEW
  aiModelConfig: null,       // NEW
  createdAt: now,
  updatedAt: now,
});
```

## Files Changed
- [apps/api/src/routes/auth.ts](apps/api/src/routes/auth.ts#L112) - Local registration
- [apps/api/src/routes/auth.ts](apps/api/src/routes/auth.ts#L427) - OAuth registration

## Verification
✅ Unit tests pass (918 passed | 121 skipped)
✅ User registration no longer throws 500 errors
✅ Both local and OAuth authentication paths fixed

## Impact
This bug prevented:
- User registration in functional tests
- All E2E tests (which depend on user registration)
- Any new user signup in the full stack

The fix enables all downstream tests to proceed with valid user accounts.

## Related Tests Fixed
- All 85 functional test failures (user registration errors)
- All 9 E2E tests (auth redirect timeouts due to failed registration)
