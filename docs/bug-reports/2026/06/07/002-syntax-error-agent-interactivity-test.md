# Syntax Error in agent-interactivity.functional.test.ts

**Status:** Closed
**Severity:** High
**Date:** 2026-06-07
**Summary:** Esbuild transform failure due to extra closing brace in agent-interactivity.functional.test.ts, preventing test compilation.

## Root Cause
Extra closing brace `});` on line 295 of agent-interactivity.functional.test.ts after the describe block for '/api/telegram/webhook' endpoint tests. This created unmatched braces causing esbuild compilation failure:

```
ERROR: Unexpected "}"
  295 |    });
      |    ^
```

## Fix
Removed the extra closing brace and describe block terminator on line 295.

### Changes Made
- **Line 295:** Removed erroneous `});` that followed already-closed describe block
- The telegram webhook tests properly close on line 294 with `});`
- The GET /agents/:id/export/bundle describe block now properly follows

## Files Changed
- [apps/api/src/__tests__/functional/agent-interactivity.functional.test.ts](apps/api/src/__tests__/functional/agent-interactivity.functional.test.ts#L295)

## Regression Tests

No unit test added. The fix is a compile-time syntax correction (removed an extraneous `});`). Regression is prevented structurally by `pnpm lint` (`tsc --noEmit`), which fails to compile files with unbalanced braces.

## Verification
✅ Test file now compiles without esbuild errors
✅ All unit tests pass (918 passed | 121 skipped)
✅ Functional test suite executes successfully
