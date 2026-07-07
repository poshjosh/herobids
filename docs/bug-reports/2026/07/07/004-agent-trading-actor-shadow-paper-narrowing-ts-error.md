# 004 — agent-trading-actor: dead isShadowOrPaper comparisons cause TS2367 build failure

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-07-07
- **Summary:** `pnpm build` fails with four TS2367 errors in `apps/worker/src/agent-trading-actor.ts` at lines 2813 and 2870 because TypeScript narrows `this.deps.executionMode` to `'live'` after the early-return guard at the top of `startReconciler`, making subsequent comparisons to `'shadow'` and `'paper'` appear unintentional.

## Root Cause

`startReconciler` opens with:
```typescript
if (this.deps.executionMode === 'shadow' || this.deps.executionMode === 'paper') return;
```
After that guard TypeScript narrows `this.deps.executionMode` to `'live'` for the rest of the method body.  Two later expressions still compared it against `'shadow'` / `'paper'`:

```typescript
// line 2813 — Reconciler constructor arg
isShadowOrPaper: this.deps.executionMode === 'shadow' || this.deps.executionMode === 'paper',

// line 2870 — local variable
const isShadowOrPaper = this.deps.executionMode === 'shadow' || this.deps.executionMode === 'paper';
```

Both expressions are logically dead (always `false`) because the only path to those lines is through live mode.

## Fix

Replaced both dead comparisons with the literal `false`:

```typescript
// line 2813
isShadowOrPaper: false,

// line 2870
const isShadowOrPaper = false;
```

## Files Changed

- `apps/worker/src/agent-trading-actor.ts`

## Verification

`npx tsc --build apps/worker/tsconfig.json` exits 0 with no output.
