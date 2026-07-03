# 003-stripemptyvalues-mock-and-format-string-test-failures.md

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-07-03
- **Summary:** Two test files had stale expectations after recent production code changes: (a) `hybrid-agent-evaluator.test.ts` mock was missing `stripEmptyValues` export added in commit `a91d6a3`, causing 3 test failures; (b) `runtime-composition.test.ts` expected the old non-compact currency format `$15000.00` instead of the new compact format `$15.0K` introduced in commit `9b31932`.
- **Root Cause:**
  - (a) `hybrid-agent-evaluator.ts` imports `stripEmptyValues` from `@herobids/llm`, but the test mock only provided `callLlmProvider`. Since Vitest's `vi.mock` with a factory replaces the entire module, `stripEmptyValues` was `undefined`, causing a TypeError inside the JSON parsing try-catch. The error was caught, and the evaluator returned early without calling `submitDecision`, resulting in spy assertions failing with 0 calls.
  - (b) `formatCurrency()` now uses `fmtUsd()` for values ≥ $10,000, which produces compact notation like `$15.0K` instead of `$15000.00`. The test expectation was not updated.
- **Fix:**
  - (a) Changed `vi.mock('@herobids/llm', () => ({ callLlmProvider: vi.fn() }))` to use `vi.mock('@herobids/llm', async (importOriginal) => { const actual = await importOriginal(); return { ...actual, callLlmProvider: vi.fn() }; })` so all real exports are preserved and only `callLlmProvider` is mocked. Also updated `$10000.00` → `$10.0K` in the hybrid prompt expectation.
  - (b) Updated expected string from `'Account summary: available capital $15000.00'` to `'Account summary: available capital $15.0K'`.
- **Files Changed:**
  - `apps/worker/src/hybrid-agent-evaluator.test.ts` — mock + one format expectation
  - `apps/worker/src/runtime-composition.test.ts` — one format expectation
- **Verification:** All 114 tests in the 3 previously-failing test files now pass; `pnpm test` reports 3651 passed, 0 failed.
