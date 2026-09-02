# Bug Report: Stale execute_shell / execute_code error-message tests fail after error string was improved

- **Status:** FIXED
- **Severity:** Low
- **Date:** 2026-09-02
- **Discovered By:** Running the full `apps/worker` vitest suite — 2 tests failed unrelated to the change under test.
- **Summary:** Two tests — `apps/worker/src/tools/code.test.ts` and `apps/worker/src/tools/shell.test.ts`, both named "does not misclassify ordinary permission stderr as sandbox infrastructure failure" — asserted the exact error string `"execute_{code,shell} failed with exit code 1"`. Commit `4c5e9f7b "Improve shell error message returned"` (2026-08-31) changed the error string to append the command's stderr (`: ${stderr.slice(0, 200)}`) but did not update these two tests, leaving them red on `main`.

---

## Root Cause

`4c5e9f7b` changed both tools' failure path:

```diff
- error: `execute_code${label} failed with exit code ${exitCode}`,
+ error: `execute_code${label} failed with exit code ${exitCode}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`,
```

(identical change in `shell.ts`). The two tests mock a script that exits 1 with `stderr = "User script error: Permission denied while opening ./output.txt"`, so the produced error is now:

```
execute_code failed with exit code 1: User script error: Permission denied while opening ./output.txt
```

The tests still asserted the pre-change bare string via `toBe(...)`, so the equality failed. The tests' substantive intent — that a script exiting non-zero is an ordinary error (`fault: false`, `success: false`, `errorCode: execute_{code,shell}.execution_failed`), NOT a sandbox infrastructure failure — was and remains satisfied by the code; only the exact-string assertion was stale.

Confirmed the failures were unrelated to concurrent work by stashing all other local changes and re-running: the two tests failed identically on the clean tree.

---

## Fix

Updated the two assertions to expect the improved error string (which now includes the stderr context), and added a comment clarifying that surfacing stderr does not change the ordinary-error classification (`fault: false`). No production code changed — the `4c5e9f7b` behaviour is the intended one.

---

## Files Changed

- `apps/worker/src/tools/code.test.ts` — assertion updated to the full error string incl. stderr.
- `apps/worker/src/tools/shell.test.ts` — same.

---

## Verification

- `npx vitest run apps/worker/src/tools/code.test.ts apps/worker/src/tools/shell.test.ts` → 61 passed.
- `pnpm lint` (`tsc --noEmit`): clean.
- Full `apps/worker` suite: **3413 passed, 21 skipped, 0 failed** (previously 2 failed).
