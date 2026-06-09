# 012 — Agent crashes on startup: `tickCount` temporal dead zone

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-09
- **Summary:** Every agent container crashed immediately on startup with `ReferenceError: Cannot access 'tickCount' before initialization`.
- **Root Cause:** `let tickCount = 0` was declared inside the "Main reasoning loop" section of `apps/worker/src/agent.ts` (line ~917), but `applyToolVisibility()` — a function that reads `tickCount` — was called at module level (line ~387) during initialization, before the `let` declaration was reached. JavaScript's Temporal Dead Zone (TDZ) for `let`/`const` causes a `ReferenceError` when a variable is accessed before its `let` declaration is executed.
- **Fix:** Moved `let tickCount = 0`, `let scoutTickCount = 0`, and `let scoutEscalationCount = 0` declarations to before the functions and module-level call sites that reference them (immediately after `toolVisibility` initialization, around line 272). Removed the duplicate declarations from the main reasoning loop section.
- **Files Changed:**
  - `apps/worker/src/agent.ts`
- **Verification:** `pnpm lint` passes. Agent container no longer crashes on startup (verified via Docker logs and UAT AG-05).
